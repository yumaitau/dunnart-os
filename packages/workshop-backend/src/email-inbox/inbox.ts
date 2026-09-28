import type {
  EmailInboxReceipt,
  EmailInboxStatus,
  EmailRoutingReason,
} from "@gadgets/workshop-shared/email-inbox";
import { channelHash } from "../chat-channels/providers";
import { EmailInputError, inboxDomain, inboxPrompt, type InboxMessage } from "./message";

interface Mailbox {
  userId: string;
  workspaceId: string;
  token: string;
  continueRelated: boolean;
}
interface Receipt extends EmailInboxReceipt {
  userId: string;
  workspaceId: string;
  token: string;
  input: InboxMessage;
  order: number;
  attempts: number;
  nextAttempt: number;
  threadKey?: string;
  relatedChatId?: number;
  prompt?: string;
}
interface Thread {
  key: string;
  chatId?: number;
  receivedAt: number;
}
const FINISHED = new Set(["complete", "failed", "cancelled"]);
const RETENTION = 30 * 86400000;

/** Email intake shares the channel DO's capture, mutation fence and alarm lifecycle. */
export class EmailInbox {
  constructor(
    private ctx: DurableObjectState,
    private env: Cloudflare.Env,
  ) {
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS email_records (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  private get<T>(key: string): T | undefined {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM email_records WHERE key=?", key)
      .toArray()[0];
    return row ? JSON.parse(row.value) : undefined;
  }
  private put(key: string, value: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO email_records VALUES (?,?)",
      key,
      JSON.stringify(value),
    );
  }
  private remove(key: string): void {
    this.ctx.storage.sql.exec("DELETE FROM email_records WHERE key=?", key);
  }
  private all<T>(prefix: string): T[] {
    return this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM email_records WHERE substr(key,1,?)=?",
        prefix.length,
        prefix,
      )
      .toArray()
      .map((row) => JSON.parse(row.value));
  }
  private workspace(id: string) {
    return this.ctx.exports.OverseerDurableObject.get(
      this.ctx.exports.OverseerDurableObject.idFromString(id),
    );
  }
  private valid(receipt: Receipt): boolean {
    const box = this.get<Mailbox>(`mailbox:${receipt.userId}`);
    return (
      !!box &&
      box.token === receipt.token &&
      box.workspaceId === receipt.workspaceId &&
      !!inboxDomain(this.env.EMAIL_INBOX_DOMAIN)
    );
  }
  private save(receipt: Receipt): void {
    if (receipt.status === "complete" || receipt.status === "cancelled")
      receipt = {
        ...receipt,
        prompt: undefined,
        input: { ...receipt.input, text: "", attachments: [] },
      };
    this.put(`message:${receipt.id}`, receipt);
  }

