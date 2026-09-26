import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  document.body.replaceChildren();
});

it("opens the embedding Workshop's trusted admin page without a privileged capability", async () => {
  vi.spyOn(document, "referrer", "get").mockReturnValue("https://workshop.example/workspaces/123");
  await import("../files/client.ts");
  const link = document.querySelector("a")!;
  expect(link.href).toBe("https://workshop.example/admin#backups");
  expect(link.target).toBe("_blank");
  expect(link.rel).toContain("noopener");
  expect(document.querySelector("input")).toBeNull();
  expect(document.body.textContent).toContain("Deployment administrator access is required.");
});

it("gives navigation instructions if the embedding origin is unavailable", async () => {
  vi.spyOn(document, "referrer", "get").mockReturnValue("");
  vi.spyOn(document, "baseURI", "get").mockReturnValue("about:srcdoc");
  await import("../files/client.ts");
  expect(document.querySelector("a")).toBeNull();
  expect(document.body.textContent).toContain("Open Admin in your Workshop, then choose Backups.");
});
