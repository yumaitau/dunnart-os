import { createFileRoute } from "@tanstack/react-router";
import { TasksPage } from "../features/planner/TasksPage";

export const Route = createFileRoute("/tasks")({
  component: TasksPage,
});
