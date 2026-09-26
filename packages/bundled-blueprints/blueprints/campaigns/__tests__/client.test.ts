import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); document.head.replaceChildren(); vi.resetModules(); });
it("preserves a rejected draft and displays untrusted content as text", async () => {
  const saveCampaign = vi.fn().mockRejectedValue(new Error("Draft changed. Refresh before saving."));
  vi.stubGlobal("gadget", { saveCampaign, listCampaigns: vi.fn().mockResolvedValue([{ id: "1", title: "<img src=x onerror=alert(1)>", channel: "email", audience: "Opt-in list", content: "Hello", plannedAt: null, revision: 1, reviewedRevision: null, updatedAt: new Date().toISOString() }]) });
  await import("../files/client.ts");
  await vi.waitFor(() => expect(document.querySelector("article")).not.toBeNull());
  expect(document.querySelector("img")).toBeNull();
  (Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Edit")!).click();
  const content = document.querySelector("textarea")!; content.value = "Updated draft";
  document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector('[role="status"]')?.textContent).toContain("Draft changed"));
  expect(content.value).toBe("Updated draft");
  expect(saveCampaign).toHaveBeenCalledWith(expect.objectContaining({ content: "Updated draft" }), "1", 1);
});
