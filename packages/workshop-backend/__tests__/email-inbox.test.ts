import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatChannels } from "../src/chat-channels/channels";
import type { UserDurableObject } from "../src/user";
import type { OverseerDurableObject } from "../src/overseer";
import type { InboxMessage } from "../src/email-inbox/message";
import { beginNativeRecovery, endNativeRecovery } from "../src/native-recovery";
import { EmailInbox } from "../src/email-inbox/inbox";
import { handleInboxEmail } from "../src/email-inbox/handler";
import {
  emailHtmlText,
  inboxPrompt,
  inboxToken,
  MAX_EMAIL_BYTES,
  parseInboxMessage,
} from "../src/email-inbox/message";

const bindings = env as typeof env & {
  TEST_CHAT_CHANNELS: DurableObjectNamespace<ChatChannels>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
};
afterEach(() => vi.restoreAllMocks());
const input = (id = "<first@example.com>", patch: Partial<InboxMessage> = {}): InboxMessage => ({
  messageId: id,
  references: [],
  sender: "sender@example.com",
  subject: "Project delivery notes",
  text: "Release checklist and updates for our current project.",
  forceNew: false,
  attachments: [],
  notices: [],
  ...patch,
});
function rawEmail(raw: string) {
  const data = new TextEncoder().encode(raw);
  return {
    from: "envelope@example.com",
    rawSize: data.length,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    }),
  };
}
async function fixture() {
  const name = "email-" + crypto.randomUUID();
  const user = bindings.TEST_USER.getByName(name);
  await user.provisionEnterpriseAccount(name, "Fixture", true, 1);
  const workspace = bindings.TEST_OVERSEER.getByName(crypto.randomUUID());
  await runInDurableObject(workspace, async (instance) => {
    const impl = (instance as any).impl;
    impl.ownerId = user.id.toString();
    impl.storage.ownerId.put(user.id.toString());
  });
  const channels = bindings.TEST_CHAT_CHANNELS.getByName(crypto.randomUUID());
  await runInDurableObject(channels, async (_instance, ctx) => {
    const setAlarm = ctx.storage.setAlarm.bind(ctx.storage);
    vi.spyOn(ctx.storage, "setAlarm").mockImplementation(() => setAlarm(Date.now() + 86400000));
  });
  const userId = user.id.toString();
  const configured = await channels.configureEmailInbox(userId, workspace.id.toString(), true);
  const token = inboxToken(configured.configuration!.address, "inbox.example.com")!;
  return { user, userId, workspace, channels, token };
}

