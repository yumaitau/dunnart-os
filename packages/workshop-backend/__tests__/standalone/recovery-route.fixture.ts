import { DurableObject, RpcTarget, WorkerEntrypoint, restore } from "cloudflare:workers";
import { captureNativeStorage, restoreNativeStorage } from "@gadgets/backend-utils/recovery-native";
import { prepareRecoveryContext, prepareRecoveryLoopbackContext } from "../../src/recovery-runtime-context";
export { RecoveryObjectRoute } from "../../src/recovery-runtime-context";
export { RouteOriginal as UserDurableObject, RouteHub as NativeRecoveryObject };

/** Original application methods exercise recovery routing without copying business logic. */
export class RouteOriginal extends DurableObject {
  constructor(ctx, env) {
    super(ctx, prepareRecoveryContext(ctx, env));
    this.ctx.blockConcurrencyWhile(async () => {});
  }
  async seed(peerId: string, value: string) {
    this.ctx.storage.kv.put("peer", peerId);
    this.ctx.storage.kv.put("value", value);
    await this.env.BLUEPRINTS.put(this.ctx.id.toString(), value);
    await this.child().write("child-" + value);
    await this.ctx.storage.put("callback", await this.ctx.restore({ kind: "callback", tag: "original-params" }));
  }
  child() { return this.ctx.facets.get("gadget7", () => ({ class: this.ctx.exports.RouteChild, id: "gadget7" })); }
  identity() { return { id: this.ctx.id.toString(), peer: this.ctx.storage.kv.get("peer") }; }
  read() { return this.ctx.storage.kv.get("value"); }
  write(value: string) { this.ctx.storage.kv.put("value", value); }
  async writePeer(value: string) {
    const namespace = this.ctx.exports.UserDurableObject;
    const id = namespace.idFromString(this.ctx.storage.kv.get("peer"));
    await namespace.get(id).write(value);
    if (!namespace.get(id).id.equals(id)) throw new Error("Synchronous route ID changed");
    return namespace.get(id).read();
  }
  async writeNamed(name: string, value: string) {
    const namespace = this.ctx.exports.UserDurableObject;
    const stub = namespace.getByName(name);
    if (!stub.id.equals(namespace.idFromName(name)) || stub.id.name !== name) throw new Error("Named identity changed");
    await stub.write(value);
    return { id: stub.id.toString(), value: await stub.read() };
  }
  rejectedIdentityOperations() {
    const namespace = this.ctx.exports.UserDurableObject;
    return [() => namespace.idFromString("invalid"), () => namespace.getByName("missing-name"), () => namespace.newUniqueId(), () => namespace.jurisdiction("eu")].map(operation => {
      try { operation(); return null; } catch (error) { return String(error); }
    });
  }
  async invoke(value: string) { const callback = await this.ctx.storage.get("callback"); return callback.invoke(value); }
  async children() { return this.child().read(); }
  async writeBlueprint(value: string) { await this.env.BLUEPRINTS.put(this.ctx.id.toString(), value); }
  readBlueprint() { return this.env.BLUEPRINTS.get(this.ctx.id.toString()); }
  hasWorkersAI() { return this.env.WORKERS_AI !== undefined; }
  externalCapabilities() { return Object.fromEntries(["WORKERS_AI", "PRODUCT_ANALYTICS", "BROWSER"].map(name => [name, this.env[name] !== undefined])); }
  invokeLoopback(value: string) {
    return this.ctx.exports.GatekeeperLoopback({ props: { peer: this.ctx.storage.kv.get("peer") } }).write(value);
  }
  async newModelSession() {
    const model = this.ctx.facets.get("new-model", () => ({ class: this.ctx.exports.LanguageModelGatekeeper({ props: {} }) }));
    return model.startSession();
  }
  mint(params) { return this.ctx.restore(params); }
  [restore](params) { return new RouteCallback(this.ctx, params); }
  async snapshot() {
    const codec = { describe: async value => typeof value === "function" ? JSON.parse(JSON.stringify(await value.descriptor())) : undefined };
    return JSON.stringify({
      id: this.ctx.id.toString(),
      storage: await captureNativeStorage(this.ctx.storage, codec),
      child: JSON.parse(await this.child().snapshot()),
    });
  }
}

