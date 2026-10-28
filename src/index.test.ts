import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureDb } from "./fixture";
import { CreateRequests } from "./creates";
import { createServer } from "./index";
import { renderArea, renderList, renderProject, renderTodo, type MdProject, type MdTodo } from "./markdown";
import { createRuntime } from "./runtime";
import { errmsg, isSandboxAutomationError, normalizeThingsValue, type ThingsRuntime } from "./shared";

const dir = mkdtempSync(join(tmpdir(), "nico-things-mcp-tools-"));
const dbPath = join(dir, "things.sqlite");
const partialDbPath = join(dir, "partial.sqlite");
const missingDbPath = join(dir, "missing.sqlite");

beforeAll(() => {
  createFixtureDb(dbPath);
  const partial = new Database(partialDbPath, { create: true });
  partial.run("create table TMTask (uuid text)");
  partial.close(false);
});

afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

const normalizeThingsJson = (text: string) => JSON.stringify(normalizeThingsValue(JSON.parse(text)));

type JxaFn = (body: string, args?: Record<string, unknown>) => Promise<string> | string;

function createMockApp({
  token = "token",
  dbPath = null,
  jxa,
  quietUrl,
}: {
  token?: string;
  dbPath?: string | null;
  jxa?: JxaFn;
  quietUrl?: () => Promise<void> | void;
} = {}) {
  const jxaCalls: Array<{ body: string; args?: Record<string, unknown>; signal?: AbortSignal }> = [];
  const quietCalls: Array<{ path: string; params: Record<string, string | undefined> }> = [];
  const quietJsonCalls: Array<Array<Record<string, unknown>>> = [];

  const runtime: ThingsRuntime = {
    token,
    appPath: "/Applications/Things3.app",
    dbPath,
    async jxa(body, args, options) {
      jxaCalls.push({ body, args, signal: options?.signal });
      return jxa ? await jxa(body, args) : "[]";
    },
    async quietUrl(path, params) {
      quietCalls.push({ path, params });
      await quietUrl?.();
    },
    async quietJson(operations) {
      quietJsonCalls.push(operations);
    },
  };

  const { tools } = createServer(runtime, new CreateRequests({ path: join(dir, `${randomUUID()}.sqlite`) }));
  return { tools, jxaCalls, quietCalls, quietJsonCalls };
}

// Returns the JXA responses in order, repeating the last one.
function sequence(...responses: string[]): JxaFn {
  let index = 0;
  return () => responses[Math.min(index++, responses.length - 1)]!;
}

async function callTool(tool: { handler: unknown }, args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return await (tool.handler as (args: Record<string, unknown>, extra: unknown) => Promise<unknown>)(args, extra);
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
}

function jsonOf(result: unknown): unknown {
  return JSON.parse(textOf(result));
}

function isError(result: unknown) {
  return Boolean((result as { isError?: boolean }).isError);
}

function parseToolInput(tool: { inputSchema?: unknown }, input: unknown): unknown {
  return (tool.inputSchema as { parse(input: unknown): unknown }).parse(input);
}

const ids = (result: unknown) => (jsonOf(result) as Array<{ id: string }>).map((item) => item.id);

