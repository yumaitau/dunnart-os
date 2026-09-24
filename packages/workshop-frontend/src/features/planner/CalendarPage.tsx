import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useDocumentTitle } from "../../useDocumentTitle";
import {
  DAY_END_HOUR,
  DAY_START_HOUR,
  HOUR_HEIGHT,
  calendarItems,
  dateKey,
  formatClock,
  itemsOn,
  rangeTitle,
  shiftAnchor,
  timeFromOffset,
  topForTime,
  visibleDays,
  type CalendarItem,
  type CalendarView,
} from "./plannerCalendar";
import { TaskDialog, type EditorState } from "./TaskDialog";
import { usePlanner } from "./usePlanner";
import "./planner.css";

const VIEWS: { id: CalendarView; label: string }[] = [
  { id: "month", label: "Month" },
  { id: "week", label: "Week" },
  { id: "day", label: "Day" },
  { id: "list", label: "List" },
];

const HOURS = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, index) => DAY_START_HOUR + index);

export const CalendarPage = () => {
  useDocumentTitle("Calendar");
  const planner = usePlanner();
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [editor, setEditor] = useState<EditorState | null>(null);
  const today = dateKey(new Date());
  const items = calendarItems(planner.snapshot?.tasks ?? [], planner.snapshot?.events ?? []);
  const days = visibleDays(view, anchor);
  const now = new Date();
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) - DAY_START_HOUR * 60) / 60 * HOUR_HEIGHT;
  const showNow = now.getHours() >= DAY_START_HOUR && now.getHours() < DAY_END_HOUR;

  const openItem = (item: CalendarItem) => {
    if (item.task) setEditor({ kind: "task", task: item.task, date: item.date, time: item.time ?? "" });
    if (item.event) setEditor({ kind: "event", event: item.event, date: item.date, time: item.time ?? "" });
  };

  const openSlot = (date: string, time = "") => {
    setEditor({ kind: "task", task: null, date, time });
  };

  return (
    <div className="planner">
      <header className="planner-head">
        <div>
          <h1>Calendar</h1>
          <p className="sub">Schedule task due dates and keep the week’s work visible in one place.</p>
        </div>
        <div className="planner-actions">
          <Link to="/tasks" className="btn">Tasks</Link>
          <button type="button" className="btn" onClick={() => setEditor({ kind: "event", event: null, date: dateKey(anchor), time: "" })}>
            New event
          </button>
          <button type="button" className="btn primary" onClick={() => openSlot(dateKey(anchor))}>
            New task
          </button>
        </div>
      </header>

      {planner.error && <p className="error" role="alert">{planner.error}</p>}

      <section className="card surface">
        <div className="toolbar planner-toolbar">
          <div className="planner-nav">
            <button type="button" className="btn" onClick={() => setAnchor(new Date())}>Today</button>
            <button type="button" className="btn icon" aria-label="Previous date range" onClick={() => setAnchor(shiftAnchor(view, anchor, -1))}>‹</button>
            <button type="button" className="btn icon" aria-label="Next date range" onClick={() => setAnchor(shiftAnchor(view, anchor, 1))}>›</button>
            <div className="range"><span>{rangeTitle(view, anchor)}</span></div>
          </div>
          <div className="planner-views" role="group" aria-label="Calendar view">
            {VIEWS.map((option) => (
              <button key={option.id} type="button" className="btn" aria-pressed={view === option.id} onClick={() => setView(option.id)}>
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {planner.loading ? <p className="empty">Loading calendar…</p> : view === "month" ? (
          <div className="month">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
              <div key={label} className="weekday">{label}</div>
            ))}
            {days.map((day) => {
              const key = dateKey(day);
              const outside = day.getMonth() !== anchor.getMonth();
              return (
                <button
                  key={key + (outside ? "-out" : "")}
                  type="button"
                  className={`day${outside ? " outside" : ""}${key === today ? " today" : ""}`}
                  onClick={() => openSlot(key)}
                >
                  <span className="date-num">{day.getDate()}</span>
                  {itemsOn(items, key).slice(0, 3).map((item) => (
                    <span
                      key={item.id}
                      className={`chip${item.kind === "event" ? " event" : ""}${item.done ? " done" : ""}${item.priority === "urgent" ? " urgent" : ""}`}
                      onClick={(event) => { event.stopPropagation(); openItem(item); }}
                    >
                      {item.time ? `${formatClock(item.time)} ` : ""}{item.title}
                    </span>
                  ))}
                </button>
              );
            })}
          </div>
        ) : view === "list" ? (
          <div>
            {days.map((day) => {
              const key = dateKey(day);
              const dayItems = itemsOn(items, key);
              return (
                <section key={key} className="list-day">
                  <h3>{day.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "short" })}</h3>
                  {dayItems.length === 0 ? <p className="when">Nothing scheduled</p> : dayItems.map((item) => (
                    <button key={item.id} type="button" className={`chip${item.kind === "event" ? " event" : ""}`} onClick={() => openItem(item)}>
                      <small>{item.time ? formatClock(item.time) : "All day"} · {item.kind === "event" ? "Event" : "Task"}</small>
                      {item.title}
                    </button>
                  ))}
                </section>
              );
            })}
          </div>
        ) : (
          <TimeGrid
            days={days}
            items={items}
            today={today}
            showNow={showNow}
            nowTop={nowTop}
            onOpenItem={openItem}
            onOpenSlot={openSlot}
          />
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

const TimeGrid = ({
  days,
  items,
  today,
  showNow,
  nowTop,
  onOpenItem,
  onOpenSlot,
}: {
  days: Date[];
  items: CalendarItem[];
  today: string;
  showNow: boolean;
  nowTop: number;
  onOpenItem: (item: CalendarItem) => void;
  onOpenSlot: (date: string, time: string) => void;
}) => {
  const single = days.length === 1;
  return (
    <>
      <div className={single ? "day-only" : "week"} style={{ display: "grid" }}>
        <div />
        {days.map((day) => {
          const key = dateKey(day);
          return (
            <div key={key} className={`col-head${key === today ? " today" : ""}`}>
              {day.toLocaleDateString("en-AU", { weekday: "short", day: "numeric" })}
            </div>
          );
        })}
      </div>
      <div className={`allday${single ? " day-only" : ""}`}>
        <div className="allday-label">All day</div>
        {days.map((day) => {
          const key = dateKey(day);
          return (
            <div key={key} className="allday-cell">
              {itemsOn(items, key).filter((item) => !item.time).map((item) => (
                <button key={item.id} type="button" className={`chip${item.kind === "event" ? " event" : ""}${item.done ? " done" : ""}`} onClick={() => onOpenItem(item)}>
                  {item.title}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className={`${single ? "day-only" : "week"} hours`} style={{ display: "grid" }}>
        <div>
          {HOURS.map((hour) => (
            <div key={hour} className="hour">{hour % 12 || 12}{hour >= 12 ? "pm" : "am"}</div>
          ))}
        </div>
        {days.map((day) => {
          const key = dateKey(day);
          return (
            <div
              key={key}
              className="col"
              onClick={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                onOpenSlot(key, timeFromOffset(event.clientY - bounds.top));
              }}
            >
              {HOURS.map((hour) => <div key={hour} className="slot" />)}
              {key === today && showNow && <div className="now" style={{ top: nowTop }} />}
              {itemsOn(items, key).filter((item) => item.time).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`chip timed${item.kind === "event" ? " event" : ""}${item.done ? " done" : ""}${item.priority === "urgent" ? " urgent" : ""}`}
                  style={{ top: topForTime(item.time!) }}
                  onClick={(event) => { event.stopPropagation(); onOpenItem(item); }}
                >
                  <small>{formatClock(item.time!)} · {item.kind === "event" ? "Event" : "Task"}</small>
                  {item.title}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
};
