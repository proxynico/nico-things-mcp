import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { CreateRequests } from "./creates";
import { type MdItem, type MdProject, renderArea, renderItem, renderList, renderProject } from "./markdown";
import {
  deadlineSchema,
  errmsg,
  isoDayToUnixEnd,
  isoDayToUnixStart,
  isSandboxAutomationError,
  type JsonPatch,
  jsonUpdate,
  jsonUpdateAttributes,
  needsJsonTagWrite,
  normalizeThingsValue,
  requireToken,
  type RuntimeCallOptions,
  THINGS_FAST_READS,
  type ThingsRuntime,
  todayIso,
  updateDeadlineSchema,
  updateWhenSchema,
  usesJsonOnlyWhen,
  whenSchema,
} from "./shared";
import * as sql from "./sqlread";
import type { Item, ListName, ReadOptions } from "./sqlread";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE = { ...WRITE, destructiveHint: true };

const limitSchema = z.number().int().nonnegative().max(MAX_LIMIT).optional();
const offsetSchema = z.number().int().nonnegative().optional().describe("Items to skip before returning results");
const requestIdSchema = z.string().min(1).max(200).describe("Unique ID for this create (e.g. a UUID). Reuse the same ID and arguments on every retry; use a new ID only for a distinct item.");

// JXA fallbacks for when SQLite is unavailable. Helpers such as todoOf live in the runtime prelude.
const JXA_ITEM = `var item;
if (P.name != null) {
  item = app.projects.byName(P.name); item.id();
} else {
  try { item = app.projects.byId(P.id); item.id(); }
  catch(e) { var todo = app.toDos.byId(P.id); todo.id(); return JSON.stringify(withChecklist(todo)); }
}
var r = projectOf(item);
r.todos = item.toDos().map(P.childChecklists ? withChecklist : todoOf);
return JSON.stringify(r);`;

const JXA_LIST = `var list = app.lists.byName(P.name);
var items = list.toDos().map(todoOf);
try { items = items.concat(list.projects().map(projectOf)); } catch(e) {}
return JSON.stringify(items);`;

const JXA_PROJECT_TODOS = `var p = app.projects.byName(P.name); p.id();
return JSON.stringify(p.toDos().map(todoOf));`;

const JXA_AREA_PROJECTS = `return JSON.stringify(app.projects().filter(function(p) {
  if (p.status() !== "open") return false;
  try { return p.area().name() === P.name; }
  catch(e) { return false; }
}).map(projectOf));`;

const JXA_PROJECTS = `return JSON.stringify(app.projects().filter(function(p) {
  return p.status() === "open";
}).map(projectOf));`;

const JXA_AREAS = `return JSON.stringify(app.areas().map(function(a) { return {id: a.id(), name: a.name()}; }));`;

const JXA_TAGS = `return JSON.stringify(app.tags().map(function(t) { return {id: t.id(), name: t.name()}; }));`;

const JXA_SEARCH = `var results = P.query ? app.toDos.whose({name: {_contains: P.query}})() : app.toDos();
results = results.filter(function(t) { return t.status() === "open"; });
if (P.tag) {
  results = results.filter(function(t) {
    return tagsOf(t).some(function(tagName) { return tagName === P.tag; });
  });
}
return JSON.stringify(results.slice(P.offset, P.offset + P.limit).map(todoOf));`;

// Projects first: Things also resolves a project id as a todo.
const JXA_KINDS = `return JSON.stringify(P.ids.map(function(id) {
  try {
    var project = app.projects.byId(id); project.id();
    return {id: id, kind: "project"};
  } catch(e) {
    var todo = app.toDos.byId(id); todo.id();
    return {id: id, kind: "todo"};
  }
}));`;

const JXA_ADD_TODO = `var project = null;
if (P.list) { project = app.projects.byName(P.list); project.id(); }
var props = {name: P.title};
if (P.notes) props.notes = P.notes;
if (P.tags && P.tags.length && !P.tagsNeedJson) props.tagNames = P.tags.join(", ");
if (P.deadline) props.dueDate = new Date(P.deadline + "T12:00:00");
var todo = app.make({new: "toDo", withProperties: props});
if (P.list) {
  todo.project = project;
}
scheduleWhen(todo, P.when);
return JSON.stringify({id: todo.id(), name: todo.name(), status: todo.status()});`;

