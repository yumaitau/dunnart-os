import { DurableObject } from 'cloudflare:workers';
import { captureNativeStorage, restoreNativeStorage, type NativeStorageSnapshot } from '../src/recovery-native';
import { decodePortableValue, encodePortableValue, type RecoveryValueCodec } from '../src/recovery-value';

export class NativeRecoveryFixture extends DurableObject {
  async seed() {
    const storage = this.ctx.storage;
    const data: Record<string, unknown> = { bytes: new Uint8Array([0, 255, 3]), count: 999999999999999999n };
    data.self = data;
    storage.kv.put('state', data);
    for (let i = 0; i < 1003; i++) storage.kv.put(`page:${i}`, i);
    storage.sql.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT UNIQUE)');
    storage.sql.exec("INSERT INTO parent(id,label) VALUES (2,'kept'),(50,'deleted')");
    storage.sql.exec('DELETE FROM parent WHERE id=50');
    storage.sql.exec('CREATE TABLE child(parent_id INTEGER REFERENCES parent(id), big INTEGER, bytes BLOB, computed TEXT GENERATED ALWAYS AS (CAST(big AS TEXT)) VIRTUAL)');
    storage.sql.exec('INSERT INTO child(rowid,parent_id,big,bytes) VALUES (77,2,9223372036854775807,?)', new Uint8Array([0, 128, 255]).buffer);
    storage.sql.exec('CREATE INDEX child_parent ON child(parent_id)');
    storage.sql.exec('CREATE VIEW child_view AS SELECT big FROM child');
    storage.sql.exec('CREATE TABLE audit(value TEXT)');
    storage.sql.exec("CREATE TRIGGER audit AFTER INSERT ON parent BEGIN INSERT INTO audit VALUES (NEW.label); END");
    storage.sql.exec('CREATE TABLE labels(tag TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID');
    storage.sql.exec("INSERT INTO labels VALUES ('étiquette','preserved')");
    await storage.setAlarm(Date.now() + 3600000);
  }
  capture() { return this.ctx.blockConcurrencyWhile(async () => JSON.stringify(await captureNativeStorage(this.ctx.storage))); }
  async restore(snapshot: string) {
    const outcome = await this.ctx.blockConcurrencyWhile(async () => {
      try { await restoreNativeStorage(this.ctx.storage, JSON.parse(snapshot), { describe: () => undefined, restore: () => () => {} }); return { error: null }; }
      catch (error) { return { error: String(error) }; }
    });
    return outcome.error;
  }
  async inspect() {
    const storage = this.ctx.storage;
    const value = storage.kv.get<Record<string, unknown>>('state');
    return { count: [...storage.kv.list()].length, last: storage.kv.get<number>('page:1002'), cyclic: value?.self === value,
      bytes: value?.bytes as Uint8Array, bigint: value?.count as bigint, alarm: await storage.getAlarm(),
      schema: storage.sql.exec("SELECT name FROM sqlite_schema WHERE name NOT LIKE '_cf_%' ORDER BY name").toArray(),
      row: storage.sql.exec('SELECT rowid,parent_id,CAST(big AS TEXT) AS big,bytes,computed FROM child').one(),
      sequence: storage.sql.exec('SELECT seq FROM sqlite_sequence WHERE name=?', 'parent').one(),
      audit: storage.sql.exec('SELECT * FROM audit').toArray(), labels: storage.sql.exec('SELECT * FROM labels').toArray() };
  }
  insertParent() {
    this.ctx.storage.sql.exec("INSERT INTO parent(label) VALUES ('next')");
    return this.ctx.storage.sql.exec("SELECT id FROM parent WHERE label='next'").one();
  }
  async occupied(kind: string) {
    if (kind === 'kv') this.ctx.storage.kv.put('existing', 'keep');
    if (kind === 'sql') this.ctx.storage.sql.exec('CREATE TABLE existing(value TEXT)');
    if (kind === 'alarm') await this.ctx.storage.setAlarm(Date.now() + 3600000);
  }
  empty() { return { kv: [...this.ctx.storage.kv.list()].length, sql: this.ctx.storage.sql.exec("SELECT name FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'").toArray() }; }
  async corruption(text: string, kind: string) {
    const snapshot: NativeStorageSnapshot = JSON.parse(text);
    const value = await decodePortableValue(snapshot.values) as { kv: Map<string, unknown>; tables: { name: string; rows: unknown[][] }[]; schema: { sql: string }[] };
    if (kind === 'missing') value.tables.pop();
    if (kind === 'sql') value.schema[0].sql = 'CREATE INDEX broken ON missing_table(x)';
    if (kind === 'kv') value.kv.set('invalid-capability', { invalidNative: true });
    return JSON.stringify({ ...snapshot, values: await encodePortableValue(value, { describe: item => "invalidNative" in item ? { id: "invalid" } : undefined, restore: () => null }) });
  }
  async capabilities(snapshot?: string) {
    const exports = this.ctx.exports as typeof this.ctx.exports & {
      NativeRecoveryFixture(options: { props: object }): DurableObjectClass<NativeRecoveryFixture>;
    };
    const codec: RecoveryValueCodec = {
      async describe(value, path) {
        return path.endsWith('["class"]') && Object.getPrototypeOf(value) !== Object.prototype ? { type: 'fixture', id: 'class' } : undefined;
      },
      restore: () => exports.NativeRecoveryFixture({ props: {} }),
    };
    if (!snapshot) {
      this.ctx.storage.kv.put('capability', { class: exports.NativeRecoveryFixture({ props: {} }) });
      return JSON.stringify(await captureNativeStorage(this.ctx.storage, codec));
    }
    await restoreNativeStorage(this.ctx.storage, JSON.parse(snapshot), codec);
    const stored = this.ctx.storage.kv.get<{ class: DurableObjectClass<NativeRecoveryFixture> }>('capability')!;
    const stub = this.ctx.facets.get('restored', () => ({ class: stored.class }));
    return { result: await stub.identity() };
  }
  identity() { return 'native-rpc-ok'; }
  async unrecognized() { try { await captureNativeStorage(this.ctx.storage); return null; } catch (error) { return String(error); } }
  alarm() {}
}
export default { fetch() { return new Response('native recovery tests'); } };
