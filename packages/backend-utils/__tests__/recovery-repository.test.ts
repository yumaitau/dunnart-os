import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { RECOVERY_CHUNK_BYTES } from "../src/recovery-archive";
import { stageRecoverySnapshot, writeRecoverySnapshot, verifyRecoverySnapshot, deleteRecoverySnapshot, type RecoverySource } from "../src/recovery-repository";

const bucket = (env as typeof env & { RECOVERY_TEST: R2Bucket }).RECOVERY_TEST;
let publicKey: JsonWebKey;
let privateKey: JsonWebKey;
let authenticationKey: CryptoKey;
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 3072,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["wrapKey", "unwrapKey"]);
  if (!("publicKey" in pair)) throw new Error("Expected key pair.");
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const secret = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (!("kty" in pub) || !("kty" in secret)) throw new Error("Expected JWK.");
  publicKey = pub; privateKey = secret;
  const authentication = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
  if ("publicKey" in authentication) throw new Error("Expected symmetric key.");
  authenticationKey = authentication;
});
const source = (id: string, value: string): RecoverySource => ({ id, version: 1,
  export: async () => new Response(value).body! });
const options = () => ({ bucket: bucket, deployment: "test", run: crypto.randomUUID(),
  publicKey, authenticationKey, capturedAt: new Date().toISOString(), required: ["auth", "apps"],
  sources: [source("auth", "private account fixture"), source("apps", "app records")] });

