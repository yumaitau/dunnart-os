import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { MutationQueue } from "@gadgets/bundled-blueprints/libraries/sync/server";
import type { Competitor, WatchSnapshot, WatchStub } from "./lib/protocol.ts";

function text(value: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(`Text must contain 1–${max} characters.`);
  return value.trim();
}

export class ExportHandler extends WorkerEntrypoint {
  getExportFormats() {
    return [{ id: "json", label: "JSON", mode: "server" as const, contentType: "application/json", fileExtension: ".json" }];
  }
  async export(gadget: WatchStub, id: string): Promise<ReadableStream<Uint8Array>> {
    if (id !== "json") throw new Error("Unsupported export format.");
    return new Response(JSON.stringify(await gadget.getWatchlist(), null, 2)).body!;
  }
}
function source(value: string): string {
  const url = new URL(text(value, 2000));
  if (url.protocol !== "https:" || url.username || url.password) throw new TypeError("Use an HTTPS URL without credentials.");
  url.hash = "";
  return url.href;
}

export class Gadget extends DurableObject implements WatchStub {
  private mutations = new MutationQueue();

  async getWatchlist(): Promise<WatchSnapshot> {
    return await this.ctx.storage.get<WatchSnapshot>("watch") ?? { revision: 0, competitors: [], findings: [] };
  }
  private async save(state: WatchSnapshot): Promise<void> {
    if (new TextEncoder().encode(JSON.stringify(state)).length > 96 * 1024) throw new Error("Watchlist is full. Remove an old competitor first.");
    await this.ctx.storage.put("watch", { ...state, revision: state.revision + 1 });
  }
  addCompetitor(input: { name: string; url: string; notes?: string }): Promise<Competitor> {
    return this.mutations.run(async () => {
      const state = await this.getWatchlist();
      const url = source(input.url);
      if (state.competitors.some(item => item.url === url)) throw new Error("This source is already watched.");
      if (state.competitors.length >= 30) throw new Error("Limit: 30 competitor sources per watchlist.");
      const competitor = { id: crypto.randomUUID(), name: text(input.name, 160), url,
        notes: input.notes ? text(input.notes, 1000) : "", lastChecked: null };
      await this.save({ ...state, competitors: [...state.competitors, competitor] });
      return competitor;
    });
  }
  removeCompetitor(id: string): Promise<void> {
    return this.mutations.run(async () => {
      const state = await this.getWatchlist();
      await this.save({ ...state, competitors: state.competitors.filter(item => item.id !== id),
        findings: state.findings.filter(item => item.competitorId !== id) });
    });
  }
  recordSnapshot(input: { competitorId: string; sourceUrl: string; content: string; summary: string }): Promise<{ changed: boolean; findingId: string }> {
    return this.mutations.run(async () => {
      const state = await this.getWatchlist();
      const competitor = state.competitors.find(item => item.id === input.competitorId);
      if (!competitor) throw new Error("Competitor not found.");
      const sourceUrl = source(input.sourceUrl);
      if (sourceUrl !== competitor.url) throw new Error("Snapshot must match the watched source URL. Add other pages as separate sources.");
      const content = text(input.content, 4000);
      const summary = text(input.summary, 1000);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content.replace(/\s+/g, " ")));
      const fingerprint = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
      const observedAt = new Date().toISOString();
      const finding = { id: crypto.randomUUID(), competitorId: competitor.id, observedAt, sourceUrl, content, summary, fingerprint };
      const changed = competitor.lastFingerprint !== fingerprint;
      await this.save({ ...state,
        competitors: state.competitors.map(item => item.id === competitor.id ? { ...item, lastChecked: observedAt,
          lastFingerprint: fingerprint, lastFindingId: changed ? finding.id : item.lastFindingId } : item),
        findings: changed ? [...state.findings, finding].slice(-12) : state.findings });
      return { changed, findingId: changed ? finding.id : competitor.lastFindingId! };
    });
  }
}
