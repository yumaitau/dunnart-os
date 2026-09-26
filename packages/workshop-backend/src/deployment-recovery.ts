import { createHash } from "node:crypto";
import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { kvRecoverySource, kvRecoveryTarget } from "@gadgets/backend-utils/recovery-kv";
import { d1RecoverySource, d1RecoveryTarget } from "@gadgets/backend-utils/recovery-d1";
import { r2RecoverySource, r2RecoveryTarget } from "@gadgets/backend-utils/recovery-r2";
import { recoveryBytes } from "@gadgets/backend-utils/recovery-archive";
import { verifyCapabilityDescriptor, type SignedRecoveryCapability } from "@gadgets/backend-utils/recovery-capability";
import { decodePortableValue, type PortableDescriptor } from "@gadgets/backend-utils/recovery-value";
import type { RecoverySource, RecoveryTarget } from "@gadgets/backend-utils/recovery-repository";
import type { GatekeeperRecoveryParticipant, GatekeeperRecoveryResolver, GatekeeperRecoveryDescriptor } from "@gadgets/workshop-shared/gatekeeper-recovery";
import type { DeploymentBackupEnv, DeploymentRecovery } from "./deployment-backup-contract";
import type { RecoveryNamedIds } from "./recovery-runtime-context";
import { NativeRecoveryService, type NativeRecoverySnapshot } from "./native-recovery";
import { verifyGadgetRecoveryDescriptor, type RecoveryGadgetInspector } from "./recovery-gadget";
import { BLUEPRINT_SCREENSHOT_R2_PREFIX } from "@gadgets/workshop-shared/api";
import { isReservedBlueprintKey, ADMIN_CONFIG_KEY, type BlueprintKvRecord } from "./blueprint-archive";
import { normalizeAdminConfig, type AdminConfig } from "./admin-config";
import { SITE_LOGO_R2_KEY } from "./site-logo";
import { buildGatekeeperVendorMap } from "./auth/auth-vendors";

type RecoveryEnv = DeploymentBackupEnv & { BACKUP_RELEASE_ID?: string; BACKUP_CAPABILITY_KEY?: string; AUTH_DB_RESTORE?: D1Database;
  BLUEPRINTS_RESTORE?: KVNamespace; AVATARS_RESTORE?: KVNamespace };
type Journal = { roots: string[]; users: string[]; workspaces: string[]; connectors: Record<string, string[]>; key: string };
type Participant = RpcStub<GatekeeperRecoveryParticipant>;
const encoder = new TextEncoder();
const journalKey = (run: string) => `recovery-provider/${run}`;
async function acquireNative(begin: () => Promise<void>): Promise<void> {
  // Installing a new fence aborts the object to invalidate existing WebSockets and RPC handles.
  // The persisted matching fence makes the second call idempotent; genuine failure still escapes.
  try { await begin(); } catch { await begin(); }
}
const safe = (value: string) => { if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid recovery identifier."); return value; };
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
const nativeContent = (snapshot: string) => { const { bookmark: _bookmark, ...content } = JSON.parse(snapshot); return JSON.stringify(content); };
// Descriptor props may be constructed in a different order by their trusted restore adapter.
// Portable storage preserves meaningful property/map order and aliases in arrays, which stay intact.
const canonicalJson = (value: unknown) => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).toSorted().map(key => [key, item[key]])) : item);
const textSource = (id: string, read: () => Promise<string>): RecoverySource => ({ id, version: 1,
  async export() {
    const value = await read();
    if (encoder.encode(value).byteLength > 32 * 1024 * 1024) throw new Error(`${id} exceeds the native recovery component limit.`);
    return new Response(value).body!;
  } });
