import type { EventInput, EventPatch, PlannerEvent, PlannerSnapshot, PlannerStub, PlannerTask, TaskInput, TaskPatch, TaskStatus } from "./lib/protocol.ts";

declare const gadget: PlannerStub;

const columns: { id: TaskStatus; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "doing", label: "In progress" },
  { id: "done", label: "Done" },
];
const today = new Date();
let month = new Date(today.getFullYear(), today.getMonth(), 1);
let view: "board" | "calendar" = "board";
let snapshot: PlannerSnapshot = { revision: 0, tasks: [], events: [] };
let editing: PlannerTask | null = null;
let request = 0;
let busy = false;

const style = document.createElement("style");
style.textContent = `
:root { color-scheme: light; font: 14px/1.45 system-ui, sans-serif; background: #fbf9f3; color: #26291f; }
* { box-sizing: border-box; }
body { margin: 0; }
button, input, textarea, select { font: inherit; }
button { cursor: pointer; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid #3a5a40; outline-offset: 2px; }
.app { min-height: 100vh; padding: clamp(16px, 3vw, 40px); max-width: 1500px; margin: auto; }
.top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
.eyebrow { color: #6f7264; text-transform: uppercase; letter-spacing: .14em; font-size: 10px; font-weight: 700; }
h1 { font: 400 clamp(29px, 4vw, 42px)/1.1 Georgia, serif; letter-spacing: -.04em; margin: 4px 0; }
.sub { color: #6f7264; margin: 0; }
.actions, .month-nav { display: flex; align-items: center; gap: 8px; }
.button, .tab { border: 1px solid #e5e2d5; border-radius: 10px; background: #fffdf6; color: #26291f; padding: 9px 13px; }
.button:hover, .tab:hover { background: #f4efe3; }
.primary, .tab[aria-pressed="true"] { border-color: #3a5a40; background: #3a5a40; color: white; }
.primary:hover { background: #2d4733; }
.tabs { display: flex; gap: 6px; margin-bottom: 18px; }
.board { display: grid; grid-template-columns: repeat(3, minmax(230px, 1fr)); gap: 14px; overflow-x: auto; }
.column { min-height: 300px; background: #f4efe3; border: 1px solid #e5e2d5; border-radius: 14px; padding: 14px; }
.column[data-over="true"] { outline: 2px solid #3a5a40; }
.column h2 { font-size: 14px; margin: 0 0 12px; display: flex; justify-content: space-between; }
.count { color: #6f7264; font-weight: 400; }
.card { background: #fffdf6; border: 1px solid #e5e2d5; border-radius: 10px; margin-bottom: 9px; padding: 12px; box-shadow: 0 2px 7px #26291f08; }
.card[draggable="true"] { cursor: grab; }
.card-title { display: block; border: 0; background: none; padding: 0; text-align: left; font-weight: 650; color: inherit; width: 100%; }
.card-title:hover { text-decoration: underline; }
.card-desc { color: #6f7264; font-size: 12px; margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.card-foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 10px; font-size: 11px; color: #6f7264; }
.card select { max-width: 130px; border: 1px solid #e5e2d5; border-radius: 7px; background: #fbf9f3; padding: 4px; color: #26291f; }
.empty { color: #6f7264; font-size: 12px; padding: 18px 4px; }
.calendar { background: #fffdf6; border: 1px solid #e5e2d5; border-radius: 14px; overflow: hidden; }
.calendar-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px; }
.calendar h2 { font: 400 22px Georgia, serif; margin: 0; }
.grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
.weekday { text-align: center; font-size: 11px; color: #6f7264; padding: 9px; border-top: 1px solid #e5e2d5; }
.day { min-height: 110px; padding: 7px; border-top: 1px solid #e5e2d5; border-right: 1px solid #e5e2d5; min-width: 0; }
.day:nth-child(7n) { border-right: 0; }
.day.outside { background: #f7f4ed; }
.date { font-size: 11px; color: #6f7264; border: 0; background: none; padding: 2px; min-width: 22px; }
.day.current .date { display: inline-block; background: #3a5a40; color: white; border-radius: 50%; width: 22px; height: 22px; text-align: center; line-height: 22px; }
.event { border: 0; border-radius: 6px; background: #dce8d8; color: #263d2c; display: block; width: 100%; text-align: left; margin-top: 4px; padding: 4px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
.event.appointment { background: #f0d98a; color: #26291f; }
.event.done { text-decoration: line-through; opacity: .6; }
dialog { border: 1px solid #e5e2d5; border-radius: 14px; background: #fffdf6; color: #26291f; padding: 22px; width: min(430px, calc(100vw - 32px)); box-shadow: 0 18px 45px #26291f30; }
dialog::backdrop { background: #26291f88; }
dialog h2 { font: 400 25px Georgia, serif; margin: 0 0 16px; }
dialog label { display: block; font-weight: 600; font-size: 12px; margin-bottom: 12px; }
dialog input, dialog textarea, dialog select { display: block; width: 100%; border: 1px solid #d7d4c7; border-radius: 8px; background: white; color: #26291f; padding: 9px; margin-top: 5px; }
dialog textarea { min-height: 95px; resize: vertical; }
.form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }
.delete { color: #9e352b; margin-right: auto; }
.message { min-height: 20px; color: #9e352b; font-size: 12px; }
@media (max-width: 760px) { .board { grid-template-columns: repeat(3, minmax(230px, 75vw)); } .day { min-height: 75px; padding: 3px; } .calendar-head { flex-wrap: wrap; } .event { font-size: 10px; } }
@media print { :root { background: white; } .app { max-width: none; padding: 0; } .top > button, .tabs, .month-nav, .column > button { display: none; } .board { overflow: visible; } .column, .calendar, .card { break-inside: avoid; box-shadow: none; } .event { white-space: normal; } }
`;
document.head.append(style);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text: string, action: () => void, className = "button"): HTMLButtonElement {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}
function key(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
const root = el("main", "app");
document.body.replaceChildren(root);
const dialog = el("dialog");
document.body.append(dialog);
const announcement = el("div");
announcement.setAttribute("role", "status");
announcement.setAttribute("aria-live", "polite");
announcement.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)";
document.body.append(announcement);

