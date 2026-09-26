import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const require = createRequire(new URL("../../package.json", import.meta.url));
const { build } = require("esbuild");
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");

async function withRuntime(run: (mf: any) => Promise<void>) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("recovery-gadget.fixture.ts", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "browser", target: "esnext",
    external: ["cloudflare:workers"],
    alias: { "@gadgets/backend-utils/recovery-value": fileURLToPath(new URL("../../../backend-utils/src/recovery-value.ts", import.meta.url)) },
  });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "proof",
    modules: true, script: result.outputFiles[0].text,
    compatibilityDate: "2026-09-04",
    compatibilityFlags: ["experimental", "allow_irrevocable_stub_storage"],
    workerLoaders: { LOADER: {} },
    durableObjects: {
      PARENTS: { className: "RecoveryProofParent", useSQLite: true },
      INSPECTORS: { className: "RecoveryGadgetInspector", useSQLite: true },
      RESTORERS: { className: "NativeRecoveryObject", useSQLite: true },
      SNAPSHOT_SOURCES: { className: "RecoverySnapshotSource", useSQLite: true },
      SNAPSHOT_FACETS: { className: "RecoverySnapshotFacet", useSQLite: true },
      FENCED_PARENTS: { className: "RecoveryFencedParent", useSQLite: true },
      IDENTITY_SOURCE: { className: "RecoveryNamespaceIdentity", scriptName: "identity-source" },
      IDENTITY_DESTINATION: { className: "RecoveryNamespaceIdentity", scriptName: "identity-destination" },
    },
  }, ...["identity-source", "identity-destination"].map(name => ({
    name, modules: true, script: result.outputFiles[0].text,
    compatibilityDate: "2026-09-04", compatibilityFlags: ["experimental", "allow_irrevocable_stub_storage"],
    durableObjects: { IDENTITY: { className: "RecoveryNamespaceIdentity", useSQLite: true } },
  }))] }));
  try { await run(mf); } finally { await mf.dispose(); }
}

test("legacy persisted callback yields trusted original params and restores into isolated app storage", async () => {
  await withRuntime(async mf => {
    const response = await mf.dispatchFetch("http://proof.test/");
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const actual = JSON.parse(body);
    assert.equal(actual.descriptor.kind, "gadget-callback");
    assert.equal(actual.descriptor.gadgetId, 7);
    assert.equal(actual.tamperRejected, true);
    assert.equal(actual.replayRejected, true);
    assert.ok(actual.applicationCountsBeforeInspection.constructions > 0);
    assert.ok(actual.applicationCountsBeforeInspection.restores > 0);
    assert.deepEqual(actual.applicationCountsDuringInspection, actual.applicationCountsBeforeInspection,
      "trusted inspection runs neither application constructor nor application restore hook");
    const expected = { tag: "original-sealed-params", when: "2026-01-02T03:04:05.000Z", bytes: [3, 7] };
    assert.deepEqual(actual.source, [{ ...expected, value: "source-before-export" }]);
    assert.deepEqual(actual.destination, [
      { ...expected, value: "source-before-export" },
      { ...expected, value: "isolated-after-recovery" },
    ]);
  });
});

test("raw Durable Object IDs are rejected by a distinct namespace running the same class", async () => {
  await withRuntime(async mf => {
    const response = await mf.dispatchFetch("http://proof.test/namespace-identity");
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const result = JSON.parse(body);
    assert.notEqual(result.sourceId, result.destinationNamedId, "namespace identities must actually differ");
    assert.equal(result.sourceAfter, "original-source-value");
    assert.equal(result.destinationNamed, "separate-destination-value");
    assert.equal(result.accepted, false);
    assert.equal(result.error, "TypeError: Durable Object ID is not valid for this namespace.");
  });
});

test("nested persistent callback params use trusted recursive descriptors and restore into destination storage", async () => {
  await withRuntime(async mf => {
    const response = await mf.dispatchFetch("http://proof.test/nested-callback");
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const result = JSON.parse(body);
    assert.deepEqual(result.source.map((write: any) => [write.tag, write.value]), [
      ["inner-sealed-params", "nested-source-before-export"],
      ["original-sealed-params", "source-before-export"],
    ]);
    assert.deepEqual(result.destination.map((write: any) => [write.tag, write.value]), [
      ["inner-sealed-params", "nested-source-before-export"],
      ["original-sealed-params", "source-before-export"],
      ["inner-sealed-params", "nested-isolated-after-recovery"],
      ["original-sealed-params", "isolated-after-recovery"],
    ]);
    assert.deepEqual(result.applicationCountsDuringInspection, result.applicationCountsBeforeInspection);
  });
});

test("persisted fence plus root abort revokes existing session writes and survives same-run retry", async () => {
  await withRuntime(async mf => {
    const response = await mf.dispatchFetch("http://proof.test/abort-fence");
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.deepEqual(JSON.parse(body), {
      resetRejected: true,
      sameRunRetrySucceeded: true,
      rootWriteBlocked: true,
      mintBlocked: true,
      staleSessionBlocked: true,
      differentRunBlocked: true,
      state: { maintenance: true, run: "proof-run", applicationStarts: 1,
        writes: ["before-fence"], rootWrite: null },
    });
  });
});

