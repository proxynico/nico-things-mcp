// Pure-SQLite read layer (spike).
//
// Maps Things database rows directly to the same JSON shapes the JXA
// serializers (todoOf / projectOf) emit, so it is a drop-in for the
// SQL-IDs-then-JXA-hydrate path — but never spawns osascript and never
// wakes Things. Reads work with the app fully closed and are ~100x faster.
//
// Boundary: covers the paths the hydrate path covers — the built-in lists
// inbox/today/logbook/trash, by-id, project todos, area projects,
// projects/areas/tags enumerations, and search. The computed lists
// (anytime/upcoming/someday) stay on JXA: Things builds them with rules
// SQL cannot reproduce reliably, so we do not pretend to here.

import { Database } from "bun:sqlite";
import {
  isoDayToThingsDate,
  isoDayToUnixEnd,
  isoDayToUnixStart,
  StatsResult,
  StatsWindow,
  todayIso,
} from "./shared";

export type SqlReadOptions = {
  limit?: number;
  offset?: number;
  completed_after?: string;
  completed_before?: string;
};

type TaskRow = {
  uuid: string;
  type: number;
  status: number;
  title: string | null;
  notes: string | null;
  deadline: number | null;
  startDate: number | null;
  stopDate: number | null;
  todayIndex: number | null;
  idx: number | null;
  userModificationDate: number | null;
  openCount: number | null;
  projectName: string | null;
  areaName: string | null;
};

const SELECT_COLUMNS = `
  t.uuid as uuid,
  t.type as type,
  t.status as status,
  t.title as title,
  t.notes as notes,
  t.deadline as deadline,
  t.startDate as startDate,
  t.stopDate as stopDate,
  t.todayIndex as todayIndex,
  t."index" as idx,
  t.userModificationDate as userModificationDate,
  t.openUntrashedLeafActionsCount as openCount,
  p.title as projectName,
  a.title as areaName
`;

const FROM_JOINS = `
  from TMTask t
  left join TMTask p on p.uuid = t.project
  left join TMArea a on a.uuid = t.area
`;

// Things status codes: 0 = open, 2 = canceled, 3 = completed.
// (Verified against JXA t.status(); the historical stats query has these swapped.)
function statusString(status: number): string {
  if (status === 3) return "completed";
  if (status === 2) return "canceled";
  return "open";
}

