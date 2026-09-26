import { describe, expect, it, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import type { UserDirectoryDurableObject } from "../src/user-directory";
declare module "cloudflare:workers" { interface ProvidedEnv { TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject> } }
import { createDeploymentRecovery, readRecoveryRelease } from "../src/deployment-recovery";
import { encodePortableValue } from "@gadgets/backend-utils/recovery-value";
import { sealCapabilityDescriptor } from "@gadgets/backend-utils/recovery-capability";

const publicKey = { kty: "RSA", n: "test-modulus", e: "AQAB" };
const authenticationKey = btoa("a".repeat(32));
const capabilityKey = btoa("c".repeat(32));
const userId = "a".repeat(64), workspaceId = "b".repeat(64);
const bytes = new Uint8Array(32).fill(7);
const hex = (value: ArrayBuffer) => [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, "0")).join("");
async function releaseManifest() {
  const manifest = { version: 1, releaseId: "release.test", bytes: bytes.length,
    sha256: hex(await crypto.subtle.digest("SHA-256", bytes)), keyEnvelope: { version: 1,
      algorithm: "RSA-OAEP-256/A256GCM", keyId: hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["RSA", publicKey.n, publicKey.e])))), wrappedKey: btoa("w".repeat(384)) },
    nonce: btoa("n".repeat(12)), authentication: "" };
  const payload = JSON.stringify([1, manifest.releaseId, manifest.bytes, manifest.sha256, manifest.keyEnvelope.version,
    manifest.keyEnvelope.algorithm, manifest.keyEnvelope.keyId, manifest.keyEnvelope.wrappedKey, manifest.nonce]);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("a".repeat(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  manifest.authentication = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)))));
  return manifest;
}
async function fixture() {
  const manifest = await releaseManifest();
  const objects = new Map<string, Uint8Array>([["release/current.json", new TextEncoder().encode(JSON.stringify(manifest))], ["release/release.test/artifact.bin", bytes]]);
  const bucket = { async get(key: string) { const value = objects.get(key); return value && { size: value.length,
    body: new Response(value).body!, text: () => new Response(value).text() }; } };
  const values = new Map<string, unknown>();
  const storage = { get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => values.delete(key) } as DurableObjectStorage;
  const events: string[] = [];
  const maintenance = { begin: vi.fn(async () => { events.push("begin-maintenance"); }), end: vi.fn(async () => { events.push("end-maintenance"); }) };
  let revision = 1;
  const root = () => ({ getRecoverySnapshot: async () => JSON.stringify({ id: "c".repeat(64), storage: { version: 1, values: await encodePortableValue({ kv: new Map([["revision", revision]]), schema: [], tables: [], sequences: [] }), alarm: null }, facets: [], bookmark: crypto.randomUUID() }),
    getRecoveryBookmark: async () => "revision", beginRecovery: async () => {}, endRecovery: async () => {} });
  const account = { getRecoveryDescriptor: async () => { events.push("describe-account"); return sealCapabilityDescriptor(capabilityKey,
    { kind: "context-account", props: { accountId: "account1", sharingDomain: "domain" } }); } };
  const user = { ...root(), beginRecovery: vi.fn(async () => { events.push("begin-user"); }), endRecovery: vi.fn(async () => { events.push("end-user"); }),
    getRecoveryInventory: async () => ({ workspaceIds: [workspaceId], accounts: [{ vendorId: "context", accountId: "record-id", account }] }) };
  const workspace = { ...root(), beginRecovery: vi.fn(async () => { events.push("begin-workspace"); }), endRecovery: vi.fn(async () => { events.push("end-workspace"); }),
    prepareRecovery: vi.fn(async () => {}), getRecoveryInventory: async () => ({ ownerId: userId }) };
  const directory = { ...root(), getRecoveryInventory: async () => ["owner@example.test"] };
  const exports = { UserDirectoryDurableObject: { getByName: () => directory }, AdminSettings: { getByName: root }, IdentityDirectory: { getByName: root },
    UserDurableObject: { get: () => user, idFromString: (id: string) => id, idFromName: () => ({ toString: () => userId }) },
    OverseerDurableObject: { get: () => workspace, idFromString: (id: string) => id } } as unknown as Cloudflare.Exports;
  const participant = { beginRecovery: vi.fn(async () => {}), endRecovery: vi.fn(async () => {}), validateRecovery: vi.fn(async () => {}),
    exportAccount: async () => JSON.stringify({ id: "account1", sharingDomain: "domain" }), exportDomain: async () => JSON.stringify({ domain: "domain" }) };
  const emptyKv = { list: async () => ({ keys: [], list_complete: true }), get: async () => null };
  const emptyR2 = { list: async () => ({ objects: [], truncated: false }) };
  const env = { BACKUP_RELEASE_ID: "release.test", BACKUP_PUBLIC_KEY: JSON.stringify(publicKey), BACKUPS: bucket, BACKUP_AUTHENTICATION_KEY: authenticationKey, BACKUP_CAPABILITY_KEY: capabilityKey,
    BLUEPRINTS: emptyKv, AVATARS: emptyKv, BLUEPRINT_CONTENT: emptyR2,
    GATEKEEPER_CONTEXT: { getRecoveryParticipant: async () => participant } } as unknown as Parameters<typeof createDeploymentRecovery>[0];
  return { env, exports, storage, maintenance, values, events, user, workspace, participant, manifest, objects, changeRoot: () => { revision++; } };
}

