import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { MutationQueue } from "@gadgets/bundled-blueprints/libraries/sync/server";
import type { EventInput, EventPatch, PlannerEvent, PlannerSnapshot, PlannerStub, PlannerTask, TaskInput, TaskPatch, TaskPriority, TaskStatus } from "./lib/protocol.ts";

const STATUSES: TaskStatus[] = ["todo", "doing", "done"];
const PRIORITIES: TaskPriority[] = ["normal", "high", "urgent"];
const DATE = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// Leave room for structured-clone overhead under the 128 KiB KV-backed value limit.
const MAX_SNAPSHOT_BYTES = 96 * 1024;

function dueDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !DATE.test(value) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new TypeError("Due date must be a valid YYYY-MM-DD date or null.");
  }
  return value;
}

function eventDate(value: unknown): string {
  const date = dueDate(value);
  if (date === null) throw new TypeError("Event date is required.");
  return date;
}

function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) {
    throw new TypeError("Task title must be 1–200 characters.");
  }
  return value.trim();
}

function status(value: unknown): TaskStatus {
  if (!STATUSES.includes(value as TaskStatus)) throw new TypeError("Invalid task status.");
  return value as TaskStatus;
}

function priority(value: unknown): TaskPriority {
  if (!PRIORITIES.includes(value as TaskPriority)) throw new TypeError("Invalid task priority.");
  return value as TaskPriority;
}

function clock(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !TIME.test(value)) {
    throw new TypeError("Time must be HH:MM or null.");
  }
  return value;
}

function description(value: unknown): string {
  if (typeof value !== "string" || value.length > 4000) {
    throw new TypeError("Description must be at most 4000 characters.");
  }
  return value;
}

function order(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Invalid task order.");
  }
  return value;
}

export class Gadget extends DurableObject {
  private mutations = new MutationQueue();

  private async save(snapshot: PlannerSnapshot): Promise<void> {
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("Planner is full. Delete tasks or events before adding more.");
    }
    await this.ctx.storage.put("planner", snapshot);
  }

  async getTasks(): Promise<PlannerSnapshot> {
    return (await this.ctx.storage.get<PlannerSnapshot>("planner")) ?? { revision: 0, tasks: [], events: [] };
  }

  createTask(input: TaskInput): Promise<PlannerTask> {
    return this.mutations.run(async () => {
      if (!input || typeof input !== "object") throw new TypeError("Task is required.");
      const current = await this.getTasks();
      const nextStatus = input.status === undefined ? "todo" : status(input.status);
      const next: PlannerTask = {
        id: crypto.randomUUID(),
        title: title(input.title),
        description: input.description === undefined ? "" : description(input.description),
        status: nextStatus,
        dueDate: input.dueDate === undefined ? null : dueDate(input.dueDate),
        dueTime: input.dueTime === undefined ? null : clock(input.dueTime),
        priority: input.priority === undefined ? "normal" : priority(input.priority),
        order: Math.max(0, ...current.tasks.filter(task => task.status === nextStatus)
          .map(task => task.order + 1)),
      };
      await this.save({ ...current, revision: current.revision + 1, tasks: [...current.tasks, next] });
      return next;
    });
  }

  updateTask(id: string, patch: TaskPatch): Promise<PlannerTask> {
    return this.mutations.run(async () => {
      if (!patch || typeof patch !== "object") throw new TypeError("Task update is required.");
      const current = await this.getTasks();
      const index = current.tasks.findIndex(task => task.id === id);
      if (index < 0) throw new Error("Task not found.");
      const previous = current.tasks[index];
      const nextStatus = patch.status === undefined ? previous.status : status(patch.status);
      const next: PlannerTask = {
        ...previous,
        title: patch.title === undefined ? previous.title : title(patch.title),
        description: patch.description === undefined ? previous.description : description(patch.description),
        status: nextStatus,
        dueDate: patch.dueDate === undefined ? previous.dueDate : dueDate(patch.dueDate),
        dueTime: patch.dueTime === undefined ? previous.dueTime ?? null : clock(patch.dueTime),
        priority: patch.priority === undefined ? previous.priority ?? "normal" : priority(patch.priority),
        order: patch.order === undefined
          ? nextStatus === previous.status ? previous.order : Math.max(0,
            ...current.tasks.filter(task => task.status === nextStatus).map(task => task.order + 1))
          : order(patch.order),
      };
      const tasks = [...current.tasks];
      tasks[index] = next;
      await this.save({ ...current, revision: current.revision + 1, tasks });
      return next;
    });
  }

  deleteTask(id: string): Promise<boolean> {
    return this.mutations.run(async () => {
      const current = await this.getTasks();
      const tasks = current.tasks.filter(task => task.id !== id);
      if (tasks.length === current.tasks.length) return false;
      await this.save({ ...current, revision: current.revision + 1, tasks });
      return true;
    });
  }

  createEvent(input: EventInput): Promise<PlannerEvent> {
    return this.mutations.run(async () => {
      if (!input || typeof input !== "object") throw new TypeError("Event is required.");
      const event: PlannerEvent = {
        id: crypto.randomUUID(), title: title(input.title), date: eventDate(input.date),
        time: input.time === undefined ? null : clock(input.time),
        notes: input.notes === undefined ? "" : description(input.notes),
      };
      const current = await this.getTasks();
      await this.save({
        ...current, revision: current.revision + 1, events: [...current.events, event],
      });
      return event;
    });
  }

  updateEvent(id: string, patch: EventPatch): Promise<PlannerEvent> {
    return this.mutations.run(async () => {
      if (!patch || typeof patch !== "object") throw new TypeError("Event update is required.");
      const current = await this.getTasks();
      const index = current.events.findIndex(event => event.id === id);
      if (index < 0) throw new Error("Event not found.");
      const previous = current.events[index];
      const event: PlannerEvent = {
        ...previous,
        title: patch.title === undefined ? previous.title : title(patch.title),
        date: patch.date === undefined ? previous.date : eventDate(patch.date),
        time: patch.time === undefined ? previous.time ?? null : clock(patch.time),
        notes: patch.notes === undefined ? previous.notes : description(patch.notes),
      };
      const events = [...current.events];
      events[index] = event;
      await this.save({ ...current, revision: current.revision + 1, events });
      return event;
    });
  }

  deleteEvent(id: string): Promise<boolean> {
    return this.mutations.run(async () => {
      const current = await this.getTasks();
      const events = current.events.filter(event => event.id !== id);
      if (events.length === current.events.length) return false;
      await this.save({ ...current, revision: current.revision + 1, events });
      return true;
    });
  }
}

export class ExportHandler extends WorkerEntrypoint {
  getExportFormats() {
    return [{ id: "json", label: "JSON", mode: "server" as const,
      contentType: "application/json", fileExtension: ".json" }];
  }

  async export(gadget: PlannerStub, id: string): Promise<ReadableStream<Uint8Array>> {
    if (id !== "json") throw new Error("Unsupported planner export format.");
    return new Response(JSON.stringify(await gadget.getTasks(), null, 2)).body!;
  }
}
