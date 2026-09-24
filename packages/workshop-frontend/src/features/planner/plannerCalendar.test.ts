import { expect, it } from "vitest";
import {
  calendarItems,
  filterTasks,
  rangeTitle,
  startOfWeek,
  timeFromOffset,
} from "./plannerCalendar";
import type { PlannerTask } from "./plannerTypes";

const today = new Date(2026, 8, 24);

function task(patch: Partial<PlannerTask> & Pick<PlannerTask, "id" | "title">): PlannerTask {
  return {
    description: "",
    status: "todo",
    dueDate: null,
    order: 0,
    ...patch,
  };
}

it("starts the week on Monday", () => {
  expect(startOfWeek(today).getDate()).toBe(21);
});

it("titles a week the way a calendar toolbar does", () => {
  expect(rangeTitle("week", today)).toMatch(/21/);
  expect(rangeTitle("week", today)).toMatch(/2026/);
});

it("snaps a click in the time grid to a half hour", () => {
  expect(timeFromOffset(0)).toBe("05:00");
  expect(timeFromOffset(48)).toBe("06:00");
});

it("hides done tasks from the overdue filter and keeps today's open work", () => {
  const tasks = [
    task({ id: "a", title: "Late", dueDate: "2026-09-20", status: "todo" }),
    task({ id: "b", title: "Finished late", dueDate: "2026-09-20", status: "done" }),
    task({ id: "c", title: "Today", dueDate: "2026-09-24", status: "doing" }),
  ];
  expect(filterTasks(tasks, "all", "overdue", today).map((item) => item.id)).toEqual(["a"]);
  expect(filterTasks(tasks, "doing", "today", today).map((item) => item.id)).toEqual(["c"]);
});

it("places timed tasks and all-day events on the same day", () => {
  const items = calendarItems(
    [task({ id: "t", title: "Bore check", dueDate: "2026-09-24", dueTime: "09:30", priority: "urgent" })],
    [{ id: "e", title: "Standup", date: "2026-09-24", time: null, notes: "" }],
  );
  expect(items.map((item) => item.title)).toEqual(["Bore check", "Standup"]);
  expect(items[0]).toMatchObject({ kind: "task", time: "09:30", priority: "urgent" });
});
