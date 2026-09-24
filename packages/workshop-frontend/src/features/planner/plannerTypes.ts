export type TaskStatus = "todo" | "doing" | "done";
export type TaskPriority = "normal" | "high" | "urgent";

export type PlannerTask = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  dueDate: string | null;
  dueTime?: string | null;
  priority?: TaskPriority;
  order: number;
};

export type PlannerEvent = {
  id: string;
  title: string;
  date: string;
  time?: string | null;
  notes: string;
};

export type PlannerSnapshot = {
  revision: number;
  tasks: PlannerTask[];
  events: PlannerEvent[];
};

export type TaskInput = {
  title: string;
  description?: string;
  status?: TaskStatus;
  dueDate?: string | null;
  dueTime?: string | null;
  priority?: TaskPriority;
};

export type EventInput = {
  title: string;
  date: string;
  time?: string | null;
  notes?: string;
};

/** The gadget methods the planner pages call through connectToGadget(). */
export type PlannerApi = {
  getTasks(): Promise<PlannerSnapshot>;
  createTask(input: TaskInput): Promise<PlannerTask>;
  updateTask(id: string, patch: TaskInput): Promise<PlannerTask>;
  deleteTask(id: string): Promise<boolean>;
  createEvent(input: EventInput): Promise<PlannerEvent>;
  updateEvent(id: string, patch: EventInput): Promise<PlannerEvent>;
  deleteEvent(id: string): Promise<boolean>;
};
