import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(new URL("../../package.json", import.meta.url));
const { build } = require("esbuild");
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");

test("archived IDs and names recover original classes, callbacks, and nested facets after the source namespace is unavailable", async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("recovery-route.fixture.ts", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "browser", target: "esnext",
    external: ["cloudflare:workers"],
  });
  const directory = await mkdtemp(join(tmpdir(), "recovery-route-proof-"));
  const runtime = (name: string, persist = false) => new Miniflare({ ...convertV4MiniflareOptions({
    workers: [{
      name, kvNamespaces: ["BLUEPRINTS", "BLUEPRINTS_RESTORE"], bindings: { WORKERS_AI: "source-only", PRODUCT_ANALYTICS: "source-only", BROWSER: "source-only" }, modules: true, script: result.outputFiles[0].text,
      compatibilityDate: "2026-09-04", compatibilityFlags: ["experimental", "allow_irrevocable_stub_storage"],
      durableObjects: Object.fromEntries(["UserDurableObject", "RouteChild", "NativeRecoveryObject", "RouteInspector", "RouteChildInspector", "LanguageModelGatekeeper"].map(className => [className, { className, useSQLite: true }])),
    }],
  }), ...(persist ? { resourcePersistencePath: directory } : {}) });
  let source = runtime("original-source", true);
  let recovered;
  try {
    const seed = await source.dispatchFetch("http://proof.test/seed");
    const seedBody = await seed.text();
    assert.equal(seed.status, 200, seedBody);
    const snapshot = JSON.parse(seedBody);
    const sourceBefore = await (await source.dispatchFetch("http://proof.test/source")).json();
    assert.deepEqual(sourceBefore.externalCapabilities, { WORKERS_AI: true, PRODUCT_ANALYTICS: true, BROWSER: true });
    // No source worker, service binding, or source storage is present in the recovery runtime.
    await source.dispose();
    source = undefined;
    recovered = runtime("replacement-namespace");
    const query = new URLSearchParams({ idA: snapshot.a.id, idB: snapshot.b.id });
    const request = (path: string) => recovered.dispatchFetch("http://proof.test/" + path + "?" + query);
    const replacement = await request("replacement-identity");
    assert.equal(replacement.status, 200);
    const replacementIdentity = await replacement.json();
    assert.notEqual(replacementIdentity.namedId, snapshot.a.id);
    assert.equal(replacementIdentity.error, "TypeError: Durable Object ID is not valid for this namespace.");

    const stage = await recovered.dispatchFetch("http://proof.test/stage", { method: "POST", body: JSON.stringify({ scope: "recovery-proof", ...snapshot }) });
    const stageBody = await stage.text();
    assert.equal(stage.status, 200, stageBody);
    const exercise = await request("exercise");
    const body = await exercise.text();
    assert.equal(exercise.status, 200, body);
    const actual = JSON.parse(body);
    assert.deepEqual(actual.ids, { a: { id: snapshot.a.id, peer: snapshot.b.id }, b: { id: snapshot.b.id, peer: snapshot.a.id } });
    assert.deepEqual(actual.before, { a: "original-A", b: "original-B", child: "child-original-A" });
    assert.equal(actual.peerWrite, "isolated-peer-write");
    assert.equal(actual.callbackId, snapshot.a.id);
    assert.equal(actual.loopbackScope, "recovery-proof");
    assert.equal(actual.loopbackValue, "isolated-loopback-write");
    assert.deepEqual(actual.namedWrite, { id: snapshot.b.id, value: "isolated-named-write" });
    assert.match(actual.rejectedIdentities[0], /Invalid archived Durable Object ID/);
    assert.match(actual.rejectedIdentities[1], /no archived identity.*missing-name/);
    for (const error of actual.rejectedIdentities.slice(2)) assert.match(error, /cannot allocate new root identities/);
    assert.equal(actual.blueprint, "isolated-blueprint");
    assert.equal(actual.workersAI, false);
    assert.deepEqual(actual.externalCapabilities, { WORKERS_AI: false, PRODUCT_ANALYTICS: false, BROWSER: false });
    assert.equal(actual.modelError, "Error: Model execution is paused in isolated recovery.");
    assert.deepEqual(actual.isolated, { a: "original-A", b: "isolated-callback-write", child: "original-params:isolated-callback-write" });

    const reset = await request("reset");
    assert.equal(reset.status, 200);
    const aborted = await reset.json();
    assert.equal(aborted.length, 2);
    for (const error of aborted) assert.match(error, /Recovery route proof reset/);
    const restarted = await request("exercise");
    const restartedBody = await restarted.text();
    assert.equal(restarted.status, 200, restartedBody);
    const afterRestart = JSON.parse(restartedBody);
    assert.deepEqual(afterRestart.before, actual.isolated);
    assert.deepEqual(afterRestart.isolated, actual.isolated);
    assert.equal(afterRestart.callbackId, snapshot.a.id);
    assert.equal(afterRestart.loopbackScope, "recovery-proof");
    assert.deepEqual(afterRestart.namedWrite, actual.namedWrite);
    assert.equal(afterRestart.modelError, actual.modelError);

    // Reopen the source only after all recovery actions finish, and confirm no mutation.
    source = runtime("original-source", true);
    const sourceAfter = await (await source.dispatchFetch("http://proof.test/source")).json();
    assert.deepEqual(sourceAfter, sourceBefore);
  } finally {
    await recovered?.dispose();
    await source?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
