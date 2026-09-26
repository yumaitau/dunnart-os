import { DurableObject, RpcTarget, WorkerEntrypoint, restore, type RpcStub } from "cloudflare:workers";
import { sealCapabilityDescriptor } from "@gadgets/backend-utils/recovery-capability";
import { captureNativeStorage, restoreNativeStorage, type NativeStorageSnapshot } from "@gadgets/backend-utils/recovery-native";
import { decodePortableValue, encodePortableValue, type PortableDescriptor, type RecoveryValueCodec } from "@gadgets/backend-utils/recovery-value";
import type { OverseerDurableObject } from "./overseer";
import type { RecoveryRuntimeIdentity } from "./recovery-runtime-context";

const FENCE_KEY = ".nativeRecovery";
type RecoveryFence = { run: string; key: string };
const contexts = new WeakMap<object, DurableObjectState>();
const recoveryServices = new WeakMap<NativeRecoveryService, RecoveryValueCodec>();

/** Register an object whose public RPC methods are guarded during native capture. */
export function registerNativeRecoveryObject(object: object, ctx: DurableObjectState): void {
  contexts.set(object, ctx);
}

/** Persist a restart-safe maintenance fence before switching any facet to trusted inspection. */
export function beginNativeRecovery(ctx: DurableObjectState, run: string, key: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(run) || !/^[a-f0-9]{64}$/.test(key)) {
    throw new Error("Invalid native recovery run or inspection key.");
  }
  const existing = readNativeRecovery(ctx);
  if (existing && (existing.run !== run || existing.key !== key)) throw new Error("Native recovery already in progress.");
  if (!existing) ctx.storage.kv.put(FENCE_KEY, { run, key });
  return !existing;
}

/** Read the persisted fence, including after the runtime restarts this object. */
export function readNativeRecovery(ctx: DurableObjectState): RecoveryFence | undefined {
  return ctx.storage.kv.get<RecoveryFence>(FENCE_KEY);
}

/** Release only the fence held by the caller's run; another run cannot unlock this object. */
export function endNativeRecovery(ctx: DurableObjectState, run: string): void {
  const existing = readNativeRecovery(ctx);
  if (existing && existing.run !== run) throw new Error("Native recovery run does not own this object.");
  ctx.storage.kv.delete(FENCE_KEY);
}

/** Guard ordinary string-named RPC methods while allowing trusted recovery control and restore. */
export function fenceNativeRecoveryMethods(constructor: { prototype: object }): void {
  for (const name of Object.getOwnPropertyNames(constructor.prototype)) {
    if (name === "constructor" || /^(getRecovery|beginRecovery|prepareRecovery|endRecovery)/.test(name)) continue;
    const property = Object.getOwnPropertyDescriptor(constructor.prototype, name)!;
    if (typeof property.value !== "function") continue;
    const original = property.value;
    Object.defineProperty(constructor.prototype, name, { ...property, value: function(this: object, ...args: unknown[]) {
      const ctx = contexts.get(this);
      if (ctx && readNativeRecovery(ctx)) throw new Error("Deployment recovery capture is in progress; retry shortly.");
      return Reflect.apply(original, this, args);
    } });
  }
}

/** Trusted in-process adapter transported over native RPC during a recovery operation. */
export class NativeRecoveryService extends RpcTarget {
  constructor(codec: RecoveryValueCodec) { super(); recoveryServices.set(this, codec); }

  /** Describe only capabilities recognized by the deployment's trusted adapter. */
  async describe(value: object, path: string): Promise<string | null> {
    const result = await recoveryServices.get(this)!.describe(value, path);
    return result === undefined ? null : JSON.stringify(result);
  }

  /** Reconstruct an authenticated capability in the isolated destination. */
  async restore(descriptor: string): Promise<unknown> {
    return await recoveryServices.get(this)!.restore(JSON.parse(descriptor));
  }
}

