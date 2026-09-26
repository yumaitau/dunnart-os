import { beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import type { DeploymentBackups } from "../src/deployment-backups";
import type { DeploymentRecovery } from "../src/deployment-backup-contract";
import { DEFAULT_BACKUP_SCHEDULE } from "../src/deployment-backup-schedule";

const testEnv = env as typeof env & { TEST_DEPLOYMENT_BACKUPS: DurableObjectNamespace<DeploymentBackups>; BACKUPS: R2Bucket };
let publicKey: JsonWebKey, privateKey: JsonWebKey, authenticationKey: CryptoKey;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 3072,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["wrapKey", "unwrapKey"]);
  if (!("publicKey" in pair)) throw new Error("Expected key pair");
  publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
  if ("publicKey" in key) throw new Error("Expected authentication key");
  authenticationKey = key;
});

async function fixture(patch: Partial<DeploymentRecovery> = {}) {
  const stub = testEnv.TEST_DEPLOYMENT_BACKUPS.getByName(crypto.randomUUID());
  const released = vi.fn(async () => {}), staged = new Map<string, string>();
  const recovery: DeploymentRecovery = {
    coverage: async () => [{ id: "app", title: "Application", ready: true }],
    acquire: async () => ({ required: ["app"], capturedAt: new Date().toISOString(), sources: [
      { id: "app", version: 1, export: async () => new Response("saved application state").body! },
    ] }),
    release: released, validate: async () => {},
    preview: async run => ({ target: `isolated-${run}`, issues: [] }),
    targets: async () => [{ id: "app", version: 1, stage: async stream => { staged.set("app", await new Response(stream).text()); } }],
    finalizeRestore: async () => {},
    getRestoredWorkspaceTarget: async () => { throw new Error("No workspace in this fixture"); },
    ...patch,
  };
  await runInDurableObject(stub, instance => {
    Reflect.set(instance, "recovery", recovery);
    Reflect.set(instance, "configuration", async () => ({ bucket: testEnv.BACKUPS, deployment: "test", publicKey, authenticationKey, recoveryKeyId: "fixture" }));
  });
  return { stub, released, staged };
}