describe("native email parsing", () => {
  it("accepts only a private address on the configured domain and treats headers as source data", async () => {
    const token = "a".repeat(48);
    expect(inboxToken(`inbox+${token}@inbox.example.com`, "inbox.example.com")).toBe(token);
    expect(inboxToken(`inbox+${token}@other.example.com`, "inbox.example.com")).toBeNull();
    expect(inboxToken(`inbox+${token}@inbox.example.com`, undefined)).toBeNull();
    const parsed = await parseInboxMessage(
      rawEmail(
        "From: Claimed person <claimed@example.com>\r\nSubject: [new] Project notes\r\nMessage-ID: <one@example.com>\r\nIn-Reply-To: <previous@example.com>\r\nReferences: <root@example.com>\r\nContent-Type: text/plain\r\n\r\nUseful information.",
      ),
    );
    expect(parsed).toMatchObject({
      sender: "claimed@example.com",
      forceNew: true,
      messageId: "<one@example.com>",
      references: ["<root@example.com>", "<previous@example.com>"],
      text: "Useful information.\n",
    });
  });
  it("hashes missing message IDs, ignores executable HTML, and never fetches remote images", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const html = await emailHtmlText(
      '<p>Useful notes</p><script>secretScript()</script><style>bad css</style><img src="https://tracking.example.com/pixel">',
    );
    expect(html).toContain("Useful notes");
    expect(await emailHtmlText("<p>First paragraph</p><p>Second paragraph</p>")).toBe("First paragraph\nSecond paragraph");
    expect(html).not.toContain("secretScript");
    expect(html).not.toContain("bad css");
    expect(fetch).not.toHaveBeenCalled();
    const first = await parseInboxMessage(rawEmail("Subject: Hello\r\n\r\nIdentical email"));
    expect(
      (await parseInboxMessage(rawEmail("Subject: Hello\r\n\r\nIdentical email"))).messageId,
    ).toBe(first.messageId);
    expect(
      (await parseInboxMessage(rawEmail("Subject: Hello\r\n\r\nChanged email"))).messageId,
    ).not.toBe(first.messageId);
  });
  it("bounds the actual stream, refuses automated replies, and reports skipped attachments", async () => {
    const raw = rawEmail("x".repeat(MAX_EMAIL_BYTES + 1));
    await expect(parseInboxMessage({ ...raw, rawSize: 0 })).rejects.toThrow("1 MiB");
    await expect(
      parseInboxMessage(rawEmail("Auto-Submitted: auto-replied\r\n\r\nReply")),
    ).rejects.toThrow("Automated");
    const result = await inboxPrompt(
      input(undefined, {
        attachments: [
          {
            name: "notes.txt",
            type: "text/plain",
            data: new TextEncoder().encode("Attachment notes").toBase64(),
          },
          { name: "run.exe", type: "application/octet-stream", data: "AA==" },
        ],
      }),
    );
    expect(result.prompt).toContain("Attachment notes");
    expect(result.notices).toEqual(["Attachment not read: run.exe (application/octet-stream)."]);
    expect(result.prompt).toContain("untrusted source material");
  });
  it("parses MIME attachments and includes converted documents with visible truncation", async () => {
    const parsed = await parseInboxMessage(
      rawEmail(
        [
          "From: sender@example.com",
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="fixture"',
          "",
          "--fixture",
          "Content-Type: text/plain",
          "",
          "Please review the document.",
          "--fixture",
          "Content-Type: application/pdf",
          'Content-Disposition: attachment; filename="notes.pdf"',
          "Content-Transfer-Encoding: base64",
          "",
          btoa("%PDF-fixture"),
          "--fixture--",
          "",
        ].join("\r\n"),
      ),
    );
    const toMarkdown = vi.fn(async (document: { name: string; blob: Blob }) => {
      expect(document.name).toBe("notes.pdf");
      expect(await document.blob.text()).toBe("%PDF-fixture");
      return {
        name: document.name,
        format: "markdown" as const,
        data: "Document information ".repeat(2000),
        tokens: 1,
      };
    });
    const result = await inboxPrompt(parsed, { toMarkdown } as Ai);
    expect(toMarkdown).toHaveBeenCalledTimes(1);
    expect(result.prompt).toContain("Document information");
    expect(result.notices).toContain("Attachment shortened: notes.pdf.");
  });
  it("rejects an unknown address before reading MIME and does not acknowledge storage failure", async () => {
    const message = {
      ...rawEmail("Subject: hello\r\n\r\nbody"),
      to: `inbox+${"a".repeat(48)}@inbox.example.com`,
      setReject: vi.fn(),
    };
    const receive = vi.fn(async () => {
      throw new Error("storage offline");
    });
    await handleInboxEmail(
      message as ForwardableEmailMessage,
      { EMAIL_INBOX_DOMAIN: "inbox.example.com" },
      { acceptsInboxAddress: async () => false, receiveInboxEmail: receive },
    );
    expect(message.setReject).toHaveBeenCalledWith("This intake address is unavailable.");
    expect(receive).not.toHaveBeenCalled();
    await expect(
      handleInboxEmail(
        message as ForwardableEmailMessage,
        { EMAIL_INBOX_DOMAIN: "inbox.example.com" },
        { acceptsInboxAddress: async () => true, receiveInboxEmail: receive },
      ),
    ).rejects.toThrow("temporarily unavailable");
  });
});

