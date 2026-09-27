import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import type { ChatChannelProvider } from "@gadgets/workshop-shared/chat-channels";

/** Optional deployment credentials. Provider secrets never cross the browser API. */
export interface ChannelEnv {
  PUBLIC_BASE_URL?: string;
  CHANNEL_ENCRYPTION_KEY?: string;
  SLACK_CHAT_CLIENT_ID?: string;
  SLACK_CHAT_CLIENT_SECRET?: string;
  SLACK_CHAT_SIGNING_SECRET?: string;
  TEAMS_CHAT_APP_ID?: string;
  TEAMS_CHAT_CLIENT_SECRET?: string;
  TEAMS_CHAT_TENANT_ID?: string;
}
/** Verified source identity and a destination fixed by provider authentication. */
export interface ChannelEvent {
  provider: ChatChannelProvider;
  tenant: string;
  actor: string;
  conversation: string;
  thread: string;
  id: string;
  text: string;
  private: boolean;
  serviceUrl?: string;
}
/** Slack installation credentials, encrypted before persistence. */
export interface SlackInstallation {
  team: string;
  bot: string;
  token: string;
}
const enc = new TextEncoder();
/** SHA-256 identifiers keep provider IDs and pairing secrets out of storage keys/logs. */
export async function channelHash(value: string): Promise<string> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))).toHex();
}
/** Providers stay disabled until all required operator inputs are present. */
export function channelAvailable(env: ChannelEnv, provider: ChatChannelProvider): boolean {
  if (!env.PUBLIC_BASE_URL || !env.CHANNEL_ENCRYPTION_KEY) return false;
  return provider === "slack"
    ? !!(env.SLACK_CHAT_CLIENT_ID && env.SLACK_CHAT_CLIENT_SECRET && env.SLACK_CHAT_SIGNING_SECRET)
    : !!(env.TEAMS_CHAT_APP_ID && env.TEAMS_CHAT_CLIENT_SECRET && env.TEAMS_CHAT_TENANT_ID);
}
/** Encrypt installation tokens with a deployment-owned AES-256 key and team-bound AAD. */
export async function protectToken(
  secret: string,
  team: string,
  value: string,
  decrypt = false,
): Promise<string> {
  const raw = new Uint8Array(Uint8Array.fromBase64(secret));
  if (raw.length !== 32) throw new Error("Channel encryption key must be 32 bytes.");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    decrypt ? "decrypt" : "encrypt",
  ]);
  if (decrypt) {
    const bytes = Uint8Array.fromBase64(value);
    return new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: enc.encode(team) },
        key,
        bytes.slice(12),
      ),
    );
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(team) },
      key,
      enc.encode(value),
    ),
  );
  return new Uint8Array([...iv, ...ciphertext]).toBase64();
}
/** Verify Slack's exact raw-body signature, including the five-minute replay window. */
export async function verifySlack(
  request: Request,
  raw: string,
  secret: string,
  now = Date.now(),
): Promise<void> {
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  if (
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !/^v0=[a-f0-9]{64}$/.test(signature)
  )
    throw new Error("Invalid Slack signature.");
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      new Uint8Array(Uint8Array.fromHex(signature.slice(3))),
      enc.encode(`v0:${timestamp}:${raw}`),
    ))
  )
    throw new Error("Invalid Slack signature.");
}
const nonempty = (value: unknown, limit = 512): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= limit;
/** Ignore bot echoes, edits, attachments-only events and unsupported Slack event types. */
export function slackEvent(body: any, bot: string): ChannelEvent | null {
  const e = body?.event;
  if (
    !nonempty(body?.team_id) ||
    !nonempty(body?.event_id) ||
    !e ||
    e.bot_id ||
    e.subtype ||
    e.user === bot ||
    !nonempty(e.user) ||
    !nonempty(e.channel) ||
    !nonempty(e.ts) ||
    !nonempty(e.text, 12000) ||
    !(e.type === "app_mention" || (e.type === "message" && e.channel_type === "im"))
  )
    return null;
  return {
    provider: "slack",
    tenant: body.team_id,
    actor: e.user,
    conversation: e.channel,
    thread: typeof e.thread_ts === "string" ? e.thread_ts : e.ts,
    id: body.event_id,
    text: e.text.replaceAll(`<@${bot}>`, "").trim(),
    private: e.channel_type === "im",
  };
}
let teamsKeys: { expires: number; keys: JSONWebKeySet } | undefined;
/** Only Microsoft's public Teams connector hosts may receive bot credentials. */
export function teamsServiceUrl(value: unknown): string {
  if (!nonempty(value)) throw new Error("Invalid Teams destination.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["smba.trafficmanager.net", "smba.infra.teams.microsoft.com"].includes(url.hostname)
  )
    throw new Error("Invalid Teams destination.");
  return url.href.endsWith("/") ? url.href : url.href + "/";
}
/** Validate Connector JWT audience, issuer, lifetime, Teams endorsement and signed destination. */
export async function verifyTeams(request: Request, body: any, env: ChannelEnv): Promise<void> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) throw new Error("Missing Teams authentication.");
  if (!teamsKeys || teamsKeys.expires < Date.now()) {
    const response = await fetch("https://login.botframework.com/v1/.well-known/keys", {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Teams keys unavailable.");
    const keys = (await response.json()) as JSONWebKeySet;
    // Endorsements bind the signing key to the channel, independently of the activity JSON.
    keys.keys = keys.keys.filter(
      (key) =>
        "endorsements" in key &&
        Array.isArray(key.endorsements) &&
        key.endorsements.includes("msteams"),
    );
    teamsKeys = { keys, expires: Date.now() + 3600000 };
  }
  const { payload } = await jwtVerify(authorization.slice(7), createLocalJWKSet(teamsKeys.keys), {
    algorithms: ["RS256"],
    issuer: "https://api.botframework.com",
    audience: env.TEAMS_CHAT_APP_ID,
    requiredClaims: ["exp", "nbf", "serviceurl"],
    clockTolerance: 60,
  });
  if (
    payload.serviceurl !== body.serviceUrl ||
    body.channelId !== "msteams" ||
    body.channelData?.tenant?.id !== env.TEAMS_CHAT_TENANT_ID
  )
    throw new Error("Invalid Teams activity.");
  teamsServiceUrl(body.serviceUrl);
}
/** Extract a text activity after successful Teams verification. */
export function teamsEvent(body: any): ChannelEvent | null {
  if (
    body.type !== "message" ||
    body.from?.role === "bot" ||
    body.from?.id === body.recipient?.id ||
    !nonempty(body.id) ||
    !nonempty(body.from?.id) ||
    !nonempty(body.conversation?.id) ||
    !nonempty(body.text, 12000)
  )
    return null;
  return {
    provider: "teams",
    tenant: body.channelData.tenant.id,
    actor: body.from.id,
    conversation: body.conversation.id,
    thread: body.replyToId ?? body.id,
    id: body.id,
    text: body.text.replace(/<at>[^<]*<\/at>/g, "").trim(),
    private: body.conversation.conversationType === "personal",
    serviceUrl: teamsServiceUrl(body.serviceUrl),
  };
}
/** Exchange an installation authorization code; token rotation must be disabled for this bot app. */
export async function installSlack(code: string, env: ChannelEnv): Promise<SlackInstallation> {
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
    headers: {
      authorization: "Basic " + btoa(`${env.SLACK_CHAT_CLIENT_ID}:${env.SLACK_CHAT_CLIENT_SECRET}`),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      redirect_uri: new URL("/api/chat-channels/slack/oauth", env.PUBLIC_BASE_URL).href,
    }),
  });
  const result: any = await response.json();
  if (
    !response.ok ||
    !result.ok ||
    !nonempty(result.team?.id) ||
    !nonempty(result.bot_user_id) ||
    !nonempty(result.access_token) ||
    result.expires_in ||
    result.refresh_token
  )
    throw new Error("Slack installation failed. Check bot scopes and disable token rotation.");
  const scopes = new Set(String(result.scope).split(","));
  if (!["chat:write", "im:history", "app_mentions:read"].every((s) => scopes.has(s)))
    throw new Error("Slack bot scopes are incomplete.");
  return { team: result.team.id, bot: result.bot_user_id, token: result.access_token };
}
/** Send once. A network error is an uncertain delivery, never an automatic resend. */
export async function sendChannelReply(
  event: ChannelEvent,
  text: string,
  env: ChannelEnv,
  slackToken?: string,
): Promise<void> {
  let response: Response;
  if (event.provider === "slack") {
    if (!slackToken) throw new Error("Slack installation missing.");
    response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: { authorization: "Bearer " + slackToken, "content-type": "application/json" },
      body: JSON.stringify({
        channel: event.conversation,
        thread_ts: event.thread,
        text,
        mrkdwn: false,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    const result: any = await response.json();
    if (!response.ok || !result.ok) throw new Error("Slack reply not confirmed.");
  } else {
    const tokenResponse = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(env.TEAMS_CHAT_TENANT_ID!)}/oauth2/v2.0/token`,
      {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: env.TEAMS_CHAT_APP_ID!,
          client_secret: env.TEAMS_CHAT_CLIENT_SECRET!,
          scope: "https://api.botframework.com/.default",
        }),
      },
    );
    const token: any = await tokenResponse.json();
    if (!tokenResponse.ok || !nonempty(token.access_token, 20000))
      throw new Error("Teams token unavailable.");
    const url = new URL(
      `v3/conversations/${encodeURIComponent(event.conversation)}/activities/${encodeURIComponent(event.id)}`,
      teamsServiceUrl(event.serviceUrl),
    );
    response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: {
        authorization: "Bearer " + token.access_token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "message", textFormat: "plain", text }),
    });
    if (!response.ok) throw new Error("Teams reply not confirmed.");
  }
}
