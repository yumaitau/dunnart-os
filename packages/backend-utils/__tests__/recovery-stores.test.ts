import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { d1RecoverySource, d1RecoveryTarget } from "../src/recovery-d1";
import { kvRecoverySource, kvRecoveryTarget } from "../src/recovery-kv";
import { r2RecoverySource, r2RecoveryTarget } from "../src/recovery-r2";
import { stageRecoverySnapshot, writeRecoverySnapshot } from "../src/recovery-repository";

const bindings = env as typeof env & {
  RECOVERY_TEST: R2Bucket;
  RECOVERY_R2_SOURCE: R2Bucket;
  RECOVERY_R2_TARGET: R2Bucket;
  RECOVERY_KV_SOURCE: KVNamespace;
  RECOVERY_KV_TARGET: KVNamespace;
  RECOVERY_D1_SOURCE: D1Database;
  RECOVERY_D1_TARGET: D1Database;
};

it("recovers D1, KV and R2 together after deleting the original records", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 3072,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["wrapKey", "unwrapKey"]);
  if (!("publicKey" in pair)) throw new Error("Expected key pair.");
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!("kty" in publicKey) || !("kty" in privateKey)) throw new Error("Expected JWK.");
  const authenticationKey = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
  if ("publicKey" in authenticationKey) throw new Error("Expected symmetric key.");

  await bindings.RECOVERY_D1_SOURCE.exec("CREATE TABLE recovery_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  await bindings.RECOVERY_D1_SOURCE.prepare("INSERT INTO recovery_fixture VALUES (?, ?)").bind(1, "private database fixture").run();
  await bindings.RECOVERY_KV_SOURCE.put("recovery-fixture", new Uint8Array([1, 255, 0]), { metadata: { version: 1 } });
  await bindings.RECOVERY_R2_SOURCE.put("recovery-fixture", "private object fixture", { httpMetadata: { contentType: "text/plain" } });
  const options = { bucket: bindings.RECOVERY_TEST, deployment: "isolated", run: crypto.randomUUID(),
    publicKey, authenticationKey, capturedAt: new Date().toISOString(), required: ["database", "kv", "objects"] };
  await writeRecoverySnapshot({ ...options, sources: [
    d1RecoverySource("database", bindings.RECOVERY_D1_SOURCE),
    kvRecoverySource("kv", bindings.RECOVERY_KV_SOURCE),
    r2RecoverySource("objects", bindings.RECOVERY_R2_SOURCE),
  ] });

  await bindings.RECOVERY_D1_SOURCE.exec("DROP TABLE recovery_fixture");
  await bindings.RECOVERY_KV_SOURCE.delete("recovery-fixture");
  await bindings.RECOVERY_R2_SOURCE.delete("recovery-fixture");
  await stageRecoverySnapshot({ ...options, privateKey, targets: [
    d1RecoveryTarget("database", bindings.RECOVERY_D1_TARGET),
    kvRecoveryTarget("kv", bindings.RECOVERY_KV_TARGET),
    r2RecoveryTarget("objects", bindings.RECOVERY_R2_TARGET),
  ] });
  expect(await bindings.RECOVERY_D1_TARGET.prepare("SELECT value FROM recovery_fixture WHERE id = 1").first("value"))
    .toBe("private database fixture");
  const restoredKv = await bindings.RECOVERY_KV_TARGET.getWithMetadata("recovery-fixture", "arrayBuffer");
  expect(new Uint8Array(restoredKv.value!)).toEqual(new Uint8Array([1, 255, 0]));
  expect(restoredKv.metadata).toEqual({ version: 1 });
  const restoredObject = (await bindings.RECOVERY_R2_TARGET.get("recovery-fixture"))!;
  expect(await restoredObject.text()).toBe("private object fixture");
  expect(restoredObject.httpMetadata?.contentType).toBe("text/plain");
});
