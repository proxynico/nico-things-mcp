import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  createRuntime,
  createServer,
  errmsg,
  isSandboxAutomationError,
  LIST_NAMES,
  normalizeThingsJson,
  type RuntimeInspection,
  type StatsResult,
  type StatsWindow,
  type ThingsRuntime,
  verifyThingsAccess,
} from "./index";
import {
  renderArea,
  renderList,
  renderProject,
  renderTodo,
  type MdProject,
  type MdTodo,
} from "./markdown";

type Call = {
  body: string;
  args: Record<string, unknown> | undefined;
  signal?: AbortSignal;
};

function createMockApp({
  token = "token",
  jxa,
  quietUrl,
  quietJson,
  fastListRead,
  sortListItems,
  statsQuery,
  inspect,
}: {
  token?: string;
  jxa?: (body: string, args?: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<string> | string;
  quietUrl?: (path: string, params: Record<string, string | undefined>, options?: { signal?: AbortSignal }) => Promise<void> | void;
  quietJson?: (operations: Array<Record<string, unknown>>, reveal?: boolean, options?: { signal?: AbortSignal }) => Promise<void> | void;
  fastListRead?: (
    list: string,
    options?: {
      limit?: number;
      offset?: number;
      completed_after?: string;
      completed_before?: string;
    },
    callOptions?: { signal?: AbortSignal },
  ) => Promise<string | null> | string | null;
  sortListItems?: (list: string, items: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
  statsQuery?: (window: StatsWindow) => Promise<StatsResult | null> | StatsResult | null;
  inspect?: () => RuntimeInspection;
} = {}) {
  const jxaCalls: Call[] = [];
  const quietCalls: Array<{ path: string; params: Record<string, string | undefined> }> = [];
  const quietJsonCalls: Array<{ operations: Array<Record<string, unknown>>; reveal?: boolean }> = [];
  const statsCalls: Array<{ window: StatsWindow }> = [];

  const runtime: ThingsRuntime = {
    token,
    async jxa(body, args, options) {
      jxaCalls.push({ body, args, signal: options?.signal });
      if (!jxa) return "[]";
      return await jxa(body, args, options);
    },
    async quietUrl(path, params, options) {
      quietCalls.push({ path, params });
      await quietUrl?.(path, params, options);
    },
    async quietJson(operations, reveal, options) {
      quietJsonCalls.push({ operations, reveal });
      await quietJson?.(operations, reveal, options);
    },
    async fastListRead(list, options, callOptions) {
      return (await fastListRead?.(list, options, callOptions)) ?? null;
    },
    sortListItems(list, items) {
      return sortListItems ? sortListItems(list, items) : items;
    },
    async statsQuery(window) {
      statsCalls.push({ window });
      if (!statsQuery) return null;
      return (await statsQuery(window)) ?? null;
    },
    inspect() {
      return inspect
        ? inspect()
        : {
            appPath: "/Applications/Things3.app",
            appPathExists: true,
            fastReadsEnabled: true,
            dbPath: null,
          };
    },
  };

  const { tools } = createServer(runtime);
  return { tools, jxaCalls, quietCalls, quietJsonCalls, statsCalls };
}

async function callTool(tool: unknown, args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return await (tool as (args: Record<string, unknown>, extra: unknown) => Promise<unknown>)(args, extra);
}

function textOf(result: unknown) {
  return (result as { content: Array<{ text: string }> }).content[0]?.text;
}

function isError(result: unknown) {
  return Boolean((result as { isError?: boolean }).isError);
}

function parseToolInput(tool: { inputSchema?: unknown }, input: unknown): unknown {
  const schema = tool.inputSchema;
  if (
    schema == null ||
    typeof schema !== "object" ||
    !("parse" in schema) ||
    typeof schema.parse !== "function"
  ) {
    throw new Error("Tool input schema is not parsable");
  }
  return schema.parse(input);
}

describe("runtime", () => {
  test("errmsg prefers stderr and strips osascript wrapper", () => {
    const error = Object.assign(new Error("fallback"), {
      stderr: "execution error: Missing permission (-1743)\n",
    });
    expect(errmsg(error)).toBe("Missing permission");
    expect(errmsg("plain")).toBe("plain");
  });

  test("stats day windows use local calendar boundaries", () => {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        [
          'import { isoDayToUnixStart, isoDayToUnixEnd } from "./src/shared.ts";',
          'console.log(JSON.stringify([isoDayToUnixStart("2026-04-23"), isoDayToUnixEnd("2026-04-23")]));',
        ].join(" "),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, TZ: "Asia/Hong_Kong" },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([1776873600, 1776959999]);
  });

  test("jxa builds the osascript invocation", async () => {
    const calls: Array<{ file: string; args: string[]; options?: { signal?: AbortSignal } }> = [];
    const controller = new AbortController();
    const runtime = createRuntime({
      token: "token",
      execFn: async (file, args, options) => {
        calls.push({ file, args, options });
        return { stdout: "  ok  " };
      },
    });

    const result = await runtime.jxa("return JSON.stringify(P);", { hello: "world" }, { signal: controller.signal });
    expect(result).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("osascript");
    expect(calls[0]?.args[0]).toBe("-l");
    expect(calls[0]?.args[1]).toBe("JavaScript");
    expect(calls[0]?.args[3]).toContain('var app = Application("/Applications/Things3.app");');
    expect(calls[0]?.args[4]).toBe(JSON.stringify({ hello: "world" }));
    expect(calls[0]?.options?.signal).toBe(controller.signal);
  });

  test("quietUrl encodes params and keeps Things in the background", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runtime = createRuntime({
      token: "token",
      execFn: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "" };
      },
    });

    await runtime.quietUrl("show", {
      query: "Today & Next",
      id: "abc/123",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[3]).toContain("things:///show?query=Today%20%26%20Next&id=abc%2F123");
    expect(calls[0]?.args[3]).toContain("c.activates = false;");
  });

  test("quietJson dispatches the JSON endpoint and auth token for updates", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runtime = createRuntime({
      token: "token",
      execFn: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "" };
      },
    });

    await runtime.quietJson([
      {
        type: "to-do",
        operation: "update",
        id: "1",
        attributes: { when: "someday" },
      },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[3]).toContain("things:///json?");
    expect(calls[0]?.args[3]).toContain("auth-token=token");
    expect(calls[0]?.args[3]).toContain("%22operation%22%3A%22update%22");
  });

  test("detects sandboxed Apple Events failures", () => {
    const sandboxError = Object.assign(new Error("fallback"), {
      stderr:
        "Connection Invalid error for service com.apple.hiservices-xpcservice.\nError received in message reply handler: Connection invalid\n",
    });
    expect(isSandboxAutomationError(sandboxError)).toBeTrue();
    expect(isSandboxAutomationError(new Error("boom"))).toBeFalse();
  });

  test("verifies Things access with a read-only startup probe", async () => {
    let seenBody = "";
    const runtime: ThingsRuntime = {
      token: "token",
      async jxa(body) {
        seenBody = body;
        return '["Inbox","Today"]';
      },
      async quietUrl() {},
      async quietJson() {},
      async fastListRead() { return null; },
      sortListItems(_list, items) { return items; },
      async statsQuery() { return null; },
      inspect() {
        return {
          appPath: "/Applications/Things3.app",
          appPathExists: true,
          fastReadsEnabled: true,
          dbPath: null,
        };
      },
    };

    await verifyThingsAccess(runtime);
    expect(seenBody).toContain("app.lists().map");
  });

  test("rewrites sandbox startup failures into a clear message", async () => {
    const runtime: ThingsRuntime = {
      token: "token",
      async jxa() {
        throw Object.assign(new Error("fallback"), {
          stderr:
            "Connection Invalid error for service com.apple.hiservices-xpcservice.\nError received in message reply handler: Connection invalid\n",
        });
      },
      async quietUrl() {},
      async quietJson() {},
      async fastListRead() { return null; },
      sortListItems(_list, items) { return items; },
      async statsQuery() { return null; },
      inspect() {
        return {
          appPath: "/Applications/Things3.app",
          appPathExists: true,
          fastReadsEnabled: true,
          dbPath: null,
        };
      },
    };

    expect(verifyThingsAccess(runtime)).rejects.toThrow(
      "Things 3 automation is blocked by the current sandbox. Run cositas outside the Codex sandbox or another restricted osascript environment.",
    );
  });

  test("rewrites non-sandbox startup failures without hiding the cause", async () => {
    const runtime: ThingsRuntime = {
      token: "token",
      async jxa() {
        throw new Error("Application can't be found.");
      },
      async quietUrl() {},
      async quietJson() {},
      async fastListRead() { return null; },
      sortListItems(_list, items) { return items; },
      async statsQuery() { return null; },
      inspect() {
        return {
          appPath: "/Applications/Things3.app",
          appPathExists: true,
          fastReadsEnabled: true,
          dbPath: null,
        };
      },
    };

    expect(verifyThingsAccess(runtime)).rejects.toThrow(
      "Things 3 startup check failed: Application can't be found.",
    );
  });
});