describe("runtime", () => {
  test("errmsg prefers stderr and strips the osascript wrapper", () => {
    const error = Object.assign(new Error("fallback"), {
      stderr: "execution error: Missing permission (-1743)\n",
    });
    expect(errmsg(error)).toBe("Missing permission");
    expect(errmsg("plain")).toBe("plain");
  });

  test("errmsg never returns a subprocess command when stderr is empty", () => {
    for (const stderr of ["", " \n"]) {
      const error = Object.assign(new Error("Command failed: osascript private-test-argument"), {
        cmd: "osascript private-test-argument", stderr, signal: "SIGKILL",
      });
      expect(errmsg(error)).not.toContain("private-test-argument");
      expect(errmsg(error)).not.toContain("things://");
      expect(errmsg(error)).not.toContain("osascript");
    }
  });

  test("stats day windows use local calendar boundaries", () => {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        'import { isoDayToUnixStart, isoDayToUnixEnd } from "./src/shared.ts"; console.log(JSON.stringify([isoDayToUnixStart("2026-04-23"), isoDayToUnixEnd("2026-04-23")]));',
      ],
      { cwd: process.cwd(), env: { ...process.env, TZ: "Asia/Hong_Kong" }, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([1776873600, 1776959999]);
  });

  test("jxa runs the body after the shared prelude with arguments as JSON", async () => {
    const calls: Array<{ file: string; args: string[]; options?: { signal?: AbortSignal } }> = [];
    const controller = new AbortController();
    const runtime = createRuntime({
      dbPath: null,
      execFn: async (file, args, options) => {
        calls.push({ file, args, options });
        return { stdout: "  ok  " };
      },
    });

    const result = await runtime.jxa("return JSON.stringify(P);", { hello: "world" }, { signal: controller.signal });
    expect(result).toBe("ok");
    expect(calls[0]?.file).toBe("osascript");
    expect(calls[0]?.args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
    expect(calls[0]?.args[3]).toContain('var app = Application("/Applications/Things3.app");');
    expect(calls[0]?.args[3]).toContain("raw.split(/,\\s*/)");
    expect(calls[0]?.args[3]?.endsWith("return JSON.stringify(P);\n}")).toBeTrue();
    expect(calls[0]?.args[4]).toBe(JSON.stringify({ hello: "world" }));
    expect(calls[0]?.options?.signal).toBe(controller.signal);
  });

  test("quietUrl encodes params and keeps Things in the background", async () => {
    const calls: string[][] = [];
    const runtime = createRuntime({
      dbPath: null,
      execFn: async (_file, args) => {
        calls.push(args);
        return { stdout: "" };
      },
    });

    await runtime.quietUrl("show", { query: "Today & Next", id: "abc/123", skipped: undefined });
    expect(calls[0]?.[3]).toContain("things:///show?query=Today%20%26%20Next&id=abc%2F123\"");
    expect(calls[0]?.[3]).toContain("$.NSWorkspaceLaunchWithoutActivation");
    expect(calls[0]?.[3]).not.toContain("CompletionHandler");
  });

  test("quietJson sends the auth token only for updates", async () => {
    const calls: string[][] = [];
    const runtime = createRuntime({
      token: "token",
      dbPath: null,
      execFn: async (_file, args) => {
        calls.push(args);
        return { stdout: "" };
      },
    });

    await runtime.quietJson([{ type: "to-do", operation: "update", id: "1", attributes: { when: "someday" } }]);
    await runtime.quietJson([{ type: "to-do", attributes: { title: "New" } }]);
    expect(calls[0]?.[3]).toContain("things:///json?auth-token=token&reveal=false&data=");
    expect(calls[0]?.[3]).toContain("%22operation%22%3A%22update%22");
    expect(calls[1]?.[3]).not.toContain("auth-token");
  });

  test("quietJson refuses updates without a token", async () => {
    const runtime = createRuntime({ token: "", dbPath: null, execFn: async () => ({ stdout: "" }) });
    await expect(runtime.quietJson([{ operation: "update" }])).rejects.toThrow("THINGS_AUTH_TOKEN is required");
  });

  test("detects sandboxed Apple Events failures", () => {
    const sandboxError = Object.assign(new Error("fallback"), {
      stderr:
        "Connection Invalid error for service com.apple.hiservices-xpcservice.\nError received in message reply handler: Connection invalid\n",
    });
    expect(isSandboxAutomationError(sandboxError)).toBeTrue();
    expect(isSandboxAutomationError(new Error("boom"))).toBeFalse();
  });
});

describe("read", () => {
  test("requires exactly one selector", async () => {
    const { tools, jxaCalls } = createMockApp();
    for (const args of [{}, { list: "today", id: "x" }]) {
      const result = await callTool(tools.read, args);
      expect(isError(result)).toBeTrue();
      expect(textOf(result)).toBe("Provide exactly one of list, project, area, or id");
    }
    expect(jxaCalls).toHaveLength(0);
  });

  test("reads every selector from SQLite without touching Things", async () => {
    const { tools, jxaCalls } = createMockApp({ dbPath });

    expect(ids(await callTool(tools.read, { list: "today" }))).toEqual([
      "t-today-b",
      "t-today-a",
      "t-unconfirmed",
      "proj-4",
      "t-overdue",
      "t-inbox-due",
      "t-evening",
    ]);
    expect(ids(await callTool(tools.read, { list: "logbook", limit: 1, offset: 1 }))).toEqual(["proj-2"]);
    expect(ids(await callTool(tools.read, { project: "Website" }))).toEqual(["t-pa", "t-pb", "t-ph"]);
    expect(ids(await callTool(tools.read, { area: "Work" }))).toEqual(["proj-1", "proj-3"]);
    expect(ids(await callTool(tools.read, { list: "projects" }))).toEqual(["proj-1", "proj-3", "proj-4"]);
    expect(ids(await callTool(tools.read, { list: "areas" }))).toEqual(["area-1", "area-2"]);
    expect(ids(await callTool(tools.read, { list: "tags" }))).toEqual(["tag-1", "tag-2"]);
    expect(jsonOf(await callTool(tools.read, { id: "t-pa" }))).toMatchObject({
      id: "t-pa",
      checklistItems: [{ name: "Step one", done: true }, { name: "Step two", done: false }],
    });
    expect(jxaCalls).toHaveLength(0);
  });

  test("defaults list reads to a bounded page", async () => {
    const { tools } = createMockApp({
      jxa: async () => JSON.stringify(Array.from({ length: 150 }, (_, index) => ({ id: `t-${index}` }))),
    });
    const result = await callTool(tools.read, { list: "anytime" });
    expect(ids(result)).toHaveLength(100);
    expect(() => parseToolInput(tools.read, { list: "today", limit: 501 })).toThrow();
  });

  test("falls back to JXA for every selector when SQLite fails", async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown> | undefined, string]> = [
      [{ id: "t-1" }, { id: "t-1", childChecklists: false }, "app.projects.byId(P.id)"],
      [{ project: "Launch" }, { name: "Launch" }, "app.projects.byName(P.name)"],
      [{ area: "Work" }, { name: "Work" }, "p.area().name() === P.name"],
      [{ list: "projects" }, undefined, "app.projects()"],
      [{ list: "areas" }, undefined, "app.areas()"],
      [{ list: "tags" }, undefined, "app.tags()"],
      [{ list: "anytime" }, { name: "Anytime" }, "app.lists.byName(P.name)"],
    ];
    for (const dbPathCase of [missingDbPath, partialDbPath, null]) {
      for (const [args, jxaArgs, bodyPart] of cases) {
        const { tools, jxaCalls } = createMockApp({
          dbPath: dbPathCase,
          jxa: async () => (args.id ? '{"id":"t-1"}' : "[]"),
        });
        const result = await callTool(tools.read, args);
        expect(isError(result)).toBeFalse();
        expect(jxaCalls).toHaveLength(1);
        expect(jxaCalls[0]?.args).toEqual(jxaArgs);
        expect(jxaCalls[0]?.body).toContain(bodyPart);
      }
    }
  });

  test("JXA reads by id try projects before todos and pass the abort signal", async () => {
    const { tools, jxaCalls } = createMockApp({ jxa: async () => '{"id":"1"}' });
    const controller = new AbortController();

    await callTool(tools.read, { id: "1" }, { signal: controller.signal });
    const body = jxaCalls[0]?.body ?? "";
    expect(body.indexOf("app.projects.byId")).toBeLessThan(body.indexOf("app.toDos.byId"));
    expect(jxaCalls[0]?.signal).toBe(controller.signal);
  });

  test("JXA list fallback applies the completion window, then pages", async () => {
    const { tools } = createMockApp({
      jxa: async () =>
        JSON.stringify([
          { id: "early", status: "completed", completionDate: "2026-03-31T12:00:00.000Z" },
          { id: "a", status: "completed", completionDate: "2026-04-02T12:00:00.000Z" },
          { id: "b", status: "canceled", cancellationDate: "2026-04-03T12:00:00.000Z" },
          { id: "c", status: "completed", completionDate: "2026-04-04T12:00:00.000Z" },
          { id: "open", status: "open" },
        ]),
    });

    const result = await callTool(tools.read, {
      list: "logbook",
      completed_after: "2026-04-01",
      completed_before: "2026-04-06",
      limit: 2,
      offset: 1,
    });
    expect(ids(result)).toEqual(["b", "c"]);
  });

  test("returns read errors from JXA", async () => {
    const { tools } = createMockApp({
      jxa: async () => {
        throw new Error("boom");
      },
    });
    const result = await callTool(tools.read, { list: "today" });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("boom");
  });
});