describe("deployment release escrow authentication", () => {
  it("authenticates metadata and streamed artifact bytes", async () => {
    const f = await fixture(); const result = await readRecoveryRelease(f.env);
    expect(result.key).toBe("release/release.test/artifact.bin");
    expect(result.sha256).toBe(f.manifest.sha256);
  });
  it("rejects valid escrow for a different deployed release or recovery key", async () => {
    const f = await fixture(); f.env.BACKUP_RELEASE_ID = "newer-release";
    await expect(readRecoveryRelease(f.env)).rejects.toThrow("does not match the deployed release");
    f.env.BACKUP_RELEASE_ID = "release.test";
    f.env.BACKUP_PUBLIC_KEY = JSON.stringify({ ...publicKey, n: "different-modulus" });
    await expect(readRecoveryRelease(f.env)).rejects.toThrow("different recovery key");
  });
  it("rejects a forged manifest before accepting its release", async () => {
    const f = await fixture(); f.manifest.releaseId = "attacker";
    f.objects.set("release/current.json", new TextEncoder().encode(JSON.stringify(f.manifest)));
    await expect(readRecoveryRelease(f.env)).rejects.toThrow("authentication failed");
  });
  it("rejects a replaced artifact even when its size matches", async () => {
    const f = await fixture(); f.objects.set("release/release.test/artifact.bin", new Uint8Array(32));
    await expect(readRecoveryRelease(f.env)).rejects.toThrow("missing or corrupt");
  });
});

