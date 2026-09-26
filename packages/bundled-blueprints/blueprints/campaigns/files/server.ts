import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { MutationQueue } from "@gadgets/bundled-blueprints/libraries/sync/server";
import type { Campaign, CampaignInput, CampaignStub } from "./lib/protocol.ts";

function text(value: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(`Text must contain 1–${max} characters.`);
  return value.trim();
}

export class ExportHandler extends WorkerEntrypoint {
  getExportFormats() {
    return [{ id: "json", label: "JSON", mode: "server" as const, contentType: "application/json", fileExtension: ".json" }];
  }
  async export(gadget: CampaignStub, id: string): Promise<ReadableStream<Uint8Array>> {
    if (id !== "json") throw new Error("Unsupported export format.");
    return new Response(JSON.stringify(await gadget.listCampaigns(), null, 2)).body!;
  }
}
export class Gadget extends DurableObject implements CampaignStub {
  private mutations = new MutationQueue();
  async listCampaigns(): Promise<Campaign[]> { return await this.ctx.storage.get<Campaign[]>("campaigns") ?? []; }
  private async save(campaigns: Campaign[]): Promise<void> {
    if (new TextEncoder().encode(JSON.stringify(campaigns)).length > 96 * 1024) throw new Error("Campaign board is full. Delete old drafts first.");
    await this.ctx.storage.put("campaigns", campaigns);
  }
  saveCampaign(input: CampaignInput, id?: string, expectedRevision?: number): Promise<Campaign> {
    return this.mutations.run(async () => {
      const campaigns = await this.listCampaigns();
      const previous = id ? campaigns.find(item => item.id === id) : undefined;
      if (id && (!previous || previous.revision !== expectedRevision)) throw new Error("Draft changed. Refresh before saving.");
      if (!["social", "email", "sms"].includes(input.channel)) throw new TypeError("Invalid campaign channel.");
      if (input.plannedAt !== null && (typeof input.plannedAt !== "string" || !Number.isFinite(Date.parse(input.plannedAt)))) throw new TypeError("Invalid planned date.");
      const campaign: Campaign = { id: previous?.id ?? crypto.randomUUID(), title: text(input.title, 160),
        channel: input.channel, audience: text(input.audience, 1000), content: text(input.content, 6000),
        plannedAt: input.plannedAt === null ? null : new Date(input.plannedAt).toISOString(),
        revision: (previous?.revision ?? 0) + 1, reviewedRevision: null, updatedAt: new Date().toISOString() };
      await this.save([...campaigns.filter(item => item.id !== campaign.id), campaign]);
      return campaign;
    });
  }
  markReviewed(id: string, expectedRevision: number): Promise<Campaign> {
    return this.mutations.run(async () => {
      const campaigns = await this.listCampaigns();
      const previous = campaigns.find(item => item.id === id);
      if (!previous || previous.revision !== expectedRevision) throw new Error("Draft changed. Review the current revision.");
      const campaign = { ...previous, reviewedRevision: previous.revision };
      await this.save(campaigns.map(item => item.id === id ? campaign : item));
      return campaign;
    });
  }
  deleteCampaign(id: string, expectedRevision: number): Promise<void> {
    return this.mutations.run(async () => {
      const campaigns = await this.listCampaigns();
      const previous = campaigns.find(item => item.id === id);
      if (!previous || previous.revision !== expectedRevision) throw new Error("Draft changed. Refresh before deleting.");
      await this.save(campaigns.filter(item => item.id !== id));
    });
  }
}