describe("durable email intake", { timeout: 30000 }, () => {
  it("runs real external chat storage, deduplicates active submissions, and appends to a selected conversation", async () => {
    const f = await fixture();
    await f.user.addModel(
      { type: "agent", id: "fixture-model", name: "Fixture" },
      { provider: "openai", model: "gpt-4.1-mini", apiToken: "fixture-token" },
    );
    await runInDurableObject(f.workspace, async (instance) => {
      const impl = (instance as any).impl;
      const starts = vi.spyOn(impl, "startAgent").mockImplementation(() => {});
      const first = await instance.receiveInboxMessage(
        f.userId,
        "thread-one",
        "first",
        "Project notes",
      );
      expect(first.accepted).toBe(true);
      expect(
        await instance.receiveInboxMessage(f.userId, "thread-one", "first", "Duplicate"),
      ).toEqual(first);
      expect(starts).toHaveBeenCalledTimes(1);
      const record = impl.storage.gadgetResponseDeliveries.get("email:first");
      expect(record.channelReplyId).toBe("email:first");
      await expect(
        instance.receiveInboxMessage(f.userId, "thread-one", "second", "More notes"),
      ).rejects.toThrow("busy");
      impl.storage.gadgetResponseDeliveries.put({
        idempotencyKey: record.idempotencyKey,
        chatId: record.chatId,
        promptSequence: record.promptSequence,
        createdAt: record.createdAt,
        status: "delivered",
        deliveredAt: Date.now(),
      });
      impl.storage.chatMeta.put({
        ...impl.storage.chatMeta.get(record.chatId),
        activeAgent: undefined,
      });
      expect(
        await instance.receiveInboxMessage(
          f.userId,
          "new-email-thread",
          "second",
          "Related notes",
          record.chatId,
        ),
      ).toEqual(first);
      expect(starts).toHaveBeenCalledTimes(2);
      expect(impl.storage.externalChats.get("email:new-email-thread").chatId).toBe(record.chatId);
    });
  });

  it("binds addresses to owned workspaces, isolates receipts, deduplicates and revokes old addresses", async () => {
    const f = await fixture();
    try {
      await f.channels.configureEmailInbox("a".repeat(64), f.workspace.id.toString(), true);
      expect.fail("Expected ownership rejection");
    } catch (error) {
      expect(String(error)).toContain("own");
    }
    await Promise.all([
      f.channels.receiveInboxEmail(f.token, JSON.stringify(input())),
      f.channels.receiveInboxEmail(f.token, JSON.stringify(input())),
    ]);
    expect((await f.channels.getEmailInboxStatus(f.userId)).messages).toHaveLength(1);
    expect(await f.channels.getEmailInboxStatus("other")).toMatchObject({
      configuration: null,
      messages: [],
    });
    await f.channels.rotateEmailInboxAddress(f.userId);
    expect(await f.channels.acceptsInboxAddress(f.token)).toBe(false);
    try {
      await f.channels.receiveInboxEmail(f.token, JSON.stringify(input("<other@example.com>")));
      expect.fail("Expected revoked address rejection");
    } catch (error) {
      expect(String(error)).toContain("unavailable");
    }
    expect((await f.channels.getEmailInboxStatus(f.userId)).messages[0].status).toBe("cancelled");
  });
  it("starts a new chat, resumes References, forces [new], and records only trusted completion links", async () => {
    const f = await fixture();
    const calls: { key: string; id: string; related?: number }[] = [];
    vi.spyOn(EmailInbox.prototype as any, "workspace").mockReturnValue({
      isChatChannelOwner: async () => true,
      findRelatedEmailChat: async () => null,
      receiveInboxMessage: async (
        _user: string,
        key: string,
        id: string,
        _prompt: string,
        related?: number,
      ) => {
        calls.push({ key, id, related });
        return { accepted: true, chatPath: `/workspace/${f.workspace.id}?chat=7` };
      },
    });
    await f.channels.receiveInboxEmail(f.token, JSON.stringify(input()));
    await runInDurableObject(f.channels, async (instance) => {
      await instance.alarm();
    });
    let receipt = (await f.channels.getEmailInboxStatus(f.userId)).messages[0];
    expect(receipt).toMatchObject({ status: "processing", routing: "new" });
    try {
      await f.channels.complete(`email:${receipt.id}`, "done", "other", 7);
      expect.fail("Expected workspace rejection");
    } catch (error) {
      expect(String(error)).toContain("Wrong email workspace");
    }
    await f.channels.complete(`email:${receipt.id}`, "done", f.workspace.id.toString(), 7);
    await f.channels.receiveInboxEmail(
      f.token,
      JSON.stringify(input("<reply@example.com>", { references: ["<first@example.com>"] })),
    );
    await runInDurableObject(f.channels, async (instance) => {
      await instance.alarm();
    });
    expect(calls[1].key).toBe(calls[0].key);
    receipt = (await f.channels.getEmailInboxStatus(f.userId)).messages[0];
    expect(receipt.routing).toBe("thread");
    await f.channels.complete(`email:${receipt.id}`, "done", f.workspace.id.toString(), 7);
    await f.channels.receiveInboxEmail(
      f.token,
      JSON.stringify(
        input("<new@example.com>", { forceNew: true, references: ["<first@example.com>"] }),
      ),
    );
    await runInDurableObject(f.channels, async (instance) => {
      await instance.alarm();
    });
    expect(calls[2].key).not.toBe(calls[0].key);
    expect(calls[2].related).toBeUndefined();
  });
  it("recovers a completion after a lost submit acknowledgement and keeps mailbox references isolated", async () => {
    const f = await fixture();
    await f.channels.configureEmailInbox(f.userId, f.workspace.id.toString(), false);
    const submit = vi.fn<(...args: unknown[]) => Promise<{ accepted: true; chatPath: string }>>(
      async () => {
        throw new Error("lost acknowledgement");
      },
    );
    const match = vi.fn(async () => 12);
    vi.spyOn(EmailInbox.prototype as any, "workspace").mockReturnValue({
      isChatChannelOwner: async () => true,
      findRelatedEmailChat: match,
      receiveInboxMessage: submit,
    });
    await f.channels.receiveInboxEmail(f.token, JSON.stringify(input()));
    await runInDurableObject(f.channels, async (instance) => {
      await instance.alarm();
    });
    const receipt = (await f.channels.getEmailInboxStatus(f.userId)).messages[0];
    expect(receipt.status).toBe("queued");
    await f.channels.complete(`email:${receipt.id}`, "done", f.workspace.id.toString(), 7);
    expect((await f.channels.getEmailInboxStatus(f.userId)).messages[0]).toMatchObject({
      status: "complete",
      chatPath: `/workspace/${f.workspace.id}?chat=7`,
    });
    expect(match).not.toHaveBeenCalled();
    await runInDurableObject(f.channels, async (_instance, ctx) => {
      const rows = JSON.stringify(
        ctx.storage.sql
          .exec("SELECT value FROM email_records WHERE key LIKE 'message:%'")
          .toArray(),
      );
      expect(rows).toContain("Release checklist");
      expect(JSON.parse(ctx.storage.sql.exec<{value: string}>("SELECT value FROM email_records WHERE key LIKE 'message:%'").one().value).prompt).toBeUndefined();
    });
    await runInDurableObject(f.channels, async (instance, ctx) => {
      beginNativeRecovery(ctx, "email-inventory", "a".repeat(64));
      expect(instance.getRecoveryWorkspaceIds()).toContain(f.workspace.id.toString());
      endNativeRecovery(ctx, "email-inventory");
    });
    const next = await f.channels.rotateEmailInboxAddress(f.userId);
    const token = inboxToken(next.configuration!.address, "inbox.example.com")!;
    submit.mockImplementation(async () => ({
      accepted: true,
      chatPath: `/workspace/${f.workspace.id}?chat=8`,
    }));
    await f.channels.receiveInboxEmail(
      token,
      JSON.stringify(input("<fresh@example.com>", { references: ["<first@example.com>"] })),
    );
    await runInDurableObject(f.channels, async (instance) => {
      await instance.alarm();
    });
    expect((await f.channels.getEmailInboxStatus(f.userId)).messages[0].routing).toBe("new");
  });
  it("does not dispatch when the address is revoked during relevance matching", async () => {
    const f = await fixture();
    const submit = vi.fn();
    await f.channels.receiveInboxEmail(f.token, JSON.stringify(input()));
    await runInDurableObject(f.channels, async (instance) => {
      vi.spyOn(EmailInbox.prototype as any, "workspace").mockReturnValue({
        isChatChannelOwner: async () => true,
        findRelatedEmailChat: async () => {
          await instance.disableEmailInbox(f.userId);
          return 12;
        },
        receiveInboxMessage: submit,
      });
      await instance.alarm();
    });
    expect(submit).not.toHaveBeenCalled();
    expect((await f.channels.getEmailInboxStatus(f.userId)).messages[0].status).toBe("cancelled");
    expect(JSON.parse(await f.channels.getRecoverySnapshot()).storage).toBeDefined();
  });
  it("records opted-in relevance and prevents dispatch after account deactivation or recovery staging", async () => {
    const f = await fixture();
    vi.spyOn(EmailInbox.prototype as any, "workspace").mockReturnValue({
      isChatChannelOwner: async () => true,
      findRelatedEmailChat: async () => 12,
      receiveInboxMessage: async () => ({
        accepted: true,
        chatPath: `/workspace/${f.workspace.id}?chat=12`,
      }),
    });
    await f.channels.receiveInboxEmail(f.token, JSON.stringify(input()));
    await runInDurableObject(f.channels, async (instance) => {
      await instance.alarm();
    });
    expect((await f.channels.getEmailInboxStatus(f.userId)).messages[0]).toMatchObject({
      routing: "related",
      chatPath: `/workspace/${f.workspace.id}?chat=12`,
    });
    vi.restoreAllMocks();
    await f.user.provisionEnterpriseAccount("email-owner", "Fixture", false, 2);
    expect(await f.channels.acceptsInboxAddress(f.token)).toBe(false);
    await runInDurableObject(f.channels, async (instance, ctx) => {
      ctx.storage.kv.put(".nativeRecoveryRuntime", {
        sourceId: "root-channels",
        kind: "channels",
        originalId: ctx.id.toString(),
        scope: "recovery-fixture",
        namedIds: {},
      });
      expect(() => instance.configureEmailInbox(f.userId, f.workspace.id.toString(), true)).toThrow(
        "paused",
      );
      await instance.alarm();
    });
  });
});

