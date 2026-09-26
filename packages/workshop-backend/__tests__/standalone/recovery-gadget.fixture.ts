import { DurableObject, RpcTarget, WorkerEntrypoint, restore } from "cloudflare:workers";
import { decodePortableValue } from "@gadgets/backend-utils/recovery-value";
import { verifyGadgetRecoveryDescriptor, type GadgetRecoveryDescriptor } from "../../src/recovery-gadget";
import { captureNativeStorage } from "@gadgets/backend-utils/recovery-native";
import { beginNativeRecovery, captureNativeRoot, fenceNativeRecoveryMethods,
  NativeRecoveryService, readNativeRecovery, registerNativeRecoveryObject } from "../../src/native-recovery";
export { RecoveryGadgetInspector } from "../../src/recovery-gadget";
export { NativeRecoveryObject } from "../../src/native-recovery";

const application = `
import { DurableObject, RpcTarget, restore } from 'cloudflare:workers';
export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.storage.kv.put('application-constructions', (this.ctx.storage.kv.get('application-constructions') || 0) + 1);
  }
  mint(params) { return this.ctx.restore(params); }
  [restore](params) {
    this.ctx.storage.kv.put('application-restores', (this.ctx.storage.kv.get('application-restores') || 0) + 1);
    return new Callback(this.ctx.storage, params);
  }
  executionCounts() {
    return { constructions: this.ctx.storage.kv.get('application-constructions'), restores: this.ctx.storage.kv.get('application-restores') };
  }
  async read() { return (await this.ctx.storage.get('writes')) || []; }
  initializeSql() { this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counters (value INTEGER)'); }
  writeKv() { return this.ctx.storage.put('bookmark-proof', 1); }
  writeSql() { this.ctx.storage.sql.exec('INSERT INTO counters VALUES (1)'); }
  setAlarm() { return this.ctx.storage.setAlarm(Date.now() + 3600000); }
  alarm() {}
  clearAlarm() { return this.ctx.storage.deleteAlarm(); }
  getRecoveryBookmark() { return this.ctx.storage.getCurrentBookmark(); }
}
class Callback extends RpcTarget {
  constructor(storage, params) {
    super(); this.storage = storage;
    this.params = params.inner ? { ...params, inner: params.inner.dup() } : params;
  }
  async invoke(value) {
    if (this.params.inner) await this.params.inner.invoke('nested-' + value);
    const writes = (await this.storage.get('writes')) || [];
    writes.push({ value, tag: this.params.tag, when: this.params.when.toISOString(), bytes: [...this.params.bytes] });
    await this.storage.put('writes', writes);
    return writes.length;
  }
  getRecoveryDescriptor() { return { payload: '{"kind":"gadget","gadgetId":999}', signature: '0'.repeat(64) }; }
}
`;

export class RecoveryProofParent extends DurableObject {
  #key: string | undefined;

  getRecoveryBookmark(): Promise<string> {
    return this.ctx.storage.getCurrentBookmark();
  }

  async bookmarkReads() {
    const bookmarks: string[] = [];
    for (let i = 0; i < 4; i++) bookmarks.push(await this.ctx.storage.getCurrentBookmark());
    return bookmarks;
  }

  async bookmarkProof() {
    const gadget = await this.ctx.restore({ type: "gadget", gadgetId: 7 });
    await gadget.initializeSql();
    const observations: Array<{ operation: string; parent: string; facet: string; error?: string }> = [];
    const record = async (operation: string, error?: string) => observations.push({
      operation, parent: await this.getRecoveryBookmark(), facet: await gadget.getRecoveryBookmark(), error,
    });
    await record("initial");
    await record("bookmark-only-first");
    await record("bookmark-only-second");
    await gadget.writeKv();
    await record("facet-kv-write");
    await gadget.writeSql();
    await record("facet-sql-write");
    this.ctx.facets.clone("gadget/7", "gadget/cloned");
    await record("facet-clone");
    this.ctx.facets.delete("gadget/cloned");
    await record("facet-delete");
    await this.ctx.storage.getAlarm();
    await record("root-read-alarm");
    this.ctx.storage.transactionSync(() => {});
    await record("root-empty-transaction");
    return observations;
  }

