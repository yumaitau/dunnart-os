import { createFileRoute } from "@tanstack/react-router";
import { CalendarPage } from "../features/planner/CalendarPage";

export const Route = createFileRoute("/calendar")({
  component: CalendarPage,
});
