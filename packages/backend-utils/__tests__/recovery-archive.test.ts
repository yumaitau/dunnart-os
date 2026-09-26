import { beforeAll, describe, expect, it } from "vitest";
import { createRecoveryKey, openRecoveryChunk, openRecoveryKey, recoveryBytes,
  RECOVERY_CHUNK_BYTES, sealRecoveryChunk } from "../src/recovery-archive";

let publicKey: JsonWebKey;
let privateKey: JsonWebKey;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 3072,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["wrapKey", "unwrapKey"]);
  if (!("publicKey" in pair)) throw new Error("Expected a key pair.");
  const exportedPublic = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const exportedPrivate = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!("kty" in exportedPublic) || !("kty" in exportedPrivate)) throw new Error("Expected JWK keys.");
  publicKey = exportedPublic;
  privateKey = exportedPrivate;
});
const identity = { deployment: "deployment-a", run: "run-a", component: "auth", ordinal: 0 };
const bytes = new TextEncoder().encode("sensitive recovery fixture");

describe("recovery archives", () => {
  it("recovers with the operator key without the original data key", async () => {
    const { key, envelope } = await createRecoveryKey(publicKey);
    const sealed = await sealRecoveryChunk(key, identity, bytes);
    const restoredKey = await openRecoveryKey(envelope, privateKey);
    expect(await openRecoveryChunk(restoredKey, identity, sealed)).toEqual(bytes);
    expect(JSON.stringify(sealed)).not.toContain("sensitive recovery fixture");
    expect(restoredKey.extractable).toBe(false);
  });
  it("uses different data keys and nonces for separate backups", async () => {
    const first = await createRecoveryKey(publicKey);
    const second = await createRecoveryKey(publicKey);
    const a = await sealRecoveryChunk(first.key, identity, bytes);
    const b = await sealRecoveryChunk(first.key, identity, bytes);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(first.envelope.wrappedKey).not.toBe(second.envelope.wrappedKey);
  });
  it.each(["deployment", "run", "component", "ordinal"] as const)("rejects moved %s chunks", async field => {
    const { key } = await createRecoveryKey(publicKey);
    const sealed = await sealRecoveryChunk(key, identity, bytes);
    const other = { ...identity, [field]: field === "ordinal" ? 1 : "other" };
    await expect(openRecoveryChunk(key, other, sealed)).rejects.toThrow();
    await expect(openRecoveryChunk(key, other, { ...sealed, identity: other })).rejects.toThrow();
  });
  it("rejects changed ciphertext and digest metadata", async () => {
    const { key } = await createRecoveryKey(publicKey);
    const sealed = await sealRecoveryChunk(key, identity, bytes);
    const changed = (sealed.ciphertext[0] === "A" ? "B" : "A") + sealed.ciphertext.slice(1);
    await expect(openRecoveryChunk(key, identity, { ...sealed, ciphertext: changed })).rejects.toThrow();
    await expect(openRecoveryChunk(key, identity, { ...sealed, sha256: "0".repeat(64) })).rejects.toThrow();
  });
  it("rejects another recovery key and unsupported envelopes", async () => {
    const { envelope } = await createRecoveryKey(publicKey);
    await expect(openRecoveryKey({ ...envelope, keyId: "other" }, privateKey)).rejects.toThrow("does not match");
    await expect(openRecoveryKey({ ...envelope, version: 2 } as never, privateKey)).rejects.toThrow("version");
    await expect(createRecoveryKey(privateKey)).rejects.toThrow("public");
  });
  it("enforces chunk and decoder bounds before encryption/decryption", async () => {
    const { key } = await createRecoveryKey(publicKey);
    await expect(sealRecoveryChunk(key, identity, new Uint8Array(RECOVERY_CHUNK_BYTES + 1))).rejects.toThrow("size limit");
    expect(() => recoveryBytes("AAAA", 1)).toThrow();
    expect(() => recoveryBytes("YQ", 10)).toThrow();
    expect(() => recoveryBytes("YR==", 10)).toThrow();
  });
});
