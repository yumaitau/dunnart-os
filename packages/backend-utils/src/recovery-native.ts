import { decodePortableValue, encodePortableValue, type PortableValue, type RecoveryValueCodec } from './recovery-value';

/** Native storage snapshot. Alarm timestamp is retained but import never activates it. */
export interface NativeStorageSnapshot { version: 1; values: PortableValue; alarm: number | null }

type Schema = { type: string; name: string; sql: string };
type IntegerCell = { integer: string };
type Cell = string | number | null | ArrayBuffer | IntegerCell;
type Table = { name: string; columns: string[]; rows: Cell[][] };
type Contents = { kv: Map<string, unknown>; schema: Schema[]; tables: Table[]; sequences: { name: string; seq: string }[] };
const schemaQuery = "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND substr(name,1,4)<>'_cf_' AND substr(name,1,7)<>'sqlite_' ORDER BY type,name";
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const invalid = (reason: string): never => { throw new Error(`Native recovery: ${reason}`); };

function readSchema(storage: DurableObjectStorage): Schema[] {
  return storage.sql.exec<Schema>(schemaQuery).toArray();
}
function isInteger(value: unknown): value is string {
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d*)$/.test(value)) return false;
  const integer = BigInt(value);
  return integer >= -9223372036854775808n && integer <= 9223372036854775807n;
}
function columnsFor(storage: DurableObjectStorage, table: Schema): string[] {
  if (/^CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql)) return invalid(`virtual table ${table.name} requires a dedicated recovery adapter`);
  const info = storage.sql.exec<{ name: string; hidden: number }>(`PRAGMA table_xinfo(${quote(table.name)})`).toArray();
  const columns = info.filter(column => column.hidden === 0).map(column => column.name);
  const options = storage.sql.exec<{ name: string; wr: number }>('PRAGMA table_list').toArray().find(item => item.name === table.name);
  if (!options) return invalid(`missing table metadata for ${table.name}`);
  if (!options.wr) {
    const rowid = ['rowid', '_rowid_', 'oid'].find(name => !info.some(column => column.name.toLowerCase() === name));
    if (!rowid) return invalid(`table ${table.name} shadows every rowid alias`);
    columns.unshift(rowid);
  }
  if (!columns.length) return invalid(`table ${table.name} has no recoverable columns`);
  return columns;
}

/**
 * Capture every native KV entry and application SQL table under the caller's write barrier.
 * Runtime _cf_ tables are represented through KV/alarm APIs, never copied as application SQL.
 * Trusted capability hooks may perform asynchronous identity lookup after the synchronous capture.
 */
export async function captureNativeStorage(storage: DurableObjectStorage, codec?: RecoveryValueCodec): Promise<NativeStorageSnapshot> {
  const alarm = await storage.getAlarm();
  const contents = storage.transactionSync((): Contents => {
    const schema = readSchema(storage);
    const tables: Table[] = [];
    for (const table of schema.filter(item => item.type === 'table')) {
      const columns = columnsFor(storage, table);
      // SQLite's JS number conversion loses int64 bits. Read integers as decimal text before they
      // cross the runtime boundary; CAST(? AS INTEGER) restores their original SQLite type.
      const expressions = columns.flatMap(column => [
        `typeof(${quote(column)})`,
        `CASE WHEN typeof(${quote(column)})='integer' THEN CAST(${quote(column)} AS TEXT) ELSE ${quote(column)} END`,
      ]);
      const rows = [...storage.sql.exec(`SELECT ${expressions.join(',')} FROM ${quote(table.name)}`).raw()].map(row => columns.map((_, index): Cell => {
        const type = row[index * 2];
        const value = row[index * 2 + 1];
        if (type === 'integer' && isInteger(value)) return { integer: value };
        if (type === 'null' && value === null || type === 'text' && typeof value === 'string' || type === 'real' && typeof value === 'number' || type === 'blob' && value instanceof ArrayBuffer) return value as Cell;
        return invalid(`unsupported SQL cell in ${table.name}.${columns[index]}`);
      }));
      tables.push({ name: table.name, columns, rows });
    }
    const hasSequence = storage.sql.exec("SELECT name FROM sqlite_schema WHERE name='sqlite_sequence'").toArray().length;
    const sequences = hasSequence ? storage.sql.exec<{ name: string; seq: string }>('SELECT name,CAST(seq AS TEXT) AS seq FROM sqlite_sequence').toArray() : [];
    return { kv: new Map(storage.kv.list()), schema, tables, sequences };
  });
  return { version: 1, values: await encodePortableValue(contents, codec), alarm };
}