describe("deployment backup coordinator", () => {
  it("persists the queued run before returning and completes only after verification", async () => {
    const { stub, released } = await fixture();
    const queued = await stub.startBackup();
    expect(queued.running).toBe(true);
    await runInDurableObject(stub, async (_instance, ctx) => {
      const saved = await ctx.storage.get<{ runs: Array<{ phase: string }> }>("backups");
      expect(saved?.runs[0].phase).toBe("queued");
    });
    await runDurableObjectAlarm(stub);
    const status = await stub.getBackupStatus();
    expect(status.runs[0]).toMatchObject({ status: "complete", components: 1, bytes: 23 });
    expect(status.runs[0].verifiedAt).toBeTypeOf("number");
    expect(released).toHaveBeenCalledWith(status.runs[0].id);
    expect(await stub.verifyBackup(status.runs[0].id)).toMatchObject({ verified: true });
  });

  it("refuses capture when any required store is unavailable", async () => {
    const acquire = vi.fn(async () => { throw new Error("must not start capture"); });
    const { stub } = await fixture({ coverage: async () => [{ id: "app", title: "Application", ready: false, reason: "Store unavailable." }], acquire });
    await stub.startBackup(); await runDurableObjectAlarm(stub);
    expect((await stub.getBackupStatus()).coverage[0].ready).toBe(false);
    expect((await stub.getBackupStatus()).runs[0].status).toBe("failed");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("never marks missing or changed source coverage complete; keeps errors content-free", async () => {
    const { stub } = await fixture({ acquire: async () => { throw new Error("credential=must-never-leak"); } });
    await stub.startBackup(); await runDurableObjectAlarm(stub);
    const status = await stub.getBackupStatus();
    expect(status.runs[0].status).toBe("failed");
    expect(JSON.stringify(status)).not.toContain("must-never-leak");
  });

  it.each([
    [{ phase: "component-capture", component: "a".repeat(16) }, "[component-capture:aaaaaaaaaaaaaaaa]"],
    [{ phase: "credential=must-never-leak", component: "customer-content" }, ""],
  ])("reports only bounded provider failure markers", async (marker, expected) => {
    const { stub } = await fixture({ acquire: async () => { throw new Error("credential=must-never-leak"); } });
    const queued = await stub.startBackup();
    await runInDurableObject(stub, async (_instance, ctx) => {
      await ctx.storage.put(`recovery-provider/phase/${queued.runs[0].id}`, marker);
    });
    await runDurableObjectAlarm(stub);
    const error = (await stub.getBackupStatus()).runs[0].error!;
    expect(error).not.toContain("must-never-leak");
    expect(error).not.toContain("customer-content");
    if (expected) expect(error).toContain(expected);
    else expect(error).not.toContain("[");
  });

  it("fails an interrupted persisted capture and releases its existing run token", async () => {
    const { stub, released } = await fixture();
    const queued = await stub.startBackup();
    await runInDurableObject(stub, async (instance, ctx) => {
      const persisted = await ctx.storage.get<{ runs: Array<{ phase: string }> }>("backups");
      persisted!.runs[0].phase = "capturing";
      await ctx.storage.put("backups", persisted);
      // Rehydrated state is identical to the constructor's persisted read after an isolate restart.
      Reflect.set(instance, "state", await ctx.storage.get("backups"));
    });
    await runDurableObjectAlarm(stub);
    expect((await stub.getBackupStatus()).runs[0]).toMatchObject({ status: "failed" });
    expect(released).toHaveBeenCalledWith(queued.runs[0].id);
  });

  it("holds completion while fence cleanup fails, then resumes verified completion", async () => {
    let fail = true;
    const { stub } = await fixture({ release: async () => { if (fail) throw new Error("secret provider failure"); } });
    await stub.startBackup(); await runDurableObjectAlarm(stub);
    expect((await stub.getBackupStatus()).runs[0].status).toBe("running");
    fail = false;
    await runDurableObjectAlarm(stub);
    expect((await stub.getBackupStatus()).runs[0].status).toBe("complete");
  });

  it("does not publish a complete head after source coherence changes", async () => {
    const { stub } = await fixture({ validate: async () => { throw new Error("source changed"); } });
    const id = (await stub.startBackup()).runs[0].id;
    await runDurableObjectAlarm(stub);
    expect((await stub.getBackupStatus()).runs[0].status).toBe("failed");
    expect(await testEnv.BACKUPS.head(`recovery/v1/test/${id}/head.json`)).toBeNull();
  });

  it("persists schedules and executes a due scheduled run", async () => {
    const { stub } = await fixture();
    const updated = await stub.setBackupSchedule({ ...DEFAULT_BACKUP_SCHEDULE, enabled: true });
    expect(updated.nextRunAt).toBeTypeOf("number");
    await runInDurableObject(stub, async (instance, ctx) => {
      const state = await ctx.storage.get<{ nextRunAt: number }>("backups");
      state!.nextRunAt = Date.now() - 1;
      Reflect.set(instance, "state", state);
      await ctx.storage.put("backups", state);
    });
    await runDurableObjectAlarm(stub);
    expect((await stub.getBackupStatus()).runs[0]).toMatchObject({ status: "complete", trigger: "scheduled" });
  });

  it("stages independently verified archive bytes without persisting private material", async () => {
    const { stub, staged } = await fixture();
    const queued = await stub.startBackup(); await runDurableObjectAlarm(stub);
    const result = await stub.stageBackupRestore(queued.runs[0].id, privateKey);
    expect(result.staged).toBe(true);
    expect(staged.get("app")).toBe("saved application state");
    await runInDurableObject(stub, async (_instance, ctx) => {
      expect(JSON.stringify(await ctx.storage.get("backups"))).not.toContain(privateKey.d);
    });
  });

  it("does not claim staging success before isolated runtime verification finishes", async () => {
    const { stub } = await fixture({ finalizeRestore: async () => { throw new Error("runtime readback failed"); } });
    const id = (await stub.startBackup()).runs[0].id;
    await runDurableObjectAlarm(stub);
    const result = await stub.stageBackupRestore(id, privateKey);
    expect(result.staged).toBe(false);
    expect(result.ready).toBe(false);
  });

  it.each([
    [{ phase: "restore-component", component: "b".repeat(16) }, "[restore-component:bbbbbbbbbbbbbbbb]"],
    [{ phase: "private-content", component: "private-content" }, ""],
  ])("reports only bounded restore diagnostics", async (marker, expected) => {
    const { stub } = await fixture({ finalizeRestore: async () => { throw new Error("private-content"); } });
    const id = (await stub.startBackup()).runs[0].id;
    await runDurableObjectAlarm(stub);
    await runInDurableObject(stub, async (_instance, ctx) => {
      await ctx.storage.put(`recovery-provider/phase/${id}`, marker);
    });
    const result = await stub.stageBackupRestore(id, privateKey);
    expect(result.staged).toBe(false);
    expect(result.issues.join(" ")).not.toContain("private-content");
    if (expected) expect(result.issues.join(" ")).toContain(expected);
    else expect(result.issues.join(" ")).not.toContain("[");
  });

  it("keeps the latest verified archive when retention removes an older run", async () => {
    const { stub } = await fixture();
    await stub.setBackupSchedule({ ...DEFAULT_BACKUP_SCHEDULE, retention: 1 });
    const first = (await stub.startBackup()).runs[0].id; await runDurableObjectAlarm(stub);
    const second = (await stub.startBackup()).runs[0].id; await runDurableObjectAlarm(stub);
    expect((await stub.getBackupStatus()).runs.map(run => run.id)).toEqual([second]);
    expect(await testEnv.BACKUPS.head(`recovery/v1/test/${first}/head.json`)).toBeNull();
    expect(await stub.verifyBackup(second)).toMatchObject({ verified: true });
  });
});

describe("deployment admission barrier", () => {
  it("closes new admission and waits for an overlapping mutation's durable lease", async () => {
    const { stub } = await fixture();
    await runInDurableObject(stub, async (instance, ctx) => {
      const lease = await instance.admitRequest();
      expect(lease).toBeTypeOf("string");
      expect(ctx.storage.kv.get(`maintenance/lease/${lease}`)).toBeTypeOf("number");
      let drained = false;
      const begin: Promise<void> = Reflect.get(instance, "beginMaintenance").call(instance, "capture");
      void begin.then(() => { drained = true; });
      await ctx.storage.sync();
      expect(await instance.admitRequest()).toBeNull();
      expect(drained).toBe(false);
      await instance.finishRequest(lease!);
      await begin;
      expect(drained).toBe(true);
      await Reflect.get(instance, "endMaintenance").call(instance, "capture");
      const next = await instance.admitRequest();
      expect(next).toBeTypeOf("string");
      await instance.finishRequest(next!);
    });
  });

  it("fails closed for an uncertain persisted request and never expires its lease", async () => {
    const { stub } = await fixture();
    await runInDurableObject(stub, async (instance, ctx) => {
      const lease = await instance.admitRequest();
      Reflect.set(instance, "drainTimeoutMs", 5);
      await expect(Reflect.get(instance, "beginMaintenance").call(instance, "capture")).rejects.toThrow("have not drained");
      expect(ctx.storage.kv.get(`maintenance/lease/${lease}`)).toBeTypeOf("number");
      expect(await instance.admitRequest()).toBeNull();
      await Reflect.get(instance, "endMaintenance").call(instance, "capture");
      expect(ctx.storage.kv.get(`maintenance/lease/${lease}`)).toBeTypeOf("number");
      await instance.finishRequest(lease!);
    });
  });
});

describe("authenticated archive rediscovery", () => {
  it("restores history and required inventory after original coordinator state is lost", async () => {
    const original = await fixture();
    const id = (await original.stub.startBackup()).runs[0].id;
    await runDurableObjectAlarm(original.stub);
    const fresh = await fixture();
    expect((await fresh.stub.getBackupStatus()).runs).toHaveLength(0);
    const recovered = await fresh.stub.rescanBackupArchives();
    expect(recovered.runs.find(run => run.id === id)).toMatchObject({ status: "complete", trigger: "recovered", components: 1, bytes: 23 });
    expect((await fresh.stub.stageBackupRestore(id, privateKey)).staged).toBe(true);
    expect(fresh.staged.get("app")).toBe("saved application state");
  });

  it("reports corrupt archives as failed while recovering intact archives", async () => {
    const good = await fixture(), bad = await fixture();
    const goodId = (await good.stub.startBackup()).runs[0].id;
    await runDurableObjectAlarm(good.stub);
    const badId = (await bad.stub.startBackup()).runs[0].id;
    await runDurableObjectAlarm(bad.stub);
    expect((await bad.stub.getBackupStatus()).runs[0].status).toBe("complete");
    await testEnv.BACKUPS.put(`recovery/v1/test/${badId}/app/0.json`, "{}");
    const fresh = await fixture();
    const recovered = await fresh.stub.rescanBackupArchives();
    expect(recovered.runs.find(run => run.id === goodId)?.status).toBe("complete");
    expect(recovered.runs.find(run => run.id === badId)?.status).toBe("failed");
    expect((await fresh.stub.previewBackupRestore(badId)).ready).toBe(false);
  });
});
