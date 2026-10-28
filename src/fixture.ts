// A small Things-shaped SQLite database for tests. Calendar dates are relative to today.

import { Database } from "bun:sqlite";
import { isoDayToThingsDate } from "./shared";

export function packDay(offsetDays: number): number {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return isoDayToThingsDate(
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
  );
}

// stopDate and creationDate are REAL unix seconds.
export const STOP_DONE = 1_780_361_094;
export const STOP_CANCEL = 1_780_000_000;
export const CREATED = Math.floor(Date.UTC(2026, 4, 10, 12) / 1000);

type Task = {
  uuid: string;
  title: string;
  type?: number;
  status?: number;
  trashed?: number;
  start?: number;
  startDate?: number | null;
  startBucket?: number;
  deadline?: number | null;
  stopDate?: number | null;
  creationDate?: number | null;
  todayIndex?: number;
  index?: number;
  userModificationDate?: number;
  openUntrashedLeafActionsCount?: number | null;
  notes?: string | null;
  project?: string | null;
  area?: string | null;
  heading?: string | null;
  rt1_recurrenceRule?: string | null;
};

// Things' start column: 0 Inbox, 1 Anytime, 2 Someday or scheduled.
export const TASKS: Task[] = [
  { uuid: "proj-1", title: "Website", type: 1, area: "area-1", notes: "site notes", deadline: packDay(30), openUntrashedLeafActionsCount: 3 },
  { uuid: "proj-2", title: "Done Project", type: 1, status: 3, stopDate: STOP_DONE - 50, index: 1 },
  { uuid: "proj-3", title: "Later Project", type: 1, start: 2, area: "area-1", index: 2 },
  { uuid: "proj-4", title: "Started Project", type: 1, start: 2, startDate: packDay(-1), todayIndex: 25, index: 3 },
  { uuid: "head-1", title: "Phase two", type: 2, project: "proj-1" },
  { uuid: "head-2", title: "Dropped phase", type: 2, project: "proj-1", trashed: 1, index: 1 },
  { uuid: "t-inbox", title: "Inbox item", start: 0, index: 5, creationDate: CREATED },
  { uuid: "t-today-a", title: "Today A", area: "area-2", startDate: packDay(0), todayIndex: 10, creationDate: CREATED },
  { uuid: "t-today-b", title: "Today B", area: "area-2", startDate: packDay(-2), todayIndex: 5 },
  { uuid: "t-evening", title: "Evening", area: "area-2", startDate: packDay(0), startBucket: 1 },
  { uuid: "t-unconfirmed", title: "Scheduled for today", area: "area-2", start: 2, startDate: packDay(0), todayIndex: 20 },
  { uuid: "t-overdue", title: "Overdue item", area: "area-2", deadline: packDay(-3), todayIndex: 30 },
  { uuid: "t-upcoming", title: "Next week", area: "area-2", start: 2, startDate: packDay(7) },
  { uuid: "t-someday", title: "Someday item", start: 2, index: 7 },
  { uuid: "t-pa", title: "Proj todo A", project: "proj-1", index: 1, userModificationDate: 60 },
  { uuid: "t-pb", title: "Proj todo B", project: "proj-1", index: 2 },
  { uuid: "t-ph", title: "Under heading", heading: "head-1", index: 0 },
  { uuid: "t-later", title: "In someday project", project: "proj-3" },
  { uuid: "t-started", title: "In started project", project: "proj-4" },
  { uuid: "t-dropped", title: "Under trashed heading", heading: "head-2" },
  { uuid: "t-template", title: "Repeating template", start: 2, rt1_recurrenceRule: "rule" },
  { uuid: "t-search", title: "Find me report", area: "area-2", userModificationDate: 70 },
  { uuid: "t-future", title: "Future deadline", area: "area-2", deadline: packDay(400) },
  { uuid: "t-log-done", title: "Logged done", status: 3, stopDate: STOP_DONE, project: "proj-1" },
  { uuid: "t-log-cancel", title: "Logged canceled", status: 2, stopDate: STOP_CANCEL },
  { uuid: "t-in-done", title: "In done project", status: 3, stopDate: STOP_DONE - 10, project: "proj-2" },
  { uuid: "t-trash", title: "Trashed", trashed: 1 },
  { uuid: "t-trash-in", title: "Trashed under trashed heading", trashed: 1, heading: "head-2" },
];

export function createFixtureDb(path: string): void {
  const db = new Database(path, { create: true });
  db.run(`create table TMTask (
    uuid text, type integer, status integer, trashed integer, title text, notes text,
    start integer, startDate integer, startBucket integer, deadline integer, deadlineSuppressionDate integer,
    stopDate real, creationDate real, userModificationDate real, todayIndex integer, "index" integer,
    openUntrashedLeafActionsCount integer, project text, area text, heading text, rt1_recurrenceRule blob
  )`);
  db.run(`create table TMArea (uuid text, title text, "index" integer)`);
  db.run(`create table TMTag (uuid text, title text, "index" integer)`);
  db.run(`create table TMTaskTag (tasks text, tags text)`);
  db.run(`create table TMChecklistItem (uuid text, task text, title text, status integer, "index" integer)`);

  db.run(`insert into TMArea values ('area-1', 'Work', 0), ('area-2', 'Personal', 1)`);
  db.run(`insert into TMTag values ('tag-1', 'urgent', 0), ('tag-2', 'home', 1)`);
  db.run(`insert into TMTaskTag values ('t-pa', 'tag-2'), ('t-pa', 'tag-1'), ('t-search', 'tag-1')`);
  db.run(`insert into TMChecklistItem values ('ci-2', 't-pa', 'Step two', 0, 1), ('ci-1', 't-pa', 'Step one', 3, 0)`);

  const insert = db.prepare(`insert into TMTask
    (uuid, type, status, trashed, title, notes, start, startDate, startBucket, deadline, stopDate, creationDate,
     userModificationDate, todayIndex, "index", openUntrashedLeafActionsCount, project, area, heading, rt1_recurrenceRule)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const task of TASKS) {
    insert.run(
      task.uuid, task.type ?? 0, task.status ?? 0, task.trashed ?? 0, task.title, task.notes ?? null,
      task.start ?? 1, task.startDate ?? null, task.startBucket ?? 0, task.deadline ?? null, task.stopDate ?? null,
      task.creationDate ?? null, task.userModificationDate ?? 0, task.todayIndex ?? 0, task.index ?? 0,
      task.openUntrashedLeafActionsCount ?? null, task.project ?? null, task.area ?? null, task.heading ?? null,
      task.rt1_recurrenceRule ?? null,
    );
  }
  db.close(false);
}
