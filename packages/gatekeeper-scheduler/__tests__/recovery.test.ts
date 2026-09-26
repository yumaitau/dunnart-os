import { env } from "cloudflare:workers";
import { RpcTarget, RpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encodePortableValue } from "@gadgets/backend-utils/recovery-value";
import type { ScheduleDriver, StoredSchedule } from "../src/schedule-driver.js";
import type { TestHooks } from "./worker.js";
import type { ScheduleRecoveryResolver, ScheduleHookRecoveryDescriptor } from "../src/recovery.js";
import { scheduleRecoveryAccount, SCHEDULE_RECOVERY_DISABLED } from "../src/recovery.js";

const testEnv = env as unknown as {
  SCHEDULE_DRIVER: DurableObjectNamespace<ScheduleDriver>;
  TEST_HOOKS: Fetcher<TestHooks>;
};

describe("Scheduler recovery", () => {
  it("restores native initiators and all pending records but never arms or replays them", async () => {
    let source = testEnv.SCHEDULE_DRIVER.getByName(crypto.randomUUID());
    const target = testEnv.SCHEDULE_DRIVER.getByName(crypto.randomUUID());
    await testEnv.TEST_HOOKS.reset();
    await runInDurableObject(source, async (instance, state) => {
      const exports = instance.ctx.exports as typeof instance.ctx.exports & { TestHooks(options: object): Fetcher<TestHooks> };
      await instance.enable({ workspaceId: "source-workspace", scheduleId: "schedule", title: "Test", description: "",
        spec: { kind: "interval", everyMs: 60_000, anchorMs: Date.now() } }, exports.TestHooks({}));
      const active = state.storage.kv.get<StoredSchedule>("schedule:source-workspace:schedule")!;
      state.storage.kv.put("schedule:source-workspace:schedule", { ...active, state: { ...active.state,
        status: "pending", stage: "delivery", runId: "in-flight", scheduledTime: 1, attempts: 1, leaseExpiresAt: 1 } });
      state.storage.kv.put("custom", { exact: new Uint8Array([0, 255]), date: new Date("2026-01-01"), map: new Map([["key", 3]]) });
    });
    try { await source.beginRecovery("capture"); } catch { source = testEnv.SCHEDULE_DRIVER.get(source.id); await source.beginRecovery("capture"); }
    const snapshot = await source.exportRecovery();
    await source.validateRecovery("capture");
    expect(snapshot.alarm).not.toBeNull();
    await runInDurableObject(target, async (instance, state) => {
      const exports = instance.ctx.exports as typeof instance.ctx.exports & { TestHooks(options: object): Fetcher<TestHooks> };
      const restored: ScheduleHookRecoveryDescriptor[] = [];
      class Resolver extends RpcTarget implements ScheduleRecoveryResolver {
        async restoreHook(descriptor: ScheduleHookRecoveryDescriptor) {
          restored.push(descriptor);
          return exports.TestHooks({});
        }
      }
      await instance.restoreRecovery(snapshot, new RpcStub(new Resolver()));
      expect(restored).toEqual([{ kind: "workshop-hook", props: { overseerId: "source-workspace", hookId: 7 } }]);
      expect(state.storage.kv.get(SCHEDULE_RECOVERY_DISABLED)).toBe(true);
      expect(state.storage.kv.get("custom")).toEqual({ exact: new Uint8Array([0, 255]), date: new Date("2026-01-01"), map: new Map([["key", 3]]) });
      expect(state.storage.kv.get("caps:source-workspace:schedule")).toBeDefined();
      expect(state.storage.kv.get<StoredSchedule>("schedule:source-workspace:schedule")?.state).toMatchObject({ status: "pending", runId: "in-flight", attempts: 1 });
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
      await expect(instance.enable({ workspaceId: "source-workspace", scheduleId: "new", title: "", description: "",
        spec: { kind: "once", at: Date.now() + 60_000 } }, exports.TestHooks({}))).rejects.toThrow("Restored schedules are disabled");
      await expect(instance.restoreRecovery(snapshot, new RpcStub(new Resolver()))).rejects.toThrow("not empty");
    });
    expect((await testEnv.TEST_HOOKS.read()).events).toEqual([]);
    await source.endRecovery("capture");
  });

  it("rejects forged native initiator descriptors before the archive is produced", async () => {
    let source = testEnv.SCHEDULE_DRIVER.getByName(crypto.randomUUID());
    await runInDurableObject(source, async (instance, state) => {
      // A plain callable cannot be persisted; malformed data must still fail closed.
      state.storage.kv.put("caps:foreign:schedule", { initiator: { kind: "workshop-hook" } });
      await expect(instance.exportRecovery()).rejects.toThrow("no recovery descriptor");
    });
  });

  it("keeps recovery fences owned by one capture and rejects malformed snapshots", async () => {
    let source = testEnv.SCHEDULE_DRIVER.getByName(crypto.randomUUID());
    try { await source.beginRecovery("first"); } catch { source = testEnv.SCHEDULE_DRIVER.get(source.id); await source.beginRecovery("first"); }
    await runInDurableObject(source, async instance => {
      await expect(instance.beginRecovery("second")).rejects.toThrow("already in progress");
      await instance.endRecovery("second");
      expect(() => instance.validateRecovery("first")).not.toThrow();
      await instance.endRecovery("first");
      expect(() => instance.validateRecovery("first")).toThrow("lost");
      await expect(instance.restoreRecovery({ version: 1, rows: JSON.stringify(await encodePortableValue([["same", 1], ["same", 2]])), alarm: null })).rejects.toThrow("Invalid Scheduler recovery rows");
    });
    expect(() => scheduleRecoveryAccount("../live", "account")).toThrow();
  });
});
