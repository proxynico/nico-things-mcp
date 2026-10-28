import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREATED, createFixtureDb, packDay, STOP_CANCEL, STOP_DONE } from "./fixture";
import * as sql from "./sqlread";

const dir = mkdtempSync(join(tmpdir(), "nico-things-mcp-sqlread-"));
const dbPath = join(dir, "things.sqlite");

beforeAll(() => createFixtureDb(dbPath));
afterAll(() => rmSync(dir, { force: true, recursive: true }));

const ids = (items: Array<Record<string, unknown>> | null) => (items ?? []).map((item) => item.id);

function isoDay(offsetDays: number): string {
  const packed = packDay(offsetDays);
  return `${packed >> 16}-${String((packed >> 12) & 0xf).padStart(2, "0")}-${String((packed >> 7) & 0x1f).padStart(2, "0")}`;
}

describe("readList", () => {
  test("inbox holds only start=0 items", () => {
    expect(ids(sql.readList(dbPath, "inbox"))).toEqual(["t-inbox"]);
  });

  test("today holds due start dates, unconfirmed schedules, and due deadlines, evening last", () => {
    expect(ids(sql.readList(dbPath, "today"))).toEqual([
      "t-today-b",
      "t-today-a",
      "t-unconfirmed",
      "proj-4",
      "t-overdue",
      "t-evening",
    ]);
  });

  test("anytime includes today's items and project todos but not someday projects", () => {
    const items = ids(sql.readList(dbPath, "anytime"));
    expect(items.slice(0, 6)).toEqual(["proj-4", "t-started", "proj-1", "t-ph", "t-pa", "t-pb"]);
    expect(items).toContain("t-unconfirmed");
    expect(items).toContain("t-search");
    expect(items).not.toContain("t-inbox");
    expect(items).not.toContain("t-upcoming");
    expect(items).not.toContain("t-later");
    expect(items).not.toContain("proj-3");
    expect(items).not.toContain("t-dropped");
    expect(items).not.toContain("t-template");
  });

  test("upcoming holds future start dates; someday holds undated start=2 items", () => {
    expect(ids(sql.readList(dbPath, "upcoming"))).toEqual(["t-upcoming"]);
    expect(ids(sql.readList(dbPath, "someday"))).toEqual(["t-someday", "proj-3"]);
  });

  test("logbook returns completed and canceled items, newest first", () => {
    expect(ids(sql.readList(dbPath, "logbook"))).toEqual(["t-log-done", "proj-2", "t-log-cancel"]);
  });

  test("trash returns only trashed items", () => {
    expect(ids(sql.readList(dbPath, "trash"))).toEqual(["t-trash"]);
  });

  test("limit and offset page the result, with or without a limit", () => {
    expect(ids(sql.readList(dbPath, "logbook", { limit: 1, offset: 1 }))).toEqual(["proj-2"]);
    expect(ids(sql.readList(dbPath, "logbook", { offset: 2 }))).toEqual(["t-log-cancel"]);
  });

  test("completed_after and completed_before filter on the stop date", () => {
    const stopDay = new Date(STOP_DONE * 1000);
    const day = `${stopDay.getFullYear()}-${String(stopDay.getMonth() + 1).padStart(2, "0")}-${String(stopDay.getDate()).padStart(2, "0")}`;
    expect(ids(sql.readList(dbPath, "logbook", { completed_after: day }))).toEqual(["t-log-done", "proj-2"]);
    expect(ids(sql.readList(dbPath, "logbook", { completed_before: "2000-01-01" }))).toEqual([]);
  });
});

describe("field mapping", () => {
  test("packed dates decode to the calendar date with no UTC shift", () => {
    const [item] = sql.readList(dbPath, "today", { limit: 1, offset: 1 });
    expect(item?.activationDate).toBe(isoDay(0));
  });

  test("status codes map to completed and canceled with matching terminal dates", () => {
    const byId = Object.fromEntries(sql.readList(dbPath, "logbook").map((item) => [item.id, item]));
    expect(byId["t-log-done"]).toMatchObject({
      status: "completed",
      completionDate: new Date(STOP_DONE * 1000).toISOString(),
      cancellationDate: null,
    });
    expect(byId["t-log-cancel"]).toMatchObject({
      status: "canceled",
      completionDate: null,
      cancellationDate: new Date(STOP_CANCEL * 1000).toISOString(),
    });
  });

  test("todos carry tags in Things order and project/area names; projects carry todoCount", () => {
    const todo = sql.readItem(dbPath, "t-pa");
    expect(todo).toMatchObject({ kind: "todo", tags: ["urgent", "home"], project: "Website", area: null });
    expect(sql.readItem(dbPath, "t-ph")?.project).toBe("Website");
    const project = sql.readItem(dbPath, "proj-1");
    expect(project).toMatchObject({ kind: "project", name: "Website", area: "Work", todoCount: 3, dueDate: isoDay(30) });
  });
});