class RouteCallback extends RpcTarget {
  constructor(private context, private params) { super(); }
  descriptor() { return { kind: "callback", sourceId: this.context.id.toString(), params: this.params }; }
  async invoke(value: string) {
    const namespace = this.context.exports.UserDurableObject;
    await namespace.get(namespace.idFromString(this.context.storage.kv.get("peer"))).write(value);
    const child = this.context.facets.get("gadget7", () => ({ class: this.context.exports.RouteChild, id: "gadget7" }));
    await child.write(this.params.tag + ":" + value);
    return this.context.id.toString();
  }
}

export class LanguageModelGatekeeper extends DurableObject {
  startSession() {
    if (this.ctx.props.recoveryScope) throw new Error("Model execution is paused in isolated recovery.");
    throw new Error("UNSAFE: external model execution would be allowed.");
  }
}

export class GatekeeperLoopback extends WorkerEntrypoint {
  constructor(ctx, env) {
    prepareRecoveryLoopbackContext(ctx, ctx.props.recoveryScope, ctx.props.recoveryNamedIds);
    super(ctx, env);
  }
  async write(value: string) {
    const namespace = this.ctx.exports.UserDurableObject;
    const peer = namespace.idFromString(this.ctx.props.peer);
    if (!namespace.idFromName("source-B").equals(peer)) throw new Error("Loopback lost archived named IDs");
    await namespace.getByName("source-B").write(value);
    return this.ctx.props.recoveryScope ?? null;
  }
}

export class RouteChild extends DurableObject {
  write(value: string) { this.ctx.storage.kv.put("child", value); }
  read() { return this.ctx.storage.kv.get("child"); }
  async snapshot() { return JSON.stringify(await captureNativeStorage(this.ctx.storage)); }
}

function route(exports, scope: string, sourceId: string) {
  const service = exports.RecoveryObjectRoute({ props: { scope, sourceId: "user-" + sourceId, originalId: sourceId, kind: "user" } });
  return new Proxy({}, {
    get(_, method) {
      if (method === "then") return undefined;
      if (method === "id") return { toString: () => sourceId };
      if (typeof method !== "string") return undefined;
      return (...args) => service.call(method, args);
    },
  });
}

