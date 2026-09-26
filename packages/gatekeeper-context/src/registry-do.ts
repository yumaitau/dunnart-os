// Per-domain registry of public collections. It serializes writes to the KV snapshot read by user
// sessions when building their enabled collection set.

import { DurableObject } from "cloudflare:workers";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { ContextCollectionSummary } from "./context-types.js";
import { publicCollectionsKvKey } from "./collection-kv.js";

import { freezeContextStorage, releaseContextStorage, requireContextWritable, captureContextRows, restoreContextRows, type ContextRecoveryRows } from "./recovery.js";

function makeRegistryStorage(storage: DurableObjectStorage) {
  return createTypedStorage(storage, {
    collections: {
      publicCollections: collection<ContextCollectionSummary>()({
        primaryKey: "id",
      }),
    },
    singletons: {},
  });
}

export class LibraryRegistryDurableObject extends DurableObject<Cloudflare.Env> {
  private storage: ReturnType<typeof makeRegistryStorage>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.storage = makeRegistryStorage(ctx.storage);
  }

  /** Freeze local mutation while the deployment takes its coherent snapshot. */
  async beginRecovery(run: string): Promise<void> {
    if (freezeContextStorage(this.ctx.storage, run)) {
      await this.ctx.storage.sync();
      this.ctx.abort("Context recovery fence installed; retry acquisition.");
    }
  }

  /** Confirm the deployment still owns this object's capture fence. */
  validateRecovery(run: string): void {
    if (this.ctx.storage.kv.get(".recoveryFreeze") !== run) throw new Error("Context recovery fence was lost.");
  }

  /** Release only the matching deployment capture fence. */
  endRecovery(run: string): void { releaseContextStorage(this.ctx.storage, run); }

  /** Capture authoritative registry state rather than the eventually consistent KV mirror. */
  async exportRecovery(): Promise<{ rows: ContextRecoveryRows; collectionIds: string[] }> {
    return { rows: await captureContextRows(this.ctx.storage), collectionIds: [...this.storage.publicCollections.list()].map(item => item.id) };
  }

  /** Restore only an empty registry; the caller owns its isolated KV mirror. */
  restoreRecovery(rows: ContextRecoveryRows): Promise<void> {
    return restoreContextRows(this.ctx.storage, rows);
  }

  async #writeSnapshot(domain: string): Promise<void> {
    let collections = [...this.storage.publicCollections.list()];
    await this.env.CONTEXT_COLLECTIONS.put(
      publicCollectionsKvKey(domain), JSON.stringify(collections));
  }

  isPublic(collectionId: string): boolean {
    return !!this.storage.publicCollections.get(collectionId);
  }

  async addPublic(domain: string, summary: ContextCollectionSummary): Promise<void> {
    requireContextWritable(this.ctx.storage);
    this.storage.publicCollections.put(summary);
    await this.#writeSnapshot(domain);
  }

  async removePublic(domain: string, collectionId: string): Promise<void> {
    requireContextWritable(this.ctx.storage);
    if (this.storage.publicCollections.get(collectionId)) {
      this.storage.publicCollections.delete(collectionId);
      await this.#writeSnapshot(domain);
    }
  }

  /** Refresh a public collection summary; no-op if it is no longer public. */
  async syncPublic(domain: string, summary: ContextCollectionSummary): Promise<void> {
    requireContextWritable(this.ctx.storage);
    let existing = this.storage.publicCollections.get(summary.id);
    if (!existing) return;
    if (existing.lastUpdated.valueOf() !== summary.lastUpdated.valueOf()) {
      this.storage.publicCollections.put(summary);
      await this.#writeSnapshot(domain);
    }
  }
}
