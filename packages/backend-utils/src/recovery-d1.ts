import { recoveryBase64, recoveryBytes } from "./recovery-archive";
import type { RecoverySource, RecoveryTarget } from "./recovery-repository";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_STATEMENTS = 5000;
const schemaQuery = "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND substr(name,1,7) <> 'sqlite_' AND substr(name,1,4) <> '_cf_' ORDER BY type, name";
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
type Cell = string | number | null | { binary: string };
interface Schema { type: string; name: string; sql: string }
interface Table { name: string; columns: string[]; rows: Cell[][] }
interface Archive { version: 1; schema: Schema[]; tables: Table[]; sequences: Array<{ name: string; seq: number }> }

function cell(value: unknown): Cell {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (value instanceof ArrayBuffer) return { binary: recoveryBase64(new Uint8Array(value)) };
  if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return { binary: recoveryBase64(new Uint8Array(value)) };
  }
  throw new Error("D1 value requires a lossless recovery adapter.");
}
function bind(value: unknown): string | number | null | Uint8Array {
  if (value && typeof value === "object" && !Array.isArray(value) && "binary" in value && typeof value.binary === "string") {
    return recoveryBytes(value.binary, MAX_BYTES);
  }
  const result = cell(value);
  if (typeof result === "object" && result !== null) throw new Error("Invalid D1 recovery value.");
  return result;
}

/** Export a transactional D1 snapshot under the coordinator's deployment write barrier. */
export function d1RecoverySource(id: string, database: D1Database): RecoverySource {
  return { id, version: 1, async export() {
    const schema = (await database.prepare(schemaQuery).all<Schema>()).results;
    if (schema.length > 256 || schema.some(entry => !["table", "index", "trigger", "view"].includes(entry.type))) {
      throw new Error("D1 schema requires a dedicated recovery adapter.");
    }
    const tables: Table[] = [];
    for (const table of schema.filter(entry => entry.type === "table")) {
      if (/^CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql)) throw new Error("D1 virtual tables require a dedicated recovery adapter.");
      const info = (await database.prepare(`PRAGMA table_xinfo(${quote(table.name)})`).all<{ name: string; hidden: number }>()).results;
      const columns = info.filter(column => column.hidden === 0).map(column => column.name);
      if (!columns.length) throw new Error("D1 table has no recoverable columns.");
      tables.push({ name: table.name, columns, rows: [] });
    }
    const hasSequence = await database.prepare("SELECT name FROM sqlite_schema WHERE name='sqlite_sequence'").first();
    // D1 executes the batch transactionally, so table rows and sequence high-water marks agree.
    // Metadata discovery happens earlier; reject it if the schema changed before this snapshot.
    const snapshot = await database.batch<Record<string, unknown>>([
      database.prepare(schemaQuery),
      ...tables.map(table => database.prepare(`SELECT ${table.columns.map(quote).join(",")} FROM ${quote(table.name)}`)),
      database.prepare(hasSequence ? "SELECT name, seq FROM sqlite_sequence" : "SELECT NULL AS name, NULL AS seq WHERE 0"),
      database.prepare(schemaQuery),
    ]);
    if (JSON.stringify(snapshot[0].results) !== JSON.stringify(schema) ||
        JSON.stringify(snapshot[snapshot.length - 1].results) !== JSON.stringify(schema)) {
      throw new Error("D1 schema changed during the recovery snapshot.");
    }
    let statements = schema.length + 2;
    for (const [index, table] of tables.entries()) {
      const records = snapshot[index + 1].results;
      statements += records.length;
      if (statements > MAX_STATEMENTS) throw new Error("D1 recovery requires a larger database export adapter.");
      table.rows = records.map(record => table.columns.map(column => cell(record[column])));
    }
    const sequences = snapshot[snapshot.length - 2].results as Archive["sequences"];
    if (sequences.some(sequence => !Number.isSafeInteger(sequence.seq) || sequence.seq < 0) ||
        statements + sequences.length * 2 > MAX_STATEMENTS) throw new Error("D1 sequence requires a dedicated recovery adapter.");
    const archive: Archive = { version: 1, schema, tables, sequences };
    const bytes = new TextEncoder().encode(JSON.stringify(archive));
    if (bytes.length > MAX_BYTES) throw new Error("D1 recovery requires a larger database export adapter.");
    return new Response(bytes).body!;
  } };
}

/**
 * Stage an authenticated archive in a newly provisioned D1 database. Schema is trusted only after
 * repository authentication; never call this with user-supplied unauthenticated SQL archives.
 */
export function d1RecoveryTarget(id: string, database: D1Database): RecoveryTarget {
  return { id, version: 1, async stage(stream) {
    if ((await database.prepare(schemaQuery).all()).results.length) throw new Error("D1 recovery target must be empty.");
    const reader = stream.getReader(); const parts: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.length; if (length > MAX_BYTES) throw new Error("D1 recovery archive exceeds the size limit.");
        parts.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
        !("schema" in value) || !Array.isArray(value.schema) || value.schema.length > 256 ||
        !("tables" in value) || !Array.isArray(value.tables) || !("sequences" in value) || !Array.isArray(value.sequences)) {
      throw new Error("Invalid D1 recovery archive.");
    }
    const schema: Schema[] = value.schema.map(item => {
      if (!item || typeof item.type !== "string" || !["table", "index", "view", "trigger"].includes(item.type) ||
          typeof item.name !== "string" || typeof item.sql !== "string" || !/^CREATE\s/i.test(item.sql)) throw new Error("Invalid D1 recovery schema.");
      return { type: item.type, name: item.name, sql: item.sql };
    });
    const statements = [database.prepare("PRAGMA defer_foreign_keys = ON"),
      ...schema.filter(entry => entry.type === "table").map(entry => database.prepare(entry.sql))];
    const names = new Set(schema.filter(entry => entry.type === "table").map(entry => entry.name));
    for (const table of value.tables) {
      if (!table || typeof table.name !== "string" || !names.delete(table.name) || !Array.isArray(table.columns) ||
          !table.columns.length || !table.columns.every((column: unknown) => typeof column === "string") || !Array.isArray(table.rows)) {
        throw new Error("Invalid D1 table inventory.");
      }
      const columns: string[] = table.columns;
      if (new Set(columns).size !== columns.length) throw new Error("Duplicate D1 recovery columns.");
      const insert = `INSERT INTO ${quote(table.name)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`;
      for (const row of table.rows) {
        if (!Array.isArray(row) || row.length !== columns.length) throw new Error("Invalid D1 recovery row.");
        statements.push(database.prepare(insert).bind(...row.map(bind)));
        if (statements.length > MAX_STATEMENTS) throw new Error("D1 recovery statement limit exceeded.");
      }
    }
    if (names.size) throw new Error("D1 recovery archive is missing tables.");
    for (const sequence of value.sequences) {
      if (!sequence || typeof sequence.name !== "string" || !Number.isSafeInteger(sequence.seq) || sequence.seq < 0 ||
          !schema.some(entry => entry.type === "table" && entry.name === sequence.name)) throw new Error("Invalid D1 recovery sequence.");
      statements.push(database.prepare("DELETE FROM sqlite_sequence WHERE name=?").bind(sequence.name));
      statements.push(database.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)").bind(sequence.name, sequence.seq));
    }
    statements.push(...schema.filter(entry => entry.type !== "table").map(entry => database.prepare(entry.sql)));
    if (statements.length > MAX_STATEMENTS) throw new Error("D1 recovery statement limit exceeded.");
    await database.batch(statements);
  } };
}
