// Reads Things straight from its SQLite database: no osascript, and Things can stay closed.
// Rows map to the same JSON shapes the JXA serializers (todoOf / projectOf) emit.

import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  isoDayToThingsDate,
  isoDayToUnixEnd,
  isoDayToUnixStart,
  type StatsResult,
  type StatsWindow,
  todayIso,
} from "./shared";

export const LISTS = ["inbox", "today", "anytime", "upcoming", "someday", "logbook", "trash"] as const;
export type ListName = (typeof LISTS)[number];

export type ReadOptions = {
  limit?: number;
  offset?: number;
  completed_after?: string;
  completed_before?: string;
};

export type Item = Record<string, unknown>;

type TaskRow = {
  uuid: string;
  type: number;
  status: number;
  title: string | null;
  notes: string | null;
  deadline: number | null;
  startDate: number | null;
  stopDate: number | null;
  openCount: number | null;
  projectName: string | null;
  areaName: string | null;
  tags: string;
  checklist?: string;
};

// A todo under a heading has no project of its own; it belongs to the heading's project.
const FROM = `from TMTask t
  left join TMTask h on h.uuid = t.heading
  left join TMTask p on p.uuid = coalesce(t.project, h.project)
  left join TMArea a on a.uuid = t.area
  left join TMArea pa on pa.uuid = p.area`;

const COLUMNS = `t.uuid, t.type, t.status, t.title, t.notes, t.deadline, t.startDate, t.stopDate,
  t.openUntrashedLeafActionsCount as openCount, p.title as projectName, a.title as areaName,
  (select json_group_array(title) from (
    select tg.title from TMTaskTag tt join TMTag tg on tg.uuid = tt.tags
    where tt.tasks = t.uuid and tg.title is not null order by tg."index"
  )) as tags`;

const CHECKLIST = `,
  (select json_group_array(json_object('name', title, 'done', json(case when status = 3 then 'true' else 'false' end))) from (
    select title, status from TMChecklistItem where task = t.uuid and title is not null order by "index"
  )) as checklist`;

// Things status codes: 0 open, 2 canceled, 3 completed.
const STATUS: Record<number, string> = { 2: "canceled", 3: "completed" };