describe("complete deployment inventory and cleanup", () => {
  it("fences all workspaces before inspecting accounts and captures every known component", async () => {
    const f = await fixture(); const recovery = createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance);
    const result = await recovery.acquire("capture1");
    expect(f.events[0]).toBe("begin-maintenance");
    expect(f.events.indexOf("begin-workspace")).toBeLessThan(f.events.indexOf("describe-account"));
    expect(result.required).toEqual(expect.arrayContaining(["root-admin", "root-users", "root-identities", `user-${userId}`, `workspace-${workspaceId}`,
      "connector-context--domain", "connector-context--account1", "kv-blueprints", "kv-avatars", "r2-blueprints", "configuration", "backup-control", "release-manifest", "release-artifact"]));
    await recovery.validate("capture1");
    f.changeRoot(); await expect(recovery.validate("capture1")).rejects.toThrow("changed during recovery");
  });
  it("includes authentication users missing from the directory", async () => {
    const f = await fixture(); const database = (testEnv as typeof testEnv & { AUTH_DB: D1Database }).AUTH_DB;
    await database.prepare("CREATE TABLE user (workshopId TEXT)").run();
    await database.prepare("INSERT INTO user VALUES ('auth-only')").run();
    f.env.AUTH_DB = database;
    const extraId = "d".repeat(64);
    vi.spyOn(f.exports.UserDurableObject, "idFromName").mockImplementation(name => ({ toString: () => name === "auth-only" ? extraId : userId }) as DurableObjectId);
    const provider = createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance);
    const result = await provider.acquire("auth-inventory");
    expect(result.required).toContain(`user-${extraId}`); expect(result.required).toContain("d1-auth");
    await provider.release("auth-inventory");
    await database.prepare("DROP TABLE user").run();
  });
  it("rejects connector snapshot from a different authenticated sharing domain", async () => {
    const f = await fixture(); f.participant.exportAccount = async () => JSON.stringify({ id: "account1", sharingDomain: "another-domain" });
    const result = await createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance).acquire("wrong-domain");
    await expect(result.sources.find(source => source.id === "connector-context--account1")!.export()).rejects.toThrow("differs from its authenticated capability");
  });
  it("releases partially acquired fences after provider restart", async () => {
    const f = await fixture(); f.workspace.beginRecovery.mockRejectedValue(new Error("workspace busy"));
    const recovery = createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance);
    await expect(recovery.acquire("capture2")).rejects.toThrow("workspace busy");
    await createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance).release("capture2");
    expect(f.user.endRecovery).toHaveBeenCalledWith("capture2");
    expect(f.workspace.endRecovery).toHaveBeenCalledWith("capture2");
    expect(f.values.has("recovery-provider/capture2")).toBe(false);
    expect(f.events.at(-1)).toBe("end-maintenance");
  });
  it("retains journal until every fence release succeeds", async () => {
    const f = await fixture(); const recovery = createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance);
    await recovery.acquire("capture3"); f.user.endRecovery.mockRejectedValueOnce(new Error("temporary outage"));
    await expect(recovery.release("capture3")).rejects.toThrow("journal retained");
    expect(f.values.has("recovery-provider/capture3")).toBe(true);
    expect(f.maintenance.end).not.toHaveBeenCalled();
    await createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance).release("capture3");
    expect(f.values.has("recovery-provider/capture3")).toBe(false);
  });
  it("fails coverage for every installed connector without an adapter", async () => {
    const f = await fixture(); Object.assign(f.env, { GATEKEEPER_UNKNOWN: {} });
    const rows = await createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance).coverage();
    expect(rows.find(row => row.id === "connector-unknown")?.ready).toBe(false);
  });
  it("refuses restore targets bound to production storage", async () => {
    const f = await fixture(); f.env.BACKUP_RESTORE = f.env.BLUEPRINT_CONTENT;
    const preview = await createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance).preview("restore1", ["r2-blueprints"]);
    expect(preview.issues).toContain("Recovery targets must differ from production bindings.");
  });
});


