// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RpcStub, RpcTarget } from "capnweb";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import type { EmailInboxMessage, EmailInboxPage } from "@gadgets/workshop-shared/email-inbox";
import { InboxPage } from "./InboxPage";
const context = vi.hoisted(() => ({ api: null as RpcStub<Api> | null }));
vi.mock("../../AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: context.api }),
  useTimeZone: () => "Australia/Sydney",
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const message: EmailInboxMessage = {
  id: "one",
  sender: "source@example.com",
  subject: "Project notes",
  receivedAt: Date.UTC(2026, 8, 27, 23),
  status: "failed",
  chatPath: "/workspace/workspace?chat=7",
  routing: "thread",
  notices: ["Attachment not read: archive.zip."],
  body: "<script>no execution</script>\nThe received information.",
  attachments: [{ name: "archive.zip", type: "application/zip" }],
};
let page: EmailInboxPage, fail: boolean, detail: (id: string) => Promise<EmailInboxMessage | null>;
const calls: (number | undefined)[] = [];
class Api extends RpcTarget {
  async getEmailInboxStatus() {
    return { available: true, configuration: null, messages: [] };
  }
  async listInboxMessages(before?: number) {
    if (fail) throw new Error("offline");
    calls.push(before);
    return before
      ? { messages: [{ ...message, id: "older", subject: "Older notes" }], nextBefore: null }
      : page;
  }
  getInboxMessage(id: string) {
    return detail(id);
  }
  async retryInboxMessage() {
    if (fail) throw new Error("offline");
    return this.getEmailInboxStatus();
  }
}
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  fail = false;
  calls.length = 0;
  page = { messages: [message], nextBefore: 1 };
  detail = async (id) => ({ ...message, id });
  context.api = new RpcStub(new Api());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  context.api?.[Symbol.dispose]();
  vi.restoreAllMocks();
});
const render = () =>
  act(async () =>
    root.render(
      <StrictMode>
        <InboxPage />
      </StrictMode>,
    ),
  );
const click = (text: string) =>
  act(async () => {
    const button = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes(text),
    );
    if (!button) throw new Error(text);
    button.click();
  });
it("loads through real callable stubs, pages receipts and opens a safe readable preview", async () => {
  await render();
  expect(container.textContent).not.toContain("Loading inbox");
  expect(container.textContent).toContain("Project notes");
  await click("Load older emails");
  expect(calls).toContain(1);
  expect(container.textContent).toContain("Older notes");
  await click("Project notes");
  expect(container.textContent).toContain("The received information");
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).toContain("Attachments (1)");
  expect(container.textContent).toContain("Continued email thread");
  expect(container.querySelector('a[href^="/workspace/"]')?.getAttribute("href")).toBe(
    message.chatPath,
  );
  expect(container.textContent).toContain("9/28/26, 9:00 AM");
  await click("Back to emails");
  expect(container.querySelector('[aria-label="Email preview"]')).toBeNull();
});
it("recovers a failed load, distinguishes empty inboxes and expired emails", async () => {
  fail = true;
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
  fail = false;
  page = { messages: [], nextBefore: null };
  await click("Refresh inbox");
  expect(container.textContent).toContain("No emails received yet");
  page = { messages: [message], nextBefore: null };
  await click("Refresh inbox");
  detail = async () => null;
  await click("Project notes");
  expect(container.textContent).toContain("no longer available");
});
it("hides private content immediately on account change and ignores late detail responses", async () => {
  let finish!: (value: EmailInboxMessage) => void;
  detail = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  await render();
  await click("Project notes");
  const previous = context.api;
  page = { messages: [], nextBefore: null };
  context.api = new RpcStub(new Api());
  await render();
  await act(async () => finish(message));
  expect(container.textContent).not.toContain("The received information");
  expect(container.textContent).not.toContain("Project notes");
  previous?.[Symbol.dispose]();
});
it("keeps message bodies unavailable when historic payloads were already discarded", async () => {
  detail = async () => ({ ...message, body: null });
  await render();
  await click("Project notes");
  expect(container.textContent).toContain("older email no longer retains its body");
});
