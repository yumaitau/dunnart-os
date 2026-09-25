// Retrieval stays in the collection Durable Object, under its existing access boundary.
const CHUNK_LENGTH = 3_000;
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
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS context_passages USING fts5(
      path UNINDEXED, offset UNINDEXED, title, description, body, tokenize = 'unicode61'
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
    this.sql.exec("DELETE FROM context_passages WHERE path = ?", path);
  }

  clear(): void {
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
}