describe("read", () => {
  test("requires exactly one selector", async () => {
    const { tools } = createMockApp();
    const result = await callTool(tools.read.handler, {});
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("Provide exactly one of list, project, area, or id");
  });

  test("rejects multiple selectors", async () => {
    const { tools } = createMockApp();
    const result = await callTool(tools.read.handler, { list: "today", id: "x" });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("Provide exactly one of list, project, area, or id");
  });

  test("reads an item by id through the shared detail script", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => '{"id":"1"}',
    });
    const controller = new AbortController();

    const result = await callTool(tools.read.handler, { id: "1" }, { signal: controller.signal });
    expect(textOf(result)).toBe('{"id":"1"}');
    expect(jxaCalls).toHaveLength(1);
    expect(jxaCalls[0]?.body).toContain("toDoChecklistItems");
    expect(jxaCalls[0]?.args).toEqual({ id: "1" });
    expect(jxaCalls[0]?.signal).toBe(controller.signal);
  });

  test("maps built-in list names", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => "[]",
    });

    await callTool(tools.read.handler, { list: "today" });
    expect(jxaCalls[0]?.args).toEqual({
      n: LIST_NAMES.today,
      completedAfter: null,
      completedBefore: null,
    });
  });

  test("built-in list reads include projects as well as todos", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => "[]",
    });

    await callTool(tools.read.handler, { list: "today" });
    expect(jxaCalls[0]?.body).toContain("list.projects().map(projectOf)");
    expect(jxaCalls[0]?.body).toContain("todos.concat(projects)");
  });

  test("built-in list reads pass merged items through the sorter", async () => {
    const { tools } = createMockApp({
      jxa: async () => '[{"id":"todo-1","kind":"todo"},{"id":"proj-1","kind":"project"}]',
      sortListItems: (list, items) => {
        expect(list).toBe("today");
        expect(items).toEqual([
          { id: "todo-1", kind: "todo" },
          { id: "proj-1", kind: "project" },
        ]);
        return [...items].reverse();
      },
    });

    const result = await callTool(tools.read.handler, { list: "today" });
    expect(textOf(result)).toBe('[{"id":"proj-1","kind":"project"},{"id":"todo-1","kind":"todo"}]');
  });

  test("passes pagination and completion window through to list reads", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => "[]",
    });

    await callTool(tools.read.handler, {
      list: "logbook",
      limit: 25,
      offset: 50,
      completed_after: "2026-04-01",
      completed_before: "2026-04-06",
    });

    expect(jxaCalls[0]?.body).toContain("todos.concat(projects)");
    expect(jxaCalls[0]?.body).toContain("P.completedAfter || P.completedBefore");
    expect(jxaCalls[0]?.args).toEqual({
      n: LIST_NAMES.logbook,
      completedAfter: "2026-04-01",
      completedBefore: "2026-04-06",
    });
  });

  test("applies built-in list pagination after sorting the full result set", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () =>
        '[{"id":"todo-1","kind":"todo"},{"id":"todo-2","kind":"todo"},{"id":"proj-1","kind":"project"}]',
      sortListItems: (_list, items) => [items[2]!, items[0]!, items[1]!],
    });

    const result = await callTool(tools.read.handler, {
      list: "today",
      limit: 1,
      offset: 1,
    });

    expect(textOf(result)).toBe('[{"id":"todo-1","kind":"todo"}]');
    expect(jxaCalls[0]?.args).toEqual({
      n: LIST_NAMES.today,
      completedAfter: null,
      completedBefore: null,
    });
  });

  test("uses fast list reads for heavy built-in lists when available", async () => {
    const { tools, jxaCalls } = createMockApp({
      fastListRead: async (list, options) => {
        expect(list).toBe("logbook");
        expect(options).toEqual({
          limit: 10,
          offset: 20,
          completed_after: "2026-04-01",
          completed_before: "2026-04-06",
        });
        return '[{"kind":"project","id":"p1"},{"kind":"todo","id":"t1"}]';
      },
    });

    const result = await callTool(tools.read.handler, {
      list: "logbook",
      limit: 10,
      offset: 20,
      completed_after: "2026-04-01",
      completed_before: "2026-04-06",
    });

    expect(textOf(result)).toBe('[{"kind":"project","id":"p1"},{"kind":"todo","id":"t1"}]');
    expect(jxaCalls).toHaveLength(0);
  });

  test("uses fast list reads for today and inbox so JXA quirks don't starve them", async () => {
    const seen: string[] = [];
    const { tools, jxaCalls } = createMockApp({
      fastListRead: async (list) => {
        seen.push(list);
        if (list === "today") return '[{"kind":"todo","id":"t1","name":"Do"}]';
        if (list === "inbox") return '[]';
        return null;
      },
    });

    const todayResult = await callTool(tools.read.handler, { list: "today" });
    expect(textOf(todayResult)).toBe('[{"kind":"todo","id":"t1","name":"Do"}]');

    const inboxResult = await callTool(tools.read.handler, { list: "inbox" });
    expect(textOf(inboxResult)).toBe("[]");

    expect(seen).toEqual(["today", "inbox"]);
    expect(jxaCalls).toHaveLength(0);
  });

  test("defaults built-in list reads to a bounded page", async () => {
    const { tools } = createMockApp({
      fastListRead: async (_list, options) => {
        expect(options?.limit).toBe(100);
        expect(options?.offset).toBe(0);
        return "[]";
      },
    });

    await callTool(tools.read.handler, { list: "today" });
  });

  test("lists open projects, areas, and tags", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => "[]",
    });

    await callTool(tools.read.handler, { list: "projects" });
    await callTool(tools.read.handler, { list: "areas" });
    await callTool(tools.read.handler, { list: "tags" });

    expect(jxaCalls[0]?.body).toContain('p.status()==="open"');
    expect(jxaCalls[1]?.body).toContain("app.areas().map");
    expect(jxaCalls[2]?.body).toContain("app.tags().map");
  });

  test("reads a project by exact name", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => "[]",
    });

    await callTool(tools.read.handler, { project: "Launch" });
    expect(jxaCalls[0]?.body).toContain("app.projects.byName(P.n); p.id();");
    expect(jxaCalls[0]?.args).toEqual({
      n: "Launch",
      limit: null,
      offset: 0,
      completedAfter: null,
      completedBefore: null,
    });
  });

  test("reads an area by exact area match", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => "[]",
    });

    await callTool(tools.read.handler, { area: "Work" });
    expect(jxaCalls[0]?.body).toContain("p.area().name() === target");
    expect(jxaCalls[0]?.args).toEqual({ n: "Work" });
  });

  test("falls back to JXA when a direct SQLite read fails", async () => {
    const { tools, jxaCalls } = createMockApp({
      inspect: () => ({
        appPath: "/Applications/Things3.app",
        appPathExists: true,
        fastReadsEnabled: true,
        dbPath: "/missing/Things.sqlite",
      }),
      jxa: async () => '[{"id":"todo-1","kind":"todo","name":"Fallback"}]',
      sortListItems: (_list, items) => items,
    });

    const result = await callTool(tools.read.handler, { list: "today" });

    expect(isError(result)).toBeFalse();
    expect(textOf(result)).toContain('"Fallback"');
    expect(jxaCalls).toHaveLength(1);
  });

  test("returns read errors from jxa", async () => {
    const { tools } = createMockApp({
      jxa: async () => {
        throw new Error("boom");
      },
    });

    const result = await callTool(tools.read.handler, { list: "today" });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("boom");
  });
});

