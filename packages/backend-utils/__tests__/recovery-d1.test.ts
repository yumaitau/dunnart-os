import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { d1RecoverySource, d1RecoveryTarget } from "../src/recovery-d1";

const bindings = env as typeof env & { RECOVERY_D1_SOURCE: D1Database; RECOVERY_D1_TARGET: D1Database };
const source = bindings.RECOVERY_D1_SOURCE, target = bindings.RECOVERY_D1_TARGET;
beforeEach(async () => {
  for (const db of [source, target]) {
    await db.batch([db.prepare("PRAGMA defer_foreign_keys=ON"),
      db.prepare("DROP VIEW IF EXISTS summary"),
      ...["child", "parent", "events", "texts", "one"].map(name => db.prepare(`DROP TABLE IF EXISTS "${name}"`))]);
  }
});
const copy = async () => d1RecoveryTarget("auth", target).stage(await d1RecoverySource("auth", source).export());

// Commit a competing change after each database read, preserving real D1 transaction behavior.
const afterDatabaseRead = (database: D1Database, afterRead: () => Promise<void>): D1Database => {
  const intercept = <T extends object>(value: T, methods: string[]): T => new Proxy(value, {
    get(object, key) {
      const member = Reflect.get(object, key);
      if (typeof member !== "function") return member;
      if (!methods.includes(String(key))) return member.bind(object);
      return async (...args: unknown[]) => {
        const result = await Reflect.apply(member, object, args);
        await afterRead();
        return result;
      };
    },
  });
  const reads = intercept(database, ["batch"]);
  return new Proxy(reads, {
    get(object, key) {
      if (key === "prepare") return (sql: string) => intercept(database.prepare(sql), ["all", "first", "raw"]);
      const member = Reflect.get(object, key);
      return typeof member === "function" ? member.bind(object) : member;
    },
  });
};

describe("D1 recovery adapter", () => {
  it("restores foreign keys, indexes, views and binary/text data", async () => {
    await source.batch([
      source.prepare("CREATE TABLE parent(id TEXT PRIMARY KEY, value TEXT)"),
      source.prepare("CREATE TABLE child(id TEXT PRIMARY KEY, parentId TEXT REFERENCES parent(id), content BLOB)"),
      source.prepare("CREATE INDEX child_parent ON child(parentId)"),
      source.prepare("CREATE VIEW summary AS SELECT id FROM parent"),
      source.prepare("INSERT INTO parent VALUES (?,?)").bind("fixture", "text\u0000with null"),
      source.prepare("INSERT INTO child VALUES (?,?,?)").bind("child", "fixture", new Uint8Array([0, 128, 255])),
    ]);
    await copy();
    expect(await target.prepare("SELECT value FROM parent").first("value")).toBe("text\u0000with null");
    expect(await target.prepare("SELECT hex(content) AS data FROM child").first("data")).toBe("0080FF");
    expect(await target.prepare("SELECT id FROM summary").first("id")).toBe("fixture");
    await expect(target.prepare("INSERT INTO child VALUES ('bad','missing',NULL)").run()).rejects.toThrow();
  });
  it("preserves the autoincrement high-water mark after deleted rows", async () => {
    await source.batch([
      source.prepare("CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)"),
      source.prepare("INSERT INTO events VALUES (100,'deleted')"),
      source.prepare("DELETE FROM events"),
    ]);
    await copy();
    await target.prepare("INSERT INTO events(body) VALUES ('next')").run();
    expect(await target.prepare("SELECT id FROM events").first("id")).toBe(101);
  });
  it("recomputes generated columns instead of trying to insert them", async () => {
    await source.batch([
      source.prepare("CREATE TABLE texts(value TEXT, length INTEGER GENERATED ALWAYS AS (length(value)) STORED)"),
      source.prepare("INSERT INTO texts(value) VALUES ('abc')"),
    ]);
    await copy();
    expect(await target.prepare("SELECT length FROM texts").first("length")).toBe(3);
  });
  it("keeps related rows and sequence marks coherent when writes occur between reads", async () => {
    await source.batch([
      source.prepare("CREATE TABLE parent(revision INTEGER)"),
      source.prepare("CREATE TABLE child(revision INTEGER)"),
      source.prepare("CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT)"),
      source.prepare("INSERT INTO parent VALUES (0)"),
      source.prepare("INSERT INTO child VALUES (0)"),
    ]);
    const competingWrites = afterDatabaseRead(source, async () => {
      await source.batch([
        source.prepare("UPDATE parent SET revision=revision+1"),
        source.prepare("UPDATE child SET revision=revision+1"),
        source.prepare("INSERT INTO events DEFAULT VALUES"),
        source.prepare("DELETE FROM events"),
      ]);
    });
    await d1RecoveryTarget("auth", target).stage(await d1RecoverySource("auth", competingWrites).export());
    const revision = await target.prepare("SELECT revision FROM parent").first<number>("revision");
    expect(revision).toBeGreaterThan(0);
    expect(await target.prepare("SELECT revision FROM child").first("revision")).toBe(revision);
    await target.prepare("INSERT INTO events DEFAULT VALUES").run();
    expect(await target.prepare("SELECT id FROM events").first("id")).toBe(revision! + 1);
  });
  it("rejects schema changes between discovery and the data snapshot", async () => {
    await source.prepare("CREATE TABLE one(id TEXT)").run();
    let changed = false;
    const migrating = afterDatabaseRead(source, async () => {
      if (changed) return;
      changed = true;
      await source.prepare("CREATE VIEW summary AS SELECT id FROM one").run();
    });
    await expect(d1RecoverySource("auth", migrating).export()).rejects.toThrow("schema changed");
  });
  it("refuses occupied targets", async () => {
    await target.prepare("CREATE TABLE one(id TEXT)").run();
    await expect(copy()).rejects.toThrow("empty");
    expect(await target.prepare("SELECT name FROM sqlite_schema WHERE name='one'").first("name")).toBe("one");
  });
  it("rolls back the entire staged database if a row violates constraints", async () => {
    await source.batch([source.prepare("CREATE TABLE one(id TEXT PRIMARY KEY)"), source.prepare("INSERT INTO one VALUES ('same')")]);
    const archive = await new Response(await d1RecoverySource("auth", source).export()).json() as { tables: Array<{ rows: unknown[][] }> };
    archive.tables[0].rows.push(archive.tables[0].rows[0]);
    await expect(d1RecoveryTarget("auth", target).stage(new Response(JSON.stringify(archive)).body!)).rejects.toThrow();
    expect(await target.prepare("SELECT name FROM sqlite_schema WHERE name='one'").first()).toBeNull();
  });
});