async function digest(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash("sha256"); const reader = stream.getReader();
  try { for (;;) { const next = await reader.read(); if (next.done) break; hash.update(next.value); }
    return hash.digest("hex");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
const descriptorKinds = new Set(["native-class", "gadget", "gadget-callback", "workshop-hook", "workshop-agent-self",
  "workshop-agent-spawner-class", "workshop-language-model-class", "context-account", "context-verifier", "context-gatekeeper-class",
  "schedule-account", "schedule-verifier", "schedule-controller", "schedule-gatekeeper-class"]);
function assertRestorableDescriptor(value: unknown): void {
  if (!value || typeof value !== "object" || !("kind" in value) || typeof value.kind !== "string" || !descriptorKinds.has(value.kind)) {
    throw new Error("A retained capability has no supported isolated recovery resolver.");
  }
}
type CaptureInventory = { workspaces: ReadonlySet<string>; accounts: ReadonlyMap<string, GatekeeperRecoveryDescriptor>; vendors: ReadonlySet<string> };
async function assertCaptureReferences(value: unknown, inventory: CaptureInventory, seen = new Set<object>()): Promise<void> {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (record.kind === "capability") assertRestorableDescriptor(record.descriptor);
  const props = record.props && typeof record.props === "object" ? record.props as Record<string, unknown> : undefined;
  const reference = record.kind === "gadget" || record.kind === "gadget-callback" ? record.overseerId
    : typeof record.kind === "string" && record.kind.startsWith("workshop-") ? props?.overseerId
    : record.kind === "schedule-controller" ? props?.workspaceId : undefined;
  if (typeof reference === "string" && !inventory.workspaces.has(reference)) throw new Error("A retained capability references a workspace outside the frozen recovery inventory.");
  if (typeof record.kind === "string" && (record.kind.startsWith("context-") || record.kind.startsWith("schedule-"))) {
    const vendor = record.kind.startsWith("context-") ? "context" : "scheduler";
    const expected = typeof props?.accountId === "string" ? inventory.accounts.get(`${vendor}/${props.accountId}`) : undefined;
    if (!inventory.vendors.has(vendor) || record.kind !== "schedule-verifier" && (!expected ||
        vendor === "context" && props?.sharingDomain !== expected.props.sharingDomain)) {
      throw new Error("A retained connector capability references an account or domain outside the frozen recovery inventory.");
    }
  }
  if (record.kind === "native-class") {
    if (typeof record.value !== "string") throw new Error("Invalid native class recovery descriptor.");
    const decoded = await decodePortableValue(JSON.parse(record.value), { describe() { return undefined; }, restore(descriptor) { return descriptor; } });
    assertRestorableDescriptor(decoded);
    await assertCaptureReferences(decoded, inventory, seen);
  }
  for (const item of Object.values(record)) await assertCaptureReferences(item, inventory, seen);
}
function verifiedSource(source: RecoverySource, expected: string): RecoverySource {
  return { ...source, async export() {
    const hash = createHash("sha256");
    return (await source.export()).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) { hash.update(bytes); controller.enqueue(bytes); },
      flush() { if (hash.digest("hex") !== expected) throw new Error(`${source.id} changed during recovery capture.`); },
    }));
  } };
}
async function boundedText(stream: ReadableStream<Uint8Array>): Promise<string> {
  let bytes = 0; const decoder = new TextDecoder("utf-8", { fatal: true }); let value = "";
  const reader = stream.getReader();
  try { for (;;) { const next = await reader.read(); if (next.done) break;
    bytes += next.value.length; if (bytes > 32 * 1024 * 1024) throw new Error("Recovery component exceeds native restore limit.");
    value += decoder.decode(next.value, { stream: true });
  } return value + decoder.decode(); } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Verify independently authenticated release escrow before including executable recovery material. */
export async function readRecoveryRelease(env: DeploymentBackupEnv & { BACKUP_RELEASE_ID?: string }): Promise<{ manifest: string; key: string; sha256: string }> {
  const object = await env.BACKUPS?.get("release/current.json");
  if (!object || object.size > 64 * 1024) throw new Error("Authenticated deployment release escrow is missing.");
  const manifest = await object.text();
  const value = JSON.parse(manifest);
  if (value?.version !== 1 || typeof value.releaseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.releaseId) ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 16 || value.bytes > 96 * 1024 * 1024 || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      value.keyEnvelope?.version !== 1 || value.keyEnvelope.algorithm !== "RSA-OAEP-256/A256GCM" ||
      typeof value.keyEnvelope.keyId !== "string" || typeof value.keyEnvelope.wrappedKey !== "string" ||
      typeof value.nonce !== "string" || typeof value.authentication !== "string") throw new Error("Invalid deployment release escrow manifest.");
  const secret = env.BACKUP_AUTHENTICATION_KEY;
  if (!secret) throw new Error("Backup authentication key is missing.");
  const secretBytes = recoveryBytes(secret, 64);
  if (secretBytes.length < 32) throw new Error("Backup authentication key is too short.");
  if (recoveryBytes(value.keyEnvelope.wrappedKey, 1024).length < 384 || recoveryBytes(value.nonce, 12).length !== 12 ||
      !/^[a-f0-9]{64}$/.test(value.keyEnvelope.keyId)) throw new Error("Invalid deployment release escrow encryption parameters.");
  const key = await crypto.subtle.importKey("raw", secretBytes,
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const payload = JSON.stringify([1, value.releaseId, value.bytes, value.sha256, value.keyEnvelope.version,
    value.keyEnvelope.algorithm, value.keyEnvelope.keyId, value.keyEnvelope.wrappedKey, value.nonce]);
  if (!await crypto.subtle.verify("HMAC", key, recoveryBytes(value.authentication, 32), encoder.encode(payload))) {
    throw new Error("Deployment release escrow authentication failed.");
  }
  if (!env.BACKUP_RELEASE_ID || value.releaseId !== env.BACKUP_RELEASE_ID) throw new Error("Deployment release escrow does not match the deployed release.");
  if (!env.BACKUP_PUBLIC_KEY) throw new Error("Backup public key is missing.");
  const publicKey = JSON.parse(env.BACKUP_PUBLIC_KEY);
  if (publicKey.kty !== "RSA" || typeof publicKey.n !== "string" || typeof publicKey.e !== "string" || publicKey.d) throw new Error("Invalid backup public key.");
  const publicKeyId = hex(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(["RSA", publicKey.n, publicKey.e]))));
  if (publicKeyId !== value.keyEnvelope.keyId) throw new Error("Deployment release escrow uses a different recovery key.");
  const artifactKey = `release/${value.releaseId}/artifact.bin`;
  const artifact = await env.BACKUPS!.get(artifactKey);
  if (!artifact || artifact.size !== value.bytes || await digest(artifact.body) !== value.sha256) {
    throw new Error("Deployment release escrow artifact is missing or corrupt.");
  }
  return { manifest, key: artifactKey, sha256: value.sha256 };
}