describe("doctor", () => {
  test("reports a healthy runtime when access, token, and fast reads are available", async () => {
    const { tools } = createMockApp({
      jxa: async () => '["Inbox","Today"]',
      fastListRead: async () => "[]",
      inspect: () => ({
        appPath: "/Applications/Things3.app",
        appPathExists: true,
        fastReadsEnabled: true,
        dbPath: "/tmp/main.sqlite",
      }),
    });

    const result = await callTool(tools.doctor.handler, {});
    const report = JSON.parse(textOf(result) ?? "{}") as {
      ok: boolean;
      checks: Record<string, { ok: boolean; message: string; available?: boolean }>;
    };

    expect(report.ok).toBeTrue();
    expect(report.checks.app_path?.ok).toBeTrue();
    expect(report.checks.auth_token?.ok).toBeTrue();
    expect(report.checks.things_access?.ok).toBeTrue();
    expect(report.checks.fast_reads?.ok).toBeTrue();
    expect(report.checks.fast_reads?.available).toBeTrue();
  });

  test("reports missing token and startup failures without crashing", async () => {
    const { tools } = createMockApp({
      token: "",
      jxa: async () => {
        throw new Error("Application can't be found.");
      },
      inspect: () => ({
        appPath: "/Applications/MissingThings.app",
        appPathExists: false,
        fastReadsEnabled: true,
        dbPath: null,
      }),
    });

    const result = await callTool(tools.doctor.handler, {});
    const report = JSON.parse(textOf(result) ?? "{}") as {
      ok: boolean;
      checks: Record<string, { ok: boolean; message: string }>;
    };

    expect(report.ok).toBeFalse();
    expect(report.checks.app_path?.ok).toBeFalse();
    expect(report.checks.auth_token?.ok).toBeFalse();
    expect(report.checks.things_access?.ok).toBeFalse();
    expect(report.checks.things_access?.message).toBe("Things 3 startup check failed: Application can't be found.");
    expect(report.checks.fast_reads?.ok).toBeTrue();
  });

  test("stays healthy overall when read access works but write auth is not configured", async () => {
    const { tools } = createMockApp({
      token: "",
      jxa: async () => '["Inbox","Today"]',
      inspect: () => ({
        appPath: "/Applications/Things3.app",
        appPathExists: true,
        fastReadsEnabled: true,
        dbPath: null,
      }),
    });

    const result = await callTool(tools.doctor.handler, {});
    const report = JSON.parse(textOf(result) ?? "{}") as {
      ok: boolean;
      checks: Record<string, { ok: boolean; message: string }>;
    };

    expect(report.ok).toBeTrue();
    expect(report.checks.auth_token?.ok).toBeFalse();
    expect(report.checks.things_access?.ok).toBeTrue();
  });

  test("fails overall when configured fast reads are broken", async () => {
    const { tools } = createMockApp({
      jxa: async () => '["Inbox","Today"]',
      fastListRead: async () => {
        throw new Error("database is locked");
      },
      inspect: () => ({
        appPath: "/Applications/Things3.app",
        appPathExists: true,
        fastReadsEnabled: true,
        dbPath: "/tmp/main.sqlite",
      }),
    });

    const result = await callTool(tools.doctor.handler, {});
    const report = JSON.parse(textOf(result) ?? "{}") as {
      ok: boolean;
      checks: Record<string, { ok: boolean; message: string }>;
    };

    expect(report.ok).toBeFalse();
    expect(report.checks.things_access?.ok).toBeTrue();
    expect(report.checks.fast_reads?.ok).toBeFalse();
    expect(report.checks.fast_reads?.message).toBe("database is locked");
  });
});

