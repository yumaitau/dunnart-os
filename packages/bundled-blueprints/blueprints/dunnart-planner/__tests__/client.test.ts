import { afterEach, expect, it, vi } from "vitest";
import type { EventInput, PlannerSnapshot, TaskInput } from "../files/lib/protocol.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal;
  delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close;
  document.body.replaceChildren();
});

it("shows board tasks and new events together on the calendar", async () => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.open = false; } });
  vi.spyOn(window, "setInterval").mockImplementation(() => 0 as unknown as ReturnType<typeof setInterval>);
  let state: PlannerSnapshot = { revision: 0, tasks: [], events: [] };
  vi.stubGlobal("gadget", {
    getTasks: async () => state,
    createTask: async (input: TaskInput) => {
      const task = { ...input, description: input.description ?? "", status: input.status ?? "todo",
        dueDate: input.dueDate ?? null, id: "t1", order: 0 };
      state = { ...state, revision: state.revision + 1, tasks: [task] };
      return task;
    },
    createEvent: async (input: EventInput) => {
      const event = { ...input, id: "e1", notes: input.notes ?? "" };
      state = { ...state, revision: state.revision + 1, events: [event] };
      return event;
    },
  });
  await import("../files/client.ts");
  const due = new Date();
  due.setDate(Math.min(due.getDate() + 1, 28));
  const dueDate = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
  document.querySelector<HTMLButtonElement>(".top .primary")!.click();
  const form = document.querySelector<HTMLFormElement>("dialog form")!;
  form.querySelector<HTMLInputElement>('input[name="title"]')!.value = "Ship release";
  form.querySelector<HTMLInputElement>('input[type="date"]')!.value = dueDate;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector(".card-title")?.textContent).toBe("Ship release"));
  document.querySelectorAll<HTMLButtonElement>(".tabs button")[1]!.click();
  expect(document.querySelector(".event")?.textContent).toBe("Ship release");
  document.querySelector<HTMLButtonElement>(".top .primary")!.click();
  const eventForm = document.querySelector<HTMLFormElement>("dialog form")!;
  eventForm.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')!.value = "Team review";
  eventForm.querySelector<HTMLInputElement>('input[type="date"]')!.value = dueDate;
  eventForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(document.querySelector(".appointment")?.textContent).toBe("Team review"));
  expect(document.querySelectorAll(".event")).toHaveLength(2);
});
