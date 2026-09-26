import { encodePortableValue, decodePortableValue } from "@gadgets/backend-utils/recovery-value";
/** Native values remain native until the trusted deployment archive codec encodes them. */
export type ContextRecoveryRows = string;

/** Encode structured storage values without losing dates, binary data, or map entries. */
export async function captureContextRows(storage: DurableObjectStorage): Promise<ContextRecoveryRows> {
  return JSON.stringify(await encodePortableValue([...storage.kv.list()].filter(([key]) => key !== CONTEXT_RECOVERY_FREEZE)));
}

/** Complete local collection state, including extracted text and semantic vectors. */
export type ContextCollectionRecovery = {
  version: 1;
  id: string;
  rows: ContextRecoveryRows;
  passages: Array<{ path: string; offset: number; title: string; description: string; body: string }>;
  vectors: Array<{ path: string; offset: number; vector: string }>;
};

/** Account-owned local data; public collections are archived once per sharing domain. */
export type ContextAccountRecovery = {
  version: 1;
  accountId: string;
  sharingDomain: string;
  rows: ContextRecoveryRows;
  collections: ContextCollectionRecovery[];
};

/** Authoritative public collection registry and all its collection bodies. */
export type ContextDomainRecovery = {
  version: 1;
  sharingDomain: string;
  rows: ContextRecoveryRows;
  collections: ContextCollectionRecovery[];
  publicSnapshot: string | null;
};

/** Reserved marker keeps restored collections offline, including background reads. */
export const CONTEXT_RECOVERY_OFFLINE = ".recoveryOffline";

/** Construct a separate domain; no restore path accepts a live target domain. */
export function contextRecoveryDomain(scope: string, original: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(scope) || !original || original.includes("\0")) {
    throw new Error("Invalid Context recovery scope.");
  }
  return `recovery:${scope}:${original}`;
}

/** Reject duplicate rows before mutating storage, then restore only an empty target. */
export async function restoreContextRows(storage: DurableObjectStorage, snapshot: ContextRecoveryRows, afterRestore?: () => void): Promise<void> {
  const rows = await decodePortableValue(JSON.parse(snapshot));
  if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string") ||
      new Set(rows.map(row => row[0])).size !== rows.length) throw new Error("Invalid Context recovery rows.");
  if ([...storage.kv.list({ limit: 1 })].length) throw new Error("Context recovery target is not empty.");
  storage.transactionSync(() => {
    for (const [key, value] of rows) storage.kv.put(key, value);
    afterRestore?.();
  });
}

/** Reserved fence blocks writers for a coherent deployment capture interval. */
export const CONTEXT_RECOVERY_FREEZE = ".recoveryFreeze";

/** Acquire an idempotent capture fence, rejecting overlapping runs. */
export function freezeContextStorage(storage: DurableObjectStorage, run: string): boolean {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(run)) throw new Error("Invalid recovery run.");
  const owner = storage.kv.get<string>(CONTEXT_RECOVERY_FREEZE);
  if (owner && owner !== run) throw new Error("Context recovery already in progress.");
  if (owner === run) return false;
  storage.kv.put(CONTEXT_RECOVERY_FREEZE, run);
  return true;
}

/** Release only the fence owned by this capture. */
export function releaseContextStorage(storage: DurableObjectStorage, run: string): void {
  if (storage.kv.get(CONTEXT_RECOVERY_FREEZE) === run) storage.kv.delete(CONTEXT_RECOVERY_FREEZE);
}

/** Fail writes explicitly during the short frozen interval instead of producing mixed snapshots. */
export function requireContextWritable(storage: DurableObjectStorage): void {
  if (storage.kv.get(CONTEXT_RECOVERY_FREEZE)) throw new Error("Context backup capture in progress; retry the change.");
}

/** First acquisition intentionally restarts the actor to terminate pre-fence sessions. */
export async function acquireContextRecovery(acquire: () => Promise<void>): Promise<void> {
  try { await acquire(); } catch { await acquire(); }
}
