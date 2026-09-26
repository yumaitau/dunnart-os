import { UserDurableObject as ProductionUser } from "../../src/user";
import { OverseerDurableObject as ProductionOverseer } from "../../src/overseer";

export { NativeRecoveryObject, NativeRecoveryHook, RecoveryGadgetRoute } from "../../src/native-recovery";
export { RecoveryGadgetInspector } from "../../src/recovery-gadget";
export { RecoveryObjectRoute } from "../../src/recovery-runtime-context";
export { AdminSettings } from "../../src/admin-settings";
export { UserDirectoryDurableObject } from "../../src/user-directory";
export { IdentityDirectory } from "../../src/auth/identity-directory";
export { LanguageModelGatekeeper } from "../../src/ai-models";
export { GatekeeperLoopback, GatekeeperHookLoopback, AgentSelfLoopback, GadgetTailLoopback,
  CodeModeTailLoopback, AgentSpawnerGatekeeper } from "../../src/overseer";

const app = `import { DurableObject, RpcTarget, restore } from 'cloudflare:workers';
export class Gadget extends DurableObject {
  read() { return this.ctx.storage.kv.get('counter') || 0; }
  increment() { const value = this.read() + 1; this.ctx.storage.kv.put('counter', value); return value; }
  [restore](params) { return new CounterCallback(this.ctx.storage, params.delta); }
}
class CounterCallback extends RpcTarget {
  constructor(storage, delta) { super(); this.storage = storage; this.delta = delta; }
  add() { const value = (this.storage.kv.get('counter') || 0) + this.delta; this.storage.kv.put('counter', value); return value; }
}`;

export class UserDurableObject extends ProductionUser {
  seed(workspaceId: string) {
    const storage = (this as any).storage;
    storage.created.put(true);
    storage.profile.put({ type: "user", id: "recovery-fixture-user", name: "Recovery Owner" });
    storage.gadgets.put({ id: workspaceId, title: "Original recovery workspace", created: new Date("2026-01-01") });
  }
}

export class OverseerDurableObject extends ProductionOverseer {
  async seed(ownerId: string) {
    const impl = (this as any).impl;
    impl.storage.ownerId.put(ownerId);
    impl.ownerId = ownerId;
    impl.storage.title.put("Original recovery workspace");
    impl.storage.version.put(4);
    const commitId = await impl.gitStore.writeFilesAsCommit(new Map([["server.js", app]]), {
      parents: [], author: { name: "Recovery Owner", email: "fixture@example.test" },
      message: "Seed recovery app", timestamp: new Date("2026-01-01"),
    });
    impl.storage.gadgets.put({ type: "gadget", id: 7, title: "Original counter", created: new Date("2026-01-01"),
      bindingName: "COUNTER", bindings: {}, commitId });
    const gadget = await impl.getGadgetFacetFetcher(7);
    await gadget.increment();
  }

  async sourceCounter() { return (await (this as any).impl.getGadgetFacetFetcher(7)).read(); }

  async probeRecoveryGuards(scope: string) {
    const props = { recoveryScope: scope, recoveryNamedIds: {} };
    const model = this.ctx.facets.get("guard-model", () => ({ class: this.ctx.exports.LanguageModelGatekeeper({ props: props as any }) }));
    const spawner = this.ctx.facets.get("guard-spawner", () => ({ class: this.ctx.exports.AgentSpawnerGatekeeper({ props: props as any }) }));
    const hook = this.ctx.exports.GatekeeperHookLoopback({ props: props as any });
    const errors: Record<string, string> = {};
    for (const [name, call] of [
      ["model", () => model.startSession(undefined as any)],
      ["spawner", () => spawner.startSession(undefined as any)],
      ["hook", () => hook.startHook()],
      ["action", () => (this as any).impl.applyPendingAction({}, {}, false)],
    ] as const) {
      try { await call(); errors[name] = "UNEXPECTED SUCCESS"; }
      catch (error) { errors[name] = String(error); }
    }
    return errors;
  }
}

