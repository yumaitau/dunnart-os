import { recoveryBase64, recoveryBytes } from "./recovery-archive";
import type { RecoverySource, RecoveryTarget } from "./recovery-repository";

const FRAME_BYTES = 256 * 1024;
const PART_BYTES = 5 * 1024 * 1024;
const MAX_LINE = Math.ceil(FRAME_BYTES / 3) * 4 + 8192;
const MAX_OBJECTS = 100_000;
const encoder = new TextEncoder();
const encode = (value: unknown) => encoder.encode(JSON.stringify(value) + "\n");

/** Export a frozen source bucket as bounded records, preserving object bytes and metadata. */
export function r2RecoverySource(id: string, bucket: R2Bucket): RecoverySource {
  return { id, version: 1, async export() {
    async function* records(): AsyncGenerator<Uint8Array> {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      let count = 0;
      do {
        const page = await bucket.list({ cursor, limit: 100 });
        for (const listed of page.objects) {
          if (++count > MAX_OBJECTS) throw new Error("R2 recovery inventory exceeds the object limit.");
          const object = await bucket.get(listed.key);
          if (!object || object.version !== listed.version) throw new Error("R2 source changed during recovery snapshot.");
          if (object.size > PART_BYTES * 10_000) throw new Error("R2 recovery object exceeds the multipart limit.");
          yield encode({ kind: "object", version: 1, key: object.key, size: object.size,
            httpMetadata: object.httpMetadata ?? {}, customMetadata: object.customMetadata ?? {},
            storageClass: object.storageClass || "Standard" });
          const reader = object.body.getReader();
          let bytes = 0;
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              bytes += next.value.length;
              for (let start = 0; start < next.value.length; start += FRAME_BYTES) {
                yield encode({ kind: "data", value: recoveryBase64(next.value.subarray(start, start + FRAME_BYTES)) });
              }
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          if (bytes !== object.size) throw new Error("Truncated R2 recovery source.");
          yield encode({ kind: "end" });
        }
        cursor = page.truncated ? page.cursor : undefined;
        if (page.truncated && (!cursor || cursors.has(cursor))) throw new Error("R2 recovery pagination did not advance.");
        if (cursor) cursors.add(cursor);
      } while (cursor !== undefined);
    }
    const iterator = records();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      },
      async cancel() { await iterator.return(undefined); },
    });
  } };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid R2 recovery record.");
  return value as Record<string, unknown>;
}
function metadata(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record(value))) {
    if (typeof entry !== "string") throw new Error("Invalid R2 recovery metadata.");
    Object.defineProperty(result, key, { value: entry, enumerable: true, configurable: true, writable: true });
  }
  return result;
}
function objectHeader(row: Record<string, unknown>) {
  if (row.version !== 1 || typeof row.key !== "string" || !row.key || encoder.encode(row.key).length > 1024 ||
      typeof row.size !== "number" || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > PART_BYTES * 10_000 ||
      row.storageClass !== "Standard" && row.storageClass !== "InfrequentAccess") throw new Error("Invalid R2 recovery object.");
  const stored = metadata(row.httpMetadata);
  const allowed = new Set(["contentType", "contentLanguage", "contentDisposition", "contentEncoding", "cacheControl", "cacheExpiry"]);
  if (Object.keys(stored).some(key => !allowed.has(key))) throw new Error("Unsupported R2 HTTP metadata.");
  const { cacheExpiry, ...fields } = stored;
  if (cacheExpiry !== undefined && !Number.isFinite(Date.parse(cacheExpiry))) throw new Error("Invalid R2 cache expiration.");
  const httpMetadata: R2HTTPMetadata = { ...fields, ...(cacheExpiry === undefined ? {} : { cacheExpiry: new Date(cacheExpiry) }) };
  return { key: row.key, size: row.size, options: { httpMetadata, customMetadata: metadata(row.customMetadata), storageClass: row.storageClass } };
}

/**
 * Stage into an empty, isolated bucket. The coordinator must keep it unbound throughout staging;
 * multipart completion has no conditional-write option. Failed uploads are aborted.
 */
export function r2RecoveryTarget(id: string, bucket: R2Bucket): RecoveryTarget {
  return { id, version: 1, async stage(stream) {
    if ((await bucket.list({ limit: 1 })).objects.length) throw new Error("R2 recovery target must be empty.");
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    const seen = new Set<string>();
    let pending = "";
    let active: ReturnType<typeof objectHeader> | undefined;
    let upload: R2MultipartUpload | undefined;
    let parts: R2UploadedPart[] = [];
    let buffer = new Uint8Array(PART_BYTES);
    let offset = 0;
    let received = 0;
    const restore = async (line: string) => {
      const row = record(JSON.parse(line));
      if (row.kind === "object") {
        if (active) throw new Error("Truncated R2 recovery object.");
        active = objectHeader(row);
        if (seen.has(active.key) || seen.size >= MAX_OBJECTS) throw new Error("Duplicate or excessive R2 recovery objects.");
        seen.add(active.key);
        if (active.size > PART_BYTES) upload = await bucket.createMultipartUpload(active.key, active.options);
        received = 0; offset = 0; parts = [];
      } else if (row.kind === "data") {
        if (!active || typeof row.value !== "string") throw new Error("Unexpected R2 recovery data.");
        const bytes = recoveryBytes(row.value, FRAME_BYTES);
        received += bytes.length;
        if (received > active.size) throw new Error("R2 recovery object exceeds its declared size.");
        let consumed = 0;
        while (consumed < bytes.length) {
          const take = Math.min(buffer.length - offset, bytes.length - consumed);
          buffer.set(bytes.subarray(consumed, consumed + take), offset);
          offset += take; consumed += take;
          if (upload && offset === buffer.length) {
            parts.push(await upload.uploadPart(parts.length + 1, buffer));
            buffer = new Uint8Array(PART_BYTES); offset = 0;
          }
        }
      } else if (row.kind === "end") {
        if (!active || received !== active.size) throw new Error("Truncated R2 recovery object.");
        if (upload) {
          if (offset) parts.push(await upload.uploadPart(parts.length + 1, buffer.slice(0, offset)));
          await upload.complete(parts);
          upload = undefined;
        } else if (!await bucket.put(active.key, buffer.slice(0, offset), { ...active.options, onlyIf: { etagDoesNotMatch: "*" } })) {
          throw new Error("R2 recovery object already exists.");
        }
        active = undefined;
      } else throw new Error("Invalid R2 recovery record.");
    };
    try {
      for (;;) {
        const next = await reader.read();
        pending += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
        for (;;) {
          const end = pending.indexOf("\n");
          if (end < 0) break;
          if (end > MAX_LINE) throw new Error("R2 recovery record exceeds the size limit.");
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          await restore(line);
        }
        if (pending.length > MAX_LINE) throw new Error("R2 recovery record exceeds the size limit.");
        if (next.done) break;
      }
      if (pending || active) throw new Error("Truncated R2 recovery archive.");
    } finally {
      if (upload) await upload.abort().catch(() => {});
      await reader.cancel().catch(() => {}); reader.releaseLock();
    }
  } };
}
