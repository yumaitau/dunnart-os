// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Gadget } from "../files/server.ts";
import type { CampaignInput } from "../files/lib/protocol.ts";

function setup() {
  const values = new Map();
  return new Gadget({ storage: { get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); } } } as unknown as DurableObjectState, {});
}
const draft: CampaignInput = { title: "Launch", channel: "email", audience: "Opt-in product updates",
  content: "New release is available.", plannedAt: "2026-10-01T09:00:00Z" };

describe("campaign drafts", () => {
  it("clears review after any change and rejects a stale editor", async () => {
    const gadget = setup(); const first = await gadget.saveCampaign(draft);
    expect((await gadget.markReviewed(first.id, first.revision)).reviewedRevision).toBe(1);
    const next = await gadget.saveCampaign({ ...draft, audience: "Different list" }, first.id, 1);
    expect(next.reviewedRevision).toBeNull(); expect(next.revision).toBe(2);
    await expect(gadget.markReviewed(first.id, 1)).rejects.toThrow("changed");
    await expect(gadget.saveCampaign(draft, first.id, 1)).rejects.toThrow("changed");
    await expect(gadget.deleteCampaign(first.id, 1)).rejects.toThrow("changed");
    expect((await gadget.listCampaigns())[0].audience).toBe("Different list");
  });
  it("serializes concurrent creates and stores a plan without claiming a send", async () => {
    const gadget = setup(); await Promise.all([gadget.saveCampaign(draft), gadget.saveCampaign({ ...draft, channel: "sms" })]);
    const campaigns = await gadget.listCampaigns(); expect(campaigns).toHaveLength(2);
    expect(campaigns[0].plannedAt).toBe("2026-10-01T09:00:00.000Z");
    expect(campaigns[0]).not.toHaveProperty("sentAt");
    await gadget.deleteCampaign(campaigns[0].id, 1); expect(await gadget.listCampaigns()).toHaveLength(1);
  });
  it("rejects bad content, channel and dates without storing a broken draft", async () => {
    const gadget = setup();
    await expect(gadget.saveCampaign({ ...draft, content: "" })).rejects.toThrow();
    await expect(gadget.saveCampaign({ ...draft, plannedAt: "invalid" })).rejects.toThrow();
    await expect(gadget.saveCampaign({ ...draft, channel: "other" as "sms" })).rejects.toThrow();
    expect(await gadget.listCampaigns()).toEqual([]);
  });
});
