import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { kvRecoverySource, kvRecoveryTarget } from "../src/recovery-kv";

const bindings = env as typeof env & { RECOVERY_KV_SOURCE: KVNamespace; RECOVERY_KV_TARGET: KVNamespace };
const source = bindings.RECOVERY_KV_SOURCE;
const target = bindings.RECOVERY_KV_TARGET;
beforeEach(async () => {
  for (const namespace of [source, target]) {
    let cursor: string | undefined;
    do {
      const page = await namespace.list({ cursor });
      for (const key of page.keys) await namespace.delete(key.name);
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
});
const stream = (text: string) => new Response(text).body!;
const row = (key: string, expiration: number | null = null) =>
  JSON.stringify({ version: 1, key, value: "AQID", metadata: null, expiration }) + "\n";

describe("KV recovery adapter", () => {
  it("recovers binary values, JSON metadata and absolute expiration across pages", async () => {
    const expiration = Math.floor(Date.now() / 1000) + 3600;
    await source.put("binary", new Uint8Array([0, 128, 255]), { metadata: { label: "fixture" }, expiration });
    for (let i = 0; i < 102; i++) await source.put(`page-${i}`, String(i));
    await kvRecoveryTarget("kv", target).stage(await kvRecoverySource("kv", source).export());
    const value = await target.getWithMetadata("binary", "arrayBuffer");
    expect(new Uint8Array(value.value!)).toEqual(new Uint8Array([0, 128, 255]));
    expect(value.metadata).toEqual({ label: "fixture" });
    expect((await target.list({ prefix: "binary" })).keys[0].expiration).toBe(expiration);
    expect(await target.get("page-101")).toBe("101");
  });
  it("does not overwrite an occupied namespace", async () => {
    await target.put("existing", "keep");
    await expect(kvRecoveryTarget("kv", target).stage(stream(row("new")))).rejects.toThrow("empty");
    expect(await target.get("existing")).toBe("keep");
    expect(await target.get("new")).toBeNull();
  });
  it("does not resurrect expired records", async () => {
    const now = Date.now();
    await kvRecoveryTarget("kv", target, () => now).stage(stream(row("expired", Math.floor(now / 1000) - 1)));
    expect(await target.get("expired")).toBeNull();
  });
  it("refuses to silently change a near expiration", async () => {
    const now = Date.now();
    await expect(kvRecoveryTarget("kv", target, () => now).stage(
      stream(row("near", Math.floor(now / 1000) + 30)))).rejects.toThrow("too close");
    expect(await target.get("near")).toBeNull();
  });
  it("rejects duplicate keys and truncated records", async () => {
    await expect(kvRecoveryTarget("kv", target).stage(stream(row("one") + row("one")))).rejects.toThrow("Duplicate");
    await target.delete("one");
    await expect(kvRecoveryTarget("kv", target).stage(stream(row("one").trim()))).rejects.toThrow("Truncated");
    expect(await target.get("one")).toBeNull();
  });
});