describe("R2 recovery repository", () => {
  it("checks encrypted archive integrity without the offline private key", async () => {
    const input = options(); await writeRecoverySnapshot(input);
    const verified = await verifyRecoverySnapshot(input);
    expect(verified.components.map(c => c.id)).toEqual(input.required);
    expect(verified.bytes).toBe(34);
  });
  it("rejects changed encrypted chunks and receipts", async () => {
    const input = options(); const manifest = await writeRecoverySnapshot(input);
    await bucket.put(manifest.components[0].chunks[0].key, "substituted ciphertext");
    await expect(verifyRecoverySnapshot(input)).rejects.toThrow("integrity");
    const receiptKey = `recovery/v1/test/${input.run}/receipt.json`;
    const receipt = JSON.parse(await (await bucket.get(receiptKey))!.text());
    receipt.payload = receipt.payload.replace('"bytes":34', '"bytes":40');
    await bucket.put(receiptKey, JSON.stringify(receipt));
    await expect(verifyRecoverySnapshot(input)).rejects.toThrow("authentication");
  });
  it("never publishes when the coherent capture fence is lost", async () => {
    const input = options();
    await expect(writeRecoverySnapshot({ ...input, beforePublish: async () => { throw new Error("fence lost"); } })).rejects.toThrow("fence lost");
    expect(await bucket.head(`recovery/v1/test/${input.run}/head.json`)).toBeNull();
  });
  it("deletes only the requested snapshot", async () => {
    const first = options(), second = options();
    await writeRecoverySnapshot(first); await writeRecoverySnapshot(second);
    await deleteRecoverySnapshot(bucket, first.deployment, first.run);
    await expect(verifyRecoverySnapshot(first)).rejects.toThrow();
    await expect(verifyRecoverySnapshot(second)).resolves.toMatchObject({ bytes: 34 });
  });

  it("rejects weak authentication keys before exporting data", async () => {
    for (const algorithm of [{ hash: "SHA-1", length: 256 }, { hash: "SHA-256", length: 128 }]) {
      const key = await crypto.subtle.generateKey({ name: "HMAC", ...algorithm }, false, ["sign", "verify"]);
      if ("publicKey" in key) throw new Error("Expected symmetric key.");
      const input = options();
      const read = vi.fn();
      input.sources[0].export = read;
      await expect(writeRecoverySnapshot({ ...input, authenticationKey: key })).rejects.toThrow("HMAC-SHA256");
      expect(read).not.toHaveBeenCalled();
    }
  });
  it("restores every component from R2 after original source data is discarded", async () => {
    const input = options();
    await writeRecoverySnapshot(input);
    input.sources = [];
    const restored = new Map<string, string>();
    const inventory = await stageRecoverySnapshot({ ...input, privateKey,
      targets: input.required.map(id => ({ id, version: 1,
        stage: async stream => { restored.set(id, await new Response(stream).text()); } })) });
    expect(restored.get("auth")).toBe("private account fixture");
    expect(restored.get("apps")).toBe("app records");
    expect(inventory.components).toHaveLength(2);
    const keys = await bucket.list({ prefix: `recovery/v1/test/${input.run}/` });
    for (const object of keys.objects) {
      expect(await (await bucket.get(object.key))!.text()).not.toContain("private account fixture");
    }
  });
  it("refuses incomplete inventories before reading any data", async () => {
    const input = options(); const read = vi.fn();
    input.sources = [{ id: "auth", version: 1, export: read }];
    await expect(writeRecoverySnapshot(input)).rejects.toThrow("coverage");
    expect(read).not.toHaveBeenCalled();
    expect(await bucket.head(`recovery/v1/test/${input.run}/head.json`)).toBeNull();
  });
  it("does not publish a head after a component export fails", async () => {
    const input = options();
    input.sources[1].export = async () => { throw new Error("source unavailable"); };
    await expect(writeRecoverySnapshot(input)).rejects.toThrow("source unavailable");
    expect(await bucket.head(`recovery/v1/test/${input.run}/head.json`)).toBeNull();
  });
  it("verifies all components before staging any restore", async () => {
    const input = options();
    const inventory = await writeRecoverySnapshot(input);
    await bucket.put(inventory.components[1].chunks[0].key, "{}");
    const stage = vi.fn();
    await expect(stageRecoverySnapshot({ ...input, privateKey,
      targets: input.required.map(id => ({ id, version: 1, stage })) })).rejects.toThrow();
    expect(stage).not.toHaveBeenCalled();
  });
  it("rejects unsupported target schemas and cross-deployment restores", async () => {
    const input = options(); await writeRecoverySnapshot(input);
    const stage = vi.fn();
    await expect(stageRecoverySnapshot({ ...input, privateKey,
      targets: input.required.map(id => ({ id, version: 2, stage })) })).rejects.toThrow("version");
    await expect(stageRecoverySnapshot({ ...input, deployment: "other", privateKey,
      targets: input.required.map(id => ({ id, version: 1, stage })) })).rejects.toThrow();
    expect(stage).not.toHaveBeenCalled();
  });
  it("does not overwrite completed snapshots", async () => {
    const input = options(); await writeRecoverySnapshot(input);
    await expect(writeRecoverySnapshot(input)).rejects.toThrow("already exists");
  });
  it("rejects target adapters which discard the archive", async () => {
    const input = options(); await writeRecoverySnapshot(input);
    await expect(stageRecoverySnapshot({ ...input, privateKey,
      targets: input.required.map(id => ({ id, version: 1, stage: async () => {} })) })).rejects.toThrow("consume");
  });
  it("streams component data across chunk boundaries", async () => {
    const input = options();
    const original = new Uint8Array(RECOVERY_CHUNK_BYTES + 7);
    original[0] = 17; original[RECOVERY_CHUNK_BYTES - 1] = 33; original[original.length - 1] = 99;
    input.required = ["apps"];
    input.sources = [{ id: "apps", version: 1, export: async () => new Response(original).body! }];
    const saved = await writeRecoverySnapshot(input);
    expect(saved.components[0].chunks).toHaveLength(2);
    await stageRecoverySnapshot({ ...input, privateKey, targets: [{ id: "apps", version: 1,
      stage: async stream => {
        const recovered = new Uint8Array(await new Response(stream).arrayBuffer());
        expect(recovered.length).toBe(original.length);
        expect(recovered[0]).toBe(17);
        expect(recovered[RECOVERY_CHUNK_BYTES - 1]).toBe(33);
        expect(recovered[recovered.length - 1]).toBe(99);
      } }] });
  });
  it("does not overwrite orphan chunks when a failed run ID is reused", async () => {
    const input = options();
    input.sources[1].export = async () => { throw new Error("source unavailable"); };
    await expect(writeRecoverySnapshot(input)).rejects.toThrow();
    const key = `recovery/v1/test/${input.run}/auth/0.json`;
    const original = await (await bucket.get(key))!.text();
    input.sources[1] = source("apps", "recovered source");
    await expect(writeRecoverySnapshot(input)).rejects.toThrow("already exists");
    expect(await (await bucket.get(key))!.text()).toBe(original);
    expect(await bucket.head(`recovery/v1/test/${input.run}/head.json`)).toBeNull();
  });
  it("reserves the encrypted manifest identity against component substitution", async () => {
    const input = options(); input.required = ["manifest"];
    input.sources = [source("manifest", "forged manifest")];
    await expect(writeRecoverySnapshot(input)).rejects.toThrow("Reserved");
  });

  it("rejects an archive signed by an untrusted recovery key", async () => {
    const input = options(); await writeRecoverySnapshot(input);
    const other = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
    if ("publicKey" in other) throw new Error("Expected symmetric key.");
    const stage = vi.fn();
    await expect(stageRecoverySnapshot({ ...input, authenticationKey: other, privateKey,
      targets: input.required.map(id => ({ id, version: 1, stage })) })).rejects.toThrow("authentication");
    expect(stage).not.toHaveBeenCalled();
  });

});
