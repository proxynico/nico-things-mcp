import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sql from "./sqlread";

// Offline fixture: builds a minimal Things-shaped SQLite database and runs the
// pure-SQL read layer against it. No Things install, no osascript, no network.

// Things packs calendar dates: year<<16 | month<<12 | day<<7.
function packDate(year: number, month: number, day: number): number {
  return (year << 16) | (month << 12) | (day << 7);
}

// stopDate / userModificationDate are REAL unix seconds.
const STOP_DONE = 1_780_361_094; // a completed item's stop time (2026)
const STOP_CANCEL = 1_780_000_000; // a canceled item's stop time (2026)
const CREATED = Math.floor(Date.UTC(2026, 4, 10, 12) / 1000); // creationDate for a couple of items

const dbPath = join(tmpdir(), `cositas-sqlread-${process.pid}.sqlite`);

beforeAll(() => {
  const db = new Database(dbPath, { create: true });
  db.run(`create table TMTask (
    uuid text, type integer, status integer, title text, notes text,
    deadline integer, startDate integer, stopDate real, creationDate real,
    todayIndex integer, "index" integer, userModificationDate real,
    openUntrashedLeafActionsCount integer,
    project text, area text, heading text, trashed integer, start integer
  )`);
  db.run(`create table TMArea (uuid text, title text, "index" integer)`);
  db.run(`create table TMTag (uuid text, title text, "index" integer)`);
  db.run(`create table TMTaskTag (tasks text, tags text)`);
  db.run(`create table TMChecklistItem (uuid text, title text, status integer, task text, "index" integer)`);

  db.run(`insert into TMArea values ('area-1','Work',0),('area-2','Personal',1)`);
  db.run(`insert into TMTag values ('tag-1','urgent',0),('tag-2','home',1)`);

  const task = db.prepare(`insert into TMTask
    (uuid,type,status,title,notes,deadline,startDate,stopDate,todayIndex,"index",userModificationDate,openUntrashedLeafActionsCount,project,area,heading,trashed,start)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  // [uuid,type,status,title,notes,deadline,startDate,stopDate,todayIndex,index,umod,openCount,project,area,heading,trashed,start]
  const rows: Array<Array<string | number | null>> = [
    // open project in Work, with a deadline and 2 open todos
    ["proj-1", 1, 0, "Website", "site notes", packDate(2026, 4, 4), null, null, 0, 0, 100, 2, null, "area-1", null, 0, 1],
    // completed project -> appears in logbook (stopped just before t-log-done)
    ["proj-2", 1, 3, "Done Project", null, null, null, STOP_DONE - 50, 0, 1, 99, 0, null, null, null, 0, 1],
    // inbox todo: no parent, not someday, not in today
    ["t-inbox", 0, 0, "Inbox item", null, null, null, null, 0, 5, 50, null, null, null, null, 0, 1],
    // today todos (ordered by todayIndex asc -> B before A)
    ["t-today-a", 0, 0, "Today A", null, packDate(2026, 4, 4), packDate(2026, 4, 4), null, 10, 0, 40, null, null, null, null, 0, 1],
    ["t-today-b", 0, 0, "Today B", null, null, null, null, 5, 0, 41, null, null, null, null, 0, 1],
    // logbook: completed + canceled todos
    ["t-log-done", 0, 3, "Logged done", null, null, null, STOP_DONE, 0, 0, 30, null, "proj-1", null, null, 0, 1],
    ["t-log-cancel", 0, 2, "Logged canceled", null, null, null, STOP_CANCEL, 0, 0, 31, null, null, null, null, 0, 1],
    // trash
    ["t-trash", 0, 0, "Trashed", null, null, null, null, 0, 0, 20, null, null, null, null, 1, 1],
    // project todos under Website (open), ordered by index
    ["t-pa", 0, 0, "Proj todo A", null, null, null, null, 0, 1, 60, null, "proj-1", null, null, 0, 1],
    ["t-pb", 0, 0, "Proj todo B", null, null, null, null, 0, 2, 61, null, "proj-1", null, null, 0, 1],
    // someday (excluded from inbox via start=2)
    ["t-someday", 0, 0, "Someday item", null, null, null, null, 0, 7, 55, null, null, null, null, 0, 2],
    // searchable open todo (parked in Personal so it is not an Inbox item)
    ["t-search", 0, 0, "Find me report", null, null, null, null, 0, 0, 70, null, null, "area-2", null, 0, 1],
    // overdue/future open todos (in Personal so they only affect stats overdue)
    ["t-overdue", 0, 0, "Overdue item", null, packDate(2020, 1, 1), null, null, 0, 0, 80, null, null, "area-2", null, 0, 1],
    ["t-future", 0, 0, "Future item", null, packDate(2099, 12, 31), null, null, 0, 0, 81, null, null, "area-2", null, 0, 1],
  ];
  for (const r of rows) task.run(...r);

  // tag urgent on Proj todo A and the searchable todo
  db.run(`insert into TMTaskTag values ('t-pa','tag-1'),('t-search','tag-1')`);
  // checklist items on Proj todo A (status 3 = done)
  db.run(`insert into TMChecklistItem values ('ci-1','Step one',3,'t-pa',0),('ci-2','Step two',0,'t-pa',1)`);
  // creationDate only on two items, for the stats "created" window
  db.run(`update TMTask set creationDate = ? where uuid in ('t-inbox','t-today-a')`, [CREATED]);
  db.close(false);
});

afterAll(() => {
  rmSync(dbPath, { force: true });
});

describe("readList", () => {
  test("inbox excludes parented, someday, today, and trashed items", () => {
    const items = sql.readList(dbPath, "inbox", {});
    expect(items.map((i) => i.id)).toEqual(["t-inbox"]);
    expect(items[0]!.kind).toBe("todo");
  });

  test("today is ordered by todayIndex ascending", () => {
    const items = sql.readList(dbPath, "today", {});
    expect(items.map((i) => i.id)).toEqual(["t-today-b", "t-today-a"]);
  });

  test("logbook returns completed and canceled, newest stop first", () => {
    const items = sql.readList(dbPath, "logbook", {});
    expect(items.map((i) => i.id)).toEqual(["t-log-done", "proj-2", "t-log-cancel"]);
  });

  test("trash returns only trashed items", () => {
    const items = sql.readList(dbPath, "trash", {});
    expect(items.map((i) => i.id)).toEqual(["t-trash"]);
  });

  test("limit and offset page the result", () => {
    expect(sql.readList(dbPath, "today", { limit: 1 }).map((i) => i.id)).toEqual(["t-today-b"]);
    expect(sql.readList(dbPath, "today", { limit: 1, offset: 1 }).map((i) => i.id)).toEqual(["t-today-a"]);
  });

  test("offset without limit skips from the front", () => {
    expect(sql.readList(dbPath, "today", { offset: 1 }).map((i) => i.id)).toEqual(["t-today-a"]);
  });

  test("completed_after / completed_before filter on stopDate", () => {
    const after = sql.readList(dbPath, "logbook", { completed_after: "2026-06-08" });
    // STOP_DONE is 2026-06-02 in UTC; both stops are before 2026-06-08
    expect(after.length).toBe(0);
    const all = sql.readList(dbPath, "logbook", { completed_before: "2027-01-01" });
    expect(all.length).toBe(3);
  });

  test("unsupported computed lists throw (callers fall back to JXA)", () => {
    expect(() => sql.readList(dbPath, "anytime", {})).toThrow();
  });
});

describe("field mapping", () => {
  test("packed deadline decodes to the true calendar date (no UTC off-by-one)", () => {
    const [today] = sql.readList(dbPath, "today", { limit: 1, offset: 1 }); // Today A
    expect(today!.dueDate).toBe("2026-04-04");
    expect(today!.activationDate).toBe("2026-04-04");
  });

  test("status codes: 3=completed, 2=canceled, 0=open", () => {
    const log = sql.readList(dbPath, "logbook", {});
    const done = log.find((i) => i.id === "t-log-done")!;
    const cancel = log.find((i) => i.id === "t-log-cancel")!;
    expect(done.status).toBe("completed");
    expect(done.completionDate).toBe(new Date(STOP_DONE * 1000).toISOString());
    expect(done.cancellationDate).toBeNull();
    expect(cancel.status).toBe("canceled");
    expect(cancel.cancellationDate).toBe(new Date(STOP_CANCEL * 1000).toISOString());
    expect(cancel.completionDate).toBeNull();
  });

  test("open items emit no terminal timestamps", () => {
    const [inbox] = sql.readList(dbPath, "inbox", {});
    expect(inbox!.completionDate).toBeNull();
    expect(inbox!.cancellationDate).toBeNull();
  });

  test("tags are resolved and attached", () => {
    const [pa] = sql.readProjectTodos(dbPath, "Website", {})!.filter((i) => i.id === "t-pa");
    expect(pa!.tags).toEqual(["urgent"]);
    const [inbox] = sql.readList(dbPath, "inbox", {});
    expect(inbox!.tags).toEqual([]);
  });

  test("project rows carry kind=project, todoCount, area; todos carry project/area names", () => {
    const projects = sql.listProjects(dbPath);
    const web = projects.find((p) => p.id === "proj-1")!;
    expect(web.kind).toBe("project");
    expect(web.todoCount).toBe(2);
    expect(web.area).toBe("Work");

    const log = sql.readList(dbPath, "logbook", {});
    const doneTodo = log.find((i) => i.id === "t-log-done")!;
    expect(doneTodo.kind).toBe("todo");
    expect(doneTodo.project).toBe("Website");
  });
});

describe("readById", () => {
  test("returns a todo by id", () => {
    const item = sql.readById(dbPath, "t-inbox");
    expect(item?.kind).toBe("todo");
    expect(item?.name).toBe("Inbox item");
  });

  test("returns a project with its open todos ordered by index", () => {
    const item = sql.readById(dbPath, "proj-1");
    expect(item?.kind).toBe("project");
    const todos = item?.todos as Array<Record<string, unknown>>;
    expect(todos.map((t) => t.id)).toEqual(["t-pa", "t-pb"]);
  });

  test("returns null for unknown id (caller falls back to JXA)", () => {
    expect(sql.readById(dbPath, "nope")).toBeNull();
  });
});

describe("readProjectTodos", () => {
  test("returns open todos for a project by name", () => {
    const todos = sql.readProjectTodos(dbPath, "Website", {});
    expect(todos?.map((t) => t.id)).toEqual(["t-pa", "t-pb"]);
  });

  test("returns null for an unknown project name", () => {
    expect(sql.readProjectTodos(dbPath, "Ghost", {})).toBeNull();
  });

  test("offset without limit pages project todos", () => {
    expect(sql.readProjectTodos(dbPath, "Website", { offset: 1 })?.map((t) => t.id)).toEqual(["t-pb"]);
  });
});

describe("readAreaProjects", () => {
  test("returns open projects in the area", () => {
    const projects = sql.readAreaProjects(dbPath, "Work");
    expect(projects.map((p) => p.id)).toEqual(["proj-1"]);
    expect(projects[0]!.kind).toBe("project");
  });

  test("returns empty for an area with no open projects", () => {
    expect(sql.readAreaProjects(dbPath, "Personal")).toEqual([]);
  });
});

describe("enumerations", () => {
  test("listProjects returns only open projects", () => {
    expect(sql.listProjects(dbPath).map((p) => p.id)).toEqual(["proj-1"]);
  });

  test("listAreas returns id/name pairs ordered by index", () => {
    expect(sql.listAreas(dbPath)).toEqual([
      { id: "area-1", name: "Work" },
      { id: "area-2", name: "Personal" },
    ]);
  });

  test("listTags returns id/name pairs ordered by index", () => {
    expect(sql.listTags(dbPath)).toEqual([
      { id: "tag-1", name: "urgent" },
      { id: "tag-2", name: "home" },
    ]);
  });
});

describe("search", () => {
  test("matches open todos by title substring (case-insensitive)", () => {
    expect(sql.search(dbPath, { query: "REPORT" }).map((i) => i.id)).toEqual(["t-search"]);
  });

  test("filters by tag", () => {
    expect(sql.search(dbPath, { tag: "urgent" }).map((i) => i.id).sort()).toEqual(["t-pa", "t-search"]);
  });

  test("combines query and tag (intersection)", () => {
    expect(sql.search(dbPath, { query: "report", tag: "urgent" }).map((i) => i.id)).toEqual(["t-search"]);
  });

  test("does not return completed or trashed items", () => {
    expect(sql.search(dbPath, { query: "logged" })).toEqual([]);
    expect(sql.search(dbPath, { query: "trashed" })).toEqual([]);
  });

  test("LIKE wildcards in the query are escaped (treated literally)", () => {
    expect(sql.search(dbPath, { query: "%" })).toEqual([]);
  });

  test("offset without limit pages search results", () => {
    const all = sql.search(dbPath, { tag: "urgent" }).map((i) => i.id).sort();
    expect(all.length).toBe(2);
    expect(sql.search(dbPath, { tag: "urgent", offset: 1 }).length).toBe(1);
  });
});

describe("stats", () => {
  // Assumes the clock is after 2026-04-04 (overdue is a now-relative snapshot).
  test("windowed counts use correct status codes (completed=3, canceled=2)", () => {
    const s = sql.stats(dbPath, { since: "2026-01-01", until: "2027-01-01" });
    expect(s.completed).toBe(2); // t-log-done + proj-2 (status 3)
    expect(s.canceled).toBe(1); // t-log-cancel (status 2)
    expect(s.created).toBe(2); // t-inbox + t-today-a have a 2026 creationDate
  });

  test("overdue compares packed deadlines, excluding future ones", () => {
    const s = sql.stats(dbPath, { since: "2026-01-01", until: "2027-01-01" });
    // t-overdue (2020) and t-today-a (2026-04-04) are past; t-future (2099) is not.
    expect(s.overdue).toBe(2);
  });

  test("snapshot counts: today and inbox", () => {
    const s = sql.stats(dbPath, { since: "2026-01-01", until: "2027-01-01" });
    expect(s.today).toBe(2); // t-today-a, t-today-b
    expect(s.inbox).toBe(1); // t-inbox
  });

  test("window excludes out-of-range completions and creations", () => {
    const s = sql.stats(dbPath, { since: "2025-01-01", until: "2025-12-31" });
    expect(s.completed).toBe(0);
    expect(s.canceled).toBe(0);
    expect(s.created).toBe(0);
    // snapshots are now-relative, unaffected by the window
    expect(s.overdue).toBe(2);
    expect(s.today).toBe(2);
    expect(s.inbox).toBe(1);
    expect(s.window).toEqual({ since: "2025-01-01", until: "2025-12-31" });
  });
});

describe("export readers (checklists attached)", () => {
  test("readItemForExport attaches checklist items to a todo", () => {
    const item = sql.readItemForExport(dbPath, "t-pa");
    expect(item?.checklistItems).toEqual([
      { name: "Step one", done: true },
      { name: "Step two", done: false },
    ]);
  });

  test("a todo without checklist items gets an empty array", () => {
    const item = sql.readItemForExport(dbPath, "t-pb");
    expect(item?.checklistItems).toEqual([]);
  });

  test("readItemForExport on a project carries todos with their checklists", () => {
    const item = sql.readItemForExport(dbPath, "proj-1");
    expect(item?.kind).toBe("project");
    const todos = item?.todos as Array<Record<string, unknown>>;
    expect(todos.map((t) => t.id)).toEqual(["t-pa", "t-pb"]);
    expect(todos[0]!.checklistItems).toEqual([
      { name: "Step one", done: true },
      { name: "Step two", done: false },
    ]);
  });

  test("readProjectForExport resolves by name with todos and checklists", () => {
    const proj = sql.readProjectForExport(dbPath, "Website");
    expect(proj?.name).toBe("Website");
    const todos = proj?.todos as Array<Record<string, unknown>>;
    expect(todos.map((t) => t.id)).toEqual(["t-pa", "t-pb"]);
    expect((todos[0]!.checklistItems as unknown[]).length).toBe(2);
  });

  test("readItemForExport / readProjectForExport return null when missing", () => {
    expect(sql.readItemForExport(dbPath, "nope")).toBeNull();
    expect(sql.readProjectForExport(dbPath, "Ghost")).toBeNull();
  });
});