async function refresh(): Promise<void> {
  const current = ++request;
  try {
    const result = await gadget.getTasks();
    if (current !== request) return;
    if (result.revision !== snapshot.revision) {
      snapshot = result;
      render();
    }
  } catch (error) {
    announcement.textContent = error instanceof Error ? error.message : "Could not load tasks.";
  }
}

async function mutate(action: () => Promise<unknown>): Promise<boolean> {
  if (busy) return false;
  busy = true;
  try {
    await action();
    const result = await gadget.getTasks();
    ++request;
    snapshot = result;
    render();
    announcement.textContent = "Planner saved.";
    return true;
  } catch (error) {
    announcement.textContent = error instanceof Error ? error.message : "Could not save task.";
    const message = dialog.querySelector(".message");
    if (message) message.textContent = announcement.textContent;
    return false;
  } finally {
    busy = false;
  }
}

function openEditor(task: PlannerTask | null = null, date: string | null = null, status: TaskStatus = "todo"): void {
  editing = task;
  dialog.replaceChildren();
  dialog.append(el("h2", "", task ? "Edit task" : "New task"));
  const form = el("form");
  const titleLabel = el("label", "", "Title");
  const titleInput = el("input");
  titleInput.name = "title";
  titleInput.required = true;
  titleInput.maxLength = 200;
  titleInput.value = task?.title ?? "";
  titleLabel.append(titleInput);
  const descLabel = el("label", "", "Description");
  const descInput = el("textarea");
  descInput.maxLength = 4000;
  descInput.value = task?.description ?? "";
  descLabel.append(descInput);
  const dateLabel = el("label", "", "Due date");
  const dateInput = el("input");
  dateInput.type = "date";
  dateInput.value = task?.dueDate ?? date ?? "";
  dateLabel.append(dateInput);
  const statusLabel = el("label", "", "Column");
  const statusInput = el("select");
  for (const column of columns) {
    const option = el("option", "", column.label);
    option.value = column.id;
    statusInput.append(option);
  }
  statusInput.value = task?.status ?? status;
  statusLabel.append(statusInput);
  const message = el("p", "message");
  message.setAttribute("role", "alert");
  const actions = el("div", "form-actions");
  if (task) actions.append(button("Delete", async () => {
    if (await mutate(() => gadget.deleteTask(task.id))) dialog.close();
  }, "button delete"));
  actions.append(button("Cancel", () => dialog.close()));
  const save = el("button", "button primary", "Save task");
  save.type = "submit";
  actions.append(save);
  form.append(titleLabel, descLabel, dateLabel, statusLabel, message, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input: TaskInput = {
      title: titleInput.value,
      description: descInput.value,
      dueDate: dateInput.value || null,
      status: statusInput.value as TaskStatus,
    };
    const saved = await mutate(() => editing
      ? gadget.updateTask(editing.id, input as TaskPatch)
      : gadget.createTask(input));
    if (saved) dialog.close();
  });
  dialog.append(form);
  dialog.showModal();
  titleInput.focus();
}

