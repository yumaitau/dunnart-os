import { useEffect, useId, useRef } from "react";
import type { PlannerEvent, PlannerTask, TaskPriority, TaskStatus } from "./plannerTypes";

export type EditorState =
  | { kind: "task"; task: PlannerTask | null; date: string; time: string }
  | { kind: "event"; event: PlannerEvent | null; date: string; time: string };

type Props = {
  editor: EditorState | null;
  pending: boolean;
  onClose: () => void;
  onSaveTask: (input: {
    title: string;
    description: string;
    status: TaskStatus;
    dueDate: string | null;
    dueTime: string | null;
    priority: TaskPriority;
  }, id?: string) => Promise<boolean>;
  onDeleteTask: (id: string) => Promise<boolean>;
  onSaveEvent: (input: { title: string; date: string; time: string | null; notes: string }, id?: string) => Promise<boolean>;
  onDeleteEvent: (id: string) => Promise<boolean>;
};

export const TaskDialog = ({
  editor,
  pending,
  onClose,
  onSaveTask,
  onDeleteTask,
  onSaveEvent,
  onDeleteEvent,
}: Props) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (editor && !dialog.open) dialog.showModal();
    if (!editor && dialog.open) dialog.close();
  }, [editor]);

  if (!editor) return <dialog ref={ref} />;

  const heading = editor.kind === "task"
    ? (editor.task ? "Task details" : "New task")
    : (editor.event ? "Event details" : "New event");

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <h2 id={titleId}>{heading}</h2>
      {editor.kind === "task" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const dueDate = String(data.get("dueDate") ?? "");
            const dueTime = String(data.get("dueTime") ?? "");
            void onSaveTask({
              title: String(data.get("title") ?? ""),
              description: String(data.get("description") ?? ""),
              status: String(data.get("status") ?? "todo") as TaskStatus,
              priority: String(data.get("priority") ?? "normal") as TaskPriority,
              dueDate: dueDate || null,
              dueTime: dueDate && dueTime ? dueTime : null,
            }, editor.task?.id).then((saved) => { if (saved) onClose(); });
          }}
        >
          <label>
            Title
            <input name="title" required maxLength={200} defaultValue={editor.task?.title ?? ""} autoFocus />
          </label>
          <label>
            Description
            <textarea name="description" maxLength={4000} defaultValue={editor.task?.description ?? ""} placeholder="What needs doing." />
          </label>
          <div className="grid-2">
            <label>
              Due date
              <input name="dueDate" type="date" defaultValue={editor.task?.dueDate ?? editor.date} />
            </label>
            <label>
              Due time
              <input name="dueTime" type="time" defaultValue={editor.task?.dueTime ?? editor.time} />
            </label>
            <label>
              Status
              <select name="status" defaultValue={editor.task?.status ?? "todo"}>
                <option value="todo">Open</option>
                <option value="doing">In progress</option>
                <option value="done">Done</option>
              </select>
            </label>
            <label>
              Priority
              <select name="priority" defaultValue={editor.task?.priority ?? "normal"}>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
          </div>
          <div className="form-actions">
            {editor.task && (
              <button
                type="button"
                className="btn delete"
                disabled={pending}
                onClick={() => { void onDeleteTask(editor.task!.id).then((saved) => { if (saved) onClose(); }); }}
              >
                Delete
              </button>
            )}
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={pending}>{pending ? "Saving…" : "Save task"}</button>
          </div>
        </form>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const time = String(data.get("time") ?? "");
            void onSaveEvent({
              title: String(data.get("title") ?? ""),
              date: String(data.get("date") ?? ""),
              time: time || null,
              notes: String(data.get("notes") ?? ""),
            }, editor.event?.id).then((saved) => { if (saved) onClose(); });
          }}
        >
          <label>
            Title
            <input name="title" required maxLength={200} defaultValue={editor.event?.title ?? ""} autoFocus />
          </label>
          <div className="grid-2">
            <label>
              Date
              <input name="date" type="date" required defaultValue={editor.event?.date ?? editor.date} />
            </label>
            <label>
              Time
              <input name="time" type="time" defaultValue={editor.event?.time ?? editor.time} />
            </label>
          </div>
          <label>
            Notes
            <textarea name="notes" maxLength={4000} defaultValue={editor.event?.notes ?? ""} />
          </label>
          <div className="form-actions">
            {editor.event && (
              <button
                type="button"
                className="btn delete"
                disabled={pending}
                onClick={() => { void onDeleteEvent(editor.event!.id).then((saved) => { if (saved) onClose(); }); }}
              >
                Delete
              </button>
            )}
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn primary" disabled={pending}>{pending ? "Saving…" : "Save event"}</button>
          </div>
        </form>
      )}
    </dialog>
  );
};