describe("doctor", () => {
  type Report = { ok: boolean; checks: Record<string, { ok: boolean; message: string }> };

  async function doctor(options: Parameters<typeof createMockApp>[0]): Promise<Report> {
    const { tools } = createMockApp(options);
    return jsonOf(await callTool(tools.doctor, {})) as Report;
  }

  const jxaWorks = async () => '["Inbox","Today"]';
  const jxaFails = async () => {
    throw new Error("Application can't be found.");
  };

  test("reports SQL reads, JXA reads, and JSON writes as independent checks", async () => {
    const report = await doctor({ dbPath, jxa: jxaWorks });
    expect(report.ok).toBeTrue();
    expect(Object.keys(report.checks)).toEqual(["sql_read", "jxa_read", "json_writes"]);
    expect(Object.values(report.checks).every((check) => check.ok)).toBeTrue();
  });

  test("is unhealthy only when neither read path works", async () => {
    const report = await doctor({ token: "", jxa: jxaFails });
    expect(report.ok).toBeFalse();
    expect(report.checks.jxa_read?.message).toBe("Things startup check failed: Application can't be found.");
    expect(report.checks.json_writes?.ok).toBeFalse();

    expect((await doctor({ token: "", jxa: jxaWorks })).ok).toBeTrue();
    expect((await doctor({ dbPath, jxa: jxaFails })).ok).toBeTrue();
  });

  test("does not report SQL reads healthy for a missing database or an incomplete schema", async () => {
    for (const path of [missingDbPath, partialDbPath]) {
      const report = await doctor({ dbPath: path, jxa: jxaFails });
      expect(report.ok).toBeFalse();
      expect(report.checks.sql_read?.ok).toBeFalse();
    }
  });

  test("explains sandboxed automation failures", async () => {
    const report = await doctor({
      jxa: async () => {
        throw Object.assign(new Error("fallback"), { stderr: "Connection Invalid error for service com.apple.hiservices-xpcservice." });
      },
    });
    expect(report.checks.jxa_read?.message).toBe(
      "Things automation is blocked by the current sandbox. Run the server outside the sandbox.",
    );
  });
});

