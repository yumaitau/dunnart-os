import { WorkerEntrypoint } from "cloudflare:workers";

/** Archived names indexed by original namespace export; recovery never derives new IDs. */
export type RecoveryNamedIds = Record<string, Record<string, string>>;

/** Original root identity and isolated scope persisted before restored code is activated. */
export interface RecoveryRuntimeIdentity {
  /** Named recovery scope, including the recovery- prefix. */
  scope: string;
  /** Inventory component ID, such as user-<hex> or root-admin. */
  sourceId: string;
  /** Source namespace's original Durable Object ID. */
  originalId: string;
  /** Original namespace owning the recovered root. */
  kind: "user" | "workspace" | "admin" | "users" | "identities";
  /** Name-to-ID mappings captured from the source namespace inventory. */
  namedIds: RecoveryNamedIds;
}

const namespaceKinds = {
  UserDurableObject: "user",
  OverseerDurableObject: "workspace",
  AdminSettings: "admin",
  UserDirectoryDurableObject: "users",
  IdentityDirectory: "identities",
} as const;

type Kind = RecoveryRuntimeIdentity["kind"];

function componentId(kind: Kind, originalId: string): string {
  return kind === "user" || kind === "workspace" ? `${kind}-${originalId}` : `root-${kind}`;
}

function validNamedIds(value: unknown): value is RecoveryNamedIds {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.entries(value).every(([namespace, names]) => Object.hasOwn(namespaceKinds, namespace) &&
      !!names && typeof names === "object" && !Array.isArray(names) &&
      Object.values(names).every(id => typeof id === "string" && /^[a-f0-9]{64}$/.test(id)));
}

function archivedId(value: string, name?: string): DurableObjectId {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid archived Durable Object ID.");
  return Object.freeze({ toString: () => value, equals: (other: DurableObjectId) => other.toString() === value,
    ...(name === undefined ? {} : { name }) });
}

/** Read the trusted runtime marker; ordinary source objects have no recovery routing. */
export function readRecoveryRuntimeIdentity(ctx: DurableObjectState): RecoveryRuntimeIdentity | undefined {
  const identity = ctx.storage.kv.get<RecoveryRuntimeIdentity>(".nativeRecoveryRuntime");
  if (identity && (!/^recovery-[A-Za-z0-9_-]{1,128}$/.test(identity.scope) ||
      !/^[a-f0-9]{64}$/.test(identity.originalId) ||
      !Object.values(namespaceKinds).includes(identity.kind) ||
      identity.sourceId !== componentId(identity.kind, identity.originalId) ||
      !validNamedIds(identity.namedIds))) {
    throw new Error("Invalid native recovery runtime identity.");
  }
  return identity;
}

/** Explicit RPC forwarding endpoint whose authority is limited to one restored root. */
export class RecoveryObjectRoute extends WorkerEntrypoint<Cloudflare.Env, RecoveryRuntimeIdentity> {
  /** Invoke the original root through its isolated hub's activation and identity checks. */
  call(method: string, args: unknown[]): Promise<unknown> {
    const { scope, sourceId } = this.ctx.props;
    return this.ctx.exports.NativeRecoveryObject.getByName(`${scope}-${sourceId}`).callRecoveryRuntime(method, args);
  }
}

