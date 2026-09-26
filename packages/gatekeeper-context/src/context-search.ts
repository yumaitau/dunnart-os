// Retrieval stays in the collection Durable Object, under its existing access boundary.
import { cosine, embedTexts } from "@gadgets/backend-utils/semantic";

const CHUNK_LENGTH = 1_200;
const CHUNK_OVERLAP = 200;
const MAX_INDEX_LENGTH = 1_800_000;

export function searchChunks(text: string): { offset: number; body: string }[] {
  if (new TextEncoder().encode(text).byteLength > MAX_INDEX_LENGTH) {
    throw new Error("Extracted document is too large to index.");
  }
  const chunks: { offset: number; body: string }[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + CHUNK_LENGTH, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf(" ", end);
      if (boundary > start + CHUNK_LENGTH / 2) end = boundary;
      // SQLite encodes strings as UTF-8; never send it half a UTF-16 surrogate pair.
      if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    }
    chunks.push({ offset: start, body: text.slice(start, end) });
    if (end === text.length) break;
    start = end - CHUNK_OVERLAP;
    if (/[\uDC00-\uDFFF]/.test(text[start])) start--;
  }
  return chunks;
}

/** Query terms are literals, never user-supplied FTS operators or SQL. */
export function searchExpression(query: string): string | null {
  const terms = query.slice(0, 500).match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
  return terms.length ? terms.map(term => `"${term}"`).join(" OR ") : null;
}

export function searchLimit(limit = 20): number {
  return Number.isFinite(limit) ? Math.max(0, Math.min(Math.floor(limit), 50)) : 20;
}

export type IndexedPassage = { path: string; offset: number; body: string; score: number };

/** Synchronous writes participate in the caller's document-storage transaction. */
export class ContextSearchIndex {
  private indexing?: Promise<void>;
  private queries = new Map<string, { vector: number[]; until: number }>();
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS context_passages USING fts5(
      path UNINDEXED, offset UNINDEXED, title, description, body, tokenize = 'unicode61'
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS context_vectors (
      path TEXT, offset INTEGER, vector TEXT, PRIMARY KEY(path, offset)
    )`);
  }

  replace(path: string, title: string, description: string, text: string): void {
    const chunks = searchChunks(text);
    this.remove(path);
    for (const chunk of chunks.length ? chunks : [{ offset: 0, body: "" }]) {
      this.sql.exec(
        "INSERT INTO context_passages (path, offset, title, description, body) VALUES (?, ?, ?, ?, ?)",
        path, chunk.offset, title, description, chunk.body);
    }
  }

  remove(path: string): void {
    this.sql.exec("DELETE FROM context_vectors WHERE path = ?", path);
    this.sql.exec("DELETE FROM context_passages WHERE path = ?", path);
  }

  clear(): void {
    this.sql.exec("DELETE FROM context_vectors");
    this.sql.exec("DELETE FROM context_passages");
  }

  read(path: string): string | null {
    const rows = this.sql.exec<{ offset: number; body: string }>(
      "SELECT offset, body FROM context_passages WHERE path = ? ORDER BY offset", path);
    let text = "";
    for (const row of rows) text += row.body.slice(Math.max(0, text.length - row.offset));
    return text || null;
  }

  retrieve(query: string, limit = 5): IndexedPassage[] {
    const expression = searchExpression(query);
    const count = searchLimit(limit);
    if (!expression || count === 0) return [];
    return this.sql.exec<IndexedPassage>(
      `SELECT path, offset, body, -rank AS score FROM context_passages
       WHERE context_passages MATCH ? ORDER BY rank LIMIT ?`, expression, count).toArray();
  }

  /** Incrementally embed up to 32 passages, without reviving deleted or changed content. */
  indexPending(ai: Ai): Promise<void> {
    if (this.indexing) return this.indexing;
    this.indexing = this.indexBatch(ai).finally(() => { this.indexing = undefined; });
    return this.indexing;
  }

  private async indexBatch(ai: Ai): Promise<void> {
    this.sql.exec(`DELETE FROM context_vectors WHERE (path, offset) NOT IN
      (SELECT path, offset FROM context_passages ORDER BY rowid DESC LIMIT 4096)`);
    const rows = this.sql.exec<{ path: string; offset: number; body: string }>(`SELECT p.path, p.offset, p.body
      FROM context_passages p LEFT JOIN context_vectors v ON p.path = v.path AND p.offset = v.offset
      WHERE v.path IS NULL AND p.body != ''
      AND p.rowid IN (SELECT rowid FROM context_passages ORDER BY rowid DESC LIMIT 4096)
      ORDER BY p.rowid DESC LIMIT 32`).toArray();
    const vectors = await embedTexts(ai, rows.map(row => row.body));
    rows.forEach((row, index) => {
      if (!this.sql.exec("SELECT path FROM context_passages WHERE path = ? AND offset = ? AND body = ?",
        row.path, row.offset, row.body).toArray().length) return;
      this.sql.exec("INSERT OR REPLACE INTO context_vectors (path, offset, vector) VALUES (?, ?, ?)",
        row.path, row.offset, JSON.stringify(vectors[index]));
    });
  }

  /** Warm a bounded index in background batches; another request can resume interrupted work. */
  async warm(ai: Ai): Promise<void> {
    for (let batch = 0; batch < 128; batch++) {
      const pending = this.sql.exec(`SELECT p.path FROM context_passages p
        LEFT JOIN context_vectors v ON p.path = v.path AND p.offset = v.offset
        WHERE v.path IS NULL AND p.body != ''
        AND p.rowid IN (SELECT rowid FROM context_passages ORDER BY rowid DESC LIMIT 4096) LIMIT 1`).toArray();
      if (!pending.length) return;
      await this.indexPending(ai);
    }
  }

  /** Hybrid rank fusion keeps exact terms and meaning useful on the same score scale. */
  async retrieveSemantic(query: string, ai: Ai, limit = 5): Promise<IndexedPassage[]> {
    const count = searchLimit(limit);
    if (!query.trim() || !count) return [];
    await this.indexPending(ai);
    const key = query.slice(0, 1200);
    let cached = this.queries.get(key);
    if (!cached || cached.until < Date.now()) {
      const [vector] = await embedTexts(ai, [key]);
      cached = { vector, until: Date.now() + 5 * 60 * 1000 };
      if (this.queries.size >= 32) this.queries.delete(this.queries.keys().next().value!);
      this.queries.set(key, cached);
    }
    const semantic = this.sql.exec<IndexedPassage & { vector: string }>(`SELECT p.path, p.offset, p.body, v.vector
      FROM context_passages p JOIN context_vectors v ON p.path = v.path AND p.offset = v.offset
      ORDER BY p.rowid DESC LIMIT 4096`).toArray().map(({ vector, ...row }) => ({
      ...row, score: cosine(cached.vector, JSON.parse(vector)),
    })).filter(row => row.score >= 0.65).toSorted((a, b) => b.score - a.score).slice(0, 50);
    const merged = new Map<string, IndexedPassage>();
    for (const ranking of [this.retrieve(query, 50), semantic]) ranking.forEach((row, index) => {
      const id = JSON.stringify([row.path, row.offset]);
      const existing = merged.get(id);
      merged.set(id, { ...row, score: (existing?.score ?? 0) + 1 / (60 + index) });
    });
    return [...merged.values()].toSorted((a, b) => b.score - a.score).slice(0, count);
  }
}