describe("search", () => {
  test("requires a query or tag", async () => {
    const { tools } = createMockApp();
    const result = await callTool(tools.search, {});
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("Provide query or tag");
  });

  test("searches SQLite when it is available", async () => {
    const { tools, jxaCalls } = createMockApp({ dbPath });
    expect(ids(await callTool(tools.search, { query: "report", tag: "urgent" }))).toEqual(["t-search"]);
    expect(jxaCalls).toHaveLength(0);
  });

  test("falls back to JXA with filters and bounded paging", async () => {
    const { tools, jxaCalls } = createMockApp({ dbPath: missingDbPath });
    await callTool(tools.search, { query: "ship", tag: "ops" });
    await callTool(tools.search, { tag: "ops", limit: 25, offset: 50 });
    expect(jxaCalls[0]?.args).toEqual({ query: "ship", tag: "ops", limit: 100, offset: 0 });
    expect(jxaCalls[1]?.args).toEqual({ query: null, tag: "ops", limit: 25, offset: 50 });
    expect(jxaCalls[0]?.body).toContain("tagsOf(t).some");
    expect(() => parseToolInput(tools.search, { query: "ship", limit: 501 })).toThrow();
  });
});

describe("add_todo", () => {
  test("exposes strict date validation", () => {
    const { tools } = createMockApp();
    expect(() => parseToolInput(tools.add_todo, { title: "x" })).toThrow();
    expect(() => parseToolInput(tools.add_todo, { request_id: randomUUID(), title: "x", when: "later" })).toThrow();
    expect(() => parseToolInput(tools.add_todo, { request_id: randomUUID(), title: "x", deadline: "2026-4-1" })).toThrow();
    expect(() => parseToolInput(tools.add_todo, { request_id: randomUUID(), title: "x", deadline: "2026-99-99" })).toThrow();
    expect(() => parseToolInput(tools.add_todo, { request_id: randomUUID(), title: "x", when: "2026-04-01" })).not.toThrow();
  });

  test("creates a todo with JXA alone when no JSON-only fields are used", async () => {
    const { tools, jxaCalls, quietCalls, quietJsonCalls } = createMockApp({
      token: "",
      jxa: async () => '{"id":"todo-1","name":"Draft","status":"open"}',
    });

    const result = await callTool(tools.add_todo, { request_id: randomUUID(), title: "Draft", list: "Roadmap", checklist_items: [] });
    expect(textOf(result)).toBe('{"id":"todo-1","name":"Draft","status":"open"}');
    expect(jxaCalls[0]?.body).toContain("project.id();");
    expect(quietCalls).toHaveLength(0);
    expect(quietJsonCalls).toHaveLength(0);
  });

  test("requires auth before creating anything that needs a JSON patch", async () => {
    const { tools, jxaCalls } = createMockApp({ token: "" });
    for (const args of [{ tags: ["ops,urgent"] }, { when: "evening" }, { checklist_items: ["A"] }]) {
      const result = await callTool(tools.add_todo, { request_id: randomUUID(), title: "Draft", ...args });
      expect(isError(result)).toBeTrue();
      expect(textOf(result)).toBe("THINGS_AUTH_TOKEN is required for this operation");
    }
    expect(jxaCalls).toHaveLength(0);
  });

  test("patches JSON-only fields after creation and re-reads the todo", async () => {
    const { tools, jxaCalls, quietJsonCalls } = createMockApp({
      jxa: sequence(
        '{"id":"todo-1","name":"Draft","status":"open"}',
        '{"id":"todo-1","name":"Draft","checklistItems":[{"name":"A","done":false}]}',
      ),
    });

    const result = await callTool(tools.add_todo, { request_id: randomUUID(), title: "Draft", when: "someday", checklist_items: ["A"] });
    expect(textOf(result)).toContain('"checklistItems"');
    expect(quietJsonCalls).toEqual([
      [
        {
          type: "to-do",
          operation: "update",
          id: "todo-1",
          attributes: {
            when: "someday",
            "checklist-items": [{ type: "checklist-item", attributes: { title: "A" } }],
          },
        },
      ],
    ]);
    expect(jxaCalls).toHaveLength(2);
    expect(jxaCalls[1]?.args).toEqual({ id: "todo-1" });
  });
});

