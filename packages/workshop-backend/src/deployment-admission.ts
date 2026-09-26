const contexts = new WeakMap<ExecutionContext, { pending: Set<Promise<unknown>>; enabled: boolean }>();
const rpcContexts = new WeakMap<object, ExecutionContext>();
export const MAINTENANCE_MESSAGE = "Deployment backup capture is in progress. Retry shortly.";

/** Track background mutations as part of their admitted HTTP/RPC operation. */
export function trackDeploymentContext(ctx: ExecutionContext, enabled: boolean): ExecutionContext {
  const state = { pending: new Set<Promise<unknown>>(), enabled };
  const tracked = new Proxy(ctx, {
    get(target, property) {
      if (property === "waitUntil") return (promise: Promise<unknown>) => {
        const settled = Promise.resolve(promise).then(() => {}, () => {});
        state.pending.add(settled);
        void settled.finally(() => state.pending.delete(settled));
        target.waitUntil(promise);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  contexts.set(tracked, state);
  return tracked;
}

/** Keep a durable lease until foreground and registered background work finish. */
export async function withDeploymentAdmission<T>(ctx: ExecutionContext, operation: () => Promise<T>): Promise<T> {
  if (!contexts.get(ctx)?.enabled) return operation();
  const coordinator = ctx.exports.DeploymentBackups.getByName("");
  const lease = await coordinator.admitRequest();
  if (lease === null) throw new Error(MAINTENANCE_MESSAGE);
  try { return await operation(); }
  finally {
    const state = contexts.get(ctx);
    while (state?.pending.size) await Promise.all(state.pending);
    await coordinator.finishRequest(lease);
  }
}

/** Register retained RPC capabilities whose methods can write after the WebSocket handshake. */
export function registerDeploymentRpc(object: object, ctx: ExecutionContext): void { rpcContexts.set(object, ctx); }

/** Admit each existing Public/Authenticated API invocation, including pre-authentication signups. */
export function guardDeploymentRpc(constructor: { prototype: object }): void {
  for (const name of Object.getOwnPropertyNames(constructor.prototype)) {
    if (name === "constructor") continue;
    const property = Object.getOwnPropertyDescriptor(constructor.prototype, name)!;
    if (typeof property.value !== "function") continue;
    const original = property.value;
    Object.defineProperty(constructor.prototype, name, { ...property, value: function(this: object, ...args: unknown[]) {
      const ctx = rpcContexts.get(this);
      if (!ctx) throw new Error("Deployment request admission context is missing.");
      return withDeploymentAdmission(ctx, async () => Reflect.apply(original, this, args));
    } });
  }
}