function openEvent(event: PlannerEvent | null = null, date = key(today)): void {
  dialog.replaceChildren(el("h2", "", event ? "Edit event" : "New event"));
  const form = el("form");
  const titleLabel = el("label", "", "Title");
  const titleInput = el("input");
  titleInput.required = true;
  titleInput.maxLength = 200;
  titleInput.value = event?.title ?? "";
  titleLabel.append(titleInput);
  const dateLabel = el("label", "", "Date");
  const dateInput = el("input");
  dateInput.type = "date";
  dateInput.required = true;
  dateInput.value = event?.date ?? date;
  dateLabel.append(dateInput);
  const notesLabel = el("label", "", "Notes");
  const notesInput = el("textarea");
  notesInput.maxLength = 4000;
  notesInput.value = event?.notes ?? "";
  notesLabel.append(notesInput);
  const message = el("p", "message");
  message.setAttribute("role", "alert");
  const actions = el("div", "form-actions");
  if (event) actions.append(button("Delete", async () => {
    if (await mutate(() => gadget.deleteEvent(event.id))) dialog.close();
  }, "button delete"));
  actions.append(button("Cancel", () => dialog.close()));
  const save = el("button", "button primary", "Save event");
  save.type = "submit";
  actions.append(save);
  form.append(titleLabel, dateLabel, notesLabel, message, actions);
  form.addEventListener("submit", async (submit) => {
    submit.preventDefault();
    const input: EventInput = { title: titleInput.value, date: dateInput.value, notes: notesInput.value };
    const saved = await mutate(() => event
      ? gadget.updateEvent(event.id, input as EventPatch)
      : gadget.createEvent(input));
    if (saved) dialog.close();
  });
  dialog.append(form);
  dialog.showModal();
  titleInput.focus();
}

function taskCard(task: PlannerTask): HTMLElement {
  const card = el("article", "card");
  card.draggable = true;
  card.addEventListener("dragstart", event => event.dataTransfer?.setData("text/plain", task.id));
  card.append(button(task.title, () => openEditor(task), "card-title"));
  if (task.description) card.append(el("p", "card-desc", task.description));
  const foot = el("div", "card-foot");
  foot.append(el("span", "", task.dueDate ? `Due ${task.dueDate}` : "No due date"));
  const select = el("select");
  select.setAttribute("aria-label", `Move ${task.title} to column`);
  for (const column of columns) {
    const option = el("option", "", column.label);
    option.value = column.id;
    select.append(option);
  }
  select.value = task.status;
  select.addEventListener("change", () => void mutate(() => gadget.updateTask(task.id, { status: select.value as TaskStatus })));
  foot.append(select);
  card.append(foot);
  return card;
}