describe("add_project", () => {
  test("creates a project and validates the target area in JXA", async () => {
    const { tools, jxaCalls } = createMockApp({
      jxa: async () => '{"id":"proj-1","name":"Launch","status":"open"}',
    });

    await callTool(tools.add_project, { request_id: randomUUID(), title: "Launch", area: "Work", todos: ["Ship it"] });
    expect(jxaCalls[0]?.body).toContain("area.id();");
    expect(jxaCalls[1]?.body).toContain("t.project = proj;");
  });

  test("patches special when through JSON and re-reads", async () => {
    const { tools, quietJsonCalls } = createMockApp({
      jxa: sequence('{"id":"proj-1","name":"Launch","status":"open"}', '{"id":"proj-1","todos":[]}'),
    });

    const result = await callTool(tools.add_project, { request_id: randomUUID(), title: "Launch", when: "evening" });
    expect(textOf(result)).toContain('"todos"');
    expect(quietJsonCalls).toEqual([
      [{ type: "project", operation: "update", id: "proj-1", attributes: { when: "evening" } }],
    ]);
  });

  test("returns project creation errors", async () => {
    const { tools } = createMockApp({
      jxa: async () => {
        throw new Error("project failed");
      },
    });

    const result = await callTool(tools.add_project, { request_id: randomUUID(), title: "Launch" });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toContain("Create outcome is uncertain: project failed");
  });
});