export default {
  async fetch(_request: Request, env: any, ctx: ExecutionContext) {
    let phase = "seed";
    try {
      const sourceUser = env.USERS.getByName("recovery-fixture-user");
      let sourceWorkspace = env.WORKSPACES.getByName("original-workspace");
      await sourceUser.seed(sourceWorkspace.id.toString());
      await sourceWorkspace.seed(sourceUser.id.toString());
      const sourceProfile = await sourceUser.whoami();
      const sourceCounter = await sourceWorkspace.sourceCounter();

      phase = "capture";
      const userArchive = await sourceUser.getRecoverySnapshot();
      try { await sourceWorkspace.beginRecovery("application-proof", "a".repeat(64)); } catch {}
      sourceWorkspace = env.WORKSPACES.getByName("original-workspace");
      await sourceWorkspace.beginRecovery("application-proof", "a".repeat(64));
      const workspaceArchive = await sourceWorkspace.getRecoverySnapshot();
      await sourceWorkspace.endRecovery("application-proof");

      const scope = "recovery-application-proof";
      const userComponent = "user-" + sourceUser.id.toString();
      const workspaceComponent = "workspace-" + sourceWorkspace.id.toString();
      const targetUser = env.RECOVERY.getByName(scope + "-" + userComponent);
      const targetWorkspace = env.RECOVERY.getByName(scope + "-" + workspaceComponent);
      phase = "stage";
      await targetUser.stageRecoverySnapshot(userArchive);
      await targetWorkspace.stageRecoverySnapshot(workspaceArchive);
      const routing = JSON.stringify({ UserDurableObject: { "recovery-fixture-user": sourceUser.id.toString() } });
      phase = "prepare";
      await targetUser.prepareRecoveryRuntime(userComponent, scope, undefined, routing);
      await targetWorkspace.prepareRecoveryRuntime(workspaceComponent, scope, undefined, routing);
      let beforeActivationRejected = false;
      try { await targetUser.callRecoveryRuntime("whoami", []); }
      catch { beforeActivationRejected = true; }
      phase = "activate";
      await targetUser.activateRecoveryRuntime();
      await targetWorkspace.activateRecoveryRuntime();
      phase = "original user and workspace methods";
      const profile = await targetUser.callRecoveryRuntime("whoami", []);
      const workspace = await targetWorkspace.openRecoveryWorkspace();
      const metadata = await workspace.getMetadata();
      phase = "original loaded gadget read and write";
      const gadgetClient = await workspace.getGadget(7);
      const gadget = await gadgetClient.connectToGadget();
      const before = await gadget.read();
      const after = await gadget.increment();
      phase = "actual callback restore and invoke";
      const callbackAfter = await targetWorkspace.callRecoveryRuntime("invokeRecoveryGadget", [
        { kind: "gadget-callback", gadgetId: 7 }, { delta: 5 }, "add", [],
      ]);
      const afterCallbackRead = await gadget.read();
      phase = "paused execution guards";
      const guards = await targetWorkspace.callRecoveryRuntime("probeRecoveryGuards", [scope]);
      const applicationCheck = await targetWorkspace.verifyRecoveryRuntime();
      phase = "source unchanged";
      const sourceCounterAfter = await sourceWorkspace.sourceCounter();
      const sourceProfileAfter = await sourceUser.whoami();
      return Response.json({ profile, metadata, before, after, callbackAfter, afterCallbackRead,
        beforeActivationRejected, guards, applicationCheck,
        sourceProfile, sourceProfileAfter, sourceCounter, sourceCounterAfter,
        originalWorkspaceId: sourceWorkspace.id.toString() });
    } catch (error) { return Response.json({ phase, error: String(error), stack: error instanceof Error ? error.stack : undefined }, { status: 500 }); }
  },
};