function parseContents(value: unknown): Contents {
  if (!value || typeof value !== 'object' || !('kv' in value) || !(value.kv instanceof Map) ||
      !('schema' in value) || !Array.isArray(value.schema) || !('tables' in value) || !Array.isArray(value.tables) ||
      !('sequences' in value) || !Array.isArray(value.sequences)) return invalid('invalid storage inventory');
  for (const key of value.kv.keys()) if (typeof key !== 'string') return invalid('invalid KV key');
  const schema: Schema[] = value.schema.map(item => {
    if (!item || typeof item.name !== 'string' || /^(?:_cf_|sqlite_)/i.test(item.name) || !['table', 'index', 'view', 'trigger'].includes(item.type) || typeof item.sql !== 'string' || !/^CREATE\s/i.test(item.sql)) return invalid('invalid application schema');
    return { type: item.type, name: item.name, sql: item.sql };
  });
  if (new Set(schema.map(item => `${item.type}:${item.name}`)).size !== schema.length) return invalid('duplicate schema name');
  const names = new Set(schema.filter(item => item.type === 'table').map(item => item.name));
  const tables: Table[] = value.tables.map(item => {
    if (!item || typeof item.name !== 'string' || !names.delete(item.name) || !Array.isArray(item.columns) || !item.columns.length ||
        !item.columns.every((column: unknown) => typeof column === 'string') || new Set(item.columns).size !== item.columns.length || !Array.isArray(item.rows)) return invalid('invalid table inventory');
    for (const row of item.rows) {
      if (!Array.isArray(row) || row.length !== item.columns.length) return invalid('invalid SQL row');
      for (const cell of row) {
        if (cell === null || typeof cell === 'string' || cell instanceof ArrayBuffer || typeof cell === 'number' && !Number.isNaN(cell)) continue;
        if (cell && typeof cell === 'object' && Object.keys(cell).length === 1 && isInteger(cell.integer)) continue;
        return invalid('invalid SQL cell');
      }
    }
    return { name: item.name, columns: item.columns, rows: item.rows };
  });
  if (names.size) return invalid('missing SQL table');
  const sequences: { name: string; seq: string }[] = [];
  for (const item of value.sequences) {
    if (!item || typeof item.name !== 'string' || !isInteger(item.seq) || !tables.some(table => table.name === item.name) || sequences.some(sequence => sequence.name === item.name)) return invalid('invalid sequence');
    sequences.push({ name: item.name, seq: item.seq });
  }
  return { kv: value.kv, schema, tables, sequences };
}

/**
 * Atomically import an authenticated snapshot into an inactive, empty target. The caller must
 * hold its write barrier throughout this call, including asynchronous capability restoration.
 * No alarm is scheduled: the caller explicitly resumes background work after recovery validation.
 * SQL and KV roll back together if validation or any native write fails.
 */
export async function restoreNativeStorage(storage: DurableObjectStorage, snapshot: NativeStorageSnapshot, codec?: RecoveryValueCodec): Promise<void> {
  if (!snapshot || snapshot.version !== 1 || snapshot.alarm !== null && (!Number.isSafeInteger(snapshot.alarm) || snapshot.alarm < 0)) return invalid('invalid snapshot');
  const assertEmpty = () => {
    if ([...storage.kv.list({ limit: 1 })].length || readSchema(storage).length) return invalid('target must be empty and inactive');
  };
  assertEmpty();
  if (await storage.getAlarm() !== null) return invalid('target must have no active alarm');
  const contents = parseContents(await decodePortableValue(snapshot.values, codec));
  storage.transactionSync(() => {
    assertEmpty();
    storage.sql.exec('PRAGMA defer_foreign_keys = ON');
    for (const table of contents.schema.filter(item => item.type === 'table')) {
      storage.sql.exec(table.sql);
      const expected = columnsFor(storage, table);
      const actual = contents.tables.find(item => item.name === table.name)!.columns;
      if (expected.length !== actual.length || expected.some((name, index) => name !== actual[index])) return invalid(`column inventory mismatch for ${table.name}`);
    }
    for (const table of contents.tables) {
      for (const row of table.rows) {
        const parameters = row.map(cell => cell && typeof cell === 'object' && !(cell instanceof ArrayBuffer) ? 'CAST(? AS INTEGER)' : '?');
        const bindings = row.map(cell => cell && typeof cell === 'object' && !(cell instanceof ArrayBuffer) ? cell.integer : cell);
        storage.sql.exec(`INSERT INTO ${quote(table.name)} (${table.columns.map(quote).join(',')}) VALUES (${parameters.join(',')})`, ...bindings);
      }
    }
    for (const sequence of contents.sequences) {
      storage.sql.exec('DELETE FROM sqlite_sequence WHERE name=?', sequence.name);
      storage.sql.exec('INSERT INTO sqlite_sequence(name,seq) VALUES (?,CAST(? AS INTEGER))', sequence.name, sequence.seq);
    }
    for (const item of contents.schema.filter(item => item.type !== 'table')) storage.sql.exec(item.sql);
    if (JSON.stringify(readSchema(storage)) !== JSON.stringify(contents.schema)) return invalid('restored schema differs from snapshot');
    if (storage.sql.exec('PRAGMA foreign_key_check').toArray().length) return invalid('foreign key violation');
    for (const [key, value] of contents.kv) storage.kv.put(key, value);
  });
  await storage.sync();
}
