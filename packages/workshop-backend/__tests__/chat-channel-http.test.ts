import { it, expect, vi, afterEach, describe } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { ChatChannels } from "../src/chat-channels/channels";
import { handleChatChannelRequest } from "../src/chat-channels/http";
const bindings = env as typeof env & { TEST_CHAT_CHANNELS: DurableObjectNamespace<ChatChannels> };
const settings = {
  PUBLIC_BASE_URL: "https://example.test",
  CHANNEL_ENCRYPTION_KEY: btoa("k".repeat(32)),
  SLACK_CHAT_CLIENT_ID: "fixture",
  SLACK_CHAT_CLIENT_SECRET: "fixture-secret",
  SLACK_CHAT_SIGNING_SECRET: "fixture-signing",
};
const endpoint = "https://example.test/api/chat-channels/slack/events";
afterEach(() => vi.restoreAllMocks());
async function signed(body: unknown) {
  const raw = JSON.stringify(body),
    timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(settings.SLACK_CHAT_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature =
    "v0=" +
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${raw}`)),
    ).toHex();
  return new Request(endpoint, {
    method: "POST",
    body: raw,
    headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
  });
}
describe("chat callback HTTP boundary", { timeout: 30000 }, () => {
  it("requires valid provider configuration and a signed URL-verification challenge", async () => {
    const channels = bindings.TEST_CHAT_CHANNELS.getByName(crypto.randomUUID());
    expect(
      (
        await handleChatChannelRequest(
          await signed({ type: "url_verification", challenge: "proof" }),
          {},
          channels,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleChatChannelRequest(
          new Request(endpoint, { method: "POST", body: "{}" }),
          settings,
          channels,
        )
      ).status,
    ).toBe(401);
    const response = await handleChatChannelRequest(
      await signed({ type: "url_verification", challenge: "proof" }),
      settings,
      channels,
    );
    expect(await response.json()).toEqual({ challenge: "proof" });
  });
  it("durably receives signed Slack events once and ignores unknown installations", async () => {
    const channels = bindings.TEST_CHAT_CHANNELS.getByName(crypto.randomUUID());
    await runInDurableObject(channels, async (_instance, ctx) => {
      const setAlarm = ctx.storage.setAlarm.bind(ctx.storage);
      vi.spyOn(ctx.storage, "setAlarm").mockImplementation(() => setAlarm(Date.now() + 86400000));
    });
    await channels.install({ team: "T1", bot: "B1", token: "fixture-token" });
    const body = {
      type: "event_callback",
      team_id: "T1",
      event_id: "event",
      event: {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        ts: "1.2",
        text: "hello",
      },
    };
    for (let i = 0; i < 2; i++)
      expect((await handleChatChannelRequest(await signed(body), settings, channels)).status).toBe(
        200,
      );
    expect(
      (
        await handleChatChannelRequest(
          await signed({ ...body, team_id: "unknown" }),
          settings,
          channels,
        )
      ).status,
    ).toBe(200);
    expect(await channels.slackBot("unknown")).toBeNull();
  });
  it("bounds streaming payloads even without Content-Length and rejects forged OAuth state", async () => {
    const channels = bindings.TEST_CHAT_CHANNELS.getByName(crypto.randomUUID());
    expect(
      (
        await handleChatChannelRequest(
          new Request(endpoint, { method: "POST", body: "x".repeat(65537) }),
          settings,
          channels,
        )
      ).status,
    ).toBe(413);
    const fetch = vi.spyOn(globalThis, "fetch");
    const response = await handleChatChannelRequest(
      new Request("https://example.test/api/chat-channels/slack/oauth?state=forged&code=code"),
      settings,
      channels,
    );
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