describe("normalization", () => {
  test("normalizes terminal dates to match the current status across nested items", () => {
    const normalized = JSON.parse(
      normalizeThingsJson(
        JSON.stringify([
          {
            id: "done",
            status: "completed",
            completionDate: "2026-04-16T11:23:18.000Z",
            cancellationDate: "2026-04-16T11:23:18.000Z",
          },
          {
            id: "canceled",
            status: "canceled",
            completionDate: "2026-04-16T11:23:18.000Z",
            cancellationDate: null,
          },
          {
            id: "open",
            status: "open",
            completionDate: "2026-04-16T11:23:18.000Z",
            cancellationDate: "2026-04-16T11:23:18.000Z",
          },
          {
            id: "project",
            status: "completed",
            completionDate: null,
            cancellationDate: "2026-04-16T11:23:18.000Z",
            todos: [
              {
                id: "nested",
                status: "canceled",
                completionDate: "2026-04-16T11:23:18.000Z",
                cancellationDate: null,
              },
            ],
          },
        ]),
      ),
    ) as Array<Record<string, unknown>>;

    expect(normalized).toEqual([
      {
        id: "done",
        status: "completed",
        completionDate: "2026-04-16T11:23:18.000Z",
        cancellationDate: null,
      },
      {
        id: "canceled",
        status: "canceled",
        completionDate: null,
        cancellationDate: "2026-04-16T11:23:18.000Z",
      },
      {
        id: "open",
        status: "open",
        completionDate: null,
        cancellationDate: null,
      },
      {
        id: "project",
        status: "completed",
        completionDate: "2026-04-16T11:23:18.000Z",
        cancellationDate: null,
        todos: [
          {
            id: "nested",
            status: "canceled",
            completionDate: null,
            cancellationDate: "2026-04-16T11:23:18.000Z",
          },
        ],
      },
    ]);
  });
});

describe("search", () => {
  test("requires at least one filter", async () => {
    const { tools } = createMockApp();
    const result = await callTool(tools.search.handler, {});
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("Provide query or tag");
  });

  test("passes query and tag filters through to jxa", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => "[]",
    });

    await callTool(tools.search.handler, { query: "ship", tag: "ops" });
    expect(jxaCalls[0]?.args).toEqual({ q: "ship", t: "ops", limit: 100, offset: 0 });
    expect(jxaCalls[0]?.body).toContain('app.toDos.whose({name: {_contains: P.q}})()');
    expect(jxaCalls[0]?.body).toContain("return tagsOf(t).some(function(tagName)");
    expect(jxaCalls[0]?.body).toContain("results.slice(start, start + P.limit)");
  });

  test("allows search callers to page within bounded limits", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => "[]",
    });

    await callTool(tools.search.handler, { query: "ship", limit: 25, offset: 50 });
    expect(jxaCalls[0]?.args).toEqual({ q: "ship", t: null, limit: 25, offset: 50 });
    expect(() => parseToolInput(tools.search, { query: "ship", limit: 501 })).toThrow();
  });

  test("uses shared tag fallback logic for tag-only searches", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => "[]",
    });

    await callTool(tools.search.handler, { tag: "ops" });
    expect(jxaCalls[0]?.body).toContain("return tagsOf(t).some(function(tagName)");
  });

  test("returns search errors from jxa", async () => {
    const { tools } = createMockApp({
      jxa: async () => {
        throw new Error("search failed");
      },
    });

    const result = await callTool(tools.search.handler, { query: "ship" });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("search failed");
  });
});

describe("add_todo", () => {
  test("exposes strict date validation", () => {
    const { tools } = createMockApp();
    expect(() => parseToolInput(tools.add_todo, { title: "x", when: "later" })).toThrow();
    expect(() => parseToolInput(tools.add_todo, { title: "x", deadline: "2026-4-1" })).toThrow();
    expect(() => parseToolInput(tools.add_todo, { title: "x", deadline: "2026-99-99" })).toThrow();
    expect(() => parseToolInput(tools.add_todo, { title: "x", when: "2026-04-01" })).not.toThrow();
  });

  test("creates a todo without fallback when only jxa features are used", async () => {
    const { tools, jxaCalls, quietCalls, quietJsonCalls } = createMockApp({
      jxa: async () => '{"id":"todo-1","name":"Draft","status":"open"}',
    });

    const result = await callTool(tools.add_todo.handler, { title: "Draft", list: "Roadmap" });
    expect(textOf(result)).toBe('{"id":"todo-1","name":"Draft","status":"open"}');
    expect(jxaCalls[0]?.body).toContain("project.id();");
    expect(quietCalls).toHaveLength(0);
    expect(quietJsonCalls).toHaveLength(0);
  });

  test("requires auth before special-when, checklist, or comma-tag patching", async () => {
    const { tools, jxaCalls } = createMockApp({ token: "" });
    const result = await callTool(tools.add_todo.handler, {
      title: "Draft",
      tags: ["ops,urgent"],
    });

    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("THINGS_AUTH_TOKEN is required for this operation");
    expect(jxaCalls).toHaveLength(0);
  });

  test("applies json fallback and re-reads the created todo", async () => {
    let callIndex = 0;
    const { tools, jxaCalls, quietJsonCalls } = createMockApp({
      jxa: async () => {
        callIndex += 1;
        return callIndex === 1
          ? '{"id":"todo-1","name":"Draft","status":"open"}'
          : '{"id":"todo-1","name":"Draft","checklistItems":[{"name":"A","done":false}]}';
      },
    });

    const result = await callTool(tools.add_todo.handler, {
      title: "Draft",
      when: "someday",
      checklist_items: ["A"],
    });

    expect(textOf(result)).toContain('"checklistItems"');
    expect(quietJsonCalls).toEqual([
      {
        operations: [
          {
            type: "to-do",
            operation: "update",
            id: "todo-1",
            attributes: {
              when: "someday",
              "checklist-items": [
                {
                  type: "checklist-item",
                  attributes: { title: "A" },
                },
              ],
            },
          },
        ],
        reveal: undefined,
      },
    ]);
    expect(jxaCalls).toHaveLength(2);
  });
});

