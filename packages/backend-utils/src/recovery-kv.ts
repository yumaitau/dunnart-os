import { recoveryBase64, recoveryBytes } from "./recovery-archive";
import type { RecoverySource, RecoveryTarget } from "./recovery-repository";

const MAX_VALUE = 25 * 1024 * 1024;
const MAX_LINE = Math.ceil(MAX_VALUE / 3) * 4 + 4096;
const MAX_KEYS = 100_000;

/** Export a frozen Workers KV namespace, including binary values, metadata and expiration. */
export function kvRecoverySource(id: string, namespace: KVNamespace): RecoverySource {
  return { id, version: 1, async export() {
    async function* entries(): AsyncGenerator<Uint8Array> {
      let cursor: string | undefined;
      let count = 0;
      const cursors = new Set<string>();
      do {
        const page = await namespace.list({ cursor, limit: 100 });
        for (const listed of page.keys) {
          if (++count > MAX_KEYS) throw new Error("KV recovery inventory exceeds the key limit.");
          const entry = await namespace.getWithMetadata(listed.name, "arrayBuffer");
          if (entry.value === null) throw new Error("KV source changed during the recovery snapshot.");
          const value = new Uint8Array(entry.value);
          if (value.length > MAX_VALUE) throw new Error("KV recovery value exceeds the size limit.");
          const encoded = JSON.stringify({ version: 1, key: listed.name, value: recoveryBase64(value),
            metadata: entry.metadata, expiration: listed.expiration ?? null }) + "\n";
          if (encoded.length > MAX_LINE) throw new Error("KV recovery record exceeds the size limit.");
          yield new TextEncoder().encode(encoded);
        }
        cursor = page.list_complete ? undefined : page.cursor;
        if (!page.list_complete && (!cursor || cursors.has(cursor))) throw new Error("KV recovery pagination did not advance.");
        if (cursor) cursors.add(cursor);
      } while (cursor !== undefined);
    }
    const iterator = entries();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      },
      async cancel() { await iterator.return(undefined); },
    });
  } };
}

/**
 * Stage a namespace archive into a newly provisioned, isolated KV namespace. Reject nonempty
 * targets; the recovery coordinator must keep the new namespace unbound until verification.
 */
export function kvRecoveryTarget(id: string, namespace: KVNamespace, now = () => Date.now()): RecoveryTarget {
  return { id, version: 1, async stage(stream) {
    if ((await namespace.list({ limit: 1 })).keys.length) throw new Error("KV recovery target must be empty.");
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    const seen = new Set<string>();
    let pending = "";
    const restore = async (line: string) => {
      const item: unknown = JSON.parse(line);
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid KV recovery record.");
      const row = item as Record<string, unknown>;
      if (row.version !== 1 || typeof row.key !== "string" || !row.key ||
          new TextEncoder().encode(row.key).length > 512 || typeof row.value !== "string" ||
          !(row.expiration === null || typeof row.expiration === "number" && Number.isSafeInteger(row.expiration) && row.expiration > 0)) {
        throw new Error("Invalid KV recovery record.");
      }
      if (seen.has(row.key) || seen.size >= MAX_KEYS) throw new Error("Duplicate or excessive KV recovery keys.");
      seen.add(row.key);
      const value = recoveryBytes(row.value, MAX_VALUE);
      // Restore absolute expirations; expired sessions/tokens must never be resurrected.
      if (row.expiration !== null && row.expiration <= Math.floor(now() / 1000)) return;
      if (row.expiration !== null && row.expiration <= Math.floor(now() / 1000) + 60) {
        throw new Error("KV expiration is too close to restore exactly; retry after it expires.");
      }
      const metadata = row.metadata;
      if (!Object.hasOwn(row, "metadata") || new TextEncoder().encode(JSON.stringify(metadata)).length > 1024) {
        throw new Error("Invalid KV recovery metadata.");
      }
      await namespace.put(row.key, value, { metadata: metadata ?? undefined,
        expiration: row.expiration ?? undefined });
    };
    try {
      for (;;) {
        const next = await reader.read();
        pending += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
        for (;;) {
          const end = pending.indexOf("\n");
          if (end < 0) break;
          if (end > MAX_LINE) throw new Error("KV recovery record exceeds the size limit.");
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          await restore(line);
        }
        if (pending.length > MAX_LINE) throw new Error("KV recovery record exceeds the size limit.");
        if (next.done) break;
      }
      if (pending) throw new Error("Truncated KV recovery archive.");
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } };
}
