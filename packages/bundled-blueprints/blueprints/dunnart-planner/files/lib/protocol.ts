export type TaskStatus = "todo" | "doing" | "done";

/** How urgently a task should read on the board and calendar. Absent means normal. */
export type TaskPriority = "normal" | "high" | "urgent";

export interface PlannerTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  dueDate: string | null;
  /** Local clock time `HH:MM`. Absent or null means the task is all-day on its due date. */
  dueTime?: string | null;
  priority?: TaskPriority;
  order: number;
}

export interface PlannerSnapshot {
  revision: number;
  tasks: PlannerTask[];
  events: PlannerEvent[];
}

export interface PlannerEvent {
  id: string;
  title: string;
  date: string;
  /** Local clock time `HH:MM`. Absent or null means the event lasts all day. */
  time?: string | null;
  notes: string;
}

export interface EventInput {
  title: string;
  date: string;
  time?: string | null;
  notes?: string;
}

export interface EventPatch {
  title?: string;
  date?: string;
  time?: string | null;
  notes?: string;
}

export interface TaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  dueDate?: string | null;
  dueTime?: string | null;
  priority?: TaskPriority;
}

export interface TaskPatch {
  title?: string;
  description?: string;
  status?: TaskStatus;
  dueDate?: string | null;
  dueTime?: string | null;
  priority?: TaskPriority;
  order?: number;
}

export interface PlannerStub {
  getTasks(): Promise<PlannerSnapshot>;
  createTask(input: TaskInput): Promise<PlannerTask>;
  updateTask(id: string, patch: TaskPatch): Promise<PlannerTask>;
  deleteTask(id: string): Promise<boolean>;
  createEvent(input: EventInput): Promise<PlannerEvent>;
  updateEvent(id: string, patch: EventPatch): Promise<PlannerEvent>;
  deleteEvent(id: string): Promise<boolean>;
}