describe("add_project", () => {
  test("creates a project and validates the target area lookup in jxa", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => '{"id":"proj-1","name":"Launch","status":"open"}',
    });

    await callTool(tools.add_project.handler, {
      title: "Launch",
      area: "Work",
      todos: ["Ship it"],
    });

    expect(jxaCalls[0]?.body).toContain("area.id();");
    expect(jxaCalls[0]?.body).toContain("t.project = proj;");
  });

  test("uses json fallback for special-when project patches and re-reads", async () => {
    let callIndex = 0;
    const { tools, quietJsonCalls } = createMockApp({
      jxa: async () => {
        callIndex += 1;
        return callIndex === 1
          ? '{"id":"proj-1","name":"Launch","status":"open"}'
          : '{"id":"proj-1","name":"Launch","status":"open","todos":[]}';
      },
    });

    const result = await callTool(tools.add_project.handler, {
      title: "Launch",
      when: "evening",
    });

    expect(textOf(result)).toContain('"todos"');
    expect(quietJsonCalls).toEqual([
      {
        operations: [
          {
            type: "project",
            operation: "update",
            id: "proj-1",
            attributes: {
              when: "evening",
            },
          },
        ],
        reveal: undefined,
      },
    ]);
  });

  test("returns project creation errors", async () => {
    const { tools } = createMockApp({
      jxa: async () => {
        throw new Error("project failed");
      },
    });

    const result = await callTool(tools.add_project.handler, { title: "Launch" });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("project failed");
  });
});

describe("update", () => {
  test("rejects an id-only update before invoking Things", async () => {
    const { tools, jxaCalls } = createMockApp();

    const result = await callTool(tools.update.handler, { id: "1" });

    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("Provide at least one field to update");
    expect(jxaCalls).toHaveLength(0);
  });

  test("rejects an empty update title before invoking Things", async () => {
    const { tools, jxaCalls } = createMockApp();

    const result = await callTool(tools.update.handler, { id: "1", title: "" });

    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("title must not be empty");
    expect(jxaCalls).toHaveLength(0);
  });

  test("accepts empty deadline to clear an item", () => {
    const { tools } = createMockApp();
    expect(() => parseToolInput(tools.update, { id: "1", deadline: "" })).not.toThrow();
    expect(() => parseToolInput(tools.update, { id: "1", deadline: "tomorrow" })).toThrow();
    expect(() => parseToolInput(tools.update, { id: "1", when: "" })).not.toThrow();
  });

  test("returns the updated item directly when no special fallback is needed", async () => {
    const { tools, jxaCalls, quietCalls, quietJsonCalls } = createMockApp({
      jxa: async () => '{"kind":"todo","item":{"id":"1","name":"Updated"}}',
    });

    const result = await callTool(tools.update.handler, {
      id: "1",
      title: "Updated",
      list: "Roadmap",
    });

    expect(textOf(result)).toBe('{"id":"1","name":"Updated"}');
    expect(jxaCalls[0]?.body).toContain('return JSON.stringify({kind: type, item:');
    expect(jxaCalls[0]?.body).toContain("project.id();");
    expect(quietCalls).toHaveLength(0);
    expect(quietJsonCalls).toHaveLength(0);
  });

  test("uses json for project special-when updates", async () => {
    let callIndex = 0;
    const { tools, quietJsonCalls, jxaCalls } = createMockApp({
      jxa: async () => {
        callIndex += 1;
        return callIndex === 1
          ? '{"kind":"project","item":{"id":"proj-1","name":"Launch"}}'
          : '{"id":"proj-1","name":"Launch","todos":[]}';
      },
    });

    const result = await callTool(tools.update.handler, {
      id: "proj-1",
      when: "someday",
    });

    expect(textOf(result)).toContain('"todos"');
    expect(quietJsonCalls).toEqual([
      {
        operations: [
          {
            type: "project",
            operation: "update",
            id: "proj-1",
            attributes: {
              when: "someday",
            },
          },
        ],
        reveal: undefined,
      },
    ]);
    expect(jxaCalls).toHaveLength(2);
  });

  test("sends an empty checklist payload when clearing checklist items", async () => {
    let callIndex = 0;
    const { tools, quietJsonCalls } = createMockApp({
      jxa: async () => {
        callIndex += 1;
        return callIndex === 1
          ? '{"kind":"todo","item":{"id":"1","name":"Updated"}}'
          : '{"id":"1","name":"Updated","checklistItems":[]}';
      },
    });

    const result = await callTool(tools.update.handler, {
      id: "1",
      checklist_items: [],
    });

    expect(textOf(result)).toContain('"checklistItems":[]');
    expect(quietJsonCalls).toEqual([
      {
        operations: [
          {
            type: "to-do",
            operation: "update",
            id: "1",
            attributes: {
              "checklist-items": [],
            },
          },
        ],
        reveal: undefined,
      },
    ]);
  });

  test("clears when via direct update url", async () => {
    let callIndex = 0;
    const { tools, quietCalls } = createMockApp({
      jxa: async () => {
        callIndex += 1;
        return callIndex === 1
          ? '{"kind":"todo","item":{"id":"1","name":"Updated"}}'
          : '{"id":"1","name":"Updated","activationDate":null}';
      },
    });

    const result = await callTool(tools.update.handler, {
      id: "1",
      when: "",
    });

    expect(textOf(result)).toContain('"activationDate":null');
    expect(quietCalls).toEqual([
      {
        path: "update",
        params: {
          "auth-token": "token",
          id: "1",
          when: "",
        },
      },
    ]);
  });

  test("fails before mutating when special fallback lacks auth", async () => {
    const { tools, jxaCalls } = createMockApp({ token: "" });
    const result = await callTool(tools.update.handler, {
      id: "1",
      when: "anytime",
    });

    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("THINGS_AUTH_TOKEN is required for this operation");
    expect(jxaCalls).toHaveLength(0);
  });
});