describe("inactive provider targets with real Cloudflare storage", () => {
  it("stages release bytes and disabled schedule in isolated R2 and refuses occupied retry", async () => {
    const f = await fixture();
    const bucket = (testEnv as typeof testEnv & { BACKUPS: R2Bucket }).BACKUPS;
    for (const object of (await bucket.list()).objects) await bucket.delete(object.key);
    f.env.BACKUP_RESTORE = bucket;
    const required = ["configuration", "backup-control", "release-manifest", "release-artifact"];
    const provider = createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance);
    const targets = await provider.targets("restore-material", required);
    const data = [JSON.stringify({ version: 1, values: { APP_SECRET: "restored-secret" } }),
      JSON.stringify({ version: 1, schedule: { enabled: true }, runs: [{ id: "prior", status: "complete" }] }), JSON.stringify(f.manifest), bytes];
    await expect(provider.finalizeRestore("restore-material", required)).rejects.toThrow("Every recovery component must be staged");
    for (const [index, target] of targets.entries()) await target.stage(new Response(data[index]).body!);
    await provider.finalizeRestore("restore-material", required);
    expect(new Uint8Array(await (await bucket.get("recovery-material/restore-material/release-artifact"))!.arrayBuffer())).toEqual(bytes);
    const control = await (await bucket.get("recovery-material/restore-material/backup-control"))!.json<{ schedule: { enabled: boolean }; runs: unknown[]; nextRunAt: null }>();
    expect(control.schedule.enabled).toBe(false); expect(control.runs).toHaveLength(1); expect(control.nextRunAt).toBeNull();
    expect((await provider.preview("another-restore", required)).issues).toContain("Isolated recovery R2 target is occupied.");
    for (const object of (await bucket.list()).objects) await bucket.delete(object.key);
  });
  it("restores D1 application rows and invalidates restored login tokens", async () => {
    const f = await fixture();
    const database = (testEnv as typeof testEnv & { AUTH_DB: D1Database }).AUTH_DB;
    f.env.AUTH_DB_RESTORE = database;
    f.env.BACKUP_RESTORE = { list: async () => ({ objects: [], truncated: false }) } as unknown as R2Bucket;
    const provider = createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance);
    const [target] = await provider.targets("restore-database", ["d1-auth"]);
    const archive = { version: 1,
      schema: ["session", "verification", "user"].map(name => ({ type: "table", name, sql: `CREATE TABLE "${name}" (id TEXT PRIMARY KEY)` })),
      tables: ["session", "verification", "user"].map(name => ({ name, columns: ["id"], rows: [[`${name}-restored`]] })), sequences: [] };
    await target!.stage(new Response(JSON.stringify(archive)).body!);
    await provider.finalizeRestore("restore-database", ["d1-auth"]);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM "session"').first("count")).toBe(0);
    expect(await database.prepare('SELECT COUNT(*) AS count FROM "verification"').first("count")).toBe(0);
    expect(await database.prepare('SELECT id FROM "user"').first("id")).toBe("user-restored");
    for (const name of ["session", "verification", "user"]) await database.prepare(`DROP TABLE "${name}"`).run();
  });
});

it("prepares every isolated native root before activation and gates workspace access on verification", async () => {
  const f = await fixture(); const bucket = (testEnv as typeof testEnv & { BACKUPS: R2Bucket }).BACKUPS;
  for (const object of (await bucket.list()).objects) await bucket.delete(object.key);
  f.env.BACKUP_RESTORE = bucket;
  const calls: string[] = [];
  const targetsByName = new Map<string, object>();
  Object.assign(f.exports, { NativeRecoveryObject: { getByName(name: string) {
    let target = targetsByName.get(name);
    if (!target) {
      let snapshot = "", sourceId = "";
      target = { stageRecoverySnapshot: async (value: string) => { snapshot = value; }, getRecoverySnapshot: async () => snapshot,
        getRecoveryRoutingIdentity: async (id: string) => id === "root-admin" ? { namespace: "AdminSettings", name: "", originalId: "c".repeat(64) } : null,
        prepareRecoveryRuntime: async (id: string) => { sourceId = id; calls.push(`prepare:${id}`); },
        activateRecoveryRuntime: async () => { calls.push(`activate:${sourceId}`); },
        verifyRecoveryRuntime: async () => { calls.push(`verify:${sourceId}`); return { kind: "workspace", sourceId, summary: {} }; },
        openRecoveryWorkspace: async () => ({ restored: true }) };
      targetsByName.set(name, target);
    }
    return target;
  } } });
  const required = ["root-admin", `workspace-${workspaceId}`, "release-manifest", "release-artifact"];
  const provider = createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance);
  await expect(provider.getRestoredWorkspaceTarget("native-runtime", workspaceId)).rejects.toThrow("not part of a verified");
  const targets = await provider.targets("native-runtime", required);
  const nativeSnapshot = await f.exports.AdminSettings.getByName("").getRecoverySnapshot();
  const data = [nativeSnapshot, nativeSnapshot, JSON.stringify(f.manifest), bytes];
  for (const [index, target] of targets.entries()) await target.stage(new Response(data[index]).body!);
  await provider.finalizeRestore("native-runtime", required);
  expect(calls).toEqual(["prepare:root-admin", `prepare:workspace-${workspaceId}`, "activate:root-admin", `activate:workspace-${workspaceId}`,
    "verify:root-admin", `verify:workspace-${workspaceId}`]);
  expect(await provider.getRestoredWorkspaceTarget("native-runtime", workspaceId)).toBe(`recovery-native-runtime-workspace-${workspaceId}`);
  await expect(provider.getRestoredWorkspaceTarget("native-runtime", "e".repeat(64))).rejects.toThrow("not part of a verified");
  for (const object of (await bucket.list()).objects) await bucket.delete(object.key);
});