/** A root and its complete, explicitly enumerated facet inventory. */
export interface NativeRecoverySnapshot {
  /** Live source identity; import never implicitly reuses it as a destination. */
  id: string;
  /** Root storage including all scalar/native values and application SQL. */
  storage: NativeStorageSnapshot;
  /** Captured application facets, retaining the names code uses to address them. */
  facets: Array<{ name: string; storage: NativeStorageSnapshot }>;
  /** Diagnostic runtime bookmark; equality is not a mutation test because reads advance it. */
  bookmark: string;
}

function plain(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Adapt trusted remote capability handling while preserving ordinary structured values locally. */
export function nativeRecoveryCodec(service?: RpcStub<NativeRecoveryService>,
    classes?: WeakMap<object, PortableDescriptor>,
    classDescriptors?: Map<number, PortableDescriptor>, root = false): RecoveryValueCodec {
  classes ??= new WeakMap();
  return {
    async describe(value, path) {
      if (root && plain(value) && "kv" in value && value.kv instanceof Map) {
        classDescriptors ??= value.kv.get(".nativeRecoveryClasses");
      }
      if (classes && classDescriptors && plain(value) && "kv" in value && value.kv instanceof Map) {
        for (const [key, record] of value.kv) {
          if (typeof key !== "string" || !key.startsWith("gatekeepers:") || !record || typeof record !== "object") continue;
          const capability = Reflect.get(record, "class");
          const id = Reflect.get(record, "id");
          if (!capability || typeof capability !== "object") continue;
          const descriptor = classDescriptors.get(id);
          if (!descriptor) throw new Error(`Gatekeeper ${id} has no trusted recovery class descriptor.`);
          classes.set(capability, descriptor);
        }
      }
      const known = classes?.get(value);
      if (known !== undefined) return known;
      if (plain(value) || Array.isArray(value) || value instanceof Map || value instanceof Set ||
          value instanceof Date || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return undefined;
      if (!service) return undefined;
      const result = await service.describe(value, path);
      return result === null ? undefined : JSON.parse(result);
    },
    async restore(descriptor) {
      if (!service) throw new Error("Native recovery capability resolver is required.");
      return await service.restore(JSON.stringify(descriptor));
    },
  };
}

/** Read native state without invoking any application constructor, alarm, or callback. */
export class NativeRecoveryObject extends DurableObject<Cloudflare.Env, { descriptor?: unknown; key?: string }> {
  /** Copy verified data into the original root's future runtime, with isolated capability routes. */
  async prepareRecoveryRuntime(sourceId: string, scope: string, service?: RpcStub<NativeRecoveryService>, routing = "{}"): Promise<void> {
    if (this.ctx.id.name !== `${scope}-${sourceId}` || !/^recovery-[A-Za-z0-9_-]+$/.test(scope)) {
      throw new Error("Recovery runtime identity does not match its isolated target.");
    }
    const snapshot: NativeRecoverySnapshot = JSON.parse(await this.getRecoverySnapshot(service));
    const kind = sourceId.startsWith("user-") ? "user" : sourceId.startsWith("workspace-") ? "workspace"
      : sourceId === "root-admin" ? "admin" : sourceId === "root-users" ? "users" : sourceId === "root-identities" ? "identities" : undefined;
    if (!kind) throw new Error("Unsupported recovery runtime component.");
    const identity: RecoveryRuntimeIdentity = { sourceId, scope, kind, originalId: snapshot.id, namedIds: JSON.parse(routing) };
    const codec = this.#runtimeCodec(identity, service);
    const runtime = this.ctx.facets.get<NativeRecoveryObject>(".runtime", () => ({ class: this.ctx.exports.NativeRecoveryObject, id: snapshot.id }));
    await runtime.importRecoveryRuntimeSnapshot(JSON.stringify(snapshot), JSON.stringify(identity), new NativeRecoveryService(codec));
    const inventory = this.ctx.facets.get<NativeRecoveryObject>(".recoveryInventory", () => ({ class: this.ctx.exports.NativeRecoveryObject }));
    await inventory.setRecoveryRuntimeIdentity(JSON.stringify(identity));
  }

  /** Stage a nested original root before its application constructor is selected. */
  async importRecoveryRuntimeSnapshot(encoded: string, identity: string, service?: RpcStub<NativeRecoveryService>): Promise<void> {
    const snapshot: NativeRecoverySnapshot = JSON.parse(encoded);
    await this.stageRecoveryStorage(JSON.stringify(snapshot.storage), service);
    for (const facet of snapshot.facets) {
      const target = this.ctx.facets.get<NativeRecoveryObject>(facet.name, () => ({ class: this.ctx.exports.NativeRecoveryObject }));
      await target.stageRecoveryStorage(JSON.stringify(facet.storage), service);
    }
    this.ctx.storage.kv.delete(FENCE_KEY);
    this.ctx.storage.kv.put(".nativeRecoveryRuntime", JSON.parse(identity));
  }

  /** Persist activation metadata separately from the archived application state. */
  setRecoveryRuntimeIdentity(encoded: string): void {
    if (this.ctx.storage.kv.get("runtime")) throw new Error("Recovery runtime already prepared.");
    this.ctx.storage.kv.put("runtime", encoded);
  }

  /** Read the prepared runtime identity without waking application code. */
  getRecoveryRuntimeIdentity(): string | undefined { return this.ctx.storage.kv.get<string>("runtime"); }

  /** Export a login or singleton alias from verified archive contents, without consulting a live namespace. */
  async getRecoveryRoutingIdentity(sourceId: string): Promise<{ namespace: string; name: string; originalId: string } | null> {
    const metadata = this.ctx.facets.get<NativeRecoveryObject>(".recoveryInventory", () => ({ class: this.ctx.exports.NativeRecoveryObject }));
    const encoded = await metadata.getRecoveryInventory();
    if (!encoded) throw new Error("Recovery target has not been verified.");
    const originalId = JSON.parse(encoded).sourceId;
    if (sourceId.startsWith("user-")) {
      const profile = this.ctx.storage.kv.get<{ id: string }>("profile");
      if (!profile || typeof profile.id !== "string") throw new Error("Archived user has no original login identity.");
      return { namespace: "UserDurableObject", name: profile.id, originalId };
    }
    const namespace = sourceId === "root-admin" ? "AdminSettings" : sourceId === "root-users" ? "UserDirectoryDurableObject"
      : sourceId === "root-identities" ? "IdentityDirectory" : undefined;
    return namespace ? { namespace, name: "", originalId } : null;
  }

  /** Record explicit activation outside application state, surviving hub restarts. */
  setRecoveryRuntimeActivated(): void { this.ctx.storage.kv.put("runtimeActive", true); }

  /** Check that this runtime passed the driver's all-roots-prepared activation phase. */
  isRecoveryRuntimeActivated(): boolean { return this.ctx.storage.kv.get("runtimeActive") === true; }

  async #runtimeIdentity(requireActive = true): Promise<RecoveryRuntimeIdentity> {
    const inventory = this.ctx.facets.get<NativeRecoveryObject>(".recoveryInventory", () => ({ class: this.ctx.exports.NativeRecoveryObject }));
    const encoded = await inventory.getRecoveryRuntimeIdentity();
    if (!encoded) throw new Error("Recovery runtime has not been prepared.");
    if (requireActive && !await inventory.isRecoveryRuntimeActivated()) throw new Error("Recovery runtime has not been activated.");
    return JSON.parse(encoded);
  }

  #runtimeFacet(identity: RecoveryRuntimeIdentity) {
    const classes = { user: this.ctx.exports.UserDurableObject, workspace: this.ctx.exports.OverseerDurableObject,
      admin: this.ctx.exports.AdminSettings, users: this.ctx.exports.UserDirectoryDurableObject, identities: this.ctx.exports.IdentityDirectory };
    return this.ctx.facets.get(".runtime", () => ({ class: classes[identity.kind], id: identity.originalId }));
  }

  /** Select original application classes only after every recovered root has been prepared. */
  async activateRecoveryRuntime(): Promise<void> {
    const identity = await this.#runtimeIdentity(false);
    this.ctx.facets.abort(".runtime", new Error("Activate isolated original runtime"));
    const inventory = this.ctx.facets.get<NativeRecoveryObject>(".recoveryInventory", () => ({ class: this.ctx.exports.NativeRecoveryObject }));
    await inventory.setRecoveryRuntimeActivated();
    this.#runtimeFacet(identity);
  }

  /** Route a trusted call to original code in this isolated root, preserving its source ID. */
  async callRecoveryRuntime(method: string, args: unknown[]): Promise<unknown> {
    if (typeof method !== "string" || !Array.isArray(args) || method === "constructor") throw new Error("Invalid recovery runtime call.");
    const facet = await this.ctx.restore({ runtime: await this.#runtimeIdentity() });
    return await Reflect.apply(Reflect.get(facet, method), facet, args);
  }

  /** Mint the original runtime through the parent's restore chain, allowing persistent app callbacks. */
  async getRecoveryRuntime(): Promise<unknown> { return await this.ctx.restore({ runtime: await this.#runtimeIdentity() }); }

  /** Open the original recovered workspace through its existing public capability contract. */
  async openRecoveryWorkspace() {
    const identity = await this.#runtimeIdentity();
    if (identity.kind !== "workspace") throw new Error("Recovery target is not a workspace.");
    const facet: Fetcher<OverseerDurableObject> = await this.ctx.restore({ runtime: identity });
    return await facet.openRecoveryWorkspace();
  }

  /** Exercise original product reads and loaded applications; throw if the recovered runtime is unusable. */
  async verifyRecoveryRuntime(): Promise<{ kind: string; sourceId: string; summary: string }> {
    const identity = await this.#runtimeIdentity();
    let summary: unknown;
    if (identity.kind === "user") summary = await this.callRecoveryRuntime("whoami", []);
    else if (identity.kind === "workspace") summary = await this.callRecoveryRuntime("verifyRecoveryApplications", []);
    else if (identity.kind === "users") summary = await this.callRecoveryRuntime("searchUsers", ["", []]);
    else summary = await this.callRecoveryRuntime("getRecoverySnapshot", []);
    return { kind: identity.kind, sourceId: identity.sourceId, summary: JSON.stringify(summary) };
  }

  #runtimeCodec(identity: RecoveryRuntimeIdentity, service?: RpcStub<NativeRecoveryService>): RecoveryValueCodec {
    const codec = nativeRecoveryCodec(service);
    return { describe: codec.describe, restore: async descriptor => {
      let value: any = descriptor;
      if (value?.kind === "native-class") value = await decodePortableValue(JSON.parse(value.value), this.#runtimeCodec(identity, service));
      if (value?.kind === "workshop-agent-spawner-class") return this.ctx.exports.AgentSpawnerGatekeeper({ props: { ...value.props, recoveryScope: identity.scope, recoveryNamedIds: identity.namedIds } });
      if (value?.kind === "workshop-language-model-class") return this.ctx.exports.LanguageModelGatekeeper({ props: { ...value.props, recoveryScope: identity.scope, recoveryNamedIds: identity.namedIds } });
      if (value?.kind === "workshop-hook") return this.ctx.exports.GatekeeperHookLoopback({ props: { ...value.props, recoveryScope: identity.scope, recoveryNamedIds: identity.namedIds } });
      if (value?.kind === "workshop-agent-self") return this.ctx.exports.AgentSelfLoopback({ props: { ...value.props, recoveryScope: identity.scope, recoveryNamedIds: identity.namedIds } });
      if (value?.kind === "gadget" || value?.kind === "gadget-callback") {
        const params = value.kind === "gadget-callback" ? await decodePortableValue(value.params, this.#runtimeCodec(identity, service)) : undefined;
        return this.ctx.exports.RecoveryGadgetRoute({ props: { scope: identity.scope, descriptor: JSON.stringify(value), params } });
      }
      return await codec.restore(value);
    } };
  }
  /** Rebind verified native routes and classes to inactive targets, preserving their source identity. */
  async resolveRecoveryCapability(encoded: string, key: string): Promise<unknown> {
    if (!this.ctx.id.name?.startsWith("recovery-")) throw new Error("Recovery capabilities require an isolated named target.");
    const descriptor = JSON.parse(encoded);
    if (!descriptor || typeof descriptor.kind !== "string") throw new Error("Invalid recovered capability descriptor.");
    if (["workshop-agent-spawner-class", "workshop-language-model-class"].includes(descriptor.kind)) {
      return this.ctx.exports.NativeRecoveryObject({ props: { descriptor, key } });
    }
    if (["gadget", "gadget-callback", "workshop-agent-self"].includes(descriptor.kind)) {
      return await this.ctx.restore({ descriptor, key });
    }
    if (descriptor.kind === "workshop-hook") {
      return this.ctx.exports.NativeRecoveryHook({ props: { scope: this.ctx.id.name,
        overseerId: descriptor.props.overseerId, hookId: descriptor.props.hookId } });
    }
    throw new Error(`Unsupported isolated native capability: ${descriptor.kind}`);
  }

  /** Attest original class props while keeping restored application behavior inactive. */
  getRecoveryClassDescriptor() {
    if (!this.ctx.props.descriptor || !this.ctx.props.key) throw new Error("No recovered class descriptor.");
    return sealCapabilityDescriptor(this.ctx.props.key, this.ctx.props.descriptor);
  }
  /** Recreate a persistent capability rooted only in this isolated destination. */
  async resolveRecoveryGadget(encoded: string, key: string) {
    if (!this.ctx.id.name?.startsWith("recovery-")) throw new Error("Recovery capabilities require an isolated named target.");
    const descriptor = JSON.parse(encoded);
    if (!descriptor || !["gadget", "gadget-callback"].includes(descriptor.kind)) throw new Error("Invalid recovered gadget descriptor.");
    return await this.ctx.restore({ descriptor, key });
  }

  /** Restore retained identity without executing application code or pending callbacks. */
  async [restore](params: { descriptor: unknown; key: string; runtime?: RecoveryRuntimeIdentity }) {
    if (params.runtime) {
      const identity = await this.#runtimeIdentity();
      if (JSON.stringify(identity) !== JSON.stringify(params.runtime)) throw new Error("Recovery runtime identity does not match its activation record.");
      return this.#runtimeFacet(identity);
    }
    return new RecoveredNativeCapability(params.descriptor, params.key);
  }

  /** Export all native storage, rejecting any value the trusted resolver cannot describe. */
  async exportRecoveryStorage(service?: RpcStub<NativeRecoveryService>): Promise<string> {
    return JSON.stringify(await captureNativeStorage(this.ctx.storage, nativeRecoveryCodec(service)));
  }

  /** Stage into empty inactive storage; alarms remain paused. */
  async stageRecoveryStorage(snapshot: string,
      service?: RpcStub<NativeRecoveryService>): Promise<void> {
    await restoreNativeStorage(this.ctx.storage, JSON.parse(snapshot), nativeRecoveryCodec(service));
  }

  /** Stage one complete source root and all facets under this explicitly isolated destination. */
  async stageRecoverySnapshot(encoded: string, service?: RpcStub<NativeRecoveryService>): Promise<void> {
    const snapshot: NativeRecoverySnapshot = JSON.parse(encoded);
    if (!snapshot || typeof snapshot.id !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.id) ||
        !Array.isArray(snapshot.facets) || snapshot.facets.some(facet => !facet || typeof facet.name !== "string" ||
          !/^(gadget\d*|gatekeeper\d+)$/.test(facet.name)) ||
        new Set(snapshot.facets.map(facet => facet.name)).size !== snapshot.facets.length) {
      throw new Error("Invalid native recovery root inventory.");
    }
    if (!this.ctx.id.name?.startsWith("recovery-")) throw new Error("Native recovery requires an isolated named target.");
    await this.stageRecoveryStorage(JSON.stringify(snapshot.storage), service);
    for (const facet of snapshot.facets) {
      const target = this.ctx.facets.get<NativeRecoveryObject>(facet.name, () => ({ class: this.ctx.exports.NativeRecoveryObject }));
      await target.stageRecoveryStorage(JSON.stringify(facet.storage), service);
    }
    const metadata = this.ctx.facets.get<NativeRecoveryObject>(".recoveryInventory", () => ({ class: this.ctx.exports.NativeRecoveryObject }));
    await metadata.setRecoveryInventory(JSON.stringify({ sourceId: snapshot.id, facets: snapshot.facets.map(facet => facet.name),
      alarm: snapshot.storage.alarm, facetAlarms: Object.fromEntries(snapshot.facets.map(facet => [facet.name, facet.storage.alarm])) }));
  }

  /** Keep staging metadata outside application storage so source rows remain byte-for-byte recoverable. */
  setRecoveryInventory(encoded: string): void {
    if ([...this.ctx.storage.kv.list()].length) throw new Error("Recovery inventory target is occupied.");
    this.ctx.storage.kv.put("inventory", encoded);
  }

  /** Return the independently stored source identity and explicit facet inventory. */
  getRecoveryInventory(): string | undefined { return this.ctx.storage.kv.get<string>("inventory"); }

  /** Revoke restored user login and incomplete connect credentials after byte-for-byte staging verification. */
  invalidateRecoverySessions(): void {
    if (!this.ctx.id.name?.startsWith("recovery-")) throw new Error("Session invalidation requires an isolated named target.");
    this.ctx.storage.transactionSync(() => {
      for (const prefix of ["sessions:", "pendingHandoffs:", "pendingConnectFlows:"]) {
        for (const key of Array.from(this.ctx.storage.kv.list({ prefix }), ([key]) => key)) {
          this.ctx.storage.kv.delete(key);
        }
      }
    });
  }

  /** Read every staged root/facet back through the same portable serializer, without activating code. */
  async getRecoverySnapshot(service?: RpcStub<NativeRecoveryService>): Promise<string> {
    const metadata = this.ctx.facets.get<NativeRecoveryObject>(".recoveryInventory", () => ({ class: this.ctx.exports.NativeRecoveryObject }));
    const encoded = await metadata.getRecoveryInventory();
    if (!encoded) throw new Error("Native recovery staging is incomplete.");
    const inventory: { sourceId: string; facets: string[]; alarm: number | null; facetAlarms: Record<string, number | null> } = JSON.parse(encoded);
    const snapshot = await captureNativeRoot(this.ctx, service);
    snapshot.id = inventory.sourceId;
    if (snapshot.storage.alarm !== null) throw new Error("Isolated recovery target unexpectedly has an active alarm.");
    snapshot.storage.alarm = inventory.alarm;
    for (const name of inventory.facets) {
      const facet = this.ctx.facets.get<NativeRecoveryObject>(name, () => ({ class: this.ctx.exports.NativeRecoveryObject }));
      const storage: NativeStorageSnapshot = JSON.parse(await facet.exportRecoveryStorage(service));
      if (storage.alarm !== null) throw new Error("Isolated recovery facet unexpectedly has an active alarm.");
      storage.alarm = inventory.facetAlarms[name] ?? null;
      snapshot.facets.push({ name, storage });
    }
    return JSON.stringify(snapshot);
  }

  /** Report a diagnostic runtime bookmark; the driver validates portable content instead. */
  getRecoveryBookmark(): Promise<string> { return this.ctx.storage.getCurrentBookmark(); }

  /** Imported application alarms never execute while the object is isolated. */
  async alarm(): Promise<void> { await this.ctx.storage.deleteAlarm(); }
}

/** A persisted restored hook retains its routing identity while remaining inert until cutover. */
export class NativeRecoveryHook extends WorkerEntrypoint<Cloudflare.Env, { scope: string; overseerId: string; hookId: number }> {
  /** Preserve the original source identity when checking an isolated restored archive. */
  getRecoveryDescriptor() {
    return sealCapabilityDescriptor(this.env.BACKUP_CAPABILITY_KEY, {
      kind: "workshop-hook", props: { overseerId: this.ctx.props.overseerId, hookId: this.ctx.props.hookId },
    });
  }

  /** Prevent scheduled work or external sends from an isolated restored deployment. */
  startHook(): never { throw new Error("Restored hooks are paused in the isolated recovery target."); }
}

class RecoveredNativeCapability extends RpcTarget {
  constructor(private readonly descriptor: unknown, private readonly key: string) { super(); }
  getRecoveryDescriptor() { return sealCapabilityDescriptor(this.key, this.descriptor); }
}

/** A persisted recovered application capability forwards only into its isolated original workspace. */
export class RecoveryGadgetRoute extends WorkerEntrypoint<Cloudflare.Env, { scope: string; descriptor: string; params?: unknown }> {
  constructor(ctx: ExecutionContext<{ scope: string; descriptor: string; params?: unknown }>, env: Cloudflare.Env) {
    super(ctx, env);
    const descriptor = JSON.parse(ctx.props.descriptor);
    if (!/^recovery-[A-Za-z0-9_-]+$/.test(ctx.props.scope) || !/^[a-f0-9]{64}$/.test(descriptor.overseerId)) {
      throw new Error("Invalid isolated gadget capability route.");
    }
    return new Proxy(this, {
      get(target, property) {
        if (typeof property === "symbol" || property === "getRecoveryDescriptor") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        if (property === "then") return undefined;
        return (...args: unknown[]) => ctx.exports.NativeRecoveryObject.getByName(`${ctx.props.scope}-workspace-${descriptor.overseerId}`)
          .callRecoveryRuntime("invokeRecoveryGadget", [descriptor, ctx.props.params, property, args]);
      },
    });
  }

  /** Preserve the original authenticated descriptor for archive round-trip verification. */
  getRecoveryDescriptor() { return sealCapabilityDescriptor(this.env.BACKUP_CAPABILITY_KEY, JSON.parse(this.ctx.props.descriptor)); }
}

/** Export one fenced root without facets; callers validate its portable contents before publishing. */
export async function captureNativeRoot(ctx: DurableObjectState,
    service?: RpcStub<NativeRecoveryService>, classes?: WeakMap<object, PortableDescriptor>,
    classDescriptors?: Map<number, PortableDescriptor>): Promise<NativeRecoverySnapshot> {
  await ctx.storage.sync();
  const storage = await captureNativeStorage(ctx.storage, nativeRecoveryCodec(service, classes, classDescriptors, true));
  const bookmark = await ctx.storage.getCurrentBookmark();
  return { id: ctx.id.toString(), storage, facets: [], bookmark };
}

/** Preserve complete class props, including nested capabilities, before storing a class descriptor. */
export async function nativeClassDescriptor(value: unknown, service?: RpcStub<NativeRecoveryService>): Promise<PortableDescriptor> {
  return { kind: "native-class", value: JSON.stringify(await encodePortableValue(value, nativeRecoveryCodec(service))) };
}