it("pages owned receipts and retains safe text after completion while discarding attachment bytes", async () => {
  const f = await fixture();
  for (let i = 0; i < 32; i++) {
    await f.channels.receiveInboxEmail(f.token, JSON.stringify(input(`<page-${i}@example.com>`, {
      subject: `Email ${i}`, attachments: [{name:"notes.txt",type:"text/plain",data:btoa("private-binary")}],
    })));
  }
  const first = await f.channels.listInboxMessages(f.userId);
  expect(first.messages).toHaveLength(30);
  expect(first.messages[0].subject).toBe("Email 31");
  const next = await f.channels.listInboxMessages(f.userId, first.nextBefore!);
  expect(next.messages.map((message) => message.subject)).toEqual(["Email 1", "Email 0"]);
  expect(next.nextBefore).toBeNull();
  expect((await f.channels.listInboxMessages("other")).messages).toEqual([]);
  const id = first.messages[0].id;
  expect(await f.channels.getInboxMessage("other", id)).toBeNull();
  await f.channels.complete(`email:${id}`, "done", f.workspace.id.toString(), 7);
  expect(await f.channels.getInboxMessage(f.userId, id)).toMatchObject({
    body: input().text, status: "complete", attachments: [{name:"notes.txt",type:"text/plain"}],
  });
  expect(JSON.stringify(await f.channels.getInboxMessage(f.userId, id))).not.toContain(btoa("private-binary"));
  expect(JSON.stringify(first)).not.toContain(input().text);
  await runInDurableObject(f.channels, (instance) => { expect(() => instance.listInboxMessages(f.userId, -1)).toThrow("Invalid inbox cursor"); });
  await runInDurableObject(f.channels, async (_instance, ctx) => {
    const row = JSON.parse(ctx.storage.sql.exec<{value:string}>("SELECT value FROM email_records WHERE key=?", `message:${id}`).one().value);
    expect(row.input.attachments).toEqual([]);
    delete row.contentRetained;
    row.input.text = "";
    ctx.storage.sql.exec("UPDATE email_records SET value=? WHERE key=?", JSON.stringify(row), `message:${id}`);
  });
  expect((await f.channels.getInboxMessage(f.userId, id))?.body).toBeNull();
  await runInDurableObject(f.channels, async (_instance, ctx) => {
    ctx.storage.sql.exec("UPDATE email_records SET value=json_set(value, '$.receivedAt', ?) WHERE key LIKE 'message:%'", Date.now()-31*86400000);
  });
  expect(await f.channels.getInboxMessage(f.userId, id)).toBeNull();
  expect((await f.channels.listInboxMessages(f.userId)).messages).toEqual([]);
});