function recoveredNamespace<T extends DurableObjectNamespace>(
  namespace: T,
  exports: Cloudflare.Exports,
  scope: string,
  kind: Kind,
  namespaceName: string,
  namedIds: RecoveryNamedIds,
): T {
  const idFromName = (name: string) => {
    const names = namedIds[namespaceName];
    if (!names || !Object.hasOwn(names, name)) throw new Error(`Recovery has no archived identity for ${namespaceName} name ${JSON.stringify(name)}.`);
    return archivedId(names[name]!, name);
  };
  const get = (id: DurableObjectId) => {
    // The source namespace may no longer exist; replacement namespaces reject its IDs.
    const originalId = archivedId(id.toString(), id.name);
    const service = exports.RecoveryObjectRoute({ props: {
      scope, kind, originalId: originalId.toString(), sourceId: componentId(kind, originalId.toString()), namedIds,
    } });
    return new Proxy(service, {
      get(target, property) {
        if (property === "id") return originalId;
        if (property === "name") return id.name;
        if (property === "then") return undefined;
        if (typeof property !== "string" || property === "dup") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...args: unknown[]) => target.call(property, args);
      },
    });
  };
  return new Proxy(namespace, {
    get(target, property) {
      if (property === "get") return get;
      if (property === "idFromString") return archivedId;
      if (property === "idFromName") return idFromName;
      if (property === "getByName") return (name: string) => get(idFromName(name));
      if (property === "newUniqueId" || property === "jurisdiction") return () => {
        throw new Error("Recovery drill cannot allocate new root identities or change their jurisdiction.");
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Replace namespace lookups before the original constructor runs, retaining the native state
 * object's brand. Passing a Proxy of DurableObjectState into super() fails workerd's brand check.
 * The namespace proxies are local method adapters; persist returned application capabilities,
 * never the adapter object itself.
 */
export function prepareRecoveryContext<Env extends object>(ctx: DurableObjectState, env: Env): Env {
  const identity = readRecoveryRuntimeIdentity(ctx);
  if (!identity) return env;
  prepareRecoveryLoopbackContext(ctx, identity.scope, identity.namedIds);
  const recovered = { ...env };
  for (const [name, restoredName] of Object.entries({ BLUEPRINTS: "BLUEPRINTS_RESTORE", AVATARS: "AVATARS_RESTORE", BLUEPRINT_CONTENT: "BACKUP_RESTORE", AUTH_DB: "AUTH_DB_RESTORE" })) {
    if (Reflect.get(env, name) === undefined) continue;
    const isolated = Reflect.get(env, restoredName);
    if (!isolated) throw new Error(`Recovery runtime requires isolated ${restoredName} binding.`);
    Reflect.set(recovered, name, isolated);
  }
  for (const name of ["WORKERS_AI", "PRODUCT_ANALYTICS", "BROWSER"]) Reflect.deleteProperty(recovered, name);
  return recovered;
}

const loopbackNames = new Set([
  "GatekeeperLoopback", "GatekeeperHookLoopback", "AgentSelfLoopback",
  "CodeModeTailLoopback", "GadgetTailLoopback", "AgentSpawnerGatekeeper", "LanguageModelGatekeeper",
]);

/** Apply isolated root lookups to a loopback before its original constructor resolves stubs. */
export function prepareRecoveryLoopbackContext(
  ctx: Pick<ExecutionContext, "exports">,
  scope: string | undefined,
  namedIds: RecoveryNamedIds = {},
): void {
  if (scope === undefined) return;
  if (!/^recovery-[A-Za-z0-9_-]{1,128}$/.test(scope) || !validNamedIds(namedIds)) throw new Error("Invalid native recovery scope.");
  const originalExports = ctx.exports;
  const namespaces = new Map<PropertyKey, DurableObjectNamespace>();
  for (const [name, kind] of Object.entries(namespaceKinds)) {
    const namespace = Reflect.get(originalExports, name);
    if (namespace) namespaces.set(name, recoveredNamespace(namespace, originalExports, scope, kind, name, namedIds));
  }
  const exports = new Proxy(originalExports, {
    get(target, property) {
      const namespace = namespaces.get(property);
      if (namespace) return namespace;
      const value = Reflect.get(target, property, target);
      if (typeof property === "string" && loopbackNames.has(property) && typeof value === "function") {
        return (options = {}) => value({ ...options, props: { ...Reflect.get(options, "props"), recoveryScope: scope, recoveryNamedIds: namedIds } });
      }
      return value;
    },
  });
  Object.defineProperty(ctx, "exports", { value: exports, configurable: true });
}