describe("update", () => {
  test("waits for a checklist replacement without returning stale SQLite fields", async () => {
    const lagPath = join(dir, "lag.sqlite");
    createFixtureDb(lagPath);
    const { tools } = createMockApp({
      dbPath: lagPath,
      jxa: sequence('{"kind":"todo","item":{"id":"t-pa"}}', '{"kind":"todo","id":"t-pa","name":"Fresh title"}'),
    });
    const flush = setTimeout(() => {
      const db = new Database(lagPath);
      db.run("delete from TMChecklistItem where task = 't-pa'");
      db.run("insert into TMChecklistItem values ('new', 't-pa', 'Replacement', 0, 0)");
      db.close();
    }, 100);
    try {
      const result = await callTool(tools.update, { id: "t-pa", checklist_items: ["Replacement"] });
      expect(jsonOf(result)).toMatchObject({ name: "Fresh title", checklistItems: [{ name: "Replacement", done: false }] });
    } finally {
      clearTimeout(flush);
    }
  });

  test("keeps fresh JXA fields and adds the stored checklist to a write reply", async () => {
    const { tools } = createMockApp({
      dbPath,
      jxa: () => '{"kind":"todo","item":{"kind":"todo","id":"t-pa","name":"Fresh title"}}',
    });
    const result = await callTool(tools.update, { id: "t-pa", title: "Fresh title" });
    expect(jsonOf(result)).toMatchObject({
      name: "Fresh title",
      checklistItems: [{ name: "Step one", done: true }, { name: "Step two", done: false }],
    });
  });

  test("rejects an id-only update or an empty title before invoking Things", async () => {
    const { tools, jxaCalls } = createMockApp();
    const idOnly = await callTool(tools.update, { id: "1" });
    expect(textOf(idOnly)).toBe("Provide at least one field to update");
    const emptyTitle = await callTool(tools.update, { id: "1", title: "" });
    expect(textOf(emptyTitle)).toBe("title must not be empty");
    expect(jxaCalls).toHaveLength(0);
  });

  test("accepts empty strings to clear when and deadline", () => {
    const { tools } = createMockApp();
    expect(() => parseToolInput(tools.update, { id: "1", deadline: "" })).not.toThrow();
    expect(() => parseToolInput(tools.update, { id: "1", deadline: "tomorrow" })).toThrow();
    expect(() => parseToolInput(tools.update, { id: "1", when: "" })).not.toThrow();
  });

  test("returns the updated item directly when JXA covers every field", async () => {
    const { tools, jxaCalls, quietCalls, quietJsonCalls } = createMockApp({
      jxa: async () => '{"kind":"todo","item":{"id":"1","name":"Updated"}}',
    });

    const result = await callTool(tools.update, { id: "1", title: "Updated", list: "Roadmap" });
    expect(textOf(result)).toBe('{"id":"1","name":"Updated"}');
    const body = jxaCalls[0]?.body ?? "";
    expect(body).toContain("project.id();");
    expect(body.indexOf("app.projects.byId")).toBeLessThan(body.indexOf("app.toDos.byId"));
    expect(quietCalls).toHaveLength(0);
    expect(quietJsonCalls).toHaveLength(0);
  });

  test("uses JSON for project special-when updates", async () => {
    const { tools, quietJsonCalls, jxaCalls } = createMockApp({
      jxa: sequence('{"kind":"project","item":{"id":"proj-1"}}', '{"id":"proj-1","todos":[]}'),
    });

    const result = await callTool(tools.update, { id: "proj-1", when: "someday" });
    expect(textOf(result)).toContain('"todos"');
    expect(quietJsonCalls).toEqual([
      [{ type: "project", operation: "update", id: "proj-1", attributes: { when: "someday" } }],
    ]);
    expect(jxaCalls).toHaveLength(2);
  });

  test("sends an empty checklist to clear checklist items", async () => {
    const { tools, quietJsonCalls } = createMockApp({
      jxa: sequence('{"kind":"todo","item":{"id":"1"}}', '{"id":"1","checklistItems":[]}'),
    });

    await callTool(tools.update, { id: "1", checklist_items: [] });
    expect(quietJsonCalls).toEqual([[{ type: "to-do", operation: "update", id: "1", attributes: { "checklist-items": [] } }]]);
  });

  test("clears when and deadline through the update URL and still applies a JSON patch", async () => {
    const { tools, quietCalls, quietJsonCalls } = createMockApp({
      jxa: sequence('{"kind":"todo","item":{"id":"1"}}', '{"id":"1","activationDate":null}'),
    });

    const result = await callTool(tools.update, { id: "1", when: "", deadline: "", checklist_items: ["A"] });
    expect(textOf(result)).toContain('"activationDate":null');
    expect(quietCalls).toEqual([
      { path: "update", params: { "auth-token": "token", id: "1", when: "", deadline: "" } },
    ]);
    expect(quietJsonCalls).toHaveLength(1);
  });

  test("fails before mutating when a JSON-only field lacks auth", async () => {
    const { tools, jxaCalls } = createMockApp({ token: "" });
    for (const args of [{ when: "anytime" }, { when: "" }, { deadline: "" }, { checklist_items: [] }]) {
      const result = await callTool(tools.update, { id: "1", ...args });
      expect(textOf(result)).toBe("THINGS_AUTH_TOKEN is required for this operation");
    }
    expect(jxaCalls).toHaveLength(0);
  });
});

