// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import type { EmailInboxStatus } from "@gadgets/workshop-shared/email-inbox";
import { EmailInboxSettings } from "./EmailInboxSettings";
const context = vi.hoisted(() => ({
  api: {} as Pick<
    AuthenticatedApi,
    | "getEmailInboxStatus"
    | "configureEmailInbox"
    | "rotateEmailInboxAddress"
    | "disableEmailInbox"
    | "retryInboxMessage"
    | "listGadgets"
  >,
}));
vi.mock("../../AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: context.api }),
  useTimeZone: () => "Australia/Sydney",
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const configuration = {
  address: "inbox+private-fixture@inbox.example.com",
  workspaceId: "workspace",
  continueRelated: true,
};
const status = (configured = false): EmailInboxStatus => ({
  available: true,
  configuration: configured ? configuration : null,
  messages: [],
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
    getEmailInboxStatus: vi.fn<AuthenticatedApi["getEmailInboxStatus"]>(async () => status()),
    listGadgets: vi.fn<AuthenticatedApi["listGadgets"]>(async () => [
      { id: "workspace", title: "Owned workspace", created: new Date(), lastActive: new Date() },
      {
        id: "shared",
        title: "Other workspace",
        created: new Date(),
        lastActive: new Date(),
        owner: { type: "user" as const, id: "other", name: "Other" },
      },
    ]),
    configureEmailInbox: vi.fn<AuthenticatedApi["configureEmailInbox"]>(async () => status(true)),
    rotateEmailInboxAddress: vi.fn<AuthenticatedApi["rotateEmailInboxAddress"]>(async () =>
      status(true),
    ),
    disableEmailInbox: vi.fn<AuthenticatedApi["disableEmailInbox"]>(async () => {}),
    retryInboxMessage: vi.fn<AuthenticatedApi["retryInboxMessage"]>(async () => status(true)),
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
        <EmailInboxSettings />
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
  expect(document.body.textContent).not.toContain("Other workspace");
  await act(async () => {
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (e) => e.textContent === "Owned workspace",
    )!;
    option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    option.click();
  });
}
it("requires an owned workspace and explains the private address authority", async () => {
  await render();
  expect(button("Enable email intake").disabled).toBe(true);
  await selectWorkspace();
  await click("Enable email intake");
  expect(context.api.configureEmailInbox).toHaveBeenCalledWith("workspace", true);
  expect(container.querySelector("code")?.textContent).toBe(configuration.address);
  expect(container.textContent).toContain("Anyone with this address");
  expect(container.textContent).toContain("no automatic email replies");
  await click("Replace address");
  expect(context.api.rotateEmailInboxAddress).toHaveBeenCalledTimes(1);
  await click("Disable intake");
  expect(context.api.disableEmailInbox).toHaveBeenCalledTimes(1);
});
it("retries failed initial load and restores the saved workspace and matching setting", async () => {
  vi.mocked(context.api.getEmailInboxStatus).mockRejectedValue(new Error("offline"));
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
  vi.mocked(context.api.getEmailInboxStatus).mockResolvedValue({
    ...status(true),
    configuration: { ...configuration, continueRelated: false },
  });
  await click("Refresh inbox");
  await click("Save intake settings");
  expect(context.api.configureEmailInbox).toHaveBeenCalledWith("workspace", false);
});
it("shows receipts, extraction notices, safe chat links and retry failures", async () => {
  vi.mocked(context.api.getEmailInboxStatus).mockResolvedValue({
    ...status(true),
    messages: [
      {
        id: "mail",
        sender: "sender@example.com",
        subject: "<script>not markup</script>",
        receivedAt: Date.now(),
        status: "failed",
        routing: "thread",
        chatPath: "/workspace/workspace?chat=7",
        notices: ["Attachment not read: archive.zip."],
      },
    ],
  });
  vi.mocked(context.api.retryInboxMessage).mockRejectedValue(new Error("offline"));
  await render();
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).toContain("Attachment not read");
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/workspace/workspace?chat=7");
  await click("Retry email");
  expect(context.api.retryInboxMessage).toHaveBeenCalledWith("mail");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not confirm");
});
it("shows deployment setup blockers without offering an unusable address", async () => {
  vi.mocked(context.api.getEmailInboxStatus).mockResolvedValue({ ...status(), available: false });
  await render();
  expect(container.textContent).toContain("configure an Email Routing domain");
  expect(container.querySelector("code")).toBeNull();
  expect(container.textContent).not.toContain("Enable email intake");
});
it("discards private addresses returned after the signed-in account changes", async () => {
  let finish!: (value: EmailInboxStatus) => void;
  vi.mocked(context.api.configureEmailInbox).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await selectWorkspace();
  await click("Enable email intake");
  context.api = { ...context.api };
  await render();
  await act(async () => finish(status(true)));
  expect(container.textContent).not.toContain(configuration.address);
});