function renderBoard(): HTMLElement {
  const board = el("div", "board");
  for (const column of columns) {
    const tasks = snapshot.tasks.filter(task => task.status === column.id).sort((a, b) => a.order - b.order);
    const container = el("section", "column");
    const heading = el("h2", "", column.label);
    heading.append(el("span", "count", String(tasks.length)));
    container.append(heading);
    container.addEventListener("dragover", event => { event.preventDefault(); container.dataset.over = "true"; });
    container.addEventListener("dragleave", () => { delete container.dataset.over; });
    container.addEventListener("drop", event => {
      event.preventDefault();
      delete container.dataset.over;
      const id = event.dataTransfer?.getData("text/plain");
      const task = snapshot.tasks.find(item => item.id === id);
      if (task && task.status !== column.id) void mutate(() => gadget.updateTask(id!, { status: column.id, order: tasks.length }));
    });
    if (!tasks.length) container.append(el("p", "empty", "No tasks yet"));
    for (const task of tasks) container.append(taskCard(task));
    container.append(button("+ Add task", () => openEditor(null, null, column.id)));
    board.append(container);
  }
  return board;
}

function renderCalendar(): HTMLElement {
  const calendar = el("section", "calendar");
  const head = el("div", "calendar-head");
  head.append(el("h2", "", month.toLocaleDateString(undefined, { month: "long", year: "numeric" })));
  const nav = el("div", "month-nav");
  nav.append(
    button("Previous month", () => { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); render(); }),
    button("Today", () => { month = new Date(today.getFullYear(), today.getMonth(), 1); render(); }),
    button("Next month", () => { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); render(); }),
  );
  head.append(nav);
  calendar.append(head);
  const grid = el("div", "grid");
  for (const day of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) grid.append(el("div", "weekday", day));
  const start = new Date(month.getFullYear(), month.getMonth(), 1 - month.getDay());
  const slots = Math.ceil((month.getDay() + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7) * 7;
  for (let i = 0; i < slots; i++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const dateKey = key(date);
    const day = el("div", "day" + (date.getMonth() !== month.getMonth() ? " outside" : "") + (dateKey === key(today) ? " current" : ""));
    day.append(button(String(date.getDate()), () => openEvent(null, dateKey), "button date"));
    for (const event of snapshot.events.filter(item => item.date === dateKey)) {
      day.append(button(event.title, () => openEvent(event), "event appointment"));
    }
    for (const task of snapshot.tasks.filter(item => item.dueDate === dateKey)) {
      day.append(button(task.title, () => openEditor(task), "event" + (task.status === "done" ? " done" : "")));
    }
    grid.append(day);
  }
  calendar.append(grid);
  return calendar;
}

function render(): void {
  root.replaceChildren();
  const header = el("header", "top");
  const title = el("div");
  title.append(el("div", "eyebrow", "Dunnart · by Yuma IT"), el("h1", "", "Planner"),
    el("p", "sub", "Work in motion, deadlines in sight."));
  header.append(title, view === "board"
    ? button("+ New task", () => openEditor(), "button primary")
    : button("+ New event", () => openEvent(), "button primary"));
  root.append(header);
  const tabs = el("div", "tabs");
  tabs.setAttribute("role", "group");
  tabs.setAttribute("aria-label", "Planner view");
  for (const [name, label] of [["board", "Board"], ["calendar", "Calendar"]] as const) {
    const tab = button(label, () => { view = name; render(); }, "tab");
    tab.setAttribute("aria-pressed", String(view === name));
    tabs.append(tab);
  }
  root.append(tabs, view === "board" ? renderBoard() : renderCalendar());
}

render();
void refresh();
window.setInterval(() => { if (!document.hidden && !busy) void refresh(); }, 10000);