  async alarmProof(method: string) {
    const gadget = await this.ctx.restore({ type: "gadget", gadgetId: 7 });
    await gadget.initializeSql();
    const before = await this.getRecoveryBookmark();
    await gadget[method]();
    return { before, after: await this.getRecoveryBookmark() };
  }


  [restore](params: { type: string; gadgetId: number }) {
    if (params.type !== "gadget" || params.gadgetId !== 7) throw new Error("Unknown gadget");
    return this.ctx.facets.get("gadget/7", () => ({
      class: this.#key
        ? this.ctx.exports.RecoveryGadgetInspector({ props: {
          scope: { overseerId: this.ctx.id.toString(), gadgetId: 7 }, key: this.#key,
        } })
        : this.env.LOADER.get("legacy-app", () => ({
          compatibilityDate: "2026-09-04",
          compatibilityFlags: ["allow_irrevocable_stub_storage"],
          mainModule: "server.js", modules: { "server.js": application }, globalOutbound: null,
        })).getDurableObjectClass("Gadget"),
      id: "gadget/7",
    }));
  }

  async seed(nested = false) {
    const gadget = await this.ctx.restore({ type: "gadget", gadgetId: 7 });
    const params: any = {
      tag: "original-sealed-params", when: new Date("2026-01-02T03:04:05Z"), bytes: new Uint8Array([3, 7]),
    };
    if (nested) params.inner = await gadget.mint({ ...params, tag: "inner-sealed-params" });
    const callback = await gadget.mint(params);
    await this.ctx.storage.put("legacy-callback", callback);
    await callback.invoke("source-before-export");
    await this.ctx.storage.put("pre-inspection-counts", await gadget.executionCounts());
    return await gadget.read();
  }

  async capture() {
    const key = crypto.randomUUID();
    this.#key = key;
    this.ctx.facets.abort("gadget/7", new Error("Enter trusted recovery inspection"));
    try {
      const service = new NativeRecoveryService({
        async describe(value: any) {
          return await verifyGadgetRecoveryDescriptor(key, await value.getRecoveryDescriptor(service)) as any;
        },
        restore() { throw new Error("Capture cannot restore a capability"); },
      });
      const callback: any = await this.ctx.storage.get("legacy-callback", { noCache: true });
      const signed = await callback.getRecoveryDescriptor(service);
      const descriptor = await verifyGadgetRecoveryDescriptor(key, signed);
      let tamperRejected = false;
      try {
        await verifyGadgetRecoveryDescriptor(key, { ...signed,
          payload: signed.payload.replace("original-sealed-params", "forged-params") });
      } catch { tamperRejected = true; }
      let replayRejected = false;
      try { await verifyGadgetRecoveryDescriptor(crypto.randomUUID(), signed); }
      catch { replayRejected = true; }
      const inspector = await this.ctx.restore({ type: "gadget", gadgetId: 7 });
      const storage = await inspector.exportRecoveryStorage();
      const contents = await decodePortableValue(JSON.parse(storage).values) as { kv: Map<string, unknown> };
      const applicationCountsDuringInspection = {
        constructions: contents.kv.get("application-constructions"),
        restores: contents.kv.get("application-restores"),
      };
      return { descriptor, storage, tamperRejected, replayRejected, applicationCountsDuringInspection,
        applicationCountsBeforeInspection: await this.ctx.storage.get("pre-inspection-counts") };
    } finally {
      this.#key = undefined;
      this.ctx.facets.abort("gadget/7", new Error("Leave trusted recovery inspection"));
    }
  }

  async install(descriptor: GadgetRecoveryDescriptor, storage: any) {
    if (descriptor.kind !== "gadget-callback") throw new Error("Expected callback");
    const target = this.ctx.facets.get("gadget/7", () => ({
      class: this.ctx.exports.NativeRecoveryObject, id: "gadget/7",
    }));
    await target.stageRecoveryStorage(storage);
    this.ctx.facets.abort("gadget/7", new Error("Activate restored application code"));
    const gadget = await this.ctx.restore({ type: "gadget", gadgetId: descriptor.gadgetId });
    const codec = {
      describe() { return undefined; },
      async restore(nested: any): Promise<unknown> {
        if (nested.kind !== "gadget-callback" || nested.gadgetId !== descriptor.gadgetId) {
          throw new Error("Unknown nested callback descriptor");
        }
        return gadget.mint(await decodePortableValue(nested.params, codec));
      },
    };
    const callback = await gadget.mint(await decodePortableValue(descriptor.params, codec));
    await this.ctx.storage.put("legacy-callback", callback);
  }

