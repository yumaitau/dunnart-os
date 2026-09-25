import type { PlannerEvent, PlannerTask, TaskPriority, TaskStatus } from "./plannerTypes";

export const DAY_START_HOUR = 5;
export const DAY_END_HOUR = 20;
export const HOUR_HEIGHT = 48;

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "Open",
  doing: "In progress",
  done: "Done",
};

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export type CalendarView = "week" | "day" | "month" | "list";

export type CalendarItem = {
  id: string;
  kind: "task" | "event";
  title: string;
  date: string;
  time: string | null;
  done: boolean;
  priority: TaskPriority;
  task?: PlannerTask;
  event?: PlannerEvent;
};

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function parseDateKey(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Monday-start week for the Australian locale. */
export function startOfWeek(date: Date): Date {
  const day = date.getDay();
  const delta = day === 0 ? -6 : 1 - day;
  return addDays(new Date(date.getFullYear(), date.getMonth(), date.getDate()), delta);
}

export function formatDay(date: Date): string {
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

export function formatLong(date: Date): string {
  return date.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export function rangeTitle(view: CalendarView, anchor: Date): string {
  if (view === "day") return formatLong(anchor);
  if (view === "month") return anchor.toLocaleDateString("en-AU", { month: "long", year: "numeric" });
  const start = startOfWeek(anchor);
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const startLabel = start.toLocaleDateString("en-AU", { day: "numeric", month: sameMonth ? undefined : "short" });
  const endLabel = end.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  return `${startLabel} – ${endLabel}`;
}

export function shiftAnchor(view: CalendarView, anchor: Date, direction: -1 | 1): Date {
  if (view === "day" || view === "list") return addDays(anchor, direction);
  if (view === "week") return addDays(anchor, direction * 7);
  return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
}

export function visibleDays(view: CalendarView, anchor: Date): Date[] {
  if (view === "day") return [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())];
  if (view === "month") {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const start = startOfWeek(first);
    const slots = Math.ceil((first.getDay() === 0 ? 6 : first.getDay() - 1 + new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate()) / 7) * 7;
    return Array.from({ length: slots }, (_, index) => addDays(start, index));
  }
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

export function taskPriority(task: PlannerTask): TaskPriority {
  return task.priority ?? "normal";
}

export function calendarItems(tasks: PlannerTask[], events: PlannerEvent[]): CalendarItem[] {
  const fromTasks = tasks
    .filter((task) => task.dueDate)
    .map((task): CalendarItem => ({
      id: task.id,
      kind: "task",
      title: task.title,
      date: task.dueDate!,
      time: task.dueTime || null,
      done: task.status === "done",
      priority: taskPriority(task),
      task,
    }));
  const fromEvents = events.map((event): CalendarItem => ({
    id: event.id,
    kind: "event",
    title: event.title,
    date: event.date,
    time: event.time || null,
    done: false,
    priority: "normal",
    event,
  }));
  return [...fromTasks, ...fromEvents].toSorted((a, b) => {
    const time = (a.time ?? "99:99").localeCompare(b.time ?? "99:99");
    return time || a.title.localeCompare(b.title);
  });
}

export function itemsOn(items: CalendarItem[], key: string): CalendarItem[] {
  return items.filter((item) => item.date === key);
}

export function minutesFromMidnight(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

export function topForTime(time: string): number {
  return ((minutesFromMidnight(time) - DAY_START_HOUR * 60) / 60) * HOUR_HEIGHT;
}

export function timeFromOffset(offsetY: number): string {
  const minutes = DAY_START_HOUR * 60 + Math.max(0, Math.round(offsetY / HOUR_HEIGHT * 2) * 30);
  const clamped = Math.min(minutes, DAY_END_HOUR * 60 - 30);
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}

export function formatClock(time: string): string {
  const [hour, minute] = time.split(":").map(Number);
  const period = hour >= 12 ? "pm" : "am";
  const hour12 = hour % 12 || 12;
  return minute === 0 ? `${hour12}${period}` : `${hour12}:${String(minute).padStart(2, "0")}${period}`;
}

export type DueFilter = "all" | "today" | "week" | "overdue";

export function filterTasks(
  tasks: PlannerTask[],
  status: TaskStatus | "all",
  due: DueFilter,
  today = new Date(),
): PlannerTask[] {
  const todayKey = dateKey(today);
  const weekEnd = dateKey(addDays(startOfWeek(today), 6));
  return tasks
    .filter((task) => status === "all" || task.status === status)
    .filter((task) => {
      if (due === "all") return true;
      if (!task.dueDate) return false;
      if (due === "today") return task.dueDate === todayKey;
      if (due === "week") return task.dueDate >= todayKey && task.dueDate <= weekEnd;
      return task.dueDate < todayKey && task.status !== "done";
    })
    .toSorted((a, b) => {
      const date = (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");
      if (date) return date;
      return PRIORITY_RANK[taskPriority(b)] - PRIORITY_RANK[taskPriority(a)];
    });
}

const PRIORITY_RANK: Record<TaskPriority, number> = { normal: 0, high: 1, urgent: 2 };

export function relativeDue(dueDate: string | null, today = new Date()): string {
  if (!dueDate) return "No due date";
  const due = parseDateKey(dueDate);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((due.getTime() - start.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1 && days < 7) return `in ${days} days`;
  if (days < 0 && days > -7) return `${Math.abs(days)} days ago`;
  return due.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}