const JXA_ADD_PROJECT = `var area = null;
if (P.area) { area = app.areas.byName(P.area); area.id(); }
var props = {name: P.title};
if (P.notes) props.notes = P.notes;
if (P.tags && P.tags.length && !P.tagsNeedJson) props.tagNames = P.tags.join(", ");
if (P.deadline) props.dueDate = new Date(P.deadline + "T12:00:00");
var proj = app.make({new: "project", withProperties: props});
if (P.area) {
  proj.area = area;
}
(P.todos || []).forEach(function(title) {
  var t = app.make({new: "toDo", withProperties: {name: title}});
  t.project = proj;
});
scheduleWhen(proj, P.when);
return JSON.stringify({id: proj.id(), name: proj.name(), status: proj.status()});`;

const JXA_UPDATE = `var item, type;
try { item = app.projects.byId(P.id); item.id(); type = "project"; }
catch(e) { item = app.toDos.byId(P.id); item.id(); type = "todo"; }
if (P.title) item.name = P.title;
if (P.hasOwnProperty("notes")) item.notes = P.notes || "";
if (P.hasOwnProperty("tags") && !P.tagsNeedJson) item.tagNames = P.tags ? P.tags.join(", ") : "";
if (P.deadline) item.dueDate = new Date(P.deadline + "T12:00:00");
if (P.list) {
  if (type === "todo") {
    var project = app.projects.byName(P.list);
    project.id();
    item.project = project;
  } else {
    var area = app.areas.byName(P.list);
    area.id();
    item.area = area;
  }
}
scheduleWhen(item, P.when);
if (P.canceled) item.status = "canceled";
else if (P.completed) item.status = "completed";
else if (P.completed === false || P.canceled === false) item.status = "open";
return JSON.stringify({kind: type, item: type === "todo" ? todoOf(item) : projectOf(item)});`;

const JXA_DELETE = `var kind, item;
try { item = app.projects.byId(P.id); item.id(); kind = "project"; }
catch(e1) {
  try { item = app.toDos.byId(P.id); item.id(); kind = "todo"; }
  catch(e2) { item = app.areas.byId(P.id); item.id(); kind = "area"; }
}
// Things only deletes a completed or canceled item through the Logbook.
try { app.delete(item); }
catch(e) {
  if (kind === "area") throw e;
  app.delete(app.lists.byName("Logbook").toDos.byId(P.id));
}
return JSON.stringify({id: P.id, kind: kind, deleted: true});`;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

// Wraps a tool body: its text becomes the result, and anything it throws becomes an error result.
function tool<A>(body: (args: A, options: RuntimeCallOptions) => Promise<string>) {
  return async (args: A, extra: RuntimeCallOptions): Promise<ToolResult> => {
    try {
      return { content: [{ type: "text", text: await body(args, { signal: extra.signal }) }] };
    } catch (error) {
      return { content: [{ type: "text", text: errmsg(error) }], isError: true };
    }
  };
}

function requireOneSelector(...selectors: unknown[]): void {
  if (selectors.filter((value) => value != null).length !== 1) {
    throw new Error("Provide exactly one of list, project, area, or id");
  }
}

// SQLite answers when it can; a failure or a miss falls back to asking Things over JXA.
async function sqlFirst<T>(
  runtime: ThingsRuntime,
  fromSql: (dbPath: string) => T | null,
  fromJxa: () => Promise<T>,
): Promise<T> {
  if (runtime.dbPath) {
    try {
      const result = fromSql(runtime.dbPath);
      if (result != null) return result;
    } catch {
      // Fall through to JXA.
    }
  }
  return fromJxa();
}

async function jxaRead<T>(
  runtime: ThingsRuntime,
  body: string,
  args: Record<string, unknown> | undefined,
  options: RuntimeCallOptions,
): Promise<T> {
  return normalizeThingsValue(JSON.parse(await runtime.jxa(body, args, options))) as T;
}