  async invoke(value: string) {
    const callback: any = await this.ctx.storage.get("legacy-callback", { noCache: true });
    return callback.invoke(value);
  }

  async read() {
    const gadget = await this.ctx.restore({ type: "gadget", gadgetId: 7 });
    return gadget.read();
  }
}

export class RecoverySnapshotFacet extends DurableObject {
  seed(label: string) {
    this.ctx.storage.kv.put("facet", { label, bytes: new Uint8Array([4, 8]), created: new Date("2026-03-04T00:00:00Z") });
    this.ctx.storage.sql.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, label TEXT)");
    this.ctx.storage.sql.exec("INSERT INTO records VALUES (13, ?)", label);
  }

  async snapshot() { return JSON.stringify(await captureNativeStorage(this.ctx.storage)); }
}

export class RecoverySnapshotSource extends DurableObject {
  alarm() {}

  async seed() {
    this.ctx.storage.kv.put("root", { nested: new Map([["count", 42n]]) });
    this.ctx.storage.sql.exec("CREATE TABLE roots (id INTEGER PRIMARY KEY, label TEXT)");
    this.ctx.storage.sql.exec("INSERT INTO roots VALUES (17, 'original-root')");
    for (const name of ["gadget7", "gatekeeper3"]) {
      await this.ctx.facets.get(name, () => ({ class: this.ctx.exports.RecoverySnapshotFacet })).seed(name);
    }
    await this.ctx.storage.setAlarm(Date.now() + 86400000);
    await this.ctx.storage.sync();
  }

  async snapshot() {
    const snapshot = await captureNativeRoot(this.ctx);
    for (const name of ["gadget7", "gatekeeper3"]) {
      const facet = this.ctx.facets.get(name, () => ({ class: this.ctx.exports.RecoverySnapshotFacet }));
      snapshot.facets.push({ name, storage: JSON.parse(await facet.snapshot()) });
    }
    return JSON.stringify(snapshot);
  }
}

class ExistingRecoverySession extends RpcTarget {
  #storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) { super(); this.#storage = storage; }
  write(value: string) {
    const writes = this.#storage.kv.get<string[]>("session-writes") ?? [];
    this.#storage.kv.put("session-writes", [...writes, value]);
  }
}

export class RecoveryFencedParent extends DurableObject {
  #maintenance: boolean;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    registerNativeRecoveryObject(this, ctx);
    this.#maintenance = !!readNativeRecovery(ctx);
    if (!this.#maintenance) {
      ctx.storage.kv.put("application-starts", (ctx.storage.kv.get<number>("application-starts") ?? 0) + 1);
    }
  }

  mint() { return new ExistingRecoverySession(this.ctx.storage); }
  write(value: string) { this.ctx.storage.kv.put("ordinary-root-write", value); }

  async beginRecovery(run: string, key: string) {
    if (beginNativeRecovery(this.ctx, run, key)) {
      await this.ctx.storage.sync();
      this.ctx.abort("Persisted recovery fence; discard existing sessions");
    }
  }

  getRecoveryState() {
    return {
      maintenance: this.#maintenance,
      run: readNativeRecovery(this.ctx)?.run,
      applicationStarts: this.ctx.storage.kv.get("application-starts"),
      writes: this.ctx.storage.kv.get("session-writes"),
      rootWrite: this.ctx.storage.kv.get("ordinary-root-write") ?? null,
    };
  }
}
fenceNativeRecoveryMethods(RecoveryFencedParent);

export class RecoveryFenceHolder extends WorkerEntrypoint {
  async run() {
    let parent = this.env.FENCED_PARENTS.getByName("existing-session-proof");
    const session = await parent.mint();
    await session.write("before-fence");
    const result: Record<string, unknown> = {};
    try { await parent.beginRecovery("proof-run", "a".repeat(64)); result.resetRejected = false; }
    catch { result.resetRejected = true; }
    parent = this.env.FENCED_PARENTS.getByName("existing-session-proof");
    await parent.beginRecovery("proof-run", "a".repeat(64));
    result.sameRunRetrySucceeded = true;
    try { await parent.write("after-fence"); result.rootWriteBlocked = false; }
    catch { result.rootWriteBlocked = true; }
    try { await parent.mint(); result.mintBlocked = false; }
    catch { result.mintBlocked = true; }
    try { await session.write("stale-session-after-fence"); result.staleSessionBlocked = false; }
    catch { result.staleSessionBlocked = true; }
    try { await parent.beginRecovery("other-run", "b".repeat(64)); result.differentRunBlocked = false; }
    catch { result.differentRunBlocked = true; }
    return { ...result, state: await parent.getRecoveryState() };
  }
}

