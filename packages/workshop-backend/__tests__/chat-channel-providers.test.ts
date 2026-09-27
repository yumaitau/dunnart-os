import { describe, expect, it, afterEach, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  protectToken,
  verifySlack,
  slackEvent,
  teamsEvent,
  teamsServiceUrl,
  verifyTeams,
  sendChannelReply,
  installSlack,
  type ChannelEnv,
  type ChannelEvent,
} from "../src/chat-channels/providers";
const enc = new TextEncoder();
const env: ChannelEnv = {
  PUBLIC_BASE_URL: "https://example.test",
  CHANNEL_ENCRYPTION_KEY: btoa("k".repeat(32)),
  SLACK_CHAT_CLIENT_ID: "test-client",
  SLACK_CHAT_CLIENT_SECRET: "test-secret",
  SLACK_CHAT_SIGNING_SECRET: "test-signing",
  TEAMS_CHAT_APP_ID: "app",
  TEAMS_CHAT_CLIENT_SECRET: "secret",
  TEAMS_CHAT_TENANT_ID: "tenant",
};
afterEach(() => vi.restoreAllMocks());
describe("verified chat providers", () => {
  it("encrypts tokens with fresh nonces and rejects a different installation", async () => {
    const a = await protectToken(env.CHANNEL_ENCRYPTION_KEY!, "team", "private-token");
    const b = await protectToken(env.CHANNEL_ENCRYPTION_KEY!, "team", "private-token");
    expect(a).not.toBe(b);
    expect(a).not.toContain("private-token");
    expect(await protectToken(env.CHANNEL_ENCRYPTION_KEY!, "team", a, true)).toBe("private-token");
    await expect(protectToken(env.CHANNEL_ENCRYPTION_KEY!, "other", a, true)).rejects.toThrow();
  });
  it("authenticates raw Slack bodies and rejects stale, changed and forged requests", async () => {
    const raw = '{"event":"message"}',
      timestamp = String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode("secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature =
      "v0=" +
      new Uint8Array(
        await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${raw}`)),
      ).toHex();
    const request = new Request("https://example.test", {
      headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
    });
    await verifySlack(request, raw, "secret");
    await expect(verifySlack(request, raw + " ", "secret")).rejects.toThrow();
    await expect(verifySlack(request, raw, "secret", Date.now() + 301000)).rejects.toThrow();
    await expect(verifySlack(request, raw, "wrong")).rejects.toThrow();
  });
  it("ignores Slack bot loops and edits, and distinguishes shared mentions from private messages", () => {
    const body = {
      team_id: "T1",
      event_id: "E1",
      event: {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        ts: "1.2",
        text: "hello",
      },
    };
    expect(slackEvent(body, "B1")?.private).toBe(true);
    expect(slackEvent({ ...body, event: { ...body.event, bot_id: "B2" } }, "B1")).toBeNull();
    expect(
      slackEvent({ ...body, event: { ...body.event, subtype: "message_changed" } }, "B1"),
    ).toBeNull();
    expect(
      slackEvent(
        { ...body, event: { ...body.event, type: "app_mention", channel_type: "channel" } },
        "B1",
      )?.private,
    ).toBe(false);
    expect(
      slackEvent({ ...body, event: { ...body.event, channel_type: "channel" } }, "B1"),
    ).toBeNull();
  });
  it("pins Teams JWT audience, issuer, tenant, key endorsement and reply destination", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
    const key = { ...(await exportJWK(publicKey)), kid: "teams", endorsements: ["msteams"] };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [key] }));
    const body = {
      serviceUrl: "https://smba.trafficmanager.net/teams/",
      channelId: "msteams",
      channelData: { tenant: { id: "tenant" } },
      type: "message",
      id: "activity",
      from: { id: "user" },
      conversation: { id: "chat", conversationType: "personal" },
      text: "hello",
    };
    const sign = (audience = "app", issuer = "https://api.botframework.com") =>
      new SignJWT({ serviceurl: body.serviceUrl })
        .setProtectedHeader({ alg: "RS256", kid: "teams" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime("2m")
        .setNotBefore("0s")
        .sign(privateKey);
    const req = async (audience?: string, issuer?: string) =>
      new Request("https://example.test", {
        headers: { authorization: "Bearer " + (await sign(audience, issuer)) },
      });
    await verifyTeams(await req(), body, env);
    expect(teamsEvent(body)?.private).toBe(true);
    await expect(verifyTeams(await req("wrong"), body, env)).rejects.toThrow();
    await expect(
      verifyTeams(await req("app", "https://attacker.test"), body, env),
    ).rejects.toThrow();
    await expect(
      verifyTeams(await req(), { ...body, serviceUrl: "https://attacker.test/" }, env),
    ).rejects.toThrow();
    await expect(
      verifyTeams(await req(), { ...body, channelData: { tenant: { id: "other" } } }, env),
    ).rejects.toThrow();
    for (const value of [
      "http://smba.trafficmanager.net/teams/",
      "https://smba.trafficmanager.net.attacker.test/",
      "https://user@smba.trafficmanager.net/",
      "https://localhost/",
    ])
      expect(() => teamsServiceUrl(value)).toThrow();
  });
  it("exchanges Slack authorization without exposing tokens and rejects incomplete scopes", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({
          ok: true,
          team: { id: "T1" },
          bot_user_id: "B1",
          access_token: "token",
          scope: "chat:write,im:history,app_mentions:read",
        }),
      );
    expect((await installSlack("code", env)).team).toBe("T1");
    expect(fetch.mock.calls[0][1]?.redirect).toBe("manual");
    fetch.mockResolvedValue(
      Response.json({
        ok: true,
        team: { id: "T1" },
        bot_user_id: "B1",
        access_token: "token",
        scope: "chat:write",
      }),
    );
    await expect(installSlack("code", env)).rejects.toThrow("scopes");
  });
  it("sends plain replies only to the verified Slack conversation/thread, with no automatic network retry", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
    const event: ChannelEvent = {
      provider: "slack",
      tenant: "T1",
      actor: "U1",
      conversation: "D1",
      thread: "1.2",
      id: "E1",
      text: "hi",
      private: true,
    };
    await sendChannelReply(event, "hello", env, "token");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({
      channel: "D1",
      thread_ts: "1.2",
      text: "hello",
      mrkdwn: false,
    });
    fetch.mockRejectedValue(new Error("network outcome unknown"));
    await expect(sendChannelReply(event, "hello", env, "token")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