export class RouteInspector extends DurableObject {
  [restore](params) { return new RouteCallback(this.ctx, params); }
  async import(snapshot, scope: string, namedIds) {
    const codec = {
      restore: descriptor => {
        if (descriptor.kind !== "callback") throw new Error("Unsupported fixture capability");
        return this.ctx.restore(descriptor.params);
      },
    };
    await restoreNativeStorage(this.ctx.storage, snapshot.storage, codec);
    this.ctx.storage.kv.put(".nativeRecoveryRuntime", { scope, sourceId: "user-" + snapshot.id, originalId: snapshot.id, kind: "user", namedIds });
    const child = this.ctx.facets.get("gadget7", () => ({ class: this.ctx.exports.RouteChildInspector, id: "gadget7" }));
    await child.import(snapshot.child);
  }
}
export class RouteChildInspector extends DurableObject {
  async import(snapshot) { await restoreNativeStorage(this.ctx.storage, snapshot); }
}
export class RouteHub extends DurableObject {
  async reset() { await this.ctx.storage.sync(); this.ctx.abort("Recovery route proof reset"); }
  async stage(scope: string, snapshot, namedIds) {
    this.ctx.storage.kv.put("identity", { scope, sourceId: snapshot.id });
    const root = await this.ctx.restore({ kind: "root" });
    await root.import(snapshot, scope, namedIds);
    this.ctx.storage.kv.put("active", true);
    this.ctx.facets.abort("root", new Error("Activate original application class"));
  }
  [restore](params) {
    if (params.kind !== "root") throw new Error("Unknown root");
    const { sourceId } = this.ctx.storage.kv.get("identity");
    return this.ctx.facets.get("root", () => ({
      class: this.ctx.storage.kv.get("active") ? this.ctx.exports.UserDurableObject : this.ctx.exports.RouteInspector,
      id: sourceId,
    }));
  }
  async callRecoveryRuntime(method: string, args: unknown[]) {
    const identity = this.ctx.storage.kv.get("identity");
    if (!identity) throw new Error("Recovery route identity missing");
    const root = await this.ctx.restore({ kind: "root" });
    return root[method](...args);
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      const sourceA = ctx.exports.UserDurableObject.getByName("source-A");
      const sourceB = ctx.exports.UserDurableObject.getByName("source-B");
      const idA = new URL(request.url).searchParams.get("idA") ?? ctx.exports.UserDurableObject.idFromName("source-A").toString();
      const idB = new URL(request.url).searchParams.get("idB") ?? ctx.exports.UserDurableObject.idFromName("source-B").toString();
      if (new URL(request.url).pathname === "/seed") {
        await sourceA.seed(idB, "original-A");
        await sourceB.seed(idA, "original-B");
        return Response.json({ a: JSON.parse(await sourceA.snapshot()), b: JSON.parse(await sourceB.snapshot()), namedIds: { UserDurableObject: { "source-A": idA, "source-B": idB } } });
      }
      if (new URL(request.url).pathname === "/stage") {
        const { scope, a, b, namedIds } = await request.json();
        // Stage callback restore parameters under the root's trusted inspector.
        // Abort switches ownership to the original class before any invocation.
        for (const snapshot of [a, b]) {
          const hub = ctx.exports.NativeRecoveryObject.getByName(scope + "-user-" + snapshot.id);
          await hub.stage(scope, snapshot, namedIds);
        }
        return Response.json({ ok: true });
      }
      if (new URL(request.url).pathname === "/source") {
        return Response.json({ a: await sourceA.read(), b: await sourceB.read(), child: await sourceA.children(), blueprint: await sourceA.readBlueprint(), workersAI: await sourceA.hasWorkersAI(), externalCapabilities: await sourceA.externalCapabilities() });
      }
      if (new URL(request.url).pathname === "/replacement-identity") {
        let error = null;
        try { ctx.exports.UserDurableObject.idFromString(idA); } catch (caught) { error = String(caught); }
        return Response.json({ error, namedId: ctx.exports.UserDurableObject.idFromName("source-A").toString() });
      }
      const scope = new URL(request.url).searchParams.get("scope") || "recovery-proof";
      if (new URL(request.url).pathname === "/reset") {
        const aborted = [];
        for (const id of [idA, idB]) {
          try { await ctx.exports.NativeRecoveryObject.getByName(scope + "-user-" + id).reset(); }
          catch (error) { aborted.push(String(error)); }
        }
        return Response.json(aborted);
      }
      const a = route(ctx.exports, scope, idA);
      const b = route(ctx.exports, scope, idB);
      if (new URL(request.url).pathname === "/exercise") {
        let modelError = null;
        try { await a.newModelSession(); } catch (error) { modelError = String(error); }
        const before = { a: await a.read(), b: await b.read(), child: await a.children() };
        const peerWrite = await a.writePeer("isolated-peer-write");
        const loopbackScope = await a.invokeLoopback("isolated-loopback-write");
        const loopbackValue = await b.read();
        const namedWrite = await a.writeNamed("source-B", "isolated-named-write");
        const rejectedIdentities = await a.rejectedIdentityOperations();
        const callbackId = await a.invoke("isolated-callback-write");
        await a.writeBlueprint("isolated-blueprint");
        return Response.json({
          ids: { a: await a.identity(), b: await b.identity() }, before, peerWrite, callbackId, loopbackScope, loopbackValue, namedWrite, rejectedIdentities, modelError,
          blueprint: await a.readBlueprint(),
          workersAI: await a.hasWorkersAI(), externalCapabilities: await a.externalCapabilities(),
          isolated: { a: await a.read(), b: await b.read(), child: await a.children() },
        });
      }
      return Response.json({ error: "Unknown path" }, { status: 404 });
    } catch (error) { return Response.json({ error: String(error), stack: error.stack }, { status: 500 }); }
  },
};
