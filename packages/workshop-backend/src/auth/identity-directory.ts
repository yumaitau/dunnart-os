import { DurableObject } from "cloudflare:workers";
import { ScimError, parseScimUser, patchScimUser, scimProfile, scimFilter, type ProvisionedProfile } from "./scim-schema.js";
import { handleScimRequest } from "./scim-http.js";
import { createWorkshopLogger } from "../observability.js";
import { beginNativeRecovery, captureNativeRoot, endNativeRecovery, fenceNativeRecoveryMethods,
  readNativeRecovery, registerNativeRecoveryObject } from "../native-recovery.js";
import { prepareRecoveryContext } from "../recovery-runtime-context.js";

const logger = createWorkshopLogger("workshop.identity");

type Identity = ProvisionedProfile & {
  revision: number; id: string; providerId: string; created: string; modified: string;
  issuer?: string; subject?: string; deleted?: boolean;
};

/** Provider-scoped identities with stable local account keys across profile and email changes. */
export class IdentityDirectory extends DurableObject<Cloudflare.Env> {
  /** Persist a maintenance fence and revoke existing RPC handles before capture. */
  async beginRecovery(run: string, key: string): Promise<void> {
    if (beginNativeRecovery(this.ctx, run, key)) {
      await this.ctx.storage.sync();
      this.ctx.abort("Native recovery fence installed; retry acquisition.");
    }
  }

  /** Release only the maintenance fence held by this run. */
  endRecovery(run: string): void { endNativeRecovery(this.ctx, run); }

  /** Export complete identity and pending synchronization SQL for deployment recovery. */
  async getRecoverySnapshot(): Promise<string> { return JSON.stringify(await captureNativeRoot(this.ctx)); }

