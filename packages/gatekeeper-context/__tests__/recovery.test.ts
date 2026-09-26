import { verifyCapabilityDescriptor } from "@gadgets/backend-utils/recovery-capability";
import { domainName } from "../src/domain.js";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import type { LibraryRegistryDurableObject } from "../src/registry-do.js";
import { contextRecoveryDomain, CONTEXT_RECOVERY_OFFLINE } from "../src/recovery.js";

const namespaces = env as {
  COLLECTIONS: DurableObjectNamespace<ContextCollectionDurableObject>;
  LIBRARIES: DurableObjectNamespace<UserLibraryDurableObject>;
  REGISTRY: DurableObjectNamespace<LibraryRegistryDurableObject>;
};

describe("Context recovery", () => {
  it("preserves documents, extracted text, vectors and account isolation in an offline target", async () => {
    const source = namespaces.COLLECTIONS.getByName(crypto.randomUUID());
    const target = namespaces.COLLECTIONS.getByName(crypto.randomUUID());
    const date = new Date("2026-01-01T00:00:00Z");
    await source.initialize({ id: "collection", title: "Private", description: "", visibility: "private",
      created: date, lastUpdated: date, documentCount: 0, content: { source: "web" } }, "original", "owner");
    await source.putContextDocument("doc.md", { description: "", contentType: "text/markdown", body: "Original body" });
    await source.putContextDocument("binary.png", { description: "", contentType: "image/png", body: "AAEC/w==" });
    await runInDurableObject(source, (_, state) => {
      state.storage.sql.exec("INSERT INTO context_vectors(path, offset, vector) VALUES (?, ?, ?)", "doc.md", 0, "[1,2,3]");
    });
    const snapshot = await source.exportRecovery();
    const domain = contextRecoveryDomain("test", "original");
    await target.restoreRecovery(snapshot, domain);
    expect((await target.getContextDocument("binary.png"))?.body).toBe("AAEC/w==");
    expect((await target.getContextDocument("doc.md"))?.body).toBe("Original body");
    expect(await target.search("Original")).toHaveLength(1);
    expect((await target.exportRecovery()).vectors).toEqual(snapshot.vectors);
    await runInDurableObject(target, async (instance, state) => {
      expect(state.storage.kv.get(CONTEXT_RECOVERY_OFFLINE)).toBe(true);
      const original = instance.env.AI;
      const outgoing = vi.fn(() => { throw new Error("Unexpected external AI call"); });
      instance.env.AI = { run: outgoing, toMarkdown: outgoing } as unknown as Ai;
      try {
        expect(await instance.retrieve("Original")).toHaveLength(1);
        await expect(instance.putContextDocument("upload.pdf", { description: "", contentType: "application/pdf", body: "AAEC" })).rejects.toThrow("offline");
        expect(outgoing).not.toHaveBeenCalled();
      } finally { instance.env.AI = original; }
    });
    await runInDurableObject(target, async instance => { await expect(instance.restoreRecovery(snapshot, domain)).rejects.toThrow("not empty"); });
    await runInDurableObject(source, async instance => { await expect(instance.restoreRecovery(snapshot, domain)).rejects.toThrow("not empty"); });
    expect((await source.getContextDocument("doc.md"))?.body).toBe("Original body");
  });

  it("preserves private account indexes and public registry independently", async () => {
    const owner = namespaces.LIBRARIES.getByName(crypto.randomUUID());
    const stranger = namespaces.LIBRARIES.getByName(crypto.randomUUID());
    const restored = namespaces.LIBRARIES.getByName(crypto.randomUUID());
    await owner.createOwnedCollection("private", "Private", "Owner only");
    await restored.restoreRecovery(await owner.exportRecovery());
    expect(await restored.hasOwned("private")).toBe(true);
    expect(await stranger.hasOwned("private")).toBe(false);
    expect(await restored.listOwnedCollections()).toEqual(await owner.listOwnedCollections());
    const registry = namespaces.REGISTRY.getByName(crypto.randomUUID());
    const registryTarget = namespaces.REGISTRY.getByName(crypto.randomUUID());
    await registry.addPublic("original", { id: "public", title: "Public", description: "", visibility: "public", documentCount: 3, lastUpdated: new Date() });
    const snapshot = await registry.exportRecovery();
    await registryTarget.restoreRecovery(snapshot.rows);
    expect((await registryTarget.exportRecovery()).collectionIds).toEqual(["public"]);
    expect(await registryTarget.isPublic("private")).toBe(false);
  });

  it("restores account capability identity through the trusted participant and preserves verifier isolation", async () => {
    await runInDurableObject(namespaces.COLLECTIONS.getByName(crypto.randomUUID()), async instance => {
    const vendor = instance.ctx.exports.GatekeeperVendor({});
    using participant = await vendor.getRecoveryParticipant();
    using account = await vendor.createAccount();
    const signed = await account.getRecoveryDescriptor();
    const descriptor = await verifyCapabilityDescriptor("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", signed);
    if (!descriptor || typeof descriptor !== "object" || !("props" in descriptor) || !descriptor.props || typeof descriptor.props !== "object" || !("accountId" in descriptor.props)) throw new Error("Missing account descriptor");
    const accountId = String(descriptor.props.accountId);
    const library = namespaces.LIBRARIES.getByName(domainName("default", accountId));
    await library.createOwnedCollection("owned", "Owner", "Private");
    const source = namespaces.COLLECTIONS.getByName(domainName("default", "owned"));
    await source.initialize({ id: "owned", title: "Owner", description: "", visibility: "private",
      created: new Date(), lastUpdated: new Date(), documentCount: 0, content: { source: "web" } }, "default", accountId);
    await participant.beginRecovery([accountId], "snapshot");
    const snapshot = await participant.exportAccount(accountId);
    await participant.validateRecovery([accountId], "snapshot");
    await participant.endRecovery([accountId], "snapshot");
    using restored = await participant.restoreAccount(snapshot, "isolated");
    using verifier = await restored.getVerifier();
    expect(await verifier.hasCollectionAccess("recovery:isolated:default", "owned")).toBe(true);
    expect(await verifier.hasCollectionAccess("default", "owned")).toBe(false);
    const copied = namespaces.LIBRARIES.getByName(domainName("recovery:isolated:default", accountId));
    expect(await copied.hasOwned("owned")).toBe(true);
    });
  });

  it("restores public domain state even when no user accounts remain", async () => {
    const domain = crypto.randomUUID();
    const collectionId = "public";
    const source = namespaces.COLLECTIONS.getByName(domainName(domain, collectionId));
    await source.initialize({ id: collectionId, title: "Public", description: "", visibility: "public",
      created: new Date(), lastUpdated: new Date(), documentCount: 0, content: { source: "web" } }, domain, "");
    await source.putContextDocument("shared.md", { description: "", body: "Shared knowledge" });
    await namespaces.REGISTRY.getByName(domain).addPublic(domain, {
      id: collectionId, title: "Public", description: "", visibility: "public", documentCount: 1, lastUpdated: new Date(),
    });
    await runInDurableObject(namespaces.COLLECTIONS.getByName(crypto.randomUUID()), async instance => {
      const vendor = instance.ctx.exports.GatekeeperVendor({ props: { sharingDomain: domain } });
      using participant = await vendor.getRecoveryParticipant();
      await participant.beginRecovery([], "public-capture");
      const snapshot = await participant.exportDomain();
      await participant.validateRecovery([], "public-capture");
      await participant.endRecovery([], "public-capture");
      await participant.restoreDomain(snapshot, "public-target");
    });
    const restoredDomain = contextRecoveryDomain("public-target", domain);
    expect(await namespaces.REGISTRY.getByName(restoredDomain).isPublic(collectionId)).toBe(true);
    expect((await namespaces.COLLECTIONS.getByName(domainName(restoredDomain, collectionId)).getContextDocument("shared.md"))?.body).toBe("Shared knowledge");
    const enabled = await namespaces.LIBRARIES.getByName(crypto.randomUUID()).getEnabledCollections(restoredDomain);
    expect(enabled.get(collectionId)).toBe("public");
  });

  it("rejects target names that could cross the domain separator", () => {
    expect(() => contextRecoveryDomain("../live", "original")).toThrow();
    expect(() => contextRecoveryDomain("test", "original\0victim")).toThrow();
    expect(contextRecoveryDomain("test", "original")).toBe("recovery:test:original");
  });
});