// Applies the completion window and paging to items JXA returned whole.
function page(items: Item[], { limit, offset = 0, completed_after, completed_before }: ReadOptions): Item[] {
  let windowed = items;
  if (completed_after || completed_before) {
    const after = completed_after ? isoDayToUnixStart(completed_after) * 1000 : -Infinity;
    const before = completed_before ? isoDayToUnixEnd(completed_before) * 1000 : Infinity;
    windowed = items.filter((item) => {
      const stamp = Date.parse(String(item.completionDate ?? item.cancellationDate));
      return stamp >= after && stamp <= before;
    });
  }
  return windowed.slice(offset, limit == null ? undefined : offset + limit);
}

function readItem(runtime: ThingsRuntime, id: string, childChecklists: boolean, options: RuntimeCallOptions) {
  return sqlFirst(
    runtime,
    (db) => sql.readItem(db, id, childChecklists),
    () => jxaRead<Item>(runtime, JXA_ITEM, { id, childChecklists }, options),
  );
}

function readList(runtime: ThingsRuntime, list: ListName, readOptions: ReadOptions, options: RuntimeCallOptions) {
  return sqlFirst(
    runtime,
    (db) => sql.readList(db, list, readOptions),
    async () => {
      const name = list.charAt(0).toUpperCase() + list.slice(1);
      return page(await jxaRead<Item[]>(runtime, JXA_LIST, { name }, options), readOptions);
    },
  );
}

function readAreaProjects(runtime: ThingsRuntime, area: string, options: RuntimeCallOptions) {
  return sqlFirst(
    runtime,
    (db) => sql.readAreaProjects(db, area),
    () => jxaRead<Item[]>(runtime, JXA_AREA_PROJECTS, { name: area }, options),
  );
}

const checklistSchema = z.array(z.object({ name: z.string(), done: z.boolean() }));

// Keep fresh JXA fields: SQLite can lag a write. Use it only for the checklist JXA cannot read.
async function withStoredChecklist({
  runtime, item, expected, options,
}: {
  runtime: ThingsRuntime;
  item: Item;
  expected?: string[];
  options: RuntimeCallOptions;
}): Promise<Item> {
  if (item.kind !== "todo" || typeof item.id !== "string") return item;
  if (runtime.dbPath) {
    const until = Date.now() + 2000;
    do {
      options.signal?.throwIfAborted();
      try {
        const stored = sql.readItem(runtime.dbPath, item.id);
        const checklist = checklistSchema.safeParse(stored?.checklistItems);
        if (checklist.success && (expected === undefined ||
          (checklist.data.length === expected.length && checklist.data.every((entry, i) => entry.name === expected[i] && !entry.done)))) {
          return { ...item, checklistItems: checklist.data };
        }
      } catch {
        break;
      }
      if (expected === undefined || Date.now() >= until) break;
      await pause(50, undefined, options);
    } while (true);
  }
  return { ...item, checklistItems: null };
}

// Applies a JSON update to an item JXA just created or changed, then returns the item as Things now has it.
async function patchAndReread({ runtime, kind, id, attributes, expectedChecklist }: {
  runtime: ThingsRuntime;
  kind: "todo" | "project";
  id: string;
  attributes: Record<string, unknown>;
  expectedChecklist?: string[];
}): Promise<string> {
  await runtime.quietJson([jsonUpdate(kind, id, attributes)]);
  const item = await jxaRead<Item>(runtime, JXA_ITEM, { id }, {});
  return JSON.stringify(await withStoredChecklist({ runtime, item, expected: expectedChecklist, options: {} }));
}

async function doctorReport(runtime: ThingsRuntime, options: RuntimeCallOptions) {
  const db_path = runtime.dbPath;
  let sqlRead: { ok: boolean; db_path: string | null; message: string };
  if (!db_path) {
    sqlRead = {
      ok: false,
      db_path,
      message: THINGS_FAST_READS ? "No Things database found" : "SQLite reads are off (THINGS_FAST_READS=0)",
    };
  } else {
    try {
      sql.probe(db_path);
      sqlRead = { ok: true, db_path, message: "SQLite reads are available" };
    } catch (error) {
      sqlRead = { ok: false, db_path, message: errmsg(error) };
    }
  }

  let jxaRead: { ok: boolean; app_path: string; message: string };
  try {
    await runtime.jxa("return JSON.stringify(app.lists().map(function(list) { return list.name(); }));", undefined, options);
    jxaRead = { ok: true, app_path: runtime.appPath, message: "JXA reads are available; checklists require SQLite (null when unavailable)" };
  } catch (error) {
    jxaRead = {
      ok: false,
      app_path: runtime.appPath,
      message: isSandboxAutomationError(error)
        ? "Things automation is blocked by the current sandbox. Run the server outside the sandbox."
        : `Things startup check failed: ${errmsg(error)}`,
    };
  }

  const json_writes = runtime.token
    ? { ok: true, message: "THINGS_AUTH_TOKEN is configured for JSON writes" }
    : { ok: false, message: "THINGS_AUTH_TOKEN is missing; JSON writes are unavailable" };

  return { ok: sqlRead.ok || jxaRead.ok, checks: { sql_read: sqlRead, jxa_read: jxaRead, json_writes } };
}