  /** Report a diagnostic bookmark; recovery validation compares portable contents. */
  getRecoveryBookmark(): Promise<string> { return this.ctx.storage.getCurrentBookmark(); }

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    env = prepareRecoveryContext(ctx, env);
    super(ctx, env);
    registerNativeRecoveryObject(this, ctx);
    if (readNativeRecovery(ctx)) return;
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, username TEXT NOT NULL,
      email TEXT NOT NULL, external_id TEXT, issuer TEXT, subject TEXT,
      deleted INTEGER NOT NULL DEFAULT 0, profile TEXT NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS identity_username ON identities(provider, username COLLATE NOCASE) WHERE deleted = 0;
    CREATE UNIQUE INDEX IF NOT EXISTS identity_email ON identities(provider, email) WHERE deleted = 0;
    CREATE UNIQUE INDEX IF NOT EXISTS identity_external ON identities(provider, external_id) WHERE deleted = 0;
    CREATE UNIQUE INDEX IF NOT EXISTS identity_subject ON identities(provider, issuer, subject) WHERE deleted = 0;
    CREATE TABLE IF NOT EXISTS pending_identity_sync (id TEXT PRIMARY KEY, revision INTEGER NOT NULL) STRICT;`);
  }

  async fetch(request: Request): Promise<Response> {
    return handleScimRequest(request, this.env, this);
  }

  #find(provider: string, id: string, includeDeleted = false): Identity {
    const row = this.ctx.storage.sql.exec<{ profile: string }>(
      "SELECT profile FROM identities WHERE provider = ? AND id = ? AND (deleted = 0 OR ?)", provider, id, includeDeleted ? 1 : 0).toArray()[0];
    if (!row) throw new ScimError(404, "User not found.");
    return JSON.parse(row.profile);
  }

  #save(identity: Identity): void {
    identity.revision = (identity.revision ?? 0) + 1;
    try {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(`INSERT INTO identities
          (id, provider, username, email, external_id, issuer, subject, deleted, profile)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
          username=excluded.username, email=excluded.email, external_id=excluded.external_id,
          issuer=excluded.issuer, subject=excluded.subject, deleted=excluded.deleted, profile=excluded.profile`,
          identity.id, identity.providerId, identity.userName, identity.email, identity.externalId ?? null,
          identity.issuer ?? null, identity.subject ?? null, identity.deleted ? 1 : 0, JSON.stringify(identity));
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO pending_identity_sync VALUES (?, ?)", identity.id, identity.revision);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint")) {
        throw new ScimError(409, "Identity already exists in this provider.", "uniqueness");
      }
      throw error;
    }
  }

  #user(identity: Identity) {
    return this.ctx.exports.UserDurableObject.getByName(`enterprise-${identity.id}`);
  }

  async #sync(identity: Identity): Promise<void> {
    // Retry failed cross-DO updates after restarts; the revision prevents a stale activation.
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
    await this.#user(identity).provisionEnterpriseAccount(
      `enterprise-${identity.id}`, identity.displayName, identity.active && !identity.deleted, identity.revision);
    if ((!identity.active || identity.deleted) && this.env.BETTER_AUTH_ENABLED === "true" && this.env.AUTH_DB) {
      await this.env.AUTH_DB.prepare('DELETE FROM session WHERE userId IN (SELECT id FROM user WHERE workshopId = ?)')
        .bind(`enterprise-${identity.id}`).run();
    }
    this.ctx.storage.sql.exec("DELETE FROM pending_identity_sync WHERE id = ? AND revision = ?", identity.id, identity.revision);
  }

  async alarm(): Promise<void> {
    const rows = this.ctx.storage.sql.exec<{ profile: string }>(
      "SELECT profile FROM identities JOIN pending_identity_sync USING (id) LIMIT 50").toArray();
    for (const row of rows) {
      try { await this.#sync(JSON.parse(row.profile)); }
      catch { logger.warn("identity sync will retry", { event: "identity.sync.retry" }); }
    }
    if (this.ctx.storage.sql.exec("SELECT id FROM pending_identity_sync LIMIT 1").toArray().length) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }

  #resource(identity: Identity, base: string) {
    return { ...scimProfile(identity), id: identity.id,
      meta: { resourceType: "User", created: identity.created, lastModified: identity.modified,
        location: `${base}/Users/${identity.id}` } };
  }

  /** Only called after the HTTP handler validates a provider-scoped bearer token. */
  async scim(provider: string, request: Request, base: string, body?: unknown): Promise<Response> {
    const url = new URL(request.url);
    const suffix = url.pathname.slice("/api/scim/v2/Users".length);
    const id = suffix.startsWith("/") ? suffix.slice(1) : "";
    if (suffix && (!/^\/[a-f0-9-]{36}$/.test(suffix))) throw new ScimError(404, "Resource not found.");
    const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status, headers: { "Content-Type": "application/scim+json", "Cache-Control": "no-store",
        ...(status === 201 && typeof value === "object" && value && "id" in value ? { Location: `${base}/Users/${value.id}` } : {}) },
    });
    if (request.method === "GET") {
      if (id) return respond(this.#resource(this.#find(provider, id), base));
      const filter = scimFilter(url.searchParams.get("filter"));
      const fields: Record<string, string> = { username: "username COLLATE NOCASE", externalid: "external_id", id: "id", "emails.value": "email COLLATE NOCASE" };
      const clause = filter ? ` AND ${fields[filter.field]} = ?` : "";
      const args = filter ? [provider, filter.value] : [provider];
      const count = pagination(url.searchParams.get("count"), 100, 0, 200);
      const start = pagination(url.searchParams.get("startIndex"), 1, 1, 1_000_000);
      const total = this.ctx.storage.sql.exec<{ total: number }>(
        `SELECT count(*) AS total FROM identities WHERE provider = ? AND deleted = 0${clause}`, ...args).one().total;
      const rows = this.ctx.storage.sql.exec<{ profile: string }>(
        `SELECT profile FROM identities WHERE provider = ? AND deleted = 0${clause} ORDER BY id LIMIT ? OFFSET ?`,
        ...args, count, start - 1).toArray();
      return respond({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: total,
        startIndex: start, itemsPerPage: rows.length, Resources: rows.map(row => this.#resource(JSON.parse(row.profile), base)) });
    }
    if (request.method === "POST" && !id) {
      const profile = parseScimUser(body);
      const now = new Date().toISOString();
      const identity: Identity = { ...profile, revision: 0, id: crypto.randomUUID(), providerId: provider, created: now, modified: now };
      this.#save(identity);
      await this.#sync(identity);
      logger.info("identity provisioned", { event: "identity.provisioned", identityId: identity.id, vendorId: provider });
      return respond(this.#resource(identity, base), 201);
    }
    if (!id) throw new ScimError(405, "Method not allowed.");
    let identity = this.#find(provider, id, request.method === "DELETE");
    if (request.method === "DELETE") {
      identity = { ...identity, active: false, deleted: true };
    } else if (request.method === "PUT" || request.method === "PATCH") {
      const profile = request.method === "PATCH" ? patchScimUser(identity, body) : parseScimUser(body);
      identity = { ...identity, ...profile };
    } else throw new ScimError(405, "Method not allowed.");
    identity.modified = new Date().toISOString();
    this.#save(identity);
    await this.#sync(identity);
    logger.info("identity updated", { event: identity.active ? "identity.updated" : "identity.deactivated", identityId: identity.id, vendorId: provider });
    return request.method === "DELETE" ? new Response(null, { status: 204 }) : respond(this.#resource(identity, base));
  }

  /** Resolve only within this provider and issuer; never claim an email-keyed local account. */
  async resolveIdentity(providerId: string, issuer: string, subject: string,
      email: string | undefined, emailVerified: boolean, requireProvisioning: boolean): Promise<string> {
    let row = this.ctx.storage.sql.exec<{ profile: string }>(
      "SELECT profile FROM identities WHERE provider = ? AND issuer = ? AND subject = ? AND deleted = 0",
      providerId, issuer, subject).toArray()[0];
    if (!row) {
      row = this.ctx.storage.sql.exec<{ profile: string }>(
        `SELECT profile FROM identities WHERE provider = ? AND deleted = 0 AND
         (external_id = ? OR (? = 1 AND email = ?)) ORDER BY external_id = ? DESC LIMIT 1`,
        providerId, subject, emailVerified ? 1 : 0, email?.toLowerCase() ?? "", subject).toArray()[0];
    }
    if (!row) {
      // A deleted, never-used assignment must not fall back to just-in-time signup.
      row = this.ctx.storage.sql.exec<{ profile: string }>(
        "SELECT profile FROM identities WHERE provider = ? AND deleted = 1 AND ((issuer = ? AND subject = ?) OR external_id = ? OR (? AND email = ?)) LIMIT 1",
        providerId, issuer, subject, subject, emailVerified ? 1 : 0, email?.toLowerCase() ?? "").toArray()[0];
    }
    let identity: Identity;
    if (row) {
      identity = JSON.parse(row.profile);
      if (!identity.active || identity.deleted ||
          (identity.subject && (identity.subject !== subject || identity.issuer !== issuer))) {
        throw new Error("Identity is not permitted to sign in.");
      }
    } else {
      if (requireProvisioning || !emailVerified || !email) throw new Error("Identity has not been provisioned.");
      const now = new Date().toISOString();
      identity = { revision: 0, id: crypto.randomUUID(), providerId, userName: email, email: email.toLowerCase(),
        displayName: email, active: true, created: now, modified: now };
    }
    identity = { ...identity, issuer, subject };
    this.#save(identity);
    await this.#sync(identity);
    return `enterprise-${identity.id}`;
  }
}

function pagination(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ScimError(400, "Invalid pagination.", "invalidValue");
  return Math.min(Math.max(Number(value), min), max);
}

fenceNativeRecoveryMethods(IdentityDirectory);