describe("readItem", () => {
  test("returns a todo with its checklist in order", () => {
    expect(sql.readItem(dbPath, "t-pa")?.checklistItems).toEqual([
      { name: "Step one", done: true },
      { name: "Step two", done: false },
    ]);
    expect(sql.readItem(dbPath, "t-pb")?.checklistItems).toEqual([]);
  });

  test("returns a project with its open todos, heading todos after loose ones", () => {
    const project = sql.readItem(dbPath, "proj-1");
    expect(ids(project?.todos as Array<Record<string, unknown>>)).toEqual(["t-pa", "t-pb", "t-ph"]);
    expect((project?.todos as Array<Record<string, unknown>>)[0]?.checklistItems).toBeUndefined();
    const withChecklists = sql.readItem(dbPath, "proj-1", true);
    expect((withChecklists?.todos as Array<Record<string, unknown>>)[0]?.checklistItems).toHaveLength(2);
  });

  test("returns null for an unknown id or a heading", () => {
    expect(sql.readItem(dbPath, "nope")).toBeNull();
    expect(sql.readItem(dbPath, "head-1")).toBeNull();
  });
});

describe("projects and areas", () => {
  test("readProject resolves a name to the project with todos and checklists", () => {
    const project = sql.readProject(dbPath, "Website");
    expect(project?.id).toBe("proj-1");
    expect((project?.todos as Array<Record<string, unknown>>)[0]?.checklistItems).toHaveLength(2);
    expect(sql.readProject(dbPath, "Missing")).toBeNull();
  });

  test("readProjectTodos pages a project's open todos and returns null for an unknown name", () => {
    expect(ids(sql.readProjectTodos(dbPath, "Website"))).toEqual(["t-pa", "t-pb", "t-ph"]);
    expect(ids(sql.readProjectTodos(dbPath, "Website", { offset: 2 }))).toEqual(["t-ph"]);
    expect(sql.readProjectTodos(dbPath, "Missing")).toBeNull();
  });

  test("readAreaProjects returns the area's open projects", () => {
    expect(ids(sql.readAreaProjects(dbPath, "Work"))).toEqual(["proj-1", "proj-3"]);
    expect(sql.readAreaProjects(dbPath, "Personal")).toEqual([]);
  });

  test("listProjects, listAreas, and listTags enumerate in Things order", () => {
    expect(ids(sql.listProjects(dbPath))).toEqual(["proj-1", "proj-3", "proj-4"]);
    expect(sql.listAreas(dbPath)).toEqual([
      { id: "area-1", name: "Work" },
      { id: "area-2", name: "Personal" },
    ]);
    expect(sql.listTags(dbPath)).toEqual([
      { id: "tag-1", name: "urgent" },
      { id: "tag-2", name: "home" },
    ]);
  });
});

describe("search", () => {
  test("matches open todo titles case-insensitively and filters by tag", () => {
    expect(ids(sql.search(dbPath, { query: "REPORT" }))).toEqual(["t-search"]);
    expect(ids(sql.search(dbPath, { tag: "urgent" }))).toEqual(["t-search", "t-pa"]);
    expect(ids(sql.search(dbPath, { query: "proj", tag: "urgent" }))).toEqual(["t-pa"]);
  });

  test("skips completed and trashed items and treats LIKE wildcards literally", () => {
    expect(sql.search(dbPath, { query: "Logged" })).toEqual([]);
    expect(sql.search(dbPath, { query: "Trashed" })).toEqual([]);
    expect(sql.search(dbPath, { query: "%" })).toEqual([]);
    expect(sql.search(dbPath, { query: "template" })).toEqual([]);
  });

  test("pages results", () => {
    expect(ids(sql.search(dbPath, { tag: "urgent", offset: 1 }))).toEqual(["t-pa"]);
  });
});

describe("stats", () => {
  const createdDay = new Date(CREATED * 1000);
  const day = `${createdDay.getFullYear()}-${String(createdDay.getMonth() + 1).padStart(2, "0")}-${String(createdDay.getDate()).padStart(2, "0")}`;

  test("counts the window and today's snapshot", () => {
    expect(sql.stats(dbPath, { since: "2000-01-01", until: "2099-12-31" })).toEqual({
      window: { since: "2000-01-01", until: "2099-12-31" },
      completed: 3,
      canceled: 1,
      created: 2,
      overdue: 1,
      inbox: 1,
      today: 6,
    });
  });

  test("window excludes completions and creations outside it", () => {
    expect(sql.stats(dbPath, { since: day, until: day })).toMatchObject({ completed: 0, canceled: 0, created: 2 });
  });
});

describe("probe", () => {
  test("passes on a full schema and throws on a partial one", () => {
    expect(() => sql.probe(dbPath)).not.toThrow();
    const partialPath = join(dir, "partial.sqlite");
    const partial = new Database(partialPath, { create: true });
    partial.run("create table TMTask (uuid text)");
    partial.close(false);
    expect(() => sql.probe(partialPath)).toThrow();
  });
});