export class RecoveryNamespaceIdentity extends DurableObject {
  write(value: string) { this.ctx.storage.kv.put("value", value); }
  read() { return this.ctx.storage.kv.get("value") ?? null; }
}

export default {
  async fetch(_request: Request, env: any, ctx: ExecutionContext) {
    const url = new URL(_request.url);
    if (url.pathname === "/namespace-identity") {
      const sourceId = env.IDENTITY_SOURCE.idFromName("same-logical-name");
      const destinationNamedId = env.IDENTITY_DESTINATION.idFromName("same-logical-name");
      const source = env.IDENTITY_SOURCE.get(sourceId);
      await source.write("original-source-value");
      const destinationNamed = env.IDENTITY_DESTINATION.get(destinationNamedId);
      await destinationNamed.write("separate-destination-value");
      const result: Record<string, unknown> = {
        sourceId: sourceId.toString(), destinationNamedId: destinationNamedId.toString(),
      };
      try {
        const copiedId = env.IDENTITY_DESTINATION.idFromString(sourceId.toString());
        result.accepted = true;
        result.copiedId = copiedId.toString();
        const destination = env.IDENTITY_DESTINATION.get(copiedId);
        result.destinationBefore = await destination.read();
        await destination.write("recovered-under-original-id");
        result.destinationAfter = await destination.read();
      } catch (error) { result.accepted = false; result.error = String(error); }
      return Response.json({ ...result, sourceAfter: await source.read(), destinationNamed: await destinationNamed.read() });
    }
    if (url.pathname === "/abort-fence") return Response.json(await ctx.exports.RecoveryFenceHolder.run());
    if (url.pathname === "/bookmark-reads") {
      return Response.json(await env.PARENTS.getByName("bookmark-reads-proof").bookmarkReads());
    }

    if (url.pathname.startsWith("/snapshot/")) {
      try {
        const source = env.SNAPSHOT_SOURCES.getByName("original-full-snapshot");
        if (url.pathname === "/snapshot/seed") {
          await source.seed();
          return new Response(await source.snapshot());
        }
        if (url.pathname === "/snapshot/source") return new Response(await source.snapshot());
        const target = env.RESTORERS.getByName(url.searchParams.get("name")!);
        if (url.pathname === "/snapshot/stage") {
          await target.stageRecoverySnapshot(await _request.text());
          return new Response(await target.getRecoverySnapshot());
        }
        if (url.pathname === "/snapshot/storage") return new Response(await target.exportRecoveryStorage());
        return new Response(await target.getRecoverySnapshot());
      } catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
    }
    if (new URL(_request.url).pathname === "/bookmarks") {
      return Response.json(await env.PARENTS.getByName("bookmark-proof").bookmarkProof());
    }
    if (new URL(_request.url).pathname === "/facet-alarm") {
      const method = new URL(_request.url).searchParams.get("method")!;
      try {
        const result = await env.PARENTS.getByName("alarm-" + method).alarmProof(method);
        return Response.json({ ...result, error: null });
      } catch (error) { return Response.json({ error: String(error) }); }
    }
    const source = env.PARENTS.getByName("source");
    const destination = env.PARENTS.getByName("isolated-destination");
    try { await source.seed(url.pathname === "/nested-callback"); }
    catch (error) { throw new Error(`seed: ${error}`, { cause: error }); }
    let capture;
    try { capture = await source.capture(); }
    catch (error) { throw new Error(`capture: ${error}`, { cause: error }); }
    try { await destination.install(capture.descriptor, capture.storage); }
    catch (error) { throw new Error(`install: ${error}`, { cause: error }); }
    try { await destination.invoke("isolated-after-recovery"); }
    catch (error) { throw new Error(`invoke: ${error}`, { cause: error }); }
    return Response.json({ ...capture, source: await source.read(), destination: await destination.read() });
  },
};
