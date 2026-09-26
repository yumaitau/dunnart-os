import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ContextSearchIndex, searchChunks } from "../src/context-search.js";
import { ContextCollectionDurableObject } from "../src/context-collection.js";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import { LibraryReadSession } from "../src/library-read.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import { domainName } from "../src/domain.js";
import { contentTypeFromPath } from "../src/context-types.js";

const collections = (env as { COLLECTIONS: DurableObjectNamespace<ContextCollectionDurableObject> }).COLLECTIONS;

function inCollection<T>(fn: (collection: ContextCollectionDurableObject, state: DurableObjectState) => Promise<T>) {
  return runInDurableObject(collections.getByName(crypto.randomUUID()), fn);
}

describe("knowledge base index", () => {
  it("finds a paraphrase without keyword overlap and reuses embeddings", () => inCollection(async (_, state) => {
    const index = new ContextSearchIndex(state.storage.sql);
    index.replace("travel.md", "Travel", "", "Taxi fares may be reimbursed.");
    const run = vi.fn(async (_model: string, input: { text: string[] }) => ({
      data: input.text.map(() => Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0)),
    }));
    const ai = { run } as Ai;
    expect(index.retrieve("Can I expense a cab?")).toEqual([]);
    expect((await index.retrieveSemantic("Can I expense a cab?", ai))[0].path).toBe("travel.md");
    const calls = run.mock.calls.length;
    expect((await index.retrieveSemantic("Can I expense a cab?", ai))[0].body).toContain("reimbursed");
    expect(run).toHaveBeenCalledTimes(calls);
    index.remove("travel.md");
    expect(await index.retrieveSemantic("Can I expense a cab?", ai)).toEqual([]);
  }));

  it("discards stale embeddings when a document changes during indexing", () => inCollection(async (_, state) => {
    const index = new ContextSearchIndex(state.storage.sql);
    index.replace("policy.md", "Policy", "", "Old policy");
    let release!: (value: { data: number[][] }) => void;
    const ai = { run: () => new Promise(resolve => { release = resolve; }) } as Ai;
    const pending = index.indexPending(ai);
    index.replace("policy.md", "Policy", "", "New policy");
    release({ data: [Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0)] });
    await pending;
    expect(state.storage.sql.exec("SELECT * FROM context_vectors").toArray()).toEqual([]);
    expect(index.read("policy.md")).toBe("New policy");
  }));

  it("retrieves passages and reconstructs text across chunk boundaries without loss", () => inCollection(async (_, state) => {
    const index = new ContextSearchIndex(state.storage.sql);
    const body = "A document paragraph with Unicode 日本語. ".repeat(250) + "x".repeat(2999) + "🦘".repeat(1700) + "The permit expires in December.";
    index.replace("permit.pdf", "Permit", "", body);
    expect(searchChunks(body).length).toBeGreaterThan(1);
    expect(index.read("permit.pdf")).toBe(body);
    const results = index.retrieve("permit expires");
    expect(results[0]).toMatchObject({ path: "permit.pdf" });
    expect(results.some(result => result.body.includes("December"))).toBe(true);
    expect(results.every(result => result.body.length <= 3000)).toBe(true);
  }));

  it("treats query operators as text and bounds query results", () => inCollection(async (_, state) => {
    const index = new ContextSearchIndex(state.storage.sql);
    index.replace("a.md", "A", "", "red OR blue NEAR permits");
    expect(index.retrieve('" OR NEAR() -*').length).toBe(1);
    expect(index.retrieve("***")).toEqual([]);
    expect(index.retrieve("red", 0)).toEqual([]);
    expect(index.retrieve("red", -1)).toEqual([]);
  }));

  it("updates, renames, and deletes uploaded documents without stale results", () => inCollection(async collection => {
    await collection.initialize({
      id: crypto.randomUUID(), title: "Test", description: "", visibility: "private",
      created: new Date(), lastUpdated: new Date(), documentCount: 0, content: { source: "web" },
    }, "test", "owner");
    await collection.putContextDocument("a.md", { description: "", body: "First platypus document" });
    expect((await collection.retrieve("platypus"))[0].path).toBe("a.md");
    await collection.putContextDocument("a.md", { description: "", body: "Second wombat document" });
    expect(await collection.search("platypus")).toEqual([]);
    await collection.moveContextDocument("a.md", "b.md");
    expect((await collection.search("wombat"))[0].path).toBe("b.md");
    await collection.deleteContextDocument("b.md");
    expect(await collection.retrieve("wombat")).toEqual([]);
  }));

  it("rolls back the index with a failed document transaction", () => inCollection(async (_, state) => {
    const index = new ContextSearchIndex(state.storage.sql);
    index.replace("a.md", "A", "", "original text");
    expect(() => state.storage.transactionSync(() => {
      index.replace("a.md", "A", "", "replacement text");
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(index.read("a.md")).toBe("original text");
  }));

  it("keeps collections in separate SQLite stores", async () => {
    const first = collections.getByName(crypto.randomUUID());
    const second = collections.getByName(crypto.randomUUID());
    await runInDurableObject(first, (_, state) => {
      new ContextSearchIndex(state.storage.sql).replace("private.md", "Private", "", "secretkookaburra");
    });
    await runInDurableObject(second, (_, state) => {
      expect(new ContextSearchIndex(state.storage.sql).retrieve("secretkookaburra")).toEqual([]);
    });
  });

  it("extracts document text while retaining original bytes and rejects failed conversion", () => inCollection(async (_, state) => {
    let extraction = "Travel policy: reimbursement requires receipts.";
    const collection = new ContextCollectionDurableObject(state, { ...env, AI: {
      toMarkdown: async () => ({ format: extraction ? "markdown" : "error", data: extraction }),
    } as Ai });
    await collection.initialize({ id: crypto.randomUUID(), title: "Test", description: "", visibility: "private",
      created: new Date(), lastUpdated: new Date(), documentCount: 0, content: { source: "web" },
    }, "test", "owner");
    const bytes = new TextEncoder().encode("binary document fixture").toBase64();
    for (const path of ["policy.pdf", "policy.docx", "policy.xlsx", "policy.odt", "policy.ods"]) {
      await collection.putContextDocument(path, { description: "", body: bytes, contentType: contentTypeFromPath(path) });
      expect((await collection.getContextDocument(path))?.body).toBe(bytes);
      expect(collection.getIndexedText(path)).toBe(extraction);
    }
    expect((await collection.retrieve("reimbursement", 10)).length).toBe(5);
    await collection.moveContextDocument("policy.pdf", "moved.pdf");
    expect(collection.getIndexedText("moved.pdf")).toBe(extraction);
    await collection.moveContextDocument("policy.docx", "moved.docx");
    expect(collection.getIndexedText("moved.docx")).toBe(extraction);
    extraction = "";
    await expect(collection.putContextDocument("moved.pdf", { description: "", body: bytes })).rejects.toThrow("converted");
    expect(collection.getIndexedText("moved.pdf")).toContain("reimbursement");
  }));

  it("rejects a delayed extraction after another upload changes the document", () => inCollection(async (_, state) => {
    let release!: (value: { format: "markdown"; data: string }) => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const conversion = new Promise<{ format: "markdown"; data: string }>(resolve => { release = resolve; });
    const collection = new ContextCollectionDurableObject(state, { ...env, AI: {
      toMarkdown: () => { started(); return conversion; },
    } as Ai });
    await collection.initialize({ id: crypto.randomUUID(), title: "Test", description: "", visibility: "private",
      created: new Date(), lastUpdated: new Date(), documentCount: 0, content: { source: "web" },
    }, "test", "owner");
    const uploading = collection.putContextDocument("policy.pdf", { description: "", body: btoa("fixture") });
    await waiting;
    await collection.putContextDocument("policy.pdf", { description: "", body: "newer document", contentType: "text/plain" });
    release({ format: "markdown", data: "stale extraction" });
    await expect(uploading).rejects.toThrow("changed during indexing");
    expect(await collection.retrieve("stale")).toEqual([]);
    expect((await collection.retrieve("newer"))[0].body).toBe("newer document");
  }));

  it("authorizes RAG passages and rechecks collection access for retained agent sessions", async () => {
    const libraries = (env as { LIBRARIES: DurableObjectNamespace<UserLibraryDurableObject> }).LIBRARIES;
    const domain = crypto.randomUUID();
    const id = crypto.randomUUID();
    const collection = collections.getByName(domainName(domain, id));
    await collection.initialize({ id, title: "Private", description: "", visibility: "private",
      created: new Date(), lastUpdated: new Date(), documentCount: 0, content: { source: "web" },
    }, domain, "owner");
    await collection.putContextDocument("policy.md", { description: "", body: "Receipt evidence required." });
    const library = libraries.getByName(domainName(domain, "owner"));
    await library.createOwnedCollection(id, "Private", "");
    let allowed = false;
    let observations = 0;
    const authorizer = new RpcStub(new class extends RpcTarget {
      async authorizeObservation() {
        if (!allowed) throw new Error("Observation denied");
        observations++;
      }
      async getGitCache(): Promise<never> { throw new Error("Unused"); }
    }());
    using session = new LibraryReadSession(collections, libraries, domain, "owner", authorizer,
      async () => ({ pendingCollections: [], commit() {} }));
    await expect(session.retrieve("receipt")).rejects.toThrow("Observation denied");
    allowed = true;
    expect((await session.retrieve("receipt"))[0]).toMatchObject({ collectionId: id, path: "policy.md", offset: 0 });
    expect(observations).toBe(1);
    using otherDomain = new LibraryReadSession(collections, libraries, "other", "owner", authorizer.dup(),
      async () => ({ pendingCollections: [], commit() {} }));
    expect(await otherDomain.retrieve("receipt", { collectionId: id })).toEqual([]);
    await library.removeOwnedCollection(id);
    expect(await session.retrieve("receipt", { collectionId: id })).toEqual([]);
    expect(observations).toBe(1);
  });
});