describe("bulk_update", () => {
  test("requires auth before bulk json updates", async () => {
    const { tools, jxaCalls } = createMockApp({ token: "" });
    const result = await callTool(tools.bulk_update.handler, {
      ids: ["1"],
      title: "Updated",
    });

    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("THINGS_AUTH_TOKEN is required for this operation");
    expect(jxaCalls).toHaveLength(0);
  });

  test("updates many items with one json payload", async () => {
    const { tools, quietJsonCalls } = createMockApp({
      jxa: async () => '[{"id":"1","kind":"todo"},{"id":"2","kind":"project"}]',
    });

    const result = await callTool(tools.bulk_update.handler, {
      ids: ["1", "2"],
      title: "Updated",
      when: "someday",
    });

    expect(textOf(result)).toContain('"updated":true');
    expect(quietJsonCalls).toEqual([
      {
        operations: [
          {
            type: "to-do",
            operation: "update",
            id: "1",
            attributes: {
              title: "Updated",
              when: "someday",
            },
          },
          {
            type: "project",
            operation: "update",
            id: "2",
            attributes: {
              title: "Updated",
              when: "someday",
            },
          },
        ],
        reveal: undefined,
      },
    ]);
  });

  test("normalizes conflicting terminal states to canceled", async () => {
    const { tools, quietJsonCalls } = createMockApp({
      jxa: async () => '[{"id":"1","kind":"todo"}]',
    });

    await callTool(tools.bulk_update.handler, {
      ids: ["1"],
      completed: true,
      canceled: true,
    });

    expect(quietJsonCalls).toEqual([
      {
        operations: [
          {
            type: "to-do",
            operation: "update",
            id: "1",
            attributes: {
              canceled: true,
            },
          },
        ],
        reveal: undefined,
      },
    ]);
  });
});

describe("delete and trash", () => {
  test("marks destructive tools and requires confirmation for empty_trash", async () => {
    const { tools, jxaCalls } = createMockApp();

    expect(tools.delete.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(tools.empty_trash.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(() => parseToolInput(tools.empty_trash, {})).toThrow();

    const result = await callTool(tools.empty_trash.handler, { confirm: false });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("Set confirm=true to permanently empty Things Trash");
    expect(jxaCalls).toHaveLength(0);
  });

  test("deletes an item by id", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => '{"id":"1","kind":"todo","deleted":true}',
    });

    const result = await callTool(tools.delete.handler, { id: "1" });
    expect(textOf(result)).toBe('{"id":"1","kind":"todo","deleted":true}');
    expect(jxaCalls[0]?.body).toContain("app.delete(todo);");
  });

  test("empties trash", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => '{"emptied":true}',
    });

    const result = await callTool(tools.empty_trash.handler, { confirm: true });
    expect(textOf(result)).toBe('{"emptied":true}');
    expect(jxaCalls[0]?.body).toContain("app.emptyTrash()");
  });
});

describe("show", () => {
  test("requires an id or query", async () => {
    const { tools } = createMockApp();
    const result = await callTool(tools.show.handler, {});
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("Provide id or query");
  });

  test("dispatches a background show url", async () => {
    const { tools, quietCalls } = createMockApp();
    const result = await callTool(tools.show.handler, { query: "Launch" });
    expect(textOf(result)).toBe("Showing: Launch");
    expect(quietCalls).toEqual([
      {
        path: "show",
        params: {
          id: undefined,
          query: "Launch",
        },
      },
    ]);
  });

  test("returns show errors from quietUrl", async () => {
    const { tools } = createMockApp({
      quietUrl: async () => {
        throw new Error("show failed");
      },
    });

    const result = await callTool(tools.show.handler, { id: "1" });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("show failed");
  });
});

