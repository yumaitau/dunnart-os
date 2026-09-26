import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { r2RecoverySource, r2RecoveryTarget } from "../src/recovery-r2";
import { recoveryDigest } from "../src/recovery-archive";

const bindings = env as typeof env & { RECOVERY_R2_SOURCE: R2Bucket; RECOVERY_R2_TARGET: R2Bucket };
const source = bindings.RECOVERY_R2_SOURCE;
const target = bindings.RECOVERY_R2_TARGET;
beforeEach(async () => {
  for (const bucket of [source, target]) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ cursor });
      if (page.objects.length) await bucket.delete(page.objects.map(object => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
});
const stream = (...rows: unknown[]) => new Response(rows.map(row => JSON.stringify(row) + "\n").join("")).body!;
const header = (key: string, size: number) => ({ kind: "object", version: 1, key, size,
  httpMetadata: {}, customMetadata: {}, storageClass: "Standard" });

describe("R2 recovery adapter", () => {
  it("exports identical bytes when R2 changes network chunk boundaries", async () => {
    const bytes = new Uint8Array(600_001);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    await source.put("chunked", bytes);
    const exportWithChunks = async (size: number) => {
      const bucket = new Proxy(source, { get(original, property) {
        if (property === "get") return async (key: string) => {
          const object = await original.get(key);
          if (!object) return object;
          const data = new Uint8Array(await object.arrayBuffer());
          let offset = 0;
          const body = new ReadableStream<Uint8Array>({ pull(controller) {
            if (offset === data.length) { controller.close(); return; }
            controller.enqueue(data.slice(offset, offset + size));
            offset = Math.min(offset + size, data.length);
          } });
          return new Proxy(object, { get(value, field) { return field === "body" ? body : Reflect.get(value, field); } });
        };
        const value = Reflect.get(original, property);
        return typeof value === "function" ? value.bind(original) : value;
      } });
      return new Uint8Array(await new Response(await r2RecoverySource("r2", bucket).export()).arrayBuffer());
    };
    const first = await exportWithChunks(65_537);
    expect(await recoveryDigest(await exportWithChunks(262_144))).toBe(await recoveryDigest(first));
    await r2RecoveryTarget("r2", target).stage(new Response(first).body!);
    expect(new Uint8Array(await (await target.get("chunked"))!.arrayBuffer())).toEqual(bytes);
  });
  it("restores bytes, empty objects and metadata across listing pages", async () => {
    const cacheExpiry = new Date("2030-01-01T00:00:00.000Z");
    await source.put("binary", new Uint8Array([0, 128, 255]), {
      httpMetadata: { contentType: "application/octet-stream", cacheControl: "private", cacheExpiry },
      customMetadata: { label: "fixture" },
    });
    await source.put("empty", "");
    for (let i = 0; i < 102; i++) await source.put(`page-${i}`, String(i));
    await r2RecoveryTarget("r2", target).stage(await r2RecoverySource("r2", source).export());
    const restored = (await target.get("binary"))!;
    expect(new Uint8Array(await restored.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255]));
    expect(restored.httpMetadata).toMatchObject({ contentType: "application/octet-stream", cacheControl: "private", cacheExpiry });
    expect(restored.customMetadata).toEqual({ label: "fixture" });
    expect((await target.head("empty"))?.size).toBe(0);
    expect(await (await target.get("page-101"))?.text()).toBe("101");
  });
  it("round trips an object spanning multipart boundaries", async () => {
    const bytes = new Uint8Array(5 * 1024 * 1024 + 37);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    await source.put("large", bytes);
    await r2RecoveryTarget("r2", target).stage(await r2RecoverySource("r2", source).export());
    const restored = (await target.get("large"))!;
    expect(restored.size).toBe(bytes.length);
    expect(await recoveryDigest(new Uint8Array(await restored.arrayBuffer()))).toBe(await recoveryDigest(bytes));
  });
  it("refuses an occupied target", async () => {
    await target.put("existing", "keep");
    await expect(r2RecoveryTarget("r2", target).stage(stream())).rejects.toThrow("empty");
    expect(await (await target.get("existing"))?.text()).toBe("keep");
  });
  it("rejects truncation without publishing the incomplete object", async () => {
    await expect(r2RecoveryTarget("r2", target).stage(stream(header("large", 6 * 1024 * 1024),
      { kind: "data", value: "AQID" }))).rejects.toThrow("Truncated");
    expect(await target.head("large")).toBeNull();
  });
  it("rejects duplicate keys and oversized bodies", async () => {
    await expect(r2RecoveryTarget("r2", target).stage(stream(header("one", 0), { kind: "end" }, header("one", 0))))
      .rejects.toThrow("Duplicate");
    await target.delete("one");
    await expect(r2RecoveryTarget("r2", target).stage(stream(header("one", 1), { kind: "data", value: "AQID" })))
      .rejects.toThrow("declared size");
    expect(await target.head("one")).toBeNull();
  });
});