it("retains staged data and executable escrow without activating a mismatched release", async () => {
  const f = await fixture(); const bucket = (testEnv as typeof testEnv & { BACKUPS: R2Bucket }).BACKUPS;
  for (const object of (await bucket.list()).objects) await bucket.delete(object.key);
  f.env.BACKUP_RESTORE = bucket;
  let snapshot = "";
  const prepare = vi.fn();
  Object.assign(f.exports, { NativeRecoveryObject: { getByName: () => ({ stageRecoverySnapshot: async (value: string) => { snapshot = value; },
    getRecoverySnapshot: async () => snapshot, prepareRecoveryRuntime: prepare }) } });
  const required = ["root-admin", "release-manifest", "release-artifact"];
  const provider = createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance);
  const targets = await provider.targets("old-release", required);
  const nativeSnapshot = await f.exports.AdminSettings.getByName("").getRecoverySnapshot();
  const data = [nativeSnapshot, JSON.stringify({ ...f.manifest, releaseId: "older-release" }), bytes];
  for (const [index, target] of targets.entries()) await target.stage(new Response(data[index]).body!);
  await expect(provider.finalizeRestore("old-release", required)).rejects.toThrow("Deploy the backup's matching escrowed release");
  expect(prepare).not.toHaveBeenCalled();
  expect(await bucket.head("recovery-material/old-release/release-artifact")).not.toBeNull();
  for (const object of (await bucket.list()).objects) await bucket.delete(object.key);
});


it("normalizes real UserDirectory profile names using the source namespace", async () => {
  const f = await fixture();
  const directoryName = `provider-names-${crypto.randomUUID()}`;
  const directory = workerEnv.TEST_USER_DIRECTORY.getByName(directoryName);
  const name = "f".repeat(64); // A hex-shaped username is still a name, never a raw namespace ID.
  await directory.syncUser({ id: name, name: "Recovered User" }, 1);
  Object.assign(f.exports, { UserDirectoryDurableObject: { getByName: () => workerEnv.TEST_USER_DIRECTORY.getByName(directoryName) } });
  const lookup = vi.spyOn(f.exports.UserDurableObject, "idFromName");
  const provider = createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance);
  const result = await provider.acquire("directory-names");
  expect(lookup).toHaveBeenCalledWith(name);
  expect(result.required).toContain(`user-${userId}`);
  expect(result.required).not.toContain(`user-${name}`);
  const configuration = JSON.parse(await new Response(await result.sources.find(source => source.id === "configuration")!.export()).text());
  expect(configuration.nativeUserNames).toContainEqual([name, userId]);
  await provider.release("directory-names");
}, 30_000);

it("rejects an authenticated retained callback whose workspace was not fenced", async () => {
  const f = await fixture();
  const original = f.workspace.getRecoverySnapshot;
  Object.assign(f.workspace, { getRecoverySnapshot: async (service: { describe(value: object, path: string): Promise<unknown> }) => {
    await service.describe({ getRecoveryDescriptor: () => sealCapabilityDescriptor(capabilityKey,
      { kind: "workshop-hook", props: { overseerId: "e".repeat(64), hookId: 1 } }) }, "$callback");
    return original();
  } });
  const provider = createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance);
  await expect(provider.acquire("foreign-callback")).rejects.toThrow("outside the frozen recovery inventory");
  await provider.release("foreign-callback");
});