// Things packs calendar dates (deadline, startDate) as integers:
// year = v >> 16, month = (v >> 12) & 0xF, day = (v >> 7) & 0x1F.
function packedToIsoDate(value: number | null): string | null {
  if (!value) return null;
  const year = value >> 16;
  const month = (value >> 12) & 0xf;
  const day = (value >> 7) & 0x1f;
  if (!year || !month || !day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// stopDate / userModificationDate are REAL unix seconds.
function unixToIso(value: number | null): string | null {
  if (!value) return null;
  return new Date(value * 1000).toISOString();
}

function fetchTags(db: Database, ids: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .query(
      `select tt.tasks as id, tg.title as title
       from TMTaskTag tt
       join TMTag tg on tg.uuid = tt.tags
       where tt.tasks in (${placeholders})`,
    )
    .all(...ids) as Array<{ id: string; title: string | null }>;
  for (const row of rows) {
    if (!row.title) continue;
    const list = map.get(row.id) ?? [];
    list.push(row.title);
    map.set(row.id, list);
  }
  return map;
}

function mapRow(row: TaskRow, tags: string[]): Record<string, unknown> {
  const status = statusString(row.status);
  const base = {
    id: row.uuid,
    name: row.title ?? "",
    status,
    notes: row.notes ?? "",
    tags,
    dueDate: packedToIsoDate(row.deadline),
    activationDate: packedToIsoDate(row.startDate),
    completionDate: row.status === 3 ? unixToIso(row.stopDate) : null,
    cancellationDate: row.status === 2 ? unixToIso(row.stopDate) : null,
  };
  if (row.type === 1) {
    return { kind: "project", ...base, area: row.areaName ?? null, todoCount: row.openCount ?? 0 };
  }
  return { kind: "todo", ...base, project: row.projectName ?? null, area: row.areaName ?? null };
}

function hydrate(db: Database, rows: TaskRow[]): Array<Record<string, unknown>> {
  const tagMap = fetchTags(
    db,
    rows.map((row) => row.uuid),
  );
  return rows.map((row) => mapRow(row, tagMap.get(row.uuid) ?? []));
}

// JXA project.toDos() returns open todos only; match that.
function openProjectTodos(db: Database, projectUuid: string): TaskRow[] {
  return db
    .query(
      `select ${SELECT_COLUMNS} ${FROM_JOINS}
       where t.project = ? and t.trashed = 0 and t.type = 0 and t.status = 0
       order by t."index" asc`,
    )
    .all(projectUuid) as TaskRow[];
}

// Checklist items belong to todos. done mirrors the task convention (3 = done).
function attachChecklists(db: Database, todos: Array<Record<string, unknown>>): void {
  const ids = todos.map((todo) => String(todo.id));
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .query(
      `select task, title, status from TMChecklistItem
       where task in (${placeholders}) order by "index" asc`,
    )
    .all(...ids) as Array<{ task: string; title: string | null; status: number }>;
  const map = new Map<string, Array<{ name: string; done: boolean }>>();
  for (const row of rows) {
    if (row.title == null) continue;
    const list = map.get(row.task) ?? [];
    list.push({ name: row.title, done: row.status === 3 });
    map.set(row.task, list);
  }
  for (const todo of todos) {
    todo.checklistItems = map.get(String(todo.id)) ?? [];
  }
}

function buildListWhere(list: string, options: SqlReadOptions): { where: string[]; params: Array<string | number>; orderBy: string } {
  const where: string[] = ["t.type in (0, 1)"];
  const params: Array<string | number> = [];
  let orderBy = "t.userModificationDate desc";

  if (list === "logbook") {
    where.push("t.trashed = 0", "t.status in (2, 3)");
    orderBy = "t.stopDate desc, t.userModificationDate desc";
  } else if (list === "trash") {
    where.push("t.trashed = 1");
  } else if (list === "today") {
    where.push("t.trashed = 0", "t.status = 0", "t.todayIndex != 0");
    orderBy = "t.todayIndex asc, t.userModificationDate desc";
  } else if (list === "inbox") {
    where.push(
      "t.trashed = 0",
      "t.status = 0",
      "t.project is null",
      "t.area is null",
      "t.heading is null",
      "t.start != 2",
      "t.todayIndex = 0",
    );
    orderBy = 't."index" asc, t.userModificationDate desc';
  } else {
    throw new Error(`sqlread does not handle list '${list}'`);
  }

  if (options.completed_after) {
    where.push("t.stopDate >= ?");
    params.push(isoDayToUnixStart(options.completed_after));
  }
  if (options.completed_before) {
    where.push("t.stopDate <= ?");
    params.push(isoDayToUnixEnd(options.completed_before));
  }

  return { where, params, orderBy };
}

export const SQL_SUPPORTED_LISTS = new Set(["inbox", "today", "logbook", "trash"]);

function withDb<T>(dbPath: string, fn: (db: Database) => T): T {
  const db = new Database(dbPath, { readonly: true, create: false });
  try {
    // Things 3 may briefly lock the DB during a Cloud checkpoint. Wait politely
    // for a few seconds rather than failing or hanging indefinitely.
    db.exec("PRAGMA busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close(false);
  }
}

export function probeSqlRead(dbPath: string): void {
  withDb(dbPath, (db) => {
    const schemaChecks = [
      `select uuid, type, status, title, notes, deadline, startDate, stopDate,
        creationDate, todayIndex, "index", userModificationDate,
        openUntrashedLeafActionsCount, project, area, heading, trashed, start
       from TMTask limit 1`,
      `select uuid, title, "index" from TMArea limit 1`,
      `select uuid, title, "index" from TMTag limit 1`,
      `select tasks, tags from TMTaskTag limit 1`,
      `select task, title, status, "index" from TMChecklistItem limit 1`,
    ];
    for (const query of schemaChecks) {
      db.query(query).get();
    }
  });
}

export function readList(dbPath: string, list: string, options: SqlReadOptions): Array<Record<string, unknown>> {
  return withDb(dbPath, (db) => {
    const { where, params, orderBy } = buildListWhere(list, options);
    let sql = `select ${SELECT_COLUMNS} ${FROM_JOINS} where ${where.join(" and ")} order by ${orderBy}`;
    if (options.limit != null) {
      sql += " limit ? offset ?";
      params.push(options.limit, options.offset ?? 0);
    } else if ((options.offset ?? 0) > 0) {
      sql += " limit -1 offset ?";
      params.push(options.offset ?? 0);
    }
    const rows = db.query(sql).all(...params) as TaskRow[];
    return hydrate(db, rows);
  });
}

export function readById(dbPath: string, id: string): Record<string, unknown> | null {
  return withDb(dbPath, (db) => {
    const row = db
      .query(`select ${SELECT_COLUMNS} ${FROM_JOINS} where t.uuid = ?`)
      .get(id) as TaskRow | null;
    if (!row) return null;
    const [mapped] = hydrate(db, [row]);
    if (!mapped) return null;
    if (row.type === 1) {
      mapped.todos = hydrate(db, openProjectTodos(db, id));
    }
    return mapped;
  });
}

// Export variants: same shapes but with checklist items attached, matching the
// JXA export path (readItemForExport / readProjectForExport).
export function readItemForExport(dbPath: string, id: string): Record<string, unknown> | null {
  return withDb(dbPath, (db) => {
    const row = db
      .query(`select ${SELECT_COLUMNS} ${FROM_JOINS} where t.uuid = ?`)
      .get(id) as TaskRow | null;
    if (!row) return null;
    const [mapped] = hydrate(db, [row]);
    if (!mapped) return null;
    if (row.type === 1) {
      const todos = hydrate(db, openProjectTodos(db, id));
      attachChecklists(db, todos);
      mapped.todos = todos;
    } else {
      attachChecklists(db, [mapped]);
    }
    return mapped;
  });
}

export function readProjectForExport(dbPath: string, name: string): Record<string, unknown> | null {
  return withDb(dbPath, (db) => {
    const row = db
      .query(
        `select ${SELECT_COLUMNS} ${FROM_JOINS}
         where t.type = 1 and t.trashed = 0 and t.title = ? order by t.status asc limit 1`,
      )
      .get(name) as TaskRow | null;
    if (!row) return null;
    const [mapped] = hydrate(db, [row]);
    if (!mapped) return null;
    const todos = hydrate(db, openProjectTodos(db, row.uuid));
    attachChecklists(db, todos);
    mapped.todos = todos;
    return mapped;
  });
}

export function readProjectTodos(
  dbPath: string,
  projectName: string,
  options: SqlReadOptions,
): Array<Record<string, unknown>> | null {
  return withDb(dbPath, (db) => {
    const project = db
      .query("select uuid from TMTask where type = 1 and trashed = 0 and title = ? order by status asc limit 1")
      .get(projectName) as { uuid: string } | null;
    if (!project) return null;

    // JXA project.toDos() returns open todos only; match that.
    const where = ["t.project = ?", "t.trashed = 0", "t.type = 0", "t.status = 0"];
    const params: Array<string | number> = [project.uuid];
    if (options.completed_after) {
      where.push("t.stopDate >= ?");
      params.push(isoDayToUnixStart(options.completed_after));
    }
    if (options.completed_before) {
      where.push("t.stopDate <= ?");
      params.push(isoDayToUnixEnd(options.completed_before));
    }
    let sql = `select ${SELECT_COLUMNS} ${FROM_JOINS} where ${where.join(" and ")} order by t."index" asc`;
    if (options.limit != null) {
      sql += " limit ? offset ?";
      params.push(options.limit, options.offset ?? 0);
    } else if ((options.offset ?? 0) > 0) {
      sql += " limit -1 offset ?";
      params.push(options.offset ?? 0);
    }
    const rows = db.query(sql).all(...params) as TaskRow[];
    return hydrate(db, rows);
  });
}

export function readAreaProjects(dbPath: string, areaName: string): Array<Record<string, unknown>> {
  return withDb(dbPath, (db) => {
    const rows = db
      .query(
        `select ${SELECT_COLUMNS} ${FROM_JOINS}
         where t.type = 1 and t.trashed = 0 and t.status = 0 and a.title = ?
         order by t."index" asc`,
      )
      .all(areaName) as TaskRow[];
    return hydrate(db, rows);
  });
}

export function listProjects(dbPath: string): Array<Record<string, unknown>> {
  return withDb(dbPath, (db) => {
    const rows = db
      .query(
        `select ${SELECT_COLUMNS} ${FROM_JOINS}
         where t.type = 1 and t.trashed = 0 and t.status = 0
         order by t."index" asc`,
      )
      .all() as TaskRow[];
    return hydrate(db, rows);
  });
}

export function listAreas(dbPath: string): Array<{ id: string; name: string }> {
  return withDb(dbPath, (db) => {
    const rows = db
      .query('select uuid as id, title as name from TMArea order by "index" asc')
      .all() as Array<{ id: string; name: string }>;
    return rows;
  });
}

export function listTags(dbPath: string): Array<{ id: string; name: string }> {
  return withDb(dbPath, (db) => {
    const rows = db
      .query('select uuid as id, title as name from TMTag order by "index" asc')
      .all() as Array<{ id: string; name: string }>;
    return rows;
  });
}

export function search(
  dbPath: string,
  options: { query?: string; tag?: string; limit?: number; offset?: number },
): Array<Record<string, unknown>> {
  return withDb(dbPath, (db) => {
    const where = ["t.trashed = 0", "t.type = 0", "t.status = 0"];
    const params: Array<string | number> = [];
    if (options.query) {
      where.push("t.title like ? escape '\\'");
      params.push(`%${options.query.replace(/[\\%_]/g, "\\$&")}%`);
    }
    if (options.tag) {
      where.push(
        "t.uuid in (select tt.tasks from TMTaskTag tt join TMTag tg on tg.uuid = tt.tags where tg.title = ?)",
      );
      params.push(options.tag);
    }
    let sql = `select ${SELECT_COLUMNS} ${FROM_JOINS} where ${where.join(" and ")} order by t.userModificationDate desc`;
    const limit = options.limit;
    const offset = options.offset ?? 0;
    if (limit != null) {
      sql += " limit ? offset ?";
      params.push(limit, offset);
    } else if (offset > 0) {
      sql += " limit -1 offset ?";
      params.push(offset);
    }
    const rows = db.query(sql).all(...params) as TaskRow[];
    return hydrate(db, rows);
  });
}

export function stats(dbPath: string, window: StatsWindow): StatsResult {
  const sinceStart = isoDayToUnixStart(window.since);
  const untilEnd = isoDayToUnixEnd(window.until);
  const todayPacked = isoDayToThingsDate(todayIso());

  return withDb(dbPath, (db) => {
    // status 3 = completed, 2 = canceled (verified against JXA).
    const windowRow = db
      .query(
        `select
           coalesce(sum(case when status = 3 and stopDate >= ? and stopDate <= ? then 1 else 0 end), 0) as completed,
           coalesce(sum(case when status = 2 and stopDate >= ? and stopDate <= ? then 1 else 0 end), 0) as canceled,
           coalesce(sum(case when creationDate >= ? and creationDate <= ? then 1 else 0 end), 0) as created
         from TMTask where trashed = 0 and type in (0, 1)`,
      )
      .get(sinceStart, untilEnd, sinceStart, untilEnd, sinceStart, untilEnd) as {
      completed: number;
      canceled: number;
      created: number;
    };

    const count = (sql: string, ...params: Array<string | number>): number => {
      const row = db.query(sql).get(...params) as { n: number } | null;
      return Number(row?.n ?? 0);
    };

    // deadline is a packed calendar date; compare against today packed the same way.
    const overdue = count(
      `select count(*) as n from TMTask
       where trashed = 0 and type = 0 and status = 0
         and deadline is not null and deadline < ?`,
      todayPacked,
    );
    const today = count(
      `select count(*) as n from TMTask
       where trashed = 0 and type = 0 and status = 0 and todayIndex != 0`,
    );
    const inbox = count(
      `select count(*) as n from TMTask
       where trashed = 0 and type = 0 and status = 0
         and project is null and area is null and heading is null
         and start != 2 and todayIndex = 0`,
    );

    return {
      window,
      completed: windowRow.completed,
      canceled: windowRow.canceled,
      created: windowRow.created,
      overdue,
      inbox,
      today,
    };
  });
}
