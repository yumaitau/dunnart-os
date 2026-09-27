import { DurableObject } from "cloudflare:workers";
import type {
  ChatChannelProvider,
  ChatChannelStatus,
  ChatChannelPairing,
  ChatChannelLink,
} from "@gadgets/workshop-shared/chat-channels";
import {
  beginNativeRecovery,
  captureNativeRoot,
  endNativeRecovery,
  fenceNativeRecoveryMethods,
  readNativeRecovery,
  registerNativeRecoveryObject,
} from "../native-recovery";
import { prepareRecoveryContext, readRecoveryRuntimeIdentity } from "../recovery-runtime-context";
import {
  channelAvailable,
  channelHash,
  protectToken,
  sendChannelReply,
  type ChannelEvent,
  type SlackInstallation,
} from "./providers";

interface Pair {
  userId: string;
  workspaceId: string;
  provider: ChatChannelProvider;
  expiresAt: number;
}
interface Link extends ChatChannelLink {
  userId: string;
  identity: string;
}
interface Job {
  id: string;
  order: number;
  event: ChannelEvent;
  linkId?: string;
  userId?: string;
  workspaceId?: string;
  text?: string;
  chatPath?: string;
  status:
    | "queued"
    | "submitted"
    | "ready"
    | "sending"
    | "delivered"
    | "uncertain"
    | "cancelled"
    | "failed";
  createdAt: number;
  updatedAt: number;
}
const TERMINAL = new Set(["delivered", "uncertain", "cancelled", "failed"]);