describe("markdown renderer", () => {
  const fullOpts = { includeNotes: true, includeCompleted: true };
  const openOnly = { includeNotes: true, includeCompleted: false };

  test("renders an open todo with checkbox, due date, and tags", () => {
    const todo: MdTodo = {
      id: "1",
      name: "Write spec",
      status: "open",
      tags: ["docs", "q2"],
      dueDate: "2026-05-01T12:00:00.000Z",
    };
    expect(renderTodo(todo, fullOpts)).toBe("- [ ] Write spec (due 2026-05-01) #docs #q2");
  });

  test("renders completed and canceled todos distinctly", () => {
    const done: MdTodo = { id: "1", name: "Done", status: "completed" };
    const killed: MdTodo = { id: "2", name: "Scrapped", status: "canceled" };
    expect(renderTodo(done, fullOpts)).toBe("- [x] Done");
    expect(renderTodo(killed, fullOpts)).toBe("- [x] Scrapped (canceled)");
  });

  test("indents todo notes by 4 spaces and preserves paragraph breaks", () => {
    const todo: MdTodo = {
      id: "1",
      name: "With notes",
      status: "open",
      notes: "Para one.\n\nPara two with more text.",
    };
    expect(renderTodo(todo, openOnly)).toBe(
      [
        "- [ ] With notes",
        "    Para one.",
        "",
        "    Para two with more text.",
      ].join("\n"),
    );
  });

  test("escapes leading list markers inside notes", () => {
    const todo: MdTodo = {
      id: "1",
      name: "Has bullet in notes",
      status: "open",
      notes: "- this would collapse\n* this too\n1. numbered",
    };
    expect(renderTodo(todo, openOnly)).toBe(
      [
        "- [ ] Has bullet in notes",
        "    \\- this would collapse",
        "    \\* this too",
        "    \\1. numbered",
      ].join("\n"),
    );
  });

  test("renders checklist items under a todo with 4-space indent", () => {
    const todo: MdTodo = {
      id: "1",
      name: "Ship it",
      status: "open",
      checklistItems: [
        { name: "draft", done: true },
        { name: "review", done: false },
      ],
    };
    expect(renderTodo(todo, fullOpts)).toBe(
      [
        "- [ ] Ship it",
        "    - [x] draft",
        "    - [ ] review",
      ].join("\n"),
    );
  });

  test("trusts markdown special chars in names and notes", () => {
    const todo: MdTodo = {
      id: "1",
      name: "[brackets] *asterisks* #hashtag",
      status: "open",
      notes: "*emphasis* and #tag-style text survive",
    };
    expect(renderTodo(todo, openOnly)).toBe(
      [
        "- [ ] [brackets] *asterisks* #hashtag",
        "    *emphasis* and #tag-style text survive",
      ].join("\n"),
    );
  });

  test("renders a project with frontmatter, heading, notes, and todos", () => {
    const project: MdProject = {
      kind: "project",
      id: "p1",
      name: "Launch",
      status: "open",
      area: "Engineering",
      dueDate: "2026-05-01T00:00:00.000Z",
      tags: ["q2"],
      notes: "Kickoff notes.",
      todos: [
        { id: "t1", name: "Plan", status: "open" },
        { id: "t2", name: "Build", status: "completed" },
      ],
    };
    expect(renderProject(project, openOnly)).toBe(
      [
        "---",
        'project: "Launch"',
        'area: "Engineering"',
        "due: 2026-05-01",
        'tags: ["q2"]',
        "---",
        "",
        "## Launch",
        "",
        "Kickoff notes.",
        "",
        "- [ ] Plan",
        "",
      ].join("\n"),
    );
  });

  test("project rendering includes completed todos when requested", () => {
    const project: MdProject = {
      kind: "project",
      id: "p1",
      name: "Launch",
      status: "open",
      todos: [
        { id: "t1", name: "Plan", status: "open" },
        { id: "t2", name: "Build", status: "completed" },
      ],
    };
    const output = renderProject(project, fullOpts);
    expect(output).toContain("- [ ] Plan");
    expect(output).toContain("- [x] Build");
  });

  test("empty project emits *(empty)*", () => {
    const project: MdProject = {
      kind: "project",
      id: "p1",
      name: "Idle",
      status: "open",
      todos: [],
    };
    expect(renderProject(project, openOnly)).toContain("*(empty)*");
  });

  test("area renders frontmatter per project with ---/--- separators", () => {
    const projects: MdProject[] = [
      { kind: "project", id: "p1", name: "Alpha", status: "open", todoCount: 3 },
      { kind: "project", id: "p2", name: "Beta", status: "open", todoCount: 1 },
    ];
    expect(renderArea("Engineering", projects)).toBe(
      [
        "# Engineering",
        "",
        "---",
        'project: "Alpha"',
        "---",
        "",
        "## Alpha",
        "",
        "*3 open todos*",
        "",
        "---",
        "",
        "---",
        'project: "Beta"',
        "---",
        "",
        "## Beta",
        "",
        "*1 open todo*",
        "",
      ].join("\n"),
    );
  });

  test("empty area emits *(no projects)*", () => {
    expect(renderArea("Quiet", [])).toBe("# Quiet\n\n*(no projects)*\n");
  });

  test("list renders a mix of todos and projects with a leading H1", () => {
    const items: Array<MdTodo | MdProject> = [
      { id: "t1", name: "Buy coffee", status: "open" },
      { kind: "project", id: "p1", name: "Launch", status: "open", todoCount: 5 },
    ];
    expect(renderList("today", items, openOnly)).toBe(
      [
        "# Today",
        "",
        "- [ ] Buy coffee",
        "- [ ] **Launch** (5 todos)",
        "",
      ].join("\n"),
    );
  });

  test("empty list emits *(empty)*", () => {
    expect(renderList("inbox", [], openOnly)).toBe("# Inbox\n\n*(empty)*\n");
  });

  test("YAML frontmatter quotes names containing colons", () => {
    const project: MdProject = {
      kind: "project",
      id: "p1",
      name: "Ship: v2",
      status: "open",
      todos: [],
    };
    expect(renderProject(project, openOnly)).toContain('project: "Ship: v2"');
  });

  test("stable output across repeated renders of the same input", () => {
    const project: MdProject = {
      kind: "project",
      id: "p1",
      name: "Stable",
      status: "open",
      todos: [
        { id: "t1", name: "One", status: "open" },
        { id: "t2", name: "Two", status: "open" },
      ],
    };
    expect(renderProject(project, openOnly)).toBe(renderProject(project, openOnly));
  });
});