describe("bulk_update", () => {
  test("requires auth and at least one field before invoking Things", async () => {
    const noToken = createMockApp({ token: "" });
    expect(textOf(await callTool(noToken.tools.bulk_update, { ids: ["1"], title: "Updated" }))).toBe(
      "THINGS_AUTH_TOKEN is required for this operation",
    );
    const noFields = createMockApp();
    expect(textOf(await callTool(noFields.tools.bulk_update, { ids: ["1"] }))).toBe("Provide at least one field to update");
    expect(noToken.jxaCalls).toHaveLength(0);
    expect(noFields.jxaCalls).toHaveLength(0);
  });

  test("updates many items with one JSON payload", async () => {
    const { tools, quietJsonCalls, jxaCalls } = createMockApp({
      jxa: async () => '[{"id":"1","kind":"todo"},{"id":"2","kind":"project"}]',
    });

    const result = await callTool(tools.bulk_update, { ids: ["1", "2"], title: "Updated", when: "someday", list: "Work" });
    expect(jsonOf(result)).toEqual([
      { id: "1", kind: "todo", updated: true },
      { id: "2", kind: "project", updated: true },
    ]);
    const body = jxaCalls[0]?.body ?? "";
    expect(body.indexOf("app.projects.byId")).toBeLessThan(body.indexOf("app.toDos.byId"));
    expect(quietJsonCalls).toEqual([
      [
        { type: "to-do", operation: "update", id: "1", attributes: { title: "Updated", when: "someday", list: "Work" } },
        { type: "project", operation: "update", id: "2", attributes: { title: "Updated", when: "someday", area: "Work" } },
      ],
    ]);
  });

  test("normalizes conflicting terminal states to canceled", async () => {
    const { tools, quietJsonCalls } = createMockApp({ jxa: async () => '[{"id":"1","kind":"todo"}]' });

    await callTool(tools.bulk_update, { ids: ["1"], completed: true, canceled: true });
    expect(quietJsonCalls[0]?.[0]?.attributes).toEqual({ canceled: true });
  });
});

