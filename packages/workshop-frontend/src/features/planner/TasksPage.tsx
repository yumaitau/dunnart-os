import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useDocumentTitle } from "../../useDocumentTitle";
import {
  PRIORITY_LABEL,
  STATUS_LABEL,
  filterTasks,
  relativeDue,
  type DueFilter,
} from "./plannerCalendar";
import { TaskDialog, type EditorState } from "./TaskDialog";
import { usePlanner } from "./usePlanner";
import type { TaskStatus } from "./plannerTypes";
import "./planner.css";

const STATUSES: (TaskStatus | "all")[] = ["all", "todo", "doing", "done"];
const DUE: { id: DueFilter; label: string }[] = [
  { id: "all", label: "Any due date" },
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "overdue", label: "Overdue" },
];

export const TasksPage = () => {
  useDocumentTitle("Tasks");
  const planner = usePlanner();
  const [status, setStatus] = useState<TaskStatus | "all">("all");
  const [due, setDue] = useState<DueFilter>("all");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const tasks = filterTasks(planner.snapshot?.tasks ?? [], status, due);
  const heading = status === "all" && due === "all" ? "My tasks" : "Tasks";

  return (
    <div className="planner">
      <header className="planner-head">
        <div>
          <h1>Tasks</h1>
          <p className="sub">Open work, due dates, and priority in one list. Scheduled items also appear on the calendar.</p>
        </div>
        <div className="planner-actions">
          <Link to="/calendar" className="btn">Calendar</Link>
          <button type="button" className="btn primary" onClick={() => setEditor({ kind: "task", task: null, date: "", time: "" })}>
            New task
          </button>
        </div>
      </header>

      <div className="planner-filters" role="group" aria-label="Filter tasks">
        {STATUSES.map((value) => (
          <button key={value} type="button" className="btn" aria-pressed={status === value} onClick={() => setStatus(value)}>
            {value === "all" ? "All" : STATUS_LABEL[value]}
          </button>
        ))}
        <select aria-label="Due" value={due} onChange={(event) => setDue(event.target.value as DueFilter)}>
          {DUE.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </div>

      {planner.error && <p className="error" role="alert">{planner.error}</p>}

      <section className="card">
        <h2>{heading} ({tasks.length})</h2>
        {planner.loading ? (
          <p className="empty">Loading tasks…</p>
        ) : tasks.length === 0 ? (
          <div className="empty">
            <p>No tasks match the current filters.</p>
            <button type="button" className="btn" onClick={() => { setStatus("all"); setDue("all"); }}>Clear filters</button>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Due</th>
                  <th className="hide-sm">Priority</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr
                    key={task.id}
                    className="row"
                    onClick={() => setEditor({ kind: "task", task, date: task.dueDate ?? "", time: task.dueTime ?? "" })}
                  >
                    <td>
                      <div className="title">{task.title}</div>
                      {task.description && <div className="desc">{task.description}</div>}
                    </td>
                    <td><span className={`badge ${task.status}`}>{STATUS_LABEL[task.status]}</span></td>
                    <td>
                      <div>{task.dueDate ? new Date(`${task.dueDate}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—"}</div>
                      <div className="when">{task.dueTime ? `${task.dueTime} · ` : ""}{relativeDue(task.dueDate)}</div>
                    </td>
                    <td className="hide-sm">
                      <span className={`badge ${task.priority ?? "normal"}`}>{PRIORITY_LABEL[task.priority ?? "normal"]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <TaskDialog
        editor={editor}
        pending={planner.pending}
        onClose={() => setEditor(null)}
        onSaveTask={planner.saveTask}
        onDeleteTask={planner.deleteTask}
        onSaveEvent={planner.saveEvent}
        onDeleteEvent={planner.deleteEvent}
      />
    </div>
  );
};
