// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { ChatChannelsSettings } from "./ChatChannelsSettings";

const context = vi.hoisted(() => ({
  api: {} as Pick<
    AuthenticatedApi,
    "getChatChannelStatus" | "pairChatChannel" | "unlinkChatChannel" | "listGadgets"
  >,
}));
vi.mock("../../AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: context.api }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const status = () => ({
  providers: [
    { provider: "slack" as const, available: true },
    { provider: "teams" as const, available: false },
  ],
  links: [],
  deliveries: [],
});
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn<() => void>(),
  });
  context.api = {
    getChatChannelStatus: vi.fn<AuthenticatedApi["getChatChannelStatus"]>(async () => status()),
    listGadgets: vi.fn<AuthenticatedApi["listGadgets"]>(async () => [
      { id: "workspace", title: "Owned workspace", created: new Date(), lastActive: new Date() },
      {
        id: "shared",
        title: "Someone else’s workspace",
        created: new Date(),
        lastActive: new Date(),
        owner: { type: "user" as const, id: "other", name: "Other" },
      },
    ]),
    pairChatChannel: vi.fn<AuthenticatedApi["pairChatChannel"]>(async () => ({
      command: "link fixture-private-code",
      expiresAt: Date.now() + 600000,
      openUrl: "https://slack.com/oauth/v2/authorize",
    })),
    unlinkChatChannel: vi.fn<AuthenticatedApi["unlinkChatChannel"]>(async () => {}),
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = () =>
  act(async () =>
    root.render(
      <StrictMode>
        <ChatChannelsSettings />
      </StrictMode>,
    ),
  );
const button = (name: string) => {
  const value = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === name,
  );
  if (!value) throw new Error(name);
  return value;
};
const click = (name: string) => act(async () => button(name).click());
async function selectWorkspace() {
  await click("Choose a workspace");
  expect(document.body.textContent).not.toContain("Someone else’s workspace");
  await act(async () => {
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (e) => e.textContent === "Owned workspace",
    )!;
    option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    option.click();
  });
}
it("requires configured providers and an owned workspace, then exposes a private one-time command", async () => {
  await render();
  expect(button("Connect Slack").disabled).toBe(true);
  expect(button("Connect Teams").disabled).toBe(true);
  await selectWorkspace();
  await click("Connect Slack");
  expect(context.api.pairChatChannel).toHaveBeenCalledWith("slack", "workspace");
  expect(container.textContent).toContain("link fixture-private-code");
  expect(container.textContent).toContain("Keep it private");
  expect(container.querySelector("a")?.rel).toBe("noreferrer");
});
it("preserves a pairing failure and supports an explicit retry", async () => {
  vi.mocked(context.api.pairChatChannel).mockRejectedValueOnce(new Error("unavailable"));
  await render();
  await selectWorkspace();
  await click("Connect Slack");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not confirm");
  await click("Connect Slack");
  expect(container.querySelector("code")?.textContent).toContain("link");
});
it("refreshes failed initial loading with both workspace and channel state", async () => {
  vi.mocked(context.api.getChatChannelStatus).mockRejectedValue(new Error("offline"));
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
  vi.mocked(context.api.getChatChannelStatus).mockResolvedValue(status());
  await click("Refresh channels");
  await selectWorkspace();
  expect(button("Connect Slack").disabled).toBe(false);
});
it("revokes links through the signed-in API and reports uncertain deliveries", async () => {
  vi.mocked(context.api.getChatChannelStatus).mockResolvedValue({
    providers: status().providers,
    links: [{ id: "link1", provider: "slack", workspaceId: "workspace", linkedAt: Date.now() }],
    deliveries: [{ id: "event", status: "uncertain", updatedAt: Date.now() }],
  });
  await render();
  expect(container.textContent).toContain("uncertain replies are not sent again");
  await click("Unlink slack");
  expect(context.api.unlinkChatChannel).toHaveBeenCalledWith("link1");
});
it("ignores a completed pairing when the account changes", async () => {
  let finish!: (value: Awaited<ReturnType<AuthenticatedApi["pairChatChannel"]>>) => void;
  vi.mocked(context.api.pairChatChannel).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await selectWorkspace();
  await click("Connect Slack");
  context.api = { ...context.api };
  await render();
  await act(async () =>
    finish({ command: "link old-account-secret", expiresAt: Date.now() + 600000, openUrl: null }),
  );
  expect(container.textContent).not.toContain("old-account-secret");
});
