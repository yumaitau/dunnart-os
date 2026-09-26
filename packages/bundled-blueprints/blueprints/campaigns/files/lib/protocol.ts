export type Channel = "social" | "email" | "sms";
export type Campaign = { id: string; title: string; channel: Channel; audience: string; content: string;
  plannedAt: string | null; revision: number; reviewedRevision: number | null; updatedAt: string };
export type CampaignInput = Pick<Campaign, "title" | "channel" | "audience" | "content" | "plannedAt">;
export interface CampaignStub {
  listCampaigns(): Promise<Campaign[]>;
  saveCampaign(input: CampaignInput, id?: string, expectedRevision?: number): Promise<Campaign>;
  markReviewed(id: string, expectedRevision: number): Promise<Campaign>;
  deleteCampaign(id: string, expectedRevision: number): Promise<void>;
}