/** Bind complete deployment inventory to authenticated archives and explicitly inactive targets. */
export function createDeploymentRecovery(env: RecoveryEnv, exports: Cloudflare.Exports,
    storage: DurableObjectStorage, maintenance?: { begin(run: string): Promise<void>; end(run: string): Promise<void> }): DeploymentRecovery {
  const vendors = buildGatekeeperVendorMap(env);
  const participants = new Map<string, Participant>();
  const checks = new Map<string, Array<() => Promise<void>>>();
  const restoreRuns = new Map<string, { required: string[]; staged: Set<string>; service: NativeRecoveryService }>();
  const phase = async (run: string, value: string, component?: string) => {
    const componentHash = component ? hex(await crypto.subtle.digest("SHA-256", encoder.encode(component))).slice(0, 16) : undefined;
    await storage.put(`recovery-provider/phase/${run}`, { phase: value, component: componentHash });
  };
  async function participant(id: string): Promise<Participant> {
    const cached = participants.get(id); if (cached) return cached;
    const vendor = vendors.get(id);
    if (!vendor) throw new Error(`Recovery connector ${id} is not installed.`);
    let result: Participant;
    try { if (typeof vendor.getRecoveryParticipant !== "function") throw new Error("Missing recovery adapter."); result = await vendor.getRecoveryParticipant(); }
    catch { throw new Error(`Installed connector ${id} has no complete recovery adapter.`); }
    if (!result) throw new Error(`Installed connector ${id} has no complete recovery adapter.`);
    participants.set(id, result); return result;
  }
  const user = (id: string) => exports.UserDurableObject.get(exports.UserDurableObject.idFromString(id));
  const workspace = (id: string) => exports.OverseerDurableObject.get(exports.OverseerDurableObject.idFromString(id));
  const roots = () => [
    { id: "root-admin", object: exports.AdminSettings.getByName("") },
    { id: "root-users", object: exports.UserDirectoryDurableObject.getByName("") },
    { id: "root-identities", object: exports.IdentityDirectory.getByName("") },
  ];
  const stores = (): RecoverySource[] => [kvRecoverySource("kv-blueprints", env.BLUEPRINTS),
    kvRecoverySource("kv-avatars", env.AVATARS), r2RecoverySource("r2-blueprints", env.BLUEPRINT_CONTENT),
    ...(env.AUTH_DB ? [d1RecoverySource("d1-auth", env.AUTH_DB)] : [])];

  function captureService(key: string, inventory?: CaptureInventory): NativeRecoveryService {
    const service = new NativeRecoveryService({
      async describe(value) {
        // RPC method presence is not evidence of provenance. Only a valid deployment MAC is trusted.
        const candidate = value as Pick<DurableObjectStub<RecoveryGadgetInspector>, "getRecoveryDescriptor">;
        let signed: SignedRecoveryCapability;
        try { signed = await candidate.getRecoveryDescriptor(service); } catch { return undefined; }
        let descriptor: PortableDescriptor;
        try { descriptor = JSON.parse(JSON.stringify(await verifyGadgetRecoveryDescriptor(key, signed))); }
        catch { descriptor = await verifyCapabilityDescriptor(env.BACKUP_CAPABILITY_KEY, signed) as PortableDescriptor; }
        if (inventory) {
          assertRestorableDescriptor(descriptor);
          await assertCaptureReferences(descriptor, inventory);
        }
        return descriptor;
      },
      restore() { throw new Error("Capture cannot restore capabilities."); },
    });
    return service;
  }
  async function preview(run: string, required: string[]) {
    safe(run); const issues: string[] = [];
    if (!env.BACKUP_RESTORE) issues.push("Isolated recovery R2 bucket is missing.");
    if (required.includes("kv-blueprints") && !env.BLUEPRINTS_RESTORE) issues.push("Isolated blueprint KV namespace is missing.");
    if (required.includes("kv-avatars") && !env.AVATARS_RESTORE) issues.push("Isolated avatar KV namespace is missing.");
    if (required.includes("d1-auth") && !env.AUTH_DB_RESTORE) issues.push("Isolated authentication D1 database is missing.");
    if (env.BACKUP_RESTORE === env.BLUEPRINT_CONTENT || env.BACKUP_RESTORE === env.BACKUPS ||
        env.BLUEPRINTS_RESTORE && env.BLUEPRINTS_RESTORE === env.BLUEPRINTS ||
        env.AVATARS_RESTORE && env.AVATARS_RESTORE === env.AVATARS || env.AUTH_DB_RESTORE && env.AUTH_DB_RESTORE === env.AUTH_DB) {
      issues.push("Recovery targets must differ from production bindings.");
    }
    if (await storage.get(`recovery-provider/staged/${run}`)) issues.push("This restore target has already been allocated; use a fresh restore run.");
    for (const [id, target] of [["kv-blueprints", env.BLUEPRINTS_RESTORE], ["kv-avatars", env.AVATARS_RESTORE]] as const) {
      if (required.includes(id) && target && (await target.list({ limit: 1 })).keys.length) issues.push(`Isolated ${id} target is occupied.`);
    }
    if (required.includes("d1-auth") && env.AUTH_DB_RESTORE &&
        (await env.AUTH_DB_RESTORE.prepare("SELECT name FROM sqlite_schema WHERE sql IS NOT NULL AND substr(name,1,7)<>'sqlite_' AND substr(name,1,4)<>'_cf_' LIMIT 1").all()).results.length) {
      issues.push("Isolated authentication D1 target is occupied.");
    }
    if (env.BACKUP_RESTORE && (await env.BACKUP_RESTORE.list({ limit: 1 })).objects.length) issues.push("Isolated recovery R2 target is occupied.");
    for (const id of required.filter(id => id.startsWith("connector-"))) {
      const vendor = id.slice("connector-".length).split("--")[0]!;
      try { await participant(vendor); } catch (error) { issues.push(String(error)); }
    }
    return { target: `isolated-${run}`, issues };
  }
  return {
    async coverage() {
      const rows = [{ id: "kv-consistency", title: "Recent avatar changes may take time to appear in backups.", ready: true }, { id: "maintenance", title: "Deployment-wide write barrier and request drain", ready: !!maintenance }, { id: "sessions", title: "Sessions and pending login state intentionally invalidated on restore", ready: true }, { id: "native", title: "Users, workspaces, native storage and capabilities", ready: !!env.BACKUP_CAPABILITY_KEY },
        { id: "storage", title: "Blueprints, avatars and authentication", ready: !!env.BLUEPRINTS && !!env.AVATARS && !!env.BLUEPRINT_CONTENT && (env.BETTER_AUTH_ENABLED !== "true" || !!env.AUTH_DB) }];
      for (const id of vendors.keys()) {
        try { await participant(id); rows.push({ id: `connector-${id}`, title: `${id} persistent connector state`, ready: true }); }
        catch { rows.push({ id: `connector-${id}`, title: `${id}: complete recovery adapter missing`, ready: false }); }
      }
      try { await readRecoveryRelease(env); rows.push({ id: "release", title: "Authenticated worker bundles, assets and deployment configuration", ready: true }); }
      catch { rows.push({ id: "release", title: "Authenticated deployment release escrow missing or invalid", ready: false }); }
      return rows;
    },
    async acquire(run) {
      safe(run);
      if (await storage.get(journalKey(run))) throw new Error("Recovery run already acquired; release its persisted journal before retrying.");
      if (!maintenance) throw new Error("Deployment recovery maintenance barrier is missing.");
      const journal: Journal = { roots: [], users: [], workspaces: [], connectors: {}, key: hex(crypto.getRandomValues(new Uint8Array(32)).buffer) };
      await storage.put(journalKey(run), journal);
      await phase(run, "maintenance-drain");
      await maintenance.begin(run);
      if (env.BETTER_AUTH_ENABLED === "true" && !env.AUTH_DB) throw new Error("Authentication recovery database is missing.");
      await phase(run, "release-escrow");
      const release = await readRecoveryRelease(env);
      for (const root of roots()) {
        await phase(run, "root-fence", root.id);
        journal.roots.push(root.id); await storage.put(journalKey(run), journal);
        await acquireNative(() => roots().find(entry => entry.id === root.id)!.object.beginRecovery(run, journal.key));
      }
      const validations: Array<() => Promise<void>> = []; checks.set(run, validations);
      const sources: RecoverySource[] = [];
      // Baselines precede discovery, so new identities, workspaces or stored objects cannot be omitted.
      for (const source of stores()) {
        await phase(run, "storage-baseline", source.id);
        const before = await digest(await source.export());
        validations.push(async () => { if (await digest(await source.export()) !== before) throw new Error(`${source.id} changed during recovery capture.`); });
        sources.push(verifiedSource(source, before));
      }
      const rootEntries = roots();
      for (const root of rootEntries) {
        const before = await digest(new Response(nativeContent(await root.object.getRecoverySnapshot())).body!);
        validations.push(async () => { if (await digest(new Response(nativeContent(await root.object.getRecoverySnapshot())).body!) !== before) throw new Error(`${root.id} changed during recovery capture.`); });
      }
      const nativeUserNames = new Map<string, string>();
      const rememberUserName = (name: string) => {
        const id = exports.UserDurableObject.idFromName(name).toString();
        nativeUserNames.set(name, id); return id;
      };
      const ids = new Set((await exports.UserDirectoryDurableObject.getByName("").getRecoveryInventory()).map(rememberUserName));
      if (env.AUTH_DB) {
        const rows = (await env.AUTH_DB.prepare("SELECT workshopId FROM user WHERE workshopId IS NOT NULL").all<{ workshopId: string }>()).results;
        for (const row of rows) ids.add(rememberUserName(row.workshopId));
      }
      const accounts = new Map<string, Set<string>>();
      const accountDescriptors = new Map<string, GatekeeperRecoveryDescriptor>();
      const accountRecords: Awaited<ReturnType<ReturnType<typeof user>["getRecoveryInventory"]>>["accounts"] = [];
      for (const id of ids) {
        await phase(run, "user-fence", id);
        journal.users.push(id); await storage.put(journalKey(run), journal); await acquireNative(() => user(id).beginRecovery(run, journal.key));
        const inventory = await user(id).getRecoveryInventory();
        for (const workspaceId of inventory.workspaceIds) if (!journal.workspaces.includes(workspaceId)) journal.workspaces.push(workspaceId);
        accountRecords.push(...inventory.accounts);
      }
      await storage.put(journalKey(run), journal);
      // Acquire EVERY workspace before inspecting a single stored application capability.
      for (const id of journal.workspaces) {
        await phase(run, "workspace-fence", id);
        await acquireNative(() => workspace(id).beginRecovery(run, journal.key));
        const ownerId = (await workspace(id).getRecoveryInventory()).ownerId;
        if (ownerId && !journal.users.includes(ownerId)) {
          journal.users.push(ownerId); await storage.put(journalKey(run), journal);
          await acquireNative(() => user(ownerId).beginRecovery(run, journal.key));
          const inventory = await user(ownerId).getRecoveryInventory();
          accountRecords.push(...inventory.accounts);
          for (const workspaceId of inventory.workspaceIds) if (!journal.workspaces.includes(workspaceId)) journal.workspaces.push(workspaceId);
          await storage.put(journalKey(run), journal);
        }
      }
      for (const account of accountRecords) {
        if (!vendors.has(account.vendorId)) throw new Error(`Retained account connector ${account.vendorId} is no longer installed; recovery adapter required.`);
        const known = accounts.get(account.vendorId) ?? new Set<string>();
        if (typeof account.account.getRecoveryDescriptor !== "function") throw new Error("Connector account has no recovery descriptor.");
        const descriptor = await verifyCapabilityDescriptor(env.BACKUP_CAPABILITY_KEY,
          await account.account.getRecoveryDescriptor()) as GatekeeperRecoveryDescriptor;
        const expectedKind = account.vendorId === "scheduler" ? "schedule-account" : `${account.vendorId}-account`;
        if (descriptor.kind !== expectedKind || typeof descriptor.props?.accountId !== "string") throw new Error("Connector account lacks an authenticated account identity.");
        const accountKey = `${account.vendorId}/${descriptor.props.accountId}`;
        const existing = accountDescriptors.get(accountKey);
        if (existing && JSON.stringify(existing) !== JSON.stringify(descriptor)) throw new Error("Connector account has conflicting recovery scopes.");
        accountDescriptors.set(accountKey, descriptor);
        known.add(descriptor.props.accountId); accounts.set(account.vendorId, known);
      }
      const captureInventory: CaptureInventory = { workspaces: new Set(journal.workspaces), accounts: accountDescriptors, vendors: new Set(vendors.keys()) };
      for (const id of vendors.keys()) {
        await phase(run, "connector-fence", id);
        const adapter = await participant(id); const accountIds = [...(accounts.get(id) ?? [])].toSorted();
        journal.connectors[id] = accountIds; await storage.put(journalKey(run), journal);
        await adapter.beginRecovery(accountIds, run);
        validations.push(() => adapter.validateRecovery(accountIds, run));
        sources.push(textSource(`connector-${safe(id)}--domain`, () => adapter.exportDomain()));
        for (const accountId of accountIds) sources.push(textSource(`connector-${safe(id)}--${safe(accountId)}`, async () => {
          const snapshot = await adapter.exportAccount(accountId);
          const expected = accountDescriptors.get(`${id}/${accountId}`)!;
          if (id === "scheduler") {
            const archived = JSON.parse(snapshot);
            if (typeof archived.rows !== "string") throw new Error("Scheduler recovery snapshot is invalid.");
            await assertCaptureReferences(JSON.parse(archived.rows), captureInventory);
          }
          if (expected.kind === "context-account" && JSON.parse(snapshot).sharingDomain !== expected.props.sharingDomain) {
            throw new Error("Context account recovery scope differs from its authenticated capability.");
          }
          return snapshot;
        }));
      }
      const service = captureService(journal.key, captureInventory);
      for (const id of journal.workspaces) await workspace(id).prepareRecovery(service);
      const nativeEntries = [...rootEntries, ...journal.users.map(id => ({ id: `user-${id}`, object: user(id) })),
        ...journal.workspaces.map(id => ({ id: `workspace-${id}`, object: workspace(id) }))];
      const blueprintLinks = new Map<string, { ownerId: string; record: BlueprintKvRecord }>();
      let adminConfig: AdminConfig | undefined;
      for (const entry of nativeEntries) {
        await phase(run, "native-baseline", entry.id);
        const baseline = await entry.object.getRecoverySnapshot(service);
        await assertCaptureReferences(JSON.parse(baseline), captureInventory);
        const before = await digest(new Response(nativeContent(baseline)).body!);
        if (entry.id === "root-admin" || entry.id.startsWith("user-")) {
          const contents = await decodePortableValue(JSON.parse(baseline).storage.values,
            { describe() { return undefined; }, restore(descriptor) { return descriptor; } }) as { kv: Map<string, unknown> };
          if (!(contents.kv instanceof Map)) throw new Error("Native recovery storage inventory is invalid.");
          if (entry.id === "root-admin") adminConfig = normalizeAdminConfig((contents.kv.get("adminConfig") ?? {}) as Partial<AdminConfig>);
          else {
            const profile = contents.kv.get("profile") as { id?: string } | undefined;
            if (typeof profile?.id === "string") nativeUserNames.set(profile.id, entry.id.slice("user-".length));
          }
          if (entry.id.startsWith("user-")) for (const [key, value] of contents.kv) {
            if (!key.startsWith("blueprints:")) continue;
            const record = value as BlueprintKvRecord;
            if (!record?.metadata) throw new Error("Native blueprint record is invalid.");
            blueprintLinks.set(key.slice("blueprints:".length), { ownerId: entry.id.slice("user-".length), record });
          }
        }
        const read = async () => {
          const snapshot = await entry.object.getRecoverySnapshot(service);
          if (await digest(new Response(nativeContent(snapshot)).body!) !== before) throw new Error(`${entry.id} changed during recovery capture.`);
          return snapshot;
        };
        validations.push(async () => { await read(); });
        sources.push(textSource(entry.id, read));
      }
      const validateLinks = async () => {
        const seen = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
        do {
          const page = await env.BLUEPRINTS.list({ cursor, limit: 100 });
          for (const key of page.keys) {
            if (isReservedBlueprintKey(key.name)) continue;
            const raw = await env.BLUEPRINTS.get(key.name);
            if (!raw) throw new Error("Blueprint metadata disappeared during recovery.");
            const record: BlueprintKvRecord = JSON.parse(raw);
            if (!record.metadata || !Number.isSafeInteger(record.metadata.version) || record.metadata.version < 0 ||
                !await env.BLUEPRINT_CONTENT.head(`${key.name}/${record.metadata.version}`)) throw new Error("Blueprint metadata references missing recovery content.");
            if (record.metadata.screenshot && !await env.BLUEPRINT_CONTENT.head(`${BLUEPRINT_SCREENSHOT_R2_PREFIX}${key.name}`)) throw new Error("Blueprint metadata references a missing screenshot.");
            const authoritative = blueprintLinks.get(key.name);
            if (authoritative && (record.ownerId !== authoritative.ownerId ||
                JSON.stringify(record.metadata) !== JSON.stringify(authoritative.record.metadata) || record.gadgetId !== authoritative.record.gadgetId)) {
              throw new Error("Blueprint KV metadata differs from its authoritative frozen owner record.");
            }
            seen.add(key.name);
          }
          cursor = page.list_complete ? undefined : page.cursor;
          if (!page.list_complete && (!cursor || cursors.has(cursor))) throw new Error("Blueprint recovery pagination did not advance.");
          if (cursor) cursors.add(cursor);
        } while (cursor !== undefined);
        if ([...blueprintLinks.keys()].some(id => !seen.has(id))) throw new Error("An owned blueprint is missing from the recovery KV inventory.");
        if (adminConfig) {
          const raw = await env.BLUEPRINTS.get(ADMIN_CONFIG_KEY);
          if (JSON.stringify(normalizeAdminConfig(raw ? JSON.parse(raw) : {})) !== JSON.stringify(adminConfig)) throw new Error("Admin KV configuration differs from its authoritative frozen record.");
          if (adminConfig.formats.some(format => !seen.has(format.blueprintId))) throw new Error("Admin formats reference missing blueprint recovery content.");
          if (adminConfig.siteLogoConfigured && !await env.BLUEPRINT_CONTENT.head(SITE_LOGO_R2_KEY)) throw new Error("Admin configuration references a missing site logo.");
        }
      };
      await phase(run, "linked-record-validation");
      await validateLinks(); validations.push(validateLinks);
      const configuration = Object.fromEntries(Object.entries(env).filter(([name, value]) => !name.startsWith("BACKUP_") &&
        (typeof value === "string" || name === "ADMINS" && Array.isArray(value))));
      sources.push(textSource("configuration", async () => JSON.stringify({ version: 1, values: configuration, nativeUserNames: [...nativeUserNames] })));
      const control = await storage.get<{ schedule: Record<string, unknown>; runs: Array<{ status: string }> }>("backups");
      sources.push(textSource("backup-control", async () => JSON.stringify({ version: 1,
        schedule: control?.schedule ?? null, runs: control?.runs.filter(entry => entry.status !== "running") ?? [],
        sessionPolicy: "Existing sessions, pending login attempts and handoffs are invalidated during restore." })));
      sources.push(textSource("release-manifest", async () => release.manifest));
      sources.push(verifiedSource({ id: "release-artifact", version: 1, async export() {
        const artifact = await env.BACKUPS!.get(release.key); if (!artifact) throw new Error("Release artifact disappeared."); return artifact.body;
      } }, release.sha256));
      validations.push(async () => { const current = await readRecoveryRelease(env); if (current.manifest !== release.manifest) throw new Error("Deployment release changed during recovery capture."); });
      return { sources: sources.map(source => ({ ...source, async export() {
        await phase(run, "component-capture", source.id); return source.export();
      } })), required: sources.map(source => source.id), capturedAt: new Date().toISOString() };
    },
    async release(run) {
      const journal = await storage.get<Journal>(journalKey(safe(run)));
      if (!journal) { await maintenance?.end(run); return; }
      const failures: unknown[] = [];
      for (const [id, accounts] of Object.entries(journal.connectors)) try { await (await participant(id)).endRecovery(accounts, run); } catch (error) { failures.push(error); }
      for (const id of journal.workspaces) try { await workspace(id).endRecovery(run); } catch (error) { failures.push(error); }
      for (const id of journal.users) try { await user(id).endRecovery(run); } catch (error) { failures.push(error); }
      for (const id of journal.roots ?? []) try { await roots().find(root => root.id === id)!.object.endRecovery(run); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Recovery fences could not all be released; journal retained.");
      await maintenance?.end(run);
      await storage.delete(journalKey(run)); checks.delete(run);
    },
    async validate(run) {
      const validations = checks.get(run); if (!validations) throw new Error("Recovery capture validation state was lost; retry capture.");
      await phase(run, "final-source-validation");
      for (const check of validations) await check();
    },
    preview,
    async targets(run, required) {
      const result = await preview(run, required); if (result.issues.length) throw new Error(result.issues.join(" "));
      await storage.put(`recovery-provider/staged/${run}`, { allocatedAt: Date.now(), required });
      const scope = `recovery-${safe(run)}`;
      const service = new NativeRecoveryService({
        async describe(value, path) {
          const encoded = await captureService("0".repeat(64)).describe(value, path);
          if (encoded === null) return undefined;
          const descriptor = JSON.parse(encoded);
          // Normalize only the comparison descriptor; restored authority retains its isolated scope.
          if (descriptor.kind?.startsWith("context-") && typeof descriptor.props?.sharingDomain === "string") {
            const prefix = `recovery:${scope}:`;
            if (!descriptor.props.sharingDomain.startsWith(prefix)) throw new Error("Restored context capability escaped its isolated scope.");
            descriptor.props.sharingDomain = descriptor.props.sharingDomain.slice(prefix.length);
          }
          if (descriptor.kind?.startsWith("schedule-") && typeof descriptor.props?.accountId === "string") {
            const prefix = `recovery:${scope}:`;
            if (!descriptor.props.accountId.startsWith(prefix)) throw new Error("Restored scheduler capability escaped its isolated scope.");
            descriptor.props.accountId = descriptor.props.accountId.slice(prefix.length);
          }
          return descriptor;
        },
        async restore(value) {
          if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.kind !== "string") throw new Error("Invalid capability recovery descriptor.");
          let descriptor = value;
          if (descriptor.kind === "native-class") {
            if (typeof descriptor.value !== "string") throw new Error("Invalid native class recovery descriptor.");
            descriptor = await decodePortableValue(JSON.parse(descriptor.value), { describe() { return undefined; }, restore: async value => service.restore(JSON.stringify(value)) }) as typeof descriptor;
          }
          const kind = descriptor.kind;
          if (typeof kind !== "string") throw new Error("Invalid capability recovery kind.");
          if (kind.startsWith("context-") || kind.startsWith("schedule-")) {
            return (await participant(kind.startsWith("context-") ? "context" : "scheduler")).restoreCapability(descriptor as GatekeeperRecoveryDescriptor, scope);
          }
          return exports.NativeRecoveryObject.getByName(`${scope}-capabilities`).resolveRecoveryCapability(JSON.stringify(descriptor), env.BACKUP_CAPABILITY_KEY!);
        },
      });
      class HookResolver extends RpcTarget implements GatekeeperRecoveryResolver {
        async restoreHook(descriptor: GatekeeperRecoveryDescriptor) {
          if (descriptor.kind !== "workshop-hook" || typeof descriptor.props.overseerId !== "string" || !Number.isSafeInteger(descriptor.props.hookId)) throw new Error("Invalid recovered schedule callback.");
          return exports.NativeRecoveryHook({ props: { scope, overseerId: descriptor.props.overseerId, hookId: descriptor.props.hookId as number } });
        }
      }
      const resolver = new HookResolver();
      const targets: RecoveryTarget[] = [];
      for (const id of required) {
        safe(id);
        if (id === "kv-blueprints") targets.push(kvRecoveryTarget(id, env.BLUEPRINTS_RESTORE!));
        else if (id === "kv-avatars") targets.push(kvRecoveryTarget(id, env.AVATARS_RESTORE!));
        else if (id === "d1-auth") targets.push({ id, version: 1, async stage(stream) {
          await d1RecoveryTarget(id, env.AUTH_DB_RESTORE!).stage(stream);
          const tables = (await env.AUTH_DB_RESTORE!.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('session','verification')").all<{ name: string }>()).results;
          if (tables.length) await env.AUTH_DB_RESTORE!.batch(tables.map(table => env.AUTH_DB_RESTORE!.prepare(`DELETE FROM "${table.name}"`)));
        } });
        else if (id === "r2-blueprints") targets.push(r2RecoveryTarget(id, env.BACKUP_RESTORE!));
        else if (/^(root-|user-|workspace-)/.test(id)) targets.push({ id, version: 1, async stage(stream) {
          const snapshot = await boundedText(stream);
          const target = exports.NativeRecoveryObject.getByName(`${scope}-${id}`);
          await target.stageRecoverySnapshot(snapshot, service);
          const restored: NativeRecoverySnapshot = JSON.parse(await target.getRecoverySnapshot(service));
          const original: NativeRecoverySnapshot = JSON.parse(snapshot);
          if (canonicalJson(restored.storage) !== canonicalJson(original.storage) || canonicalJson(restored.facets) !== canonicalJson(original.facets)) {
            throw new Error(`Native restored storage verification failed for ${id}.`);
          }
          if (id.startsWith("user-")) await target.invalidateRecoverySessions();
        } });
        else if (id.startsWith("connector-")) {
          const [vendor, account] = id.slice("connector-".length).split("--");
          const adapter = await participant(vendor!);
          targets.push({ id, version: 1, async stage(stream) { const snapshot = await boundedText(stream);
            if (account === "domain") await adapter.restoreDomain(snapshot, scope); else await adapter.restoreAccount(snapshot, scope, resolver);
          } });
        } else if (["configuration", "backup-control", "release-manifest", "release-artifact"].includes(id)) {
          targets.push({ id, version: 1, async stage(stream) {
            const key = `recovery-material/${run}/${id}`;
            if (id === "release-artifact") {
              const manifestObject = await env.BACKUP_RESTORE!.get(`recovery-material/${run}/release-manifest`);
              if (!manifestObject) throw new Error("Release manifest must be staged before artifact.");
              const manifest = JSON.parse(await manifestObject.text());
              if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes < 16 || manifest.bytes > 96 * 1024 * 1024) throw new Error("Invalid recovered release size.");
              const fixed = new FixedLengthStream(manifest.bytes);
              const abort = new AbortController();
              try {
                await Promise.all([
                  env.BACKUP_RESTORE!.put(key, fixed.readable, { onlyIf: { etagDoesNotMatch: "*" } }).then(stored => {
                    if (!stored) throw new Error("Recovery material target is occupied.");
                  }),
                  stream.pipeTo(fixed.writable, { signal: abort.signal }),
                ]);
              } catch (error) { abort.abort(error); throw error; }
            } else {
              let material = await boundedText(stream);
              if (id === "backup-control") {
                const control = JSON.parse(material);
                if (control.schedule) control.schedule.enabled = false;
                control.nextRunAt = null;
                material = JSON.stringify(control);
              }
              if (!await env.BACKUP_RESTORE!.put(key, material, { onlyIf: { etagDoesNotMatch: "*" } })) throw new Error("Recovery material target is occupied.");
            }
          } });
        } else throw new Error(`Unknown recovery component: ${id}`);
      }
      const state = { required: [...required], staged: new Set<string>(), service };
      restoreRuns.set(run, state);
      return targets.map(target => ({ ...target, async stage(stream: ReadableStream<Uint8Array>) {
        if (state.staged.has(target.id)) throw new Error("Recovery component was already staged.");
        await phase(run, "restore-component", target.id);
        await target.stage(stream);
        state.staged.add(target.id);
      } }));
    },
    async getRestoredWorkspaceTarget(run, workspaceId) {
      safe(run);
      if (!/^[a-f0-9]{64}$/.test(workspaceId)) throw new Error("Invalid restored workspace identifier.");
      const sourceId = `workspace-${workspaceId}`;
      const receipt = await storage.get<{ required: string[]; verifiedAt?: number; verification?: Array<{ sourceId: string }> }>(`recovery-provider/staged/${run}`);
      if (!receipt?.verifiedAt || !receipt.required.includes(sourceId) || !receipt.verification?.some(entry => entry.sourceId === sourceId)) {
        throw new Error("Workspace is not part of a verified isolated recovery runtime.");
      }
      return `recovery-${run}-${sourceId}`;
    },
    async finalizeRestore(run, required) {
      const state = restoreRuns.get(run);
      if (!state || JSON.stringify(state.required) !== JSON.stringify(required) ||
          required.some(id => !state.staged.has(id))) throw new Error("Every recovery component must be staged before isolated runtime activation.");
      const scope = `recovery-${safe(run)}`;
      const native = required.filter(id => /^(root-|user-|workspace-)/.test(id));
      if (native.length) {
        const manifestObject = await env.BACKUP_RESTORE!.get(`recovery-material/${run}/release-manifest`);
        const manifest = manifestObject ? JSON.parse(await manifestObject.text()) : undefined;
        if (!env.BACKUP_RELEASE_ID || manifest?.releaseId !== env.BACKUP_RELEASE_ID) {
          throw new Error("Recovered data and escrow remain inactive. Deploy the backup's matching escrowed release before activating its runtime.");
        }
      }
      const namedIds: RecoveryNamedIds = Object.create(null);
      const addName = (namespace: string, name: string, originalId: string) => {
        if (!/^[a-f0-9]{64}$/.test(originalId)) throw new Error("Invalid archived native routing identity.");
        const names = namedIds[namespace] ??= Object.create(null);
        if (Object.hasOwn(names, name) && names[name] !== originalId) throw new Error("Conflicting archived native routing identities.");
        Object.defineProperty(names, name, { value: originalId, configurable: true, enumerable: true });
      };
      for (const id of native) {
        const identity = await exports.NativeRecoveryObject.getByName(`${scope}-${id}`).getRecoveryRoutingIdentity(id);
        if (identity) addName(identity.namespace, identity.name, identity.originalId);
      }
      if (native.length && required.includes("configuration")) {
        const object = await env.BACKUP_RESTORE!.get(`recovery-material/${run}/configuration`);
        if (!object) throw new Error("Archived native routing configuration is missing.");
        const config = JSON.parse(await object.text());
        if (!Array.isArray(config.nativeUserNames)) throw new Error("Archived native name inventory is missing.");
        for (const entry of config.nativeUserNames) {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string" || !required.includes(`user-${entry[1]}`)) throw new Error("Archived native name points outside the recovery inventory.");
          addName("UserDurableObject", entry[0], entry[1]);
        }
      }
      // Build the complete isolated graph before exposing any original application class.
      for (const id of native) {
        await phase(run, "restore-runtime-prepare", id);
        await exports.NativeRecoveryObject.getByName(`${scope}-${id}`).prepareRecoveryRuntime(id, scope, state.service, JSON.stringify(namedIds));
      }
      for (const id of native) {
        await phase(run, "restore-runtime-activate", id);
        await exports.NativeRecoveryObject.getByName(`${scope}-${id}`).activateRecoveryRuntime();
      }
      const verification: Array<{ sourceId: string; kind: string }> = [];
      for (const id of native) {
        await phase(run, "restore-runtime-verify", id);
        const result = await exports.NativeRecoveryObject.getByName(`${scope}-${id}`).verifyRecoveryRuntime();
        if (result.sourceId !== id) throw new Error("Isolated runtime identity does not match its recovery source.");
        verification.push({ sourceId: result.sourceId, kind: result.kind });
      }
      await storage.put(`recovery-provider/staged/${run}`, { required, verifiedAt: Date.now(), verification });
      restoreRuns.delete(run);
    },
  };
}
