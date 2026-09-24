// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ExportHandler, Gadget } from "../files/server.ts";

function planner() {
  const stored = new Map<string, unknown>();
  const state = {
    storage: {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => { stored.set(key, value); },
    },
  } as unknown as DurableObjectState;
  return new Gadget(state, {});
}

describe("Dunnart Planner", () => {
  it("keeps board status and calendar due date on the same task", async () => {
    const gadget = planner();
    const task = await gadget.createTask({ title: "  Ship planner  ", dueDate: "2026-09-30" });
    expect(task).toMatchObject({ title: "Ship planner", status: "todo", dueDate: "2026-09-30" });
    await gadget.updateTask(task.id, { status: "doing", dueDate: "2026-10-01" });
    expect((await gadget.getTasks()).tasks).toMatchObject([
      { id: task.id, status: "doing", dueDate: "2026-10-01" },
    ]);
    expect(await gadget.deleteTask(task.id)).toBe(true);
    expect((await gadget.getTasks()).tasks).toEqual([]);
  });

  it("keeps events when tasks change and allows an agent to reschedule", async () => {
    const gadget = planner();
    const event = await gadget.createEvent({ title: "Review", date: "2026-09-30" });
    const task = await gadget.createTask({ title: "Prepare" });
    await gadget.updateTask(task.id, { status: "done" });
    await gadget.updateEvent(event.id, { date: "2026-10-02" });
    expect((await gadget.getTasks()).events).toMatchObject([{ id: event.id, date: "2026-10-02" }]);
    await expect(gadget.createEvent({ title: "Invalid", date: "2026-02-30" })).rejects.toThrow();
    expect(await gadget.deleteEvent(event.id)).toBe(true);
    expect((await gadget.getTasks()).tasks).toHaveLength(1);
  });

  it("serializes overlapping creates without losing either task", async () => {
    const gadget = planner();
    await Promise.all([
      gadget.createTask({ title: "First" }),
      gadget.createTask({ title: "Second" }),
    ]);
    const result = await gadget.getTasks();
    expect(result.revision).toBe(2);
    expect(result.tasks.map(task => task.title)).toEqual(["First", "Second"]);
  });

  it("rejects invalid dates and statuses before writing", async () => {
    const gadget = planner();
    await expect(gadget.createTask({ title: "Impossible", dueDate: "2026-02-30" })).rejects.toThrow();
    await expect(gadget.createTask({ title: "Wrong", status: "blocked" as "todo" })).rejects.toThrow();
    expect((await gadget.getTasks()).revision).toBe(0);
  });

  it("rejects an oversized snapshot without losing saved events", async () => {
    const gadget = planner();
    let rejected = false;
    for (let i = 0; i < 30; i++) {
      try {
        await gadget.createEvent({ title: `Event ${i}`, date: "2026-09-30", notes: "x".repeat(4000) });
      } catch (error) {
        expect(error).toBeInstanceOf(RangeError);
        expect((error as Error).message).toMatch(/Planner is full/);
        rejected = true;
        break;
      }
    }
    expect(rejected).toBe(true);
    const snapshot = await gadget.getTasks();
    expect(snapshot.events.length).toBeGreaterThan(0);
    expect(snapshot.events.length).toBeLessThan(30);
    expect(snapshot.revision).toBe(snapshot.events.length);
  });

  it("exports current planner data without browser-only state", async () => {
    const gadget = planner();
    await gadget.createTask({ title: "Shared task", dueDate: "2026-09-30" });
    const handler = Object.create(ExportHandler.prototype) as ExportHandler;
    const stream = await handler.export(gadget, "json");
    const exported = JSON.parse(await new Response(stream).text());
    expect(exported.tasks).toMatchObject([{ title: "Shared task", dueDate: "2026-09-30" }]);
  });
});