describe("export_markdown", () => {
  test("requires exactly one selector", async () => {
    const { tools } = createMockApp();
    const result = await callTool(tools.export_markdown.handler, {});
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("Provide exactly one of list, project, area, or id");
  });

  test("rejects multiple selectors", async () => {
    const { tools } = createMockApp();
    const result = await callTool(tools.export_markdown.handler, {
      list: "today",
      project: "X",
    });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("Provide exactly one of list, project, area, or id");
  });

  test("renders a project by name and filters completed todos by default", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () =>
        JSON.stringify({
          kind: "project",
          id: "p1",
          name: "Launch",
          status: "open",
          area: "Engineering",
          dueDate: null,
          tags: [],
          notes: "",
          todos: [
            { kind: "todo", id: "t1", name: "Open item", status: "open" },
            { kind: "todo", id: "t2", name: "Done item", status: "completed" },
          ],
        }),
    });

    const result = await callTool(tools.export_markdown.handler, { project: "Launch" });
    const text = textOf(result);
    expect(text).toContain("## Launch");
    expect(text).toContain("- [ ] Open item");
    expect(text).not.toContain("Done item");
    expect(jxaCalls[0]?.body).toContain("app.projects.byName(P.n)");
    expect(jxaCalls[0]?.body).toContain("toDoChecklistItems");
  });

  test("renders a project by id with include_completed", async () => {
    const { tools } = createMockApp({
      jxa: async () =>
        JSON.stringify({
          kind: "project",
          id: "p1",
          name: "Launch",
          status: "open",
          todos: [
            { kind: "todo", id: "t1", name: "Open", status: "open" },
            { kind: "todo", id: "t2", name: "Done", status: "completed" },
            { kind: "todo", id: "t3", name: "Killed", status: "canceled" },
          ],
        }),
    });

    const result = await callTool(tools.export_markdown.handler, {
      id: "p1",
      include_completed: true,
    });
    const text = textOf(result);
    expect(text).toContain("- [ ] Open");
    expect(text).toContain("- [x] Done");
    expect(text).toContain("- [x] Killed (canceled)");
  });

  test("renders a bare todo when id resolves to a todo", async () => {
    const { tools } = createMockApp({
      jxa: async () =>
        JSON.stringify({
          kind: "todo",
          id: "t1",
          name: "Standalone",
          status: "open",
          checklistItems: [{ name: "sub", done: false }],
        }),
    });

    const result = await callTool(tools.export_markdown.handler, { id: "t1" });
    const text = textOf(result);
    expect(text).toContain("- [ ] Standalone");
    expect(text).toContain("    - [ ] sub");
  });

  test("renders an area with shallow project summaries", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () =>
        JSON.stringify([
          { kind: "project", id: "p1", name: "Alpha", status: "open", todoCount: 4 },
          { kind: "project", id: "p2", name: "Beta", status: "open", todoCount: 1 },
        ]),
    });

    const result = await callTool(tools.export_markdown.handler, { area: "Engineering" });
    const text = textOf(result);
    expect(text).toContain("# Engineering");
    expect(text).toContain('project: "Alpha"');
    expect(text).toContain('project: "Beta"');
    expect(text).toContain("*4 open todos*");
    expect(text).toContain("*1 open todo*");
    expect(jxaCalls[0]?.body).toContain("p.area().name() === target");
  });

  test("renders a built-in list via fast-read when available", async () => {
    const { tools, jxaCalls } = createMockApp({
      fastListRead: async (list) => {
        expect(list).toBe("logbook");
        return JSON.stringify([
          { kind: "todo", id: "t1", name: "Finished", status: "completed" },
        ]);
      },
    });

    const result = await callTool(tools.export_markdown.handler, {
      list: "logbook",
      include_completed: true,
    });
    const text = textOf(result);
    expect(text).toContain("# Logbook");
    expect(text).toContain("- [x] Finished");
    expect(jxaCalls).toHaveLength(0);
  });

  test("renders logbook completed items by default", async () => {
    const { tools } = createMockApp({
      fastListRead: async () =>
        JSON.stringify([
          { kind: "todo", id: "t1", name: "Finished", status: "completed" },
        ]),
    });

    const result = await callTool(tools.export_markdown.handler, { list: "logbook" });
    const text = textOf(result);
    expect(text).toContain("# Logbook");
    expect(text).toContain("- [x] Finished");
  });

  test("renders an empty list with *(empty)*", async () => {
    const { tools } = createMockApp({
      jxa: async () => "[]",
    });

    const result = await callTool(tools.export_markdown.handler, { list: "inbox" });
    expect(textOf(result)).toBe("# Inbox\n\n*(empty)*\n");
  });

  test("surfaces errors from jxa", async () => {
    const { tools } = createMockApp({
      jxa: async () => {
        throw new Error("not found");
      },
    });

    const result = await callTool(tools.export_markdown.handler, { project: "Missing" });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("not found");
  });
});

describe("stats", () => {
  test("defaults to today-today window and returns mocked counts", async () => {
    const today = new Date();
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    const { tools, statsCalls } = createMockApp({
      statsQuery: async (window) => ({
        window,
        completed: 3,
        canceled: 0,
        created: 5,
        overdue: 2,
        inbox: 4,
        today: 6,
      }),
    });

    const result = await callTool(tools.stats.handler, {});
    const parsed = JSON.parse(textOf(result)!) as StatsResult;
    expect(parsed.window).toEqual({ since: todayIso, until: todayIso });
    expect(parsed.completed).toBe(3);
    expect(parsed.canceled).toBe(0);
    expect(parsed.created).toBe(5);
    expect(parsed.overdue).toBe(2);
    expect(parsed.inbox).toBe(4);
    expect(parsed.today).toBe(6);
    expect(statsCalls).toHaveLength(1);
    expect(statsCalls[0]?.window).toEqual({ since: todayIso, until: todayIso });
  });

  test("passes an explicit window through", async () => {
    const { tools, statsCalls } = createMockApp({
      statsQuery: async (window) => ({
        window,
        completed: 12,
        canceled: 1,
        created: 20,
        overdue: 0,
        inbox: 2,
        today: 3,
      }),
    });

    const result = await callTool(tools.stats.handler, {
      since: "2026-04-16",
      until: "2026-04-22",
    });
    const parsed = JSON.parse(textOf(result)!) as StatsResult;
    expect(parsed.window).toEqual({ since: "2026-04-16", until: "2026-04-22" });
    expect(parsed.completed).toBe(12);
    expect(statsCalls[0]?.window).toEqual({ since: "2026-04-16", until: "2026-04-22" });
  });

  test("defaults since to until when only until is provided", async () => {
    const { tools, statsCalls } = createMockApp({
      statsQuery: async (window) => ({
        window,
        completed: 0,
        canceled: 0,
        created: 0,
        overdue: 0,
        inbox: 0,
        today: 0,
      }),
    });

    await callTool(tools.stats.handler, { until: "2026-04-20" });
    expect(statsCalls[0]?.window).toEqual({ since: "2026-04-20", until: "2026-04-20" });
  });

  test("rejects until < since", async () => {
    const { tools, statsCalls } = createMockApp();
    const result = await callTool(tools.stats.handler, {
      since: "2026-04-22",
      until: "2026-04-16",
    });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("until must be >= since");
    expect(statsCalls).toHaveLength(0);
  });

  test("fails explicitly when the database is unavailable", async () => {
    const { tools } = createMockApp({
      statsQuery: async () => null,
    });

    const result = await callTool(tools.stats.handler, {});
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toContain("stats requires THINGS_FAST_READS=1");
    expect(textOf(result)).toContain("doctor");
  });

  test("allows null inbox/today when JXA is unavailable", async () => {
    const { tools } = createMockApp({
      statsQuery: async (window) => ({
        window,
        completed: 1,
        canceled: 0,
        created: 2,
        overdue: 1,
        inbox: null,
        today: null,
      }),
    });

    const result = await callTool(tools.stats.handler, {});
    const parsed = JSON.parse(textOf(result)!) as StatsResult;
    expect(parsed.inbox).toBeNull();
    expect(parsed.today).toBeNull();
    expect(parsed.completed).toBe(1);
  });

  test("surfaces unexpected statsQuery errors", async () => {
    const { tools } = createMockApp({
      statsQuery: async () => {
        throw new Error("db locked");
      },
    });

    const result = await callTool(tools.stats.handler, {});
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("db locked");
  });
});
