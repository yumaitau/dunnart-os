import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { ChatChannels } from "../src/chat-channels/channels";
import type { UserDurableObject } from "../src/user";
import type { OverseerDurableObject } from "../src/overseer";
import type { ChannelEvent } from "../src/chat-channels/providers";
const bindings = env as typeof env & {
  TEST_CHAT_CHANNELS: DurableObjectNamespace<ChatChannels>;
  TEST_USER: DurableObjectNamespace<UserDurableObject>;
  TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
};
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const name = "channel-" + crypto.randomUUID();
  const user = bindings.TEST_USER.getByName(name);
  await user.provisionEnterpriseAccount(name, "Fixture owner", true, 1);
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
  await channels.install({ team: "T1", bot: "B1", token: "fixture-token" });
  const event = (text: string, id = crypto.randomUUID()): ChannelEvent => ({
    provider: "slack",
    tenant: "T1",
    actor: "U1",
    conversation: "D1",
    thread: "1.2",
    id,
    text,
    private: true,
  });
  return { user, workspace, channels, event };
}
describe("durable private chat routing", { timeout: 30000 }, () => {
  it("pairs only owned workspaces; consumes a challenge once and isolates account link listings", async () => {
    const f = await fixture();
    const userId = f.user.id.toString();
    let denied = false;
    try {
      await f.channels.pair("a".repeat(64), "slack", f.workspace.id.toString());
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);
    const pairing = await f.channels.pair(userId, "slack", f.workspace.id.toString());
    await f.channels.receive(f.event(pairing.command, "E1"));
    const linked = await f.channels.status(userId);
    expect(linked.links).toHaveLength(1);
    expect((await f.channels.status("other")).links).toEqual([]);
    await f.channels.receive({
      ...f.event(pairing.command, "E2"),
      actor: "U2",
      conversation: "D2",
    });
    expect((await f.channels.status(userId)).links).toHaveLength(1);
    await f.channels.receive(f.event(pairing.command, "E1"));
    expect((await f.channels.status(userId)).deliveries).toHaveLength(1);
    await f.channels.unlink("other", linked.links[0].id);
    expect((await f.channels.status(userId)).links).toHaveLength(1);
    await f.channels.unlink(userId, linked.links[0].id);
    expect((await f.channels.status(userId)).links).toEqual([]);
    expect((await f.channels.status(userId)).deliveries[0].status).toBe("cancelled");
  });
  it("never consumes private pairing challenges from shared channels or another provider", async () => {
    const f = await fixture();
    const id = f.user.id.toString();
    const pair = await f.channels.pair(id, "slack", f.workspace.id.toString());
    await f.channels.receive({ ...f.event(pair.command), private: false });
    await f.channels.receive({
      ...f.event(pair.command),
      provider: "teams",
      tenant: "fixture-tenant",
      serviceUrl: "https://smba.trafficmanager.net/teams/",
    });
    expect((await f.channels.status(id)).links).toHaveLength(0);
    await f.channels.receive(f.event(pair.command));
    expect((await f.channels.status(id)).links).toHaveLength(1);
  });
  it("stores Slack credentials encrypted and makes OAuth state single-use", async () => {
    const f = await fixture();
    const pair = await f.channels.pair(f.user.id.toString(), "slack", f.workspace.id.toString());
    const state = new URL(pair.openUrl!).searchParams.get("state")!;
    expect(await f.channels.consumeOAuth(state)).toBe(true);
    expect(await f.channels.consumeOAuth(state)).toBe(false);
    await runInDurableObject(f.channels, async (_instance, ctx) => {
      const dump = JSON.stringify(ctx.storage.sql.exec("SELECT * FROM channel_records").toArray());
      expect(dump).not.toContain("fixture-token");
      expect(dump).not.toContain(pair.command.slice(5));
    });
  });
  it("serializes turns, persists completed replies and suppresses duplicate delivery", async () => {
    const f = await fixture();
    const id = f.user.id.toString();
    const pair = await f.channels.pair(id, "slack", f.workspace.id.toString());
    await f.channels.receive(f.event(pair.command, "pair"));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
    await runInDurableObject(f.channels, async (instance) => {
      await instance.alarm();
    });
    await f.channels.receive(f.event("question", "first"));
    await f.channels.receive(f.event("follow up", "second"));
    const submissions: string[] = [];
    await runInDurableObject(f.channels, async (instance) => {
      vi.spyOn(instance as any, "workspace").mockReturnValue({
        isChatChannelOwner: async () => true,
        receivePairedChannelMessage: async (_user: string, _link: string, message: string) => {
          submissions.push(message);
          return { accepted: true, chatPath: "/workspace/fixture?chat=1" };
        },
      });
      await instance.alarm();
      expect(submissions).toHaveLength(1);
      await instance.complete(submissions[0], "answer", f.workspace.id.toString());
      await instance.alarm();
      expect(submissions).toHaveLength(2);
      await instance.complete(submissions[0], "duplicate", f.workspace.id.toString());
      expect(
        (await instance.status(id)).deliveries.filter((j) => j.status === "delivered"),
      ).toHaveLength(2);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // Pair confirmation + first answer.
  });
  it("does not resend an uncertain reply after a network failure or a restarted sending record", async () => {
    const f = await fixture();
    const id = f.user.id.toString();
    const pair = await f.channels.pair(id, "slack", f.workspace.id.toString());
    await f.channels.receive(f.event(pair.command));
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unknown outcome"));
    await runInDurableObject(f.channels, async (instance) => {
      await instance.alarm();
      await instance.alarm();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await f.channels.status(id)).deliveries[0].status).toBe("uncertain");
  });
  it("stops pending egress when SCIM deactivates the linked account", async () => {
    const f = await fixture();
    const id = f.user.id.toString();
    const pair = await f.channels.pair(id, "slack", f.workspace.id.toString());
    await f.channels.receive(f.event(pair.command));
    await f.user.provisionEnterpriseAccount("revoked", "Fixture", false, 2);
    const fetch = vi.spyOn(globalThis, "fetch");
    await runInDurableObject(f.channels, async (instance) => {
      await instance.alarm();
    });
    expect(fetch).not.toHaveBeenCalled();
    expect((await f.channels.status(id)).deliveries[0].status).toBe("cancelled");
  });
  it("pauses restored channel dispatch and captures native SQL state", async () => {
    const f = await fixture();
    expect(JSON.parse(await f.channels.getRecoverySnapshot()).storage).toBeDefined();
    await runInDurableObject(f.channels, async (instance, ctx) => {
      ctx.storage.kv.put(".nativeRecoveryRuntime", {
        sourceId: "root-channels",
        kind: "channels",
        originalId: ctx.id.toString(),
        scope: "recovery-fixture",
        namedIds: {},
      });
      const fetch = vi.spyOn(globalThis, "fetch");
      await instance.alarm();
      expect(fetch).not.toHaveBeenCalled();
      await expect(instance.receive(f.event("hello"))).rejects.toThrow("paused");
    });
  });
  it("uses the real external-chat storage path, deduplicates prompts and resumes its chat", async () => {
    const f = await fixture();
    await f.user.addModel(
      { type: "agent", id: "fixture-model", name: "Fixture model" },
      { provider: "openai", model: "gpt-4.1-mini", apiToken: "fixture-token" },
    );
    await runInDurableObject(f.workspace, async (instance) => {
      const impl = (instance as any).impl;
      // Only model execution is replaced; ownership, model choice, prompt storage and dedup run unchanged.
      const starts = vi.spyOn(impl, "startAgent").mockImplementation(() => {});
      const first = await instance.receivePairedChannelMessage(
        f.user.id.toString(),
        "link-id",
        "message-id",
        "remember this",
      );
      expect(first.accepted).toBe(true);
      const duplicate = await instance.receivePairedChannelMessage(
        f.user.id.toString(),
        "link-id",
        "message-id",
        "remember this",
      );
      expect(duplicate).toEqual(first);
      expect(starts).toHaveBeenCalledTimes(1);
      const record = impl.storage.gadgetResponseDeliveries.get("channel:message-id");
      expect(record.channelReplyId).toBe("message-id");
      expect(record.chatGatewayRpcTarget).toBeUndefined();
      // A completion receipt is what releases the existing chat for its next serialized turn.
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
      const next = await instance.receivePairedChannelMessage(
        f.user.id.toString(),
        "link-id",
        "second-id",
        "what did I ask?",
      );
      expect(next).toEqual(first);
      expect(starts).toHaveBeenCalledTimes(2);
      impl.storage.containsRestrictedData.put(true);
      expect(await instance.isChatChannelOwner(f.user.id.toString())).toBe(false);
    });
  });
});
