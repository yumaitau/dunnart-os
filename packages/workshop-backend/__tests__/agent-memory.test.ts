import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { AgentMemory, type MemorySource } from "../src/agent-memory";
import type { OverseerDurableObject } from "../src/overseer";
import { keyString } from "@gadgets/typed-storage";

const objects = (env as { TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject> }).TEST_OVERSEER;
const inside = <T>(fn: (instance: OverseerDurableObject, state: DurableObjectState) => Promise<T>) =>
  runInDurableObject(objects.getByName(crypto.randomUUID()), fn);
const vector = (axis = 0) => Array.from({ length: 768 }, (_, index) => index === axis ? 1 : 0);
function embeddings() {
  const run = vi.fn(async (_model: string, input: { text: string[] }) => ({
    data: input.text.map(text => vector(text.includes("unrelated") ? 1 : 0)),
  }));
  return { ai: { run } as Ai, run };
}
const source = (patch: Partial<MemorySource> = {}): MemorySource => ({ chatId: 1,
  questionSequence: 1, answerSequence: 2, question: "What is the release procedure?",
  answer: "Build, test, then deploy.", recordedAt: Date.now(), ...patch });

describe("workspace semantic memory", () => {
  it("recalls paraphrases, skips unrelated questions, and reuses exact questions without model I/O", () => inside(async (_, state) => {
    const { ai, run } = embeddings();
    const memory = new AgentMemory(state.storage.sql, ai, () => true);
    await memory.remember(source());
    expect(await memory.recall("How do we ship this application?")).toContain("Build, test, then deploy.");
    const calls = run.mock.calls.length;
    expect(await memory.recall("What is the release procedure?")).toContain('"sourceChatId":1');
    expect(run).toHaveBeenCalledTimes(calls);
    expect(await memory.recall("unrelated topic")).toBe("");
  }));

  it("updates repeated answers, prefers newer evidence, and rejects an older late write", () => inside(async (_, state) => {
    const { ai } = embeddings();
    const memory = new AgentMemory(state.storage.sql, ai, () => true);
    const old = source({ recordedAt: Date.now() - 10_000 });
    await memory.remember(old);
    await memory.remember(source({ answer: "Correction: staging verification is required first.", answerSequence: 4 }));
    await memory.remember(old);
    const result = await memory.recall(old.question);
    expect(result).toContain("Correction: staging verification");
    expect(result).not.toContain("Build, test, then deploy.");
    expect(state.storage.sql.exec("SELECT id FROM agent_memory").toArray()).toHaveLength(1);
  }));

  it("invalidates deleted/reverted sources and does not share another workspace's data", () => inside(async (_, state) => {
    const { ai } = embeddings(); let current = true;
    const memory = new AgentMemory(state.storage.sql, ai, () => current);
    await memory.remember(source());
    await inside(async (_other, otherState) => {
      expect(await new AgentMemory(otherState.storage.sql, ai, () => true).recall(source().question)).toBe("");
    });
    current = false;
    expect(await memory.recall(source().question)).toBe("");
    expect(state.storage.sql.exec("SELECT id FROM agent_memory").toArray()).toHaveLength(0);
  }));

  it("includes newer corrections when the original question is repeated exactly", () => inside(async (_, state) => {
    const { ai, run } = embeddings(); const memory = new AgentMemory(state.storage.sql, ai, () => true);
    await memory.remember(source({ recordedAt: Date.now() - 1000 }));
    await memory.remember(source({ question: "Correction to our release steps", answer: "Staging approval is now required.", chatId: 2 }));
    const calls = run.mock.calls.length;
    const recalled = await memory.recall(source().question);
    expect(recalled).toContain("Staging approval is now required.");
    expect(recalled.indexOf('"sourceChatId":2')).toBeLessThan(recalled.indexOf('"sourceChatId":1'));
    expect(run).toHaveBeenCalledTimes(calls);
  }));

  it("does not resurrect a source removed while embedding was pending", () => inside(async (_, state) => {
    let release!: (value: { data: number[][] }) => void;
    let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    const ai = { run: () => { started(); return new Promise(resolve => { release = resolve; }); } } as Ai;
    let current = true;
    const memory = new AgentMemory(state.storage.sql, ai, () => current);
    const saving = memory.remember(source()); await pending; current = false;
    release({ data: [vector()] }); await saving;
    expect(await memory.recall(source().question)).toBe("");
  }));

  it("marks old evidence stale and expires records after retention", () => inside(async (_, state) => {
    const { ai } = embeddings(); const memory = new AgentMemory(state.storage.sql, ai, () => true);
    await memory.remember(source({ recordedAt: Date.now() - 8 * 86400000 }));
    expect(await memory.recall(source().question)).toContain('"needsRefresh":true');
    state.storage.sql.exec("UPDATE agent_memory SET recordedAt = ?", Date.now() - 91 * 86400000);
    expect(await memory.recall(source().question)).toBe("");
  }));

  it("rejects malformed embeddings without storing a partial memory", () => inside(async (_, state) => {
    const ai = { run: async () => ({ data: [[NaN]] }) } as Ai;
    const memory = new AgentMemory(state.storage.sql, ai, () => true);
    await expect(memory.remember(source())).rejects.toThrow("Invalid embedding");
    expect(await memory.recall(source().question)).toBe("");
  }));

  it("indexes completed durable answers and excludes spawned agents at the actual agent hooks", () => inside(async (instance) => {
    const impl = instance["impl"];
    const previousAI = impl.env.WORKERS_AI;
    try {
      const { ai, run } = embeddings(); impl.env.WORKERS_AI = ai;
      impl.storage.chatMeta.put({ id: 1, title: "Release", started: new Date(), lastActive: new Date() });
      impl.storage.chats.put({ chatId: 1, sequence: 1, timestamp: new Date(Date.now() - 1000), type: "message",
        author: { type: "user", id: "owner", name: "Owner" }, message: source().question });
      impl.storage.chats.put({ chatId: 1, sequence: 2, timestamp: new Date(), type: "message",
        author: { type: "agent", id: "model", name: "Model" }, message: source().answer });
      // The first new question imports the prior completed turn even when its chat has a new user message.
      impl.storage.chats.put({ chatId: 1, sequence: 3, timestamp: new Date(Date.now() + 1000), type: "message",
        author: { type: "user", id: "owner", name: "Owner" }, message: "How do I deploy this again?" });
      expect(await impl.recallAgentMemory(2, source().question)).toContain(source().answer);
      impl.storage.chatContext.put({ chatId: 2, spawnerConfig: { displayName: "Isolated task", modelId: null, env: {} } });
      const count = run.mock.calls.length;
      expect(await impl.recallAgentMemory(2, source().question)).toBe("");
      await impl.rememberAgentTurn(2); expect(run).toHaveBeenCalledTimes(count);
      impl.storage.chats.delete(`${keyString(1)}.${keyString(2)}`);
      expect(await impl.recallAgentMemory(1, source().question)).toBe("");
    } finally { impl.env.WORKERS_AI = previousAI; }
  }));
});