it("rejects observed blueprint metadata whose versioned R2 content is missing", async () => {
  const f = await fixture();
  const raw = JSON.stringify({ metadata: { version: 1 } });
  f.env.BLUEPRINTS = {
    list: async () => ({ keys: [{ name: "example-blueprint" }], list_complete: true }),
    get: async (key: string) => key === "example-blueprint" ? raw : null,
    getWithMetadata: async () => ({ value: new TextEncoder().encode(raw).buffer, metadata: null }),
  } as unknown as KVNamespace;
  Object.assign(f.env.BLUEPRINT_CONTENT, { head: async () => null });
  const provider = createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance);
  await expect(provider.acquire("missing-blueprint-content")).rejects.toThrow("references missing recovery content");
  await provider.release("missing-blueprint-content");
});

it("rejects a native class whose retained connector account is absent from capture", async () => {
  const f = await fixture();
  const marker = {};
  const descriptor = { kind: "native-class", value: JSON.stringify(await encodePortableValue({
    kind: "context-gatekeeper-class", props: { accountId: "disconnected-account", sharingDomain: "domain" },
  })) };
  Object.assign(f.workspace, { getRecoverySnapshot: async () => JSON.stringify({ id: workspaceId, bookmark: "irrelevant",
    facets: [], storage: { version: 1, alarm: null, values: await encodePortableValue({ kv: new Map([["class", marker]]), schema: [], tables: [], sequences: [] }, {
      describe(value) { return value === marker ? descriptor : undefined; }, restore(value) { return value; },
    }) } }) });
  const provider = createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance);
  await expect(provider.acquire("orphan-connector-class")).rejects.toThrow("account or domain outside the frozen recovery inventory");
  await provider.release("orphan-connector-class");
});

it.each([false, true])("compares restored connector descriptor values independently of property order (tampered=%s)", async tampered => {
  const f = await fixture();
  f.env.BACKUP_RESTORE = (testEnv as typeof testEnv & { BACKUPS: R2Bucket }).BACKUPS;
  const sourceAccount = {};
  // Context's real createAccount and restoreCapability construct props in opposite orders.
  const sourceDescriptor = { kind: "context-account", props: { sharingDomain: "domain", accountId: "account1" } };
  const snapshot = JSON.stringify({ id: userId, bookmark: "source", facets: [], storage: { version: 1, alarm: null,
    values: await encodePortableValue({ kv: new Map([["connectedAccounts:1", { account: sourceAccount }]]), schema: [], tables: [], sequences: [] }, {
      describe(value) { return value === sourceAccount ? sourceDescriptor : undefined; }, restore(value) { return value; },
    }),
  } });
  const run = `descriptor-order-${tampered}`;
  Object.assign(f.exports, { NativeRecoveryObject: { getByName: () => ({
    stageRecoverySnapshot: async () => {},
    async getRecoverySnapshot(service: { describe(value: object, path: string): Promise<string | null> }) {
      const result = JSON.parse(snapshot);
      const restoredAccount = { getRecoveryDescriptor: () => sealCapabilityDescriptor(capabilityKey, {
        kind: "context-account", props: { accountId: tampered ? "another-account" : "account1", sharingDomain: `recovery:recovery-${run}:domain` },
      }) };
      const node = result.storage.values.nodes.find((node: { kind: string }) => node.kind === "capability");
      node.descriptor = JSON.parse((await service.describe(restoredAccount, "$account"))!);
      return JSON.stringify(result);
    },
    invalidateRecoverySessions: async () => {},
  }) } });
  const provider = createDeploymentRecovery(f.env, f.exports, f.storage, f.maintenance);
  const targets = await provider.targets(run, [`user-${userId}`]);
  const stage = targets[0]!.stage(new Response(snapshot).body!);
  if (tampered) await expect(stage).rejects.toThrow("Native restored storage verification failed");
  else await expect(stage).resolves.toBeUndefined();
});