describe("delete and trash", () => {
  test("marks destructive tools and requires confirmation for empty_trash", async () => {
    const { tools, jxaCalls } = createMockApp();

    expect(tools.delete.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(tools.empty_trash.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(() => parseToolInput(tools.empty_trash, {})).toThrow();

    const result = await callTool(tools.empty_trash, { confirm: false });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("Set confirm=true to permanently empty Things Trash");
    expect(jxaCalls).toHaveLength(0);
  });

  test("deletes an item by id, trying projects first", async () => {
    const { tools, jxaCalls } = createMockApp({ jxa: async () => '{"id":"1","kind":"todo","deleted":true}' });

    const result = await callTool(tools.delete, { id: "1" });
    expect(textOf(result)).toBe('{"id":"1","kind":"todo","deleted":true}');
    const body = jxaCalls[0]?.body ?? "";
    expect(body).toContain('app.lists.byName("Logbook").toDos.byId(P.id)');
    expect(body.indexOf("app.projects.byId")).toBeLessThan(body.indexOf("app.toDos.byId"));
  });

  test("empties trash", async () => {
    const { tools, jxaCalls } = createMockApp({ jxa: async () => "" });
    const result = await callTool(tools.empty_trash, { confirm: true });
    expect(textOf(result)).toBe('{"emptied":true}');
    expect(jxaCalls[0]?.body).toContain("app.emptyTrash()");
  });
});

describe("show", () => {
  test("requires an id or query", async () => {
    const { tools } = createMockApp();
    const result = await callTool(tools.show, {});
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("Provide id or query");
  });

  test("dispatches a background show url", async () => {
    const { tools, quietCalls } = createMockApp();
    const result = await callTool(tools.show, { query: "Launch" });
    expect(textOf(result)).toBe("Showing: Launch");
    expect(quietCalls).toEqual([{ path: "show", params: { id: undefined, query: "Launch" } }]);
  });

  test("returns show errors", async () => {
    const { tools } = createMockApp({
      quietUrl: async () => {
        throw new Error("show failed");
      },
    });
    const result = await callTool(tools.show, { id: "1" });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("show failed");
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
    for (const args of [{}, { list: "today", project: "X" }]) {
      const result = await callTool(tools.export_markdown, args);
      expect(isError(result)).toBeTrue();
      expect(textOf(result)).toBe("Provide exactly one of list, project, area, or id");
    }
  });

  test("renders every selector from SQLite", async () => {
    const { tools, jxaCalls } = createMockApp({ dbPath });

    const project = textOf(await callTool(tools.export_markdown, { project: "Website" }));
    expect(project).toContain("## Website");
    expect(project).toContain("- [ ] Proj todo A #urgent #home");
    expect(project).toContain("    - [x] Step one");

    expect(textOf(await callTool(tools.export_markdown, { id: "t-pa" }))).toContain("    - [ ] Step two");
    expect(textOf(await callTool(tools.export_markdown, { area: "Work" }))).toContain("*3 open todos*");
    expect(textOf(await callTool(tools.export_markdown, { list: "inbox" }))).toBe("# Inbox\n\n- [ ] Inbox item\n");
    expect(textOf(await callTool(tools.export_markdown, { list: "logbook" }))).toContain("- [x] Logged canceled (canceled)");
    expect(jxaCalls).toHaveLength(0);
  });

  test("filters completed todos unless asked", async () => {
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

    const open = textOf(await callTool(tools.export_markdown, { id: "p1" }));
    expect(open).toContain("- [ ] Open");
    expect(open).not.toContain("Done");
    const all = textOf(await callTool(tools.export_markdown, { id: "p1", include_completed: true }));
    expect(all).toContain("- [x] Done");
    expect(all).toContain("- [x] Killed (canceled)");
  });

  test("falls back to JXA with checklists for every selector when SQLite fails", async () => {
    const cases: Array<[Record<string, unknown>, string, Record<string, unknown>]> = [
      [{ id: "t1" }, '{"kind":"todo","id":"t1","name":"Solo","status":"open"}', { id: "t1", childChecklists: true }],
      [{ project: "Launch" }, '{"kind":"project","id":"p1","name":"Launch","status":"open","todos":[]}', { name: "Launch", childChecklists: true }],
      [{ area: "Work" }, "[]", { name: "Work" }],
      [{ list: "upcoming" }, "[]", { name: "Upcoming" }],
    ];
    for (const [args, response, jxaArgs] of cases) {
      const { tools, jxaCalls } = createMockApp({ dbPath: partialDbPath, jxa: async () => response });
      const result = await callTool(tools.export_markdown, args);
      expect(isError(result)).toBeFalse();
      expect(jxaCalls[0]?.args).toEqual(jxaArgs);
    }
  });

  test("surfaces errors from JXA", async () => {
    const { tools } = createMockApp({
      jxa: async () => {
        throw new Error("export failed");
      },
    });
    const result = await callTool(tools.export_markdown, { list: "today" });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("export failed");
  });
});

describe("stats", () => {
  test("defaults to a today-only window", async () => {
    const { tools } = createMockApp({ dbPath });
    const result = jsonOf(await callTool(tools.stats, {})) as { window: { since: string; until: string }; today: number };
    expect(result.window.since).toBe(result.window.until);
    expect(result.today).toBe(7);
  });

  test("defaults since to until and passes an explicit window through", async () => {
    const { tools } = createMockApp({ dbPath });
    expect(jsonOf(await callTool(tools.stats, { until: "2026-04-05" }))).toMatchObject({
      window: { since: "2026-04-05", until: "2026-04-05" },
    });
    expect(jsonOf(await callTool(tools.stats, { since: "2000-01-01", until: "2099-12-31" }))).toMatchObject({
      completed: 3,
      canceled: 1,
      inbox: 1,
    });
  });

  test("rejects until < since", async () => {
    const { tools } = createMockApp({ dbPath });
    const result = await callTool(tools.stats, { since: "2026-04-05", until: "2026-04-01" });
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toBe("until must be >= since");
  });

  test("fails clearly without a database", async () => {
    const { tools } = createMockApp();
    const result = await callTool(tools.stats, {});
    expect(isError(result)).toBeTrue();
    expect(textOf(result)).toContain("Run doctor");
  });

  test("surfaces database errors", async () => {
    const { tools } = createMockApp({ dbPath: partialDbPath });
    expect(isError(await callTool(tools.stats, {}))).toBeTrue();
  });
});
