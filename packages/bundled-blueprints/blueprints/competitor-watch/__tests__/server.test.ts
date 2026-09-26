// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Gadget } from "../files/server.ts";
function setup() {
  const values = new Map();
  return new Gadget({ storage: { get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); } } } as unknown as DurableObjectState, {});
}
describe("competitor snapshots", () => {
  it("reuses an unchanged baseline and records a changed price with its source", async () => {
    const gadget = setup(); const competitor = await gadget.addCompetitor({ name: "Example", url: "https://example.com/pricing" });
    const snapshot = { competitorId: competitor.id, sourceUrl: competitor.url, content: "Plan costs 10", summary: "Baseline" };
    expect((await gadget.recordSnapshot(snapshot)).changed).toBe(true);
    expect((await gadget.recordSnapshot({ ...snapshot, content: "Plan  costs 10", summary: "Different summary" })).changed).toBe(false);
    expect((await gadget.recordSnapshot({ ...snapshot, content: "Plan costs 12", summary: "Price increased" })).changed).toBe(true);
    const state = await gadget.getWatchlist(); expect(state.findings).toHaveLength(2);
    expect(state.findings[1]).toMatchObject({ summary: "Price increased", sourceUrl: competitor.url });
    expect(state.competitors[0].lastChecked).not.toBeNull();
    await gadget.removeCompetitor(competitor.id); expect((await gadget.getWatchlist()).findings).toEqual([]);
  });
  it("rejects credential URLs and repeated sources; keeps concurrent changes", async () => {
    const gadget = setup();
    await expect(gadget.addCompetitor({ name: "Invalid", url: "https://user:password@example.com" })).rejects.toThrow();
    await expect(gadget.addCompetitor({ name: "Invalid", url: "javascript:alert(1)" })).rejects.toThrow();
    await Promise.all([gadget.addCompetitor({ name: "One", url: "https://one.example" }), gadget.addCompetitor({ name: "Two", url: "https://two.example" })]);
    await expect(gadget.addCompetitor({ name: "Again", url: "https://one.example/#fragment" })).rejects.toThrow("already");
    expect((await gadget.getWatchlist()).competitors).toHaveLength(2);
  });
  it("retains deduplication after old findings leave the bounded history", async () => {
    const gadget = setup();
    const first = await gadget.addCompetitor({ name: "First", url: "https://first.example" });
    const second = await gadget.addCompetitor({ name: "Second", url: "https://second.example" });
    const baseline = { competitorId: first.id, sourceUrl: first.url, content: "Baseline", summary: "Initial" };
    await gadget.recordSnapshot(baseline);
    for (let i = 0; i < 13; i++) await gadget.recordSnapshot({ competitorId: second.id, sourceUrl: second.url, content: `Price ${i}`, summary: "Changed" });
    expect((await gadget.getWatchlist()).findings).toHaveLength(12);
    expect((await gadget.recordSnapshot(baseline)).changed).toBe(false);
  });
});
