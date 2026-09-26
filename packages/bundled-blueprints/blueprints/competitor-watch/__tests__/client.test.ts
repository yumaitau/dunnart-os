import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); document.head.replaceChildren(); vi.resetModules(); });
it("adds a watch source and renders fetched snippets without interpreting HTML", async () => {
  const addCompetitor = vi.fn().mockResolvedValue({});
  const getWatchlist = vi.fn().mockResolvedValue({ revision: 1, competitors: [{ id: "1", name: "Example", url: "https://example.com", notes: "", lastChecked: null }], findings: [{ id: "2", competitorId: "1", sourceUrl: "https://example.com", observedAt: new Date().toISOString(), summary: "<script>alert(1)</script>", content: "<img src=x onerror=alert(1)>" }] });
  vi.stubGlobal("gadget", { addCompetitor, getWatchlist });
  await import("../files/client.ts");
  await vi.waitFor(() => expect(document.querySelectorAll("article")).toHaveLength(2));
  expect(document.querySelector("script, img")).toBeNull();
  const inputs = document.querySelectorAll("input"); inputs[0].value = "Other"; inputs[1].value = "https://other.example";
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(addCompetitor).toHaveBeenCalledWith({ name: "Other", url: "https://other.example", notes: "" }));
});
