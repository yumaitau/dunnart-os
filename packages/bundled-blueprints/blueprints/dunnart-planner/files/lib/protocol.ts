export type TaskStatus = "todo" | "doing" | "done";

export interface PlannerTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  dueDate: string | null;
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
  notes: string;
}

export interface EventInput {
  title: string;
  date: string;
  notes?: string;
}

export interface EventPatch {
  title?: string;
  date?: string;
  notes?: string;
}

export interface TaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  dueDate?: string | null;
}

export interface TaskPatch {
  title?: string;
  description?: string;
  status?: TaskStatus;
  dueDate?: string | null;
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