test("NativeRecoveryObject stages complete root and facet inventories only into empty isolated targets", async () => {
  await withRuntime(async mf => {
    const seed = await mf.dispatchFetch("http://proof.test/snapshot/seed");
    const seedBody = await seed.text();
    assert.equal(seed.status, 200, seedBody);
    const source = JSON.parse(seedBody);
    assert.ok(source.storage.alarm > 0, "source snapshot retains its scheduled alarm");
    const stage = (name: string, snapshot: unknown) => mf.dispatchFetch(
      "http://proof.test/snapshot/stage?name=" + encodeURIComponent(name),
      { method: "POST", body: JSON.stringify(snapshot) });
    const staged = await stage("recovery-full-inventory", source);
    const stagedBody = await staged.text();
    assert.equal(staged.status, 200, stagedBody);
    const recovered = JSON.parse(stagedBody);
    assert.equal(recovered.id, source.id);
    assert.deepEqual(recovered.storage, source.storage);
    assert.deepEqual(recovered.facets, source.facets);
    assert.deepEqual(recovered.facets.map((facet: any) => facet.name), ["gadget7", "gatekeeper3"]);
    const liveStorage = await mf.dispatchFetch("http://proof.test/snapshot/storage?name=recovery-full-inventory");
    assert.equal(liveStorage.status, 200);
    assert.equal((await liveStorage.json()).alarm, null, "isolated target's actual runtime alarm remains paused");

    const readback = await mf.dispatchFetch("http://proof.test/snapshot/read?name=recovery-full-inventory");
    assert.equal(readback.status, 200);
    const readbackSnapshot = await readback.json();
    assert.deepEqual({ ...readbackSnapshot, bookmark: undefined }, { ...recovered, bookmark: undefined });
    const occupied = await stage("recovery-full-inventory", source);
    assert.equal(occupied.status, 400);
    assert.match((await occupied.json()).error, /empty|occupied/i);
    const retained = await mf.dispatchFetch("http://proof.test/snapshot/read?name=recovery-full-inventory");
    const retainedSnapshot = await retained.json();
    assert.deepEqual({ ...retainedSnapshot, bookmark: undefined }, { ...recovered, bookmark: undefined },
      "occupied destination retains original staged state");

    for (const [name, invalid, expected] of [
      ["ordinary-production-name", source, /isolated named target/],
      ["recovery-duplicate", { ...source, facets: [source.facets[0], source.facets[0]] }, /Invalid native recovery root inventory/],
      ["recovery-invalid-facet", { ...source, facets: [{ ...source.facets[0], name: "gadget/7" }] }, /Invalid native recovery root inventory/],
      ["recovery-invalid-id", { ...source, id: "invalid" }, /Invalid native recovery root inventory/],
    ] as const) {
      const rejected = await stage(name, invalid);
      assert.equal(rejected.status, 400, name);
      assert.match((await rejected.json()).error, expected, name);
      const incomplete = await mf.dispatchFetch("http://proof.test/snapshot/read?name=" + name);
      assert.equal(incomplete.status, 400, "rejected target has no completed recovery inventory");
      assert.match((await incomplete.json()).error, /staging is incomplete/);
    }
    const original = await mf.dispatchFetch("http://proof.test/snapshot/source");
    assert.equal(original.status, 200);
    const originalSnapshot = await original.json();
    assert.deepEqual({ ...originalSnapshot, bookmark: undefined }, { ...source, bookmark: undefined },
      "original root and facets remain unchanged; read-only verification may advance bookmarks");
  });
});

test("parent bookmark covers facet writes but also advances for reads; facet alarms remain unsupported", async () => {
  await withRuntime(async mf => {
    const direct = await mf.dispatchFetch("http://proof.test/bookmark-reads");
    const directBookmarks = await direct.json();
    assert.equal(directBookmarks.length, 4);
    for (let i = 1; i < directBookmarks.length; i++) assert.ok(directBookmarks[i] > directBookmarks[i - 1]);
    const response = await mf.dispatchFetch("http://proof.test/bookmarks");
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const observations = JSON.parse(body);
    assert.deepEqual(observations.map((entry: any) => entry.operation), [
      "initial", "bookmark-only-first", "bookmark-only-second", "facet-kv-write", "facet-sql-write", "facet-clone", "facet-delete",
      "root-read-alarm", "root-empty-transaction",
    ]);
    for (let index = 0; index < observations.length; index++) {
      const entry = observations[index];
      assert.equal(entry.parent, entry.facet, entry.operation);
      if (index > 0) assert.ok(entry.parent > observations[index - 1].parent, entry.operation);
    }
    for (const method of ["setAlarm", "clearAlarm"]) {
      const alarm = await mf.dispatchFetch("http://proof.test/facet-alarm?method=" + method);
      const result = await alarm.json();
      if (method === "setAlarm") assert.match(result.error, /Facets currently cannot set alarms/);
      else {
        assert.equal(result.error, null);
        assert.ok(result.after > result.before, "facet deleteAlarm advances parent bookmark");
      }
    }
  });
});