// Packed calendar date (see isoDayToThingsDate) to yyyy-mm-dd.
function packedToIsoDate(value: number | null): string | null {
  if (!value) return null;
  const year = value >> 16;
  const month = (value >> 12) & 0xf;
  const day = (value >> 7) & 0x1f;
  if (!year || !month || !day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// stopDate is REAL unix seconds.
function unixToIso(value: number | null): string | null {
  return value ? new Date(value * 1000).toISOString() : null;
}

function toItem(row: TaskRow): Item {
  const stopped = unixToIso(row.stopDate);
  const base = {
    id: row.uuid,
    name: row.title ?? "",
    status: STATUS[row.status] ?? "open",
    notes: row.notes ?? "",
    tags: JSON.parse(row.tags) as string[],
    dueDate: packedToIsoDate(row.deadline),
    activationDate: packedToIsoDate(row.startDate),
    completionDate: row.status === 3 ? stopped : null,
    cancellationDate: row.status === 2 ? stopped : null,
  };
  if (row.type === 1) {
    return { kind: "project", ...base, area: row.areaName, todoCount: row.openCount ?? 0 };
  }
  const todo: Item = { kind: "todo", ...base, project: row.projectName, area: row.areaName };
  if (row.checklist != null) todo.checklistItems = JSON.parse(row.checklist);
  return todo;
}

function selectTasks(
  db: Database,
  where: string[],
  params: SQLQueryBindings[],
  orderBy: string,
  options: ReadOptions = {},
  checklists = false,
): Item[] {
  const clauses = [NOT_TEMPLATE, ...where];
  const values = [...params];
  if (options.completed_after) {
    clauses.push("t.stopDate >= ?");
    values.push(isoDayToUnixStart(options.completed_after));
  }
  if (options.completed_before) {
    clauses.push("t.stopDate <= ?");
    values.push(isoDayToUnixEnd(options.completed_before));
  }
  const sql = `select ${COLUMNS}${checklists ? CHECKLIST : ""} ${FROM}
    where ${clauses.join(" and ")} order by ${orderBy} limit ? offset ?`;
  const rows = db.query(sql).all(...values, options.limit ?? -1, options.offset ?? 0) as TaskRow[];
  return rows.map(toItem);
}

// A repeating todo's template row never shows in Things; its instances do.
const NOT_TEMPLATE = "t.rt1_recurrenceRule is null";
const OPEN = [
  "t.type in (0, 1)",
  "t.trashed = 0",
  "t.status = 0",
  "coalesce(h.trashed, 0) = 0",
  "coalesce(p.trashed, 0) = 0",
];
const BY_AREA = 'coalesce(a."index", pa."index"), p."index", t."index"';

// The start column is 0 for Inbox, 1 for Anytime, and 2 for Someday or a scheduled startDate.
// Things moves scheduled items to Anytime only while it runs, so a due startDate counts either way.
// Checked against Things' own lists on 2026-10-28.
function listQuery(list: ListName, today: number): { where: string[]; params: number[]; orderBy: string } {
  switch (list) {
    case "inbox":
      return { where: [...OPEN, "t.start = 0"], params: [], orderBy: 't."index"' };
    case "today":
      return {
        where: [
          ...OPEN,
          `((t.start in (1, 2) and t.startDate <= ?)
            or (t.startDate is null and t.deadline <= ? and t.deadlineSuppressionDate is null))`,
        ],
        params: [today, today],
        orderBy: 't.startBucket, t.todayIndex, t."index"',
      };
    case "anytime":
      return {
        where: [
          ...OPEN,
          "(t.start = 1 or (t.start = 2 and t.startDate <= ?))",
          "(p.uuid is null or p.start = 1 or p.startDate <= ?)",
        ],
        params: [today, today],
        orderBy: BY_AREA,
      };
    case "upcoming":
      return { where: [...OPEN, "t.start = 2", "t.startDate > ?"], params: [today], orderBy: 't.startDate, t."index"' };
    case "someday":
      return { where: [...OPEN, "t.start = 2", "t.startDate is null"], params: [], orderBy: BY_AREA };
    // A logged or trashed project shows as one row; its todos stay inside it.
    case "logbook":
      return {
        where: [
          "t.type in (0, 1)",
          "t.trashed = 0",
          "t.status in (2, 3)",
          "coalesce(h.trashed, 0) = 0",
          "coalesce(p.trashed, 0) = 0",
          "coalesce(p.status, 0) = 0",
        ],
        params: [],
        orderBy: "t.stopDate desc",
      };
    case "trash":
      return {
        where: ["t.type in (0, 1)", "t.trashed = 1", "coalesce(h.trashed, 0) = 0", "coalesce(p.trashed, 0) = 0"],
        params: [],
        orderBy: "t.userModificationDate desc",
      };
  }
}

function todayPacked(): number {
  return isoDayToThingsDate(todayIso());
}

function withDb<T>(dbPath: string, fn: (db: Database) => T): T {
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    // Things may briefly lock the database while it syncs; wait rather than fail.
    db.exec("PRAGMA busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close(false);
  }
}

function findProject(db: Database, name: string): string | null {
  const row = db
    .query("select uuid from TMTask where type = 1 and trashed = 0 and title = ? order by status limit 1")
    .get(name) as { uuid: string } | null;
  return row?.uuid ?? null;
}

// Matches JXA project.toDos(): open todos only.
function projectTodos(db: Database, projectId: string, options: ReadOptions = {}, checklists = false): Item[] {
  return selectTasks(
    db,
    ["coalesce(t.project, h.project) = ?", "t.type = 0", "t.trashed = 0", "t.status = 0", "coalesce(h.trashed, 0) = 0"],
    [projectId],
    'h."index", t."index"',
    options,
    checklists,
  );
}

export function readList(dbPath: string, list: ListName, options: ReadOptions = {}): Item[] {
  return withDb(dbPath, (db) => {
    const { where, params, orderBy } = listQuery(list, todayPacked());
    return selectTasks(db, where, params, orderBy, options);
  });
}

// A todo with its checklist, or a project with its open todos.
export function readItem(dbPath: string, id: string, childChecklists = false): Item | null {
  return withDb(dbPath, (db) => {
    const [item] = selectTasks(db, ["t.uuid = ?", "t.type in (0, 1)"], [id], "t.uuid", {}, true);
    if (!item) return null;
    if (item.kind === "project") item.todos = projectTodos(db, id, {}, childChecklists);
    return item;
  });
}

// A project by name with its open todos and their checklists.
export function readProject(dbPath: string, name: string): Item | null {
  return withDb(dbPath, (db) => {
    const id = findProject(db, name);
    if (!id) return null;
    const [project] = selectTasks(db, ["t.uuid = ?"], [id], "t.uuid");
    if (!project) return null;
    project.todos = projectTodos(db, id, {}, true);
    return project;
  });
}

export function readProjectTodos(dbPath: string, name: string, options: ReadOptions = {}): Item[] | null {
  return withDb(dbPath, (db) => {
    const id = findProject(db, name);
    return id ? projectTodos(db, id, options) : null;
  });
}

export function readAreaProjects(dbPath: string, area: string): Item[] {
  return withDb(dbPath, (db) =>
    selectTasks(db, ["t.type = 1", "t.trashed = 0", "t.status = 0", "a.title = ?"], [area], 't."index"'),
  );
}

export function listProjects(dbPath: string): Item[] {
  return withDb(dbPath, (db) => selectTasks(db, ["t.type = 1", "t.trashed = 0", "t.status = 0"], [], 't."index"'));
}

export function listAreas(dbPath: string): Array<{ id: string; name: string }> {
  return withDb(dbPath, (db) =>
    db.query('select uuid as id, title as name from TMArea order by "index"').all() as Array<{ id: string; name: string }>,
  );
}

export function listTags(dbPath: string): Array<{ id: string; name: string }> {
  return withDb(dbPath, (db) =>
    db.query('select uuid as id, title as name from TMTag order by "index"').all() as Array<{ id: string; name: string }>,
  );
}

// Open todos whose title contains query (case-insensitive) and that carry tag.
export function search(dbPath: string, options: { query?: string; tag?: string; limit?: number; offset?: number }): Item[] {
  return withDb(dbPath, (db) => {
    const where = ["t.type = 0", "t.trashed = 0", "t.status = 0", "coalesce(h.trashed, 0) = 0", "coalesce(p.trashed, 0) = 0"];
    const params: string[] = [];
    if (options.query) {
      where.push("t.title like ? escape '\\'");
      params.push(`%${options.query.replace(/[\\%_]/g, "\\$&")}%`);
    }
    if (options.tag) {
      where.push("t.uuid in (select tt.tasks from TMTaskTag tt join TMTag tg on tg.uuid = tt.tags where tg.title = ?)");
      params.push(options.tag);
    }
    return selectTasks(db, where, params, "t.userModificationDate desc", { limit: options.limit, offset: options.offset });
  });
}

export function stats(dbPath: string, window: StatsWindow): StatsResult {
  const today = todayPacked();
  return withDb(dbPath, (db) => {
    const windowed = db
      .query(
        `select
           coalesce(sum(status = 3 and stopDate between ?1 and ?2), 0) as completed,
           coalesce(sum(status = 2 and stopDate between ?1 and ?2), 0) as canceled,
           coalesce(sum(creationDate between ?1 and ?2), 0) as created
         from TMTask where trashed = 0 and type in (0, 1)`,
      )
      .get(isoDayToUnixStart(window.since), isoDayToUnixEnd(window.until)) as Pick<StatsResult, "completed" | "canceled" | "created">;

    const countList = (list: ListName): number => {
      const { where, params } = listQuery(list, today);
      const sql = `select count(*) as n ${FROM} where ${[NOT_TEMPLATE, ...where].join(" and ")}`;
      return (db.query(sql).get(...params) as { n: number }).n;
    };
    const { n: overdue } = db
      .query(
        `select count(*) as n from TMTask
         where trashed = 0 and type = 0 and status = 0 and rt1_recurrenceRule is null and deadline < ?`,
      )
      .get(today) as { n: number };

    return { window, ...windowed, overdue, inbox: countList("inbox"), today: countList("today") };
  });
}

// Runs every query shape against the database, so a Things schema change shows up here.
export function probe(dbPath: string): void {
  for (const list of LISTS) readList(dbPath, list, { limit: 0 });
  readItem(dbPath, "");
  listAreas(dbPath);
  listTags(dbPath);
  stats(dbPath, { since: todayIso(), until: todayIso() });
}
