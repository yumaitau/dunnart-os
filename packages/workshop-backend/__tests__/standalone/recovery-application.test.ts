import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(new URL("../../package.json", import.meta.url));
const { build } = require("esbuild");
const capnwebValidate = require("capnweb-validate/esbuild");
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve("wrangler/package.json"))("miniflare");

test("actual User, Overseer and committed gadget run from staged isolated recovery", async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("recovery-application.fixture.ts", import.meta.url))],
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    conditions: ["workerd", "browser"],
    external: ["cloudflare:*", "node:*"], loader: { ".txt": "text", ".html": "text" },
    plugins: [capnwebValidate({ cwd: fileURLToPath(new URL("../../", import.meta.url)) }), { name: "text-module-symlinks", setup(pluginBuild: any) {
      pluginBuild.onResolve({ filter: /\.txt$/ }, (args: any) => ({ path: path.resolve(args.resolveDir, args.path), namespace: "literal-text" }));
      pluginBuild.onLoad({ filter: /.*/, namespace: "literal-text" }, (args: any) => ({ contents: readFileSync(args.path, "utf8"), loader: "text" }));
    } }],
  });
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: "application-proof", modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-09-04", compatibilityFlags: ["experimental", "nodejs_compat", "allow_irrevocable_stub_storage"],
    workerLoaders: { LOADER: {} },
    bindings: { PUBLIC_BASE_URL: "https://recovery.example.test", BACKUP_CAPABILITY_KEY: Buffer.alloc(32, 7).toString("base64") },
    kvNamespaces: ["BLUEPRINTS", "BLUEPRINTS_RESTORE"],
    durableObjects: {
      USERS: { className: "UserDurableObject", useSQLite: true },
      WORKSPACES: { className: "OverseerDurableObject", useSQLite: true },
      RECOVERY: { className: "NativeRecoveryObject", useSQLite: true },
      INSPECTORS: { className: "RecoveryGadgetInspector", useSQLite: true },
      ADMINS: { className: "AdminSettings", useSQLite: true },
      USER_DIRECTORY: { className: "UserDirectoryDurableObject", useSQLite: true },
      IDENTITIES: { className: "IdentityDirectory", useSQLite: true },
      SPAWNERS: { className: "AgentSpawnerGatekeeper", useSQLite: true },
      MODELS: { className: "LanguageModelGatekeeper", useSQLite: true },
    },
  }] }));
  try {
    const response = await mf.dispatchFetch("http://application-proof.test/");
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const result = JSON.parse(body);
    assert.deepEqual(result.profile, { type: "user", id: "recovery-fixture-user", name: "Recovery Owner" });
    assert.equal(result.metadata.id, result.originalWorkspaceId);
    assert.equal(result.metadata.title, "Original recovery workspace");
    assert.equal(result.before, 1);
    assert.equal(result.after, 2);
    assert.equal(result.callbackAfter, 7);
    assert.equal(result.afterCallbackRead, 7);
    assert.equal(result.beforeActivationRejected, true);
    assert.match(result.guards.model, /Model execution is paused/);
    assert.match(result.guards.spawner, /Agent spawning remains paused/);
    assert.match(result.guards.hook, /Scheduled hooks remain paused/);
    assert.match(result.guards.action, /Pending actions remain paused/);
    assert.equal(result.sourceCounter, 1);
    assert.equal(result.sourceCounterAfter, 1);
    assert.deepEqual(result.sourceProfileAfter, result.sourceProfile);
    assert.deepEqual(JSON.parse(result.applicationCheck.summary), {
      title: "Original recovery workspace", gadgets: [{ id: 7, files: 1 }],
    });
  } finally { await mf.dispose(); }
});