  /** Return only the requesting account's address and receipt metadata, never message bodies. */
  status(userId: string): EmailInboxStatus {
    const domain = inboxDomain(this.env.EMAIL_INBOX_DOMAIN);
    const box = this.get<Mailbox>(`mailbox:${userId}`);
    return {
      available: !!domain,
      configuration:
        box && domain
          ? {
              address: `inbox+${box.token}@${domain}`,
              workspaceId: box.workspaceId,
              continueRelated: box.continueRelated,
            }
          : null,
      messages: this.all<Receipt>("message:")
        .filter((item) => item.userId === userId)
        .toSorted((a, b) => b.order - a.order)
        .slice(0, 30)
        .map(({ id, sender, subject, receivedAt, status, chatPath, routing, notices }) => ({
          id,
          sender,
          subject,
          receivedAt,
          status,
          chatPath,
          routing,
          notices,
        })),
    };
  }
  /** Mint an intake address only after checking current ownership of the selected workspace. */
  async configure(
    userId: string,
    workspaceId: string,
    continueRelated: boolean,
    rotate = false,
  ): Promise<EmailInboxStatus> {
    if (!inboxDomain(this.env.EMAIL_INBOX_DOMAIN))
      throw new Error("Email intake is not configured.");
    if (!(await this.workspace(workspaceId).isChatChannelOwner(userId)))
      throw new Error("Choose a workspace you own.");
    const prior = this.get<Mailbox>(`mailbox:${userId}`);
    const token =
      !rotate && prior?.workspaceId === workspaceId
        ? prior.token
        : crypto.getRandomValues(new Uint8Array(24)).toHex();
    this.put(`mailbox:${userId}`, {
      userId,
      workspaceId,
      continueRelated,
      token,
    } satisfies Mailbox);
    for (const receipt of this.all<Receipt>("message:")) {
      if (receipt.userId === userId && receipt.token !== token && !FINISHED.has(receipt.status))
        this.save({ ...receipt, status: "cancelled", prompt: undefined });
    }
    return this.status(userId);
  }
  /** Rotate the address without widening the account's configured workspace. */
  async rotate(userId: string): Promise<EmailInboxStatus> {
    const box = this.get<Mailbox>(`mailbox:${userId}`);
    if (!box) throw new Error("Enable email intake first.");
    return this.configure(userId, box.workspaceId, box.continueRelated, true);
  }
  /** Revoke the address and stop messages that have not yet been submitted. */
  disable(userId: string): void {
    this.remove(`mailbox:${userId}`);
    for (const receipt of this.all<Receipt>("message:")) {
      if (receipt.userId === userId && !FINISHED.has(receipt.status))
        this.save({ ...receipt, status: "cancelled", prompt: undefined });
    }
  }
  /** Check the opaque recipient capability before reading or converting MIME content. */
  async accepts(token: string): Promise<boolean> {
    const box = this.all<Mailbox>("mailbox:").find((item) => item.token === token);
    return (
      !!box &&
      !!inboxDomain(this.env.EMAIL_INBOX_DOMAIN) &&
      (await this.workspace(box.workspaceId).isChatChannelOwner(box.userId))
    );
  }
  /** Persist and deduplicate before the SMTP event is acknowledged. */
  async receive(token: string, input: InboxMessage): Promise<void> {
    const id = await channelHash(JSON.stringify([token, input.messageId]));
    const box = this.all<Mailbox>("mailbox:").find((item) => item.token === token);
    if (!box || !inboxDomain(this.env.EMAIL_INBOX_DOMAIN))
      throw new EmailInputError("This intake address is unavailable.");
    if (!(await this.workspace(box.workspaceId).isChatChannelOwner(box.userId)))
      throw new EmailInputError("This intake address is unavailable.");
    await this.ctx.storage.transaction(async () => {
      if (this.get(`message:${id}`)) return;
      if (this.get<Mailbox>(`mailbox:${box.userId}`)?.token !== token)
        throw new EmailInputError("This intake address is unavailable.");
      const receipts = this.all<Receipt>("message:");
      const now = Date.now();
      const storedBytes = this.ctx.storage.sql
        .exec<{ bytes: number }>(
          "SELECT coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes FROM email_records",
        )
        .one().bytes;
      if (
        storedBytes + new TextEncoder().encode(JSON.stringify(input)).byteLength >
          8 * 1024 * 1024 ||
        receipts.filter((item) => !FINISHED.has(item.status)).length >= 200 ||
        receipts.filter((item) => item.userId === box.userId && item.receivedAt > now - 86400000)
          .length >= 100
      ) {
        throw new Error("Email intake is temporarily busy.");
      }
      const order = this.get<number>("next-order") ?? 1;
      this.put("next-order", order + 1);
      this.save({
        id,
        userId: box.userId,
        workspaceId: box.workspaceId,
        token,
        input,
        sender: input.sender,
        subject: input.subject,
        receivedAt: now,
        order,
        attempts: 0,
        nextAttempt: now,
        status: "queued",
        chatPath: null,
        routing: null,
        notices: input.notices,
      });
      await this.ctx.storage.setAlarm(now + 1000);
    });
  }
  /** Retry a failed receipt without changing its original idempotency key or account scope. */
  async retry(userId: string, id: string): Promise<EmailInboxStatus> {
    const receipt = this.get<Receipt>(`message:${id}`);
    if (
      !receipt ||
      receipt.userId !== userId ||
      receipt.status !== "failed" ||
      !this.valid(receipt)
    )
      throw new Error("This email cannot be retried.");
    this.save({ ...receipt, status: "queued", attempts: 0, nextAttempt: Date.now() });
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return this.status(userId);
  }
  /** Complete only the receipt submitted to the replying workspace; no email is sent back. */
  async complete(id: string, workspaceId: string, chatId?: number): Promise<void> {
    const receipt = this.get<Receipt>(`message:${id}`);
    if (!receipt || receipt.status === "complete" || receipt.status === "cancelled") return;
    if (receipt.workspaceId !== workspaceId) throw new Error("Wrong email workspace.");
    const hash = await channelHash(receipt.input.messageId);
    const current = this.get<Receipt>(`message:${id}`)!;
    if (current.status === "cancelled") return;
    if (chatId !== undefined && Number.isSafeInteger(chatId) && chatId >= 0) {
      current.chatPath = `/workspace/${workspaceId}?chat=${chatId}`;
      if (current.threadKey)
        this.put(`thread:${current.token}:${hash}`, {
          key: current.threadKey,
          chatId,
          receivedAt: current.receivedAt,
        } satisfies Thread);
    }
    this.save({
      ...current,
      status: this.valid(current) ? "complete" : "cancelled",
      prompt: undefined,
    });
  }
  /** Whether the shared dispatcher needs its short watchdog interval. */
  pending(): boolean {
    return this.all<Receipt>("message:").some((receipt) => !FINISHED.has(receipt.status));
  }
  /** Process at most one message per workspace per pass; persisted retries survive worker resets. */
  async process(): Promise<boolean> {
    const seen = new Set<string>();
    for (const original of this.all<Receipt>("message:").toSorted((a, b) => a.order - b.order)) {
      if (FINISHED.has(original.status)) {
        if (original.receivedAt < Date.now() - RETENTION) this.remove(`message:${original.id}`);
        continue;
      }
      if (!this.valid(original)) {
        this.save({ ...original, status: "cancelled", prompt: undefined });
        continue;
      }
      if (seen.has(original.workspaceId)) continue;
      seen.add(original.workspaceId);
      if (original.nextAttempt > Date.now()) continue;
      let receipt = original;
      if (receipt.status === "processing") {
        if (receipt.nextAttempt <= Date.now()) this.save({ ...receipt, status: "failed" });
        continue;
      }
      try {
        const workspace = this.workspace(receipt.workspaceId);
        if (!(await workspace.isChatChannelOwner(receipt.userId))) {
          this.save({ ...receipt, status: "cancelled" });
          continue;
        }
        if (!receipt.threadKey) {
          let thread: Thread | undefined;
          if (!receipt.input.forceNew) {
            for (const ref of receipt.input.references.toReversed()) {
              thread = this.get<Thread>(`thread:${receipt.token}:${await channelHash(ref)}`);
              if (thread) break;
            }
          }
          let relatedChatId: number | undefined;
          if (
            !thread &&
            !receipt.input.forceNew &&
            this.get<Mailbox>(`mailbox:${receipt.userId}`)?.continueRelated
          ) {
            relatedChatId =
              (await workspace.findRelatedEmailChat(
                receipt.userId,
                `${receipt.subject}\n${receipt.input.text.slice(0, 2000)}`,
              )) ?? undefined;
          }
          const routing: EmailRoutingReason = thread
            ? "thread"
            : relatedChatId !== undefined
              ? "related"
              : "new";
          receipt = {
            ...receipt,
            threadKey: thread?.key ?? receipt.id,
            relatedChatId: thread?.chatId ?? relatedChatId,
            routing,
          };
        }
        if (!receipt.prompt) {
          const converted = await inboxPrompt(receipt.input, this.env.WORKERS_AI);
          receipt = { ...receipt, prompt: converted.prompt, notices: converted.notices };
        }
        // Rotation/revocation may have occurred during extraction or semantic matching.
        if (!this.valid(receipt) || this.get<Receipt>(`message:${receipt.id}`)?.status !== "queued")
          continue;
        this.save(receipt);
        const result = await workspace.receiveInboxMessage(
          receipt.userId,
          receipt.threadKey!,
          receipt.id,
          receipt.prompt!,
          receipt.relatedChatId,
        );
        const current = this.get<Receipt>(`message:${receipt.id}`)!;
        if (current.status === "cancelled") continue;
        if (!result.accepted) {
          this.save({ ...current, status: "failed" });
          continue;
        }
        const chatId = Number(
          new URL(result.chatPath, "https://local.invalid").searchParams.get("chat"),
        );
        this.put(`thread:${receipt.token}:${await channelHash(receipt.input.messageId)}`, {
          key: receipt.threadKey!,
          chatId,
          receivedAt: receipt.receivedAt,
        } satisfies Thread);
        this.save({
          ...current,
          chatPath: result.chatPath,
          status: current.status === "complete" ? "complete" : "processing",
          nextAttempt: Date.now() + 15 * 60000,
        });
      } catch {
        const current = this.get<Receipt>(`message:${receipt.id}`)!;
        if (current.status !== "queued") continue;
        const attempts = current.attempts + 1;
        this.save({
          ...current,
          attempts,
          status: attempts >= 8 ? "failed" : "queued",
          nextAttempt: Date.now() + Math.min(300000, 15000 * 2 ** attempts),
        });
      }
    }
    for (const row of this.ctx.storage.sql
      .exec<{ key: string; value: string }>(
        "SELECT key,value FROM email_records WHERE key LIKE 'thread:%'",
      )
      .toArray()) {
      if (JSON.parse(row.value).receivedAt < Date.now() - RETENTION) this.remove(row.key);
    }
    return this.all<Receipt>("message:").some((receipt) => !FINISHED.has(receipt.status));
  }
}