/** Durable pairing, inbox and outbox. Only verified provider requests reach receive(). */
export class ChatChannels extends DurableObject<Cloudflare.Env> {
  private working = false;
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    env = prepareRecoveryContext(ctx, env);
    super(ctx, env);
    registerNativeRecoveryObject(this, ctx);
    if (readNativeRecovery(ctx)) return;
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS channel_records (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  private get<T>(key: string): T | undefined {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM channel_records WHERE key=?", key)
      .toArray()[0];
    return row ? JSON.parse(row.value) : undefined;
  }
  private put(key: string, value: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO channel_records VALUES (?,?)",
      key,
      JSON.stringify(value),
    );
  }
  private remove(key: string): void {
    this.ctx.storage.sql.exec("DELETE FROM channel_records WHERE key=?", key);
  }
  private all<T>(prefix: string): T[] {
    return this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM channel_records WHERE substr(key,1,?)=? ORDER BY key",
        prefix.length,
        prefix,
      )
      .toArray()
      .map((row) => JSON.parse(row.value));
  }
  private live(): void {
    if (readRecoveryRuntimeIdentity(this.ctx))
      throw new Error("Chat channels are paused in isolated recovery.");
  }
  private workspace(id: string) {
    return this.ctx.exports.OverseerDurableObject.get(
      this.ctx.exports.OverseerDurableObject.idFromString(id),
    );
  }
  private async owned(userId: string, workspaceId: string): Promise<boolean> {
    return this.workspace(workspaceId).isChatChannelOwner(userId);
  }
  /** Capture channel installation and delivery state together with the rest of the deployment. */
  async getRecoverySnapshot(): Promise<string> {
    return JSON.stringify(await captureNativeRoot(this.ctx));
  }
  /** Freeze persistent channel state and abort in-flight dispatch before backup. */
  async beginRecovery(run: string, key: string): Promise<void> {
    if (beginNativeRecovery(this.ctx, run, key)) {
      await this.ctx.storage.sync();
      this.ctx.abort("Chat channel recovery fence installed; retry.");
    }
  }
  /** Release only the matching backup fence. */
  endRecovery(run: string): void {
    endNativeRecovery(this.ctx, run);
  }
  /** Present only this user's links and bounded delivery diagnostics. */
  async status(userId: string): Promise<ChatChannelStatus> {
    return {
      providers: (["slack", "teams"] as const).map((provider) => ({
        provider,
        available: channelAvailable(this.env, provider),
      })),
      links: this.all<Link>("link:")
        .filter((l) => l.userId === userId)
        .map(({ id, provider, workspaceId, linkedAt }) => ({
          id,
          provider,
          workspaceId,
          linkedAt,
        })),
      deliveries: this.all<Job>("job:")
        .filter((j) => j.userId === userId)
        .toSorted((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 10)
        .map(({ id, status, updatedAt }) => ({ id, status, updatedAt })),
    };
  }
  /** Create a single-use challenge bound to the authenticated user and owned workspace. */
  async pair(
    userId: string,
    provider: ChatChannelProvider,
    workspaceId: string,
  ): Promise<ChatChannelPairing> {
    this.live();
    if (!["slack", "teams"].includes(provider) || !channelAvailable(this.env, provider))
      throw new Error("Provider not configured by the deployment administrator.");
    if (!/^[a-f0-9]{64}$/.test(workspaceId) || !(await this.owned(userId, workspaceId)))
      throw new Error("Choose a workspace you own.");
    const code = crypto
      .getRandomValues(new Uint8Array(24))
      .toBase64({ alphabet: "base64url", omitPadding: true });
    const hash = await channelHash(code);
    const expiresAt = Date.now() + 600000;
    await this.ctx.storage.transaction(async () => {
      const previous = this.get<string>(`pair-user:${userId}:${provider}`);
      if (previous) this.remove(`pair:${previous}`);
      this.put(`pair:${hash}`, { userId, provider, workspaceId, expiresAt } satisfies Pair);
      this.put(`pair-user:${userId}:${provider}`, hash);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    });
    let openUrl: string;
    if (provider === "slack") {
      const state = crypto.randomUUID();
      this.put(`oauth:${state}`, { userId, expiresAt });
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.search = new URLSearchParams({
        client_id: this.env.SLACK_CHAT_CLIENT_ID!,
        scope: "chat:write,im:history,app_mentions:read",
        state,
        redirect_uri: new URL("/api/chat-channels/slack/oauth", this.env.PUBLIC_BASE_URL).href,
      }).toString();
      openUrl = url.href;
    } else
      openUrl = `https://teams.microsoft.com/l/chat/0/0?users=28:${encodeURIComponent(this.env.TEAMS_CHAT_APP_ID!)}`;
    return { command: `link ${code}`, expiresAt, openUrl };
  }
  /** Consume OAuth state once before exchanging the provider authorization code. */
  consumeOAuth(state: string): boolean {
    this.live();
    const value = this.get<{ expiresAt: number }>(`oauth:${state}`);
    this.remove(`oauth:${state}`);
    return !!value && value.expiresAt > Date.now();
  }
  /** Persist a verified Slack installation with encrypted credentials. */
  async install(installation: SlackInstallation): Promise<void> {
    this.live();
    const sealed = await protectToken(
      this.env.CHANNEL_ENCRYPTION_KEY!,
      installation.team,
      installation.token,
    );
    this.put(`install:${installation.team}`, { bot: installation.bot, sealed });
  }
  /** Return only the installed bot identity needed to ignore bot echoes. */
  slackBot(team: string): string | null {
    return this.get<{ bot: string }>(`install:${team}`)?.bot ?? null;
  }
  /** Revoke this account's link; queued and in-progress replies fail the final link check. */
  unlink(userId: string, id: string): void {
    this.live();
    const link = this.all<Link>("link:").find((l) => l.id === id && l.userId === userId);
    if (!link) return;
    this.remove(`link:${link.identity}`);
    for (const job of this.all<Job>("job:"))
      if (job.linkId === id && !TERMINAL.has(job.status))
        this.save({ ...job, status: "cancelled", text: undefined });
  }
  private save(job: Job): void {
    this.put(`job:${job.id}`, { ...job, updatedAt: Date.now() });
  }
  /** Durably acknowledge a verified event before provider retries can arrive. */
  async receive(event: ChannelEvent): Promise<void> {
    this.live();
    if (!channelAvailable(this.env, event.provider)) throw new Error("Channel disabled.");
    const identity = await channelHash(
      JSON.stringify([event.provider, event.tenant, event.actor, event.conversation]),
    );
    const id = await channelHash(JSON.stringify([event.provider, event.tenant, event.id]));
    const match = event.private ? /^link ([A-Za-z0-9_-]{32})$/.exec(event.text.trim()) : null;
    const pairingHash = match ? await channelHash(match[1]) : null;
    // All state decisions happen without an await inside the transaction, so duplicate delivery
    // and simultaneous pairing cannot consume a challenge twice.
    await this.ctx.storage.transaction(async () => {
      if (this.get(`job:${id}`)) return;
      const now = Date.now();
      const jobs = this.all<Job>("job:");
      if (
        jobs.filter((j) => !TERMINAL.has(j.status)).length >= 200 ||
        jobs.filter(
          (j) =>
            j.event.actor === event.actor &&
            j.event.tenant === event.tenant &&
            j.createdAt > now - 60000,
        ).length >= 20
      )
        throw new Error("Channel queue is full; retry later.");
      let link = this.get<Link>(`link:${identity}`);
      let text: string | undefined;
      if (!event.private)
        text =
          "Please message this bot privately and link your Dunnart account. Shared-channel agent replies are not enabled.";
      else if (pairingHash) {
        const pair = this.get<Pair>(`pair:${pairingHash}`);
        if (!pair || pair.provider !== event.provider || pair.expiresAt <= now)
          text =
            "Pairing code is invalid or expired. Generate a new code in Dunnart Settings > Chat channels.";
        else if (link && link.userId !== pair.userId)
          text =
            "This conversation is already linked. Unlink it from the original Dunnart account first.";
        else {
          this.remove(`pair:${pairingHash}`);
          link = {
            id: crypto.randomUUID(),
            provider: event.provider,
            userId: pair.userId,
            workspaceId: pair.workspaceId,
            identity,
            linkedAt: now,
          };
          this.put(`link:${identity}`, link);
          text =
            "Dunnart connected. Send a message here to chat with your selected workspace. Approve pending actions in Dunnart.";
        }
      } else if (!link)
        text =
          "Link your account first: open Dunnart Settings > Chat channels, choose a workspace, then paste the pairing command here.";
      const order = (this.get<number>("sequence") ?? 0) + 1;
      this.put("sequence", order);
      const job: Job = {
        id,
        order,
        event: { ...event, text: pairingHash ? "" : event.text },
        linkId: link?.id,
        userId: link?.userId,
        workspaceId: link?.workspaceId,
        status: text ? "ready" : "queued",
        text,
        createdAt: now,
        updatedAt: now,
      };
      this.save(job);
      await this.ctx.storage.setAlarm(now + 100);
    });
  }
  /** Idempotent durable handoff from an agent's completed turn into the reply outbox. */
  async complete(id: string, text: string, workspaceId: string): Promise<void> {
    this.live();
    const job = this.get<Job>(`job:${id}`);
    if (!job || TERMINAL.has(job.status) || job.status === "sending" || job.status === "ready")
      return;
    if (job.workspaceId !== workspaceId) throw new Error("Wrong reply workspace.");
    await this.ctx.storage.transaction(async () => {
      this.save({ ...job, status: "ready", text: text.slice(0, 2800) });
      await this.ctx.storage.setAlarm(Date.now() + 100);
    });
  }
  private validLink(job: Job): boolean {
    return (
      !job.linkId ||
      this.all<Link>("link:").some(
        (l) => l.id === job.linkId && l.userId === job.userId && l.workspaceId === job.workspaceId,
      )
    );
  }
  /** Serialize agent turns per conversation and send each reply at most once after uncertainty. */
  async alarm(): Promise<void> {
    if (readNativeRecovery(this.ctx) || readRecoveryRuntimeIdentity(this.ctx) || this.working)
      return;
    this.working = true;
    try {
      // Re-arm before any network work. A crash leaves a durable watchdog, not a lost inbox.
      await this.ctx.storage.setAlarm(Date.now() + 15000);
      const jobs = this.all<Job>("job:").toSorted((a, b) => a.order - b.order);
      for (const initial of jobs) {
        if (Date.now() - initial.createdAt > 7 * 86400000 && TERMINAL.has(initial.status)) {
          this.remove(`job:${initial.id}`);
          continue;
        }
        let job = this.get<Job>(`job:${initial.id}`)!;
        if (TERMINAL.has(job.status)) continue;
        if (!this.validLink(job) || !channelAvailable(this.env, job.event.provider)) {
          this.save({ ...job, status: "cancelled", text: undefined });
          continue;
        }
        if (job.status === "sending") {
          this.save({ ...job, status: "uncertain", text: undefined });
          continue;
        }
        if (job.status === "submitted" && Date.now() - job.updatedAt > 15 * 60000) {
          this.save({ ...job, status: "failed", text: undefined });
          continue;
        }
        if (job.status === "queued") {
          if (
            jobs.some(
              (other) =>
                other.id !== job.id &&
                other.linkId === job.linkId &&
                other.order < job.order &&
                !TERMINAL.has(this.get<Job>(`job:${other.id}`)?.status ?? "delivered"),
            )
          )
            continue;
          if (!(await this.owned(job.userId!, job.workspaceId!))) {
            this.save({ ...job, status: "cancelled" });
            continue;
          }
          try {
            const result = await this.workspace(job.workspaceId!).receivePairedChannelMessage(
              job.userId!,
              job.linkId!,
              job.id,
              job.event.text,
            );
            const current = this.get<Job>(`job:${job.id}`)!;
            if (current.status !== "queued") {
              if (result.accepted && current.status === "ready")
                this.save({ ...current, chatPath: result.chatPath });
              continue; // The agent may already have completed.
            }
            job = {
              ...current,
              ...(result.accepted
                ? { status: "submitted" as const, chatPath: result.chatPath }
                : { status: "ready" as const, text: result.message }),
            };
            this.save(job);
          } catch {
            this.save({ ...job, status: "failed", text: undefined });
            continue;
          }
        }
        if (job.status === "ready") {
          if (job.userId && job.workspaceId && !(await this.owned(job.userId, job.workspaceId))) {
            this.save({ ...job, status: "cancelled", text: undefined });
            continue;
          }
          // Re-read after authorization: unlink may have run while its RPC was pending.
          if (!this.validLink(job) || this.get<Job>(`job:${job.id}`)?.status !== "ready") continue;
          let token: string | undefined;
          if (job.event.provider === "slack") {
            const installation = this.get<{ sealed: string }>(`install:${job.event.tenant}`);
            if (!installation) {
              this.save({ ...job, status: "failed", text: undefined });
              continue;
            }
            token = await protectToken(
              this.env.CHANNEL_ENCRYPTION_KEY!,
              job.event.tenant,
              installation.sealed,
              true,
            );
          }
          if (!this.validLink(job) || this.get<Job>(`job:${job.id}`)?.status !== "ready") continue;
          this.save({ ...job, status: "sending" });
          await this.ctx.storage.sync();
          const suffix = job.chatPath
            ? `\n\nOpen workspace and approvals: ${new URL(job.chatPath, this.env.PUBLIC_BASE_URL).href}`
            : "";
          try {
            await sendChannelReply(job.event, (job.text ?? "") + suffix, this.env, token);
            this.save({ ...job, status: "delivered", text: undefined });
          } catch {
            this.save({ ...job, status: "uncertain", text: undefined });
          }
        }
      }
      for (const row of this.ctx.storage.sql
        .exec<{ key: string; value: string }>(
          "SELECT key,value FROM channel_records WHERE key LIKE 'pair:%' OR key LIKE 'oauth:%'",
        )
        .toArray()) {
        if (JSON.parse(row.value).expiresAt < Date.now()) this.remove(row.key);
      }
      await this.ctx.storage.setAlarm(
        Date.now() +
          (this.all<Job>("job:").some((j) => !TERMINAL.has(j.status)) ? 15000 : 86400000),
      );
    } finally {
      this.working = false;
    }
  }
}
fenceNativeRecoveryMethods(ChatChannels);