export function registerTools(server: McpServer, runtime: ThingsRuntime, requests = new CreateRequests()): Record<string, RegisteredTool> {
  const tools: Record<string, RegisteredTool> = {};

  tools.doctor = server.registerTool(
    "doctor",
    {
      description: "Report independent SQLite read, JXA read, and authenticated JSON write capabilities.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    tool(async (_args, options) => JSON.stringify(await doctorReport(runtime, options))),
  );

  tools.read = server.registerTool(
    "read",
    {
      description: "Read from Things 3. Returns JSON with full item details including IDs.",
      inputSchema: {
        list: z
          .enum([...sql.LISTS, "projects", "areas", "tags"])
          .optional()
          .describe("Built-in list, or 'projects'/'areas'/'tags' to list all"),
        project: z.string().optional().describe("Project name — returns its todos"),
        area: z.string().optional().describe("Area name — returns its projects"),
        id: z.string().optional().describe("Todo or project ID — returns full detail with checklist/child todos"),
        limit: limitSchema.describe("Max items to return"),
        offset: offsetSchema,
        completed_after: deadlineSchema.optional().describe("Only return items completed/canceled on or after yyyy-mm-dd"),
        completed_before: deadlineSchema.optional().describe("Only return items completed/canceled on or before yyyy-mm-dd"),
      },
      annotations: READ_ONLY,
    },
    tool(async ({ list, project, area, id, limit, offset, completed_after, completed_before }, options) => {
      requireOneSelector(list, project, area, id);
      let result: unknown;
      if (id != null) {
        result = await readItem(runtime, id, false, options);
      } else if (project != null) {
        const readOptions = { limit, offset, completed_after, completed_before };
        result = await sqlFirst(
          runtime,
          (db) => sql.readProjectTodos(db, project, readOptions),
          async () => page(await jxaRead<Item[]>(runtime, JXA_PROJECT_TODOS, { name: project }, options), readOptions),
        );
      } else if (area != null) {
        result = await readAreaProjects(runtime, area, options);
      } else if (list === "projects") {
        result = await sqlFirst(runtime, sql.listProjects, () => jxaRead<Item[]>(runtime, JXA_PROJECTS, undefined, options));
      } else if (list === "areas") {
        result = await sqlFirst(runtime, sql.listAreas, () => jxaRead<Item[]>(runtime, JXA_AREAS, undefined, options));
      } else if (list === "tags") {
        result = await sqlFirst(runtime, sql.listTags, () => jxaRead<Item[]>(runtime, JXA_TAGS, undefined, options));
      } else {
        result = await readList(runtime, list!, {
          limit: limit ?? DEFAULT_LIMIT,
          offset,
          completed_after,
          completed_before,
        }, options);
      }
      return JSON.stringify(result);
    }),
  );

  tools.search = server.registerTool(
    "search",
    {
      description: "Search Things 3 open todos by name or tag. Returns JSON.",
      inputSchema: {
        query: z.string().optional().describe("Text to search in todo names"),
        tag: z.string().optional().describe("Tag name to filter by"),
        limit: limitSchema.describe("Max items to return"),
        offset: offsetSchema,
      },
      annotations: READ_ONLY,
    },
    tool(async ({ query, tag, limit, offset }, options) => {
      if (!query && !tag) throw new Error("Provide query or tag");
      const paging = { limit: limit ?? DEFAULT_LIMIT, offset: offset ?? 0 };
      return JSON.stringify(await sqlFirst(
        runtime,
        (db) => sql.search(db, { query, tag, ...paging }),
        () => jxaRead<Item[]>(runtime, JXA_SEARCH, { query: query ?? null, tag: tag ?? null, ...paging }, options),
      ));
    }),
  );

  tools.export_markdown = server.registerTool(
    "export_markdown",
    {
      description: "Export Things items as clean markdown for pasting into notes. Returns raw markdown text, not JSON.",
      inputSchema: {
        list: z.enum(sql.LISTS).optional().describe("Built-in list to render as markdown"),
        project: z.string().optional().describe("Project name — renders its todos"),
        area: z.string().optional().describe("Area name — renders shallow per-project summaries"),
        id: z.string().optional().describe("Todo or project ID — renders detail"),
        include_notes: z.boolean().optional().describe("Include notes in the output (default true)"),
        include_completed: z.boolean().optional().describe("Include completed and canceled items (default false)"),
        limit: limitSchema.describe("Max items to return for list reads"),
        offset: offsetSchema,
        completed_after: deadlineSchema.optional().describe("For list reads: only include items completed/canceled on or after yyyy-mm-dd"),
        completed_before: deadlineSchema.optional().describe("For list reads: only include items completed/canceled on or before yyyy-mm-dd"),
      },
      annotations: READ_ONLY,
    },
    tool(async (args, options) => {
      const { list, project, area, id } = args;
      requireOneSelector(list, project, area, id);
      const opts = {
        includeNotes: args.include_notes ?? true,
        includeCompleted: args.include_completed ?? (list === "logbook" || list === "trash"),
      };
      if (id != null) {
        return renderItem((await readItem(runtime, id, true, options)) as MdItem, opts);
      }
      if (project != null) {
        const item = await sqlFirst(
          runtime,
          (db) => sql.readProject(db, project),
          () => jxaRead<Item>(runtime, JXA_ITEM, { name: project, childChecklists: true }, options),
        );
        return renderProject(item as MdProject, opts);
      }
      if (area != null) {
        return renderArea(area, (await readAreaProjects(runtime, area, options)) as MdProject[]);
      }
      const items = await readList(runtime, list!, {
        limit: args.limit ?? DEFAULT_LIMIT,
        offset: args.offset,
        completed_after: args.completed_after,
        completed_before: args.completed_before,
      }, options);
      return renderList(list!, items as MdItem[], opts);
    }),
  );

  tools.stats = server.registerTool(
    "stats",
    {
      description: "Return Things counts: windowed (completed, canceled, created) and snapshot (overdue, inbox, today). Needs Things' SQLite database. Windows use local-time calendar days.",
      inputSchema: {
        since: deadlineSchema.optional().describe("yyyy-mm-dd (default: until)"),
        until: deadlineSchema.optional().describe("yyyy-mm-dd (default: today, local time)"),
      },
      annotations: READ_ONLY,
    },
    tool(async ({ since, until }) => {
      const windowUntil = until ?? todayIso();
      const windowSince = since ?? windowUntil;
      if (windowSince > windowUntil) throw new Error("until must be >= since");
      if (!runtime.dbPath) throw new Error("stats needs Things' SQLite database. Run doctor for details.");
      return JSON.stringify(sql.stats(runtime.dbPath, { since: windowSince, until: windowUntil }));
    }),
  );

  tools.add_todo = server.registerTool(
    "add_todo",
    {
      description: "Create a todo in Things 3. Reuse request_id and identical arguments after a timeout to get the original result without creating a duplicate.",
      inputSchema: {
        request_id: requestIdSchema,
        title: z.string(),
        notes: z.string().optional(),
        when: whenSchema.optional().describe("today | tomorrow | evening | anytime | someday | yyyy-mm-dd"),
        deadline: deadlineSchema.optional().describe("yyyy-mm-dd"),
        tags: z.array(z.string()).optional(),
        list: z.string().optional().describe("Project name to add the todo to"),
        checklist_items: z.array(z.string()).optional(),
      },
      annotations: WRITE,
    },
    tool(async ({ request_id, ...params }, options) => {
      const tagsNeedJson = needsJsonTagWrite(params.tags);
      const attributes = jsonUpdateAttributes("todo", {
        when: usesJsonOnlyWhen(params.when) ? params.when : undefined,
        tags: tagsNeedJson ? params.tags : undefined,
        checklist_items: params.checklist_items?.length ? params.checklist_items : undefined,
      });
      if (attributes) requireToken(runtime.token);

      return requests.run({ requestId: request_id, tool: "add_todo", params, signal: options.signal,
        preflight: params.list ? async () => {
          await runtime.jxa('var project = app.projects.byName(P.name); project.id(); return "";', { name: params.list }, options);
        } : undefined,
        create: async (recordId) => {
          const created = await runtime.jxa(JXA_ADD_TODO, { ...params, tagsNeedJson });
          const { id } = z.object({ id: z.string() }).parse(JSON.parse(created));
          recordId(id);
          if (!attributes) return created;
          return patchAndReread({ runtime, kind: "todo", id, attributes, expectedChecklist: params.checklist_items });
        },
      });
    }),
  );

  tools.add_project = server.registerTool(
    "add_project",
    {
      description: "Create a project in Things 3 with optional child todos. Reuse request_id and identical arguments after a timeout to get the original result without creating a duplicate.",
      inputSchema: {
        request_id: requestIdSchema,
        title: z.string(),
        notes: z.string().optional(),
        when: whenSchema.optional().describe("today | tomorrow | evening | anytime | someday | yyyy-mm-dd"),
        deadline: deadlineSchema.optional().describe("yyyy-mm-dd"),
        tags: z.array(z.string()).optional(),
        area: z.string().optional().describe("Area name"),
        todos: z.array(z.string()).optional().describe("Child todo titles"),
      },
      annotations: WRITE,
    },
    tool(async ({ request_id, ...params }, options) => {
      const tagsNeedJson = needsJsonTagWrite(params.tags);
      const attributes = jsonUpdateAttributes("project", {
        when: usesJsonOnlyWhen(params.when) ? params.when : undefined,
        tags: tagsNeedJson ? params.tags : undefined,
      });
      if (attributes) requireToken(runtime.token);

      return requests.run({ requestId: request_id, tool: "add_project", params, signal: options.signal,
        preflight: params.area ? async () => {
          await runtime.jxa('var area = app.areas.byName(P.name); area.id(); return "";', { name: params.area }, options);
        } : undefined,
        create: async (recordId) => {
          const created = await runtime.jxa(JXA_ADD_PROJECT, { ...params, tagsNeedJson });
          const { id } = z.object({ id: z.string() }).parse(JSON.parse(created));
          recordId(id);
          if (!attributes) return created;
          return patchAndReread({ runtime, kind: "project", id, attributes });
        },
      });
    }),
  );

  tools.update = server.registerTool(
    "update",
    {
      description: "Update a todo or project in Things 3 by ID. Detects item type automatically.",
      inputSchema: {
        id: z.string().describe("Todo or project ID"),
        title: z.string().optional(),
        notes: z.string().optional().describe("Replace notes (use empty string to clear)"),
        when: updateWhenSchema
          .optional()
          .describe("today | tomorrow | evening | anytime | someday | yyyy-mm-dd | empty string to clear"),
        deadline: updateDeadlineSchema.optional().describe("yyyy-mm-dd (empty string to clear)"),
        tags: z.array(z.string()).optional().describe("Replace all tags"),
        checklist_items: z.array(z.string()).optional().describe("Replace all checklist items"),
        completed: z.boolean().optional(),
        canceled: z.boolean().optional(),
        list: z.string().optional().describe("Move to project (todos) or area (projects) by name"),
      },
      annotations: WRITE,
    },
    tool(async (params, options) => {
      const { id, ...fields } = params;
      if (Object.values(fields).every((value) => value === undefined)) {
        throw new Error("Provide at least one field to update");
      }
      if (params.title === "") throw new Error("title must not be empty");

      // JXA cannot clear when or deadline, set evening/anytime/someday, write checklists, or write comma tags.
      const tagsNeedJson = needsJsonTagWrite(params.tags);
      const clears = params.when === "" || params.deadline === "";
      const patch: JsonPatch = {
        when: usesJsonOnlyWhen(params.when) ? params.when : undefined,
        tags: tagsNeedJson ? params.tags : undefined,
        checklist_items: params.checklist_items,
      };
      if (clears || jsonUpdateAttributes("todo", patch)) requireToken(runtime.token);

      const { kind, item } = z.object({
        kind: z.enum(["todo", "project"]), item: z.record(z.string(), z.unknown()),
      }).parse(JSON.parse(await runtime.jxa(JXA_UPDATE, { ...params, tagsNeedJson }, options)));
      const attributes = jsonUpdateAttributes(kind, patch);
      if (!clears && !attributes) {
        return JSON.stringify(await withStoredChecklist({ runtime, item: normalizeThingsValue(item), options }));
      }

      if (clears) {
        await runtime.quietUrl(kind === "project" ? "update-project" : "update", {
          "auth-token": runtime.token,
          id,
          when: params.when === "" ? "" : undefined,
          deadline: params.deadline === "" ? "" : undefined,
        }, options);
      }
      if (attributes) await runtime.quietJson([jsonUpdate(kind, id, attributes)], options);
      const updated = await jxaRead<Item>(runtime, JXA_ITEM, { id }, options);
      return JSON.stringify(await withStoredChecklist({ runtime, item: updated, expected: params.checklist_items, options }));
    }),
  );

  tools.bulk_update = server.registerTool(
    "bulk_update",
    {
      description: "Update multiple todos or projects at once. Uses Things JSON updates and requires THINGS_AUTH_TOKEN.",
      inputSchema: {
        ids: z.array(z.string()).min(1).describe("Todo or project IDs"),
        title: z.string().optional(),
        notes: z.string().optional().describe("Replace notes"),
        when: whenSchema.optional().describe("today | tomorrow | evening | anytime | someday | yyyy-mm-dd"),
        deadline: deadlineSchema.optional().describe("yyyy-mm-dd"),
        tags: z.array(z.string()).optional().describe("Replace all tags"),
        checklist_items: z.array(z.string()).optional().describe("Replace all checklist items on todos"),
        completed: z.boolean().optional(),
        canceled: z.boolean().optional(),
        list: z.string().optional().describe("Move todos to a project/area, or projects to an area"),
      },
      annotations: WRITE,
    },
    tool(async ({ ids, ...patch }, options) => {
      requireToken(runtime.token);
      if (!jsonUpdateAttributes("todo", patch)) throw new Error("Provide at least one field to update");

      const items = JSON.parse(await runtime.jxa(JXA_KINDS, { ids }, options)) as Array<{
        id: string;
        kind: "todo" | "project";
      }>;
      const operations = items.flatMap((item) => {
        const attributes = jsonUpdateAttributes(item.kind, patch);
        return attributes ? [jsonUpdate(item.kind, item.id, attributes)] : [];
      });
      if (!operations.length) throw new Error("Provide at least one field to update");

      await runtime.quietJson(operations, options);
      return JSON.stringify(items.map((item) => ({ id: item.id, kind: item.kind, updated: true })));
    }),
  );

  tools.delete = server.registerTool(
    "delete",
    {
      description: "Move a todo, project, or area to Things Trash.",
      inputSchema: {
        id: z.string().describe("Todo, project, or area ID"),
      },
      annotations: DESTRUCTIVE,
    },
    tool(({ id }, options) => runtime.jxa(JXA_DELETE, { id }, options)),
  );

  tools.empty_trash = server.registerTool(
    "empty_trash",
    {
      description: "Permanently delete everything currently in Things Trash.",
      inputSchema: {
        confirm: z.boolean().describe("Must be true to permanently empty Things Trash"),
      },
      annotations: DESTRUCTIVE,
    },
    tool(async ({ confirm }, options) => {
      if (!confirm) throw new Error("Set confirm=true to permanently empty Things Trash");
      await runtime.jxa("app.emptyTrash();", undefined, options);
      return '{"emptied":true}';
    }),
  );

  tools.show = server.registerTool(
    "show",
    {
      description: "Navigate Things 3 to a list, project, area, or item. Uses background URL dispatch.",
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe("Built-in list (inbox, today, anytime, upcoming, someday, logbook) or item ID"),
        query: z.string().optional().describe("Project, area, or tag name to navigate to"),
      },
      annotations: READ_ONLY,
    },
    tool(async ({ id, query }, options) => {
      if (!id && !query) throw new Error("Provide id or query");
      await runtime.quietUrl("show", { id, query }, options);
      return `Showing: ${id ?? query}`;
    }),
  );

  return tools;
}
