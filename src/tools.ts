import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildJsonUpdateOperation,
  COSITAS_SQL_READS,
  deadlineSchema,
  errmsg,
  fail,
  LIST_NAMES,
  THINGS_FAST_READS,
  needsJsonTagWrite,
  normalizeThingsJson,
  normalizeThingsValue,
  ok,
  requireToken,
  RuntimeCallOptions,
  StatsWindow,
  ThingsRuntime,
  todayIso,
  updateDeadlineSchema,
  updateWhenSchema,
  usesSpecialWhen,
  whenSchema,
} from "./shared";
import {
  MdItem,
  MdProject,
  MdRenderOptions,
  renderArea,
  renderItem,
  renderList,
  renderProject,
} from "./markdown";
import { verifyThingsAccess } from "./runtime";
import * as sqlread from "./sqlread";

// When the SQL-reads spike is enabled and a database is reachable, reads run
// through the pure-SQLite layer for the paths it covers (no osascript, app
// stays closed). Computed lists (anytime/upcoming/someday) are not covered and
// always fall through to the JXA path below.
function sqlDbPath(runtime: ThingsRuntime): string | null {
  if (!COSITAS_SQL_READS || !THINGS_FAST_READS) return null;
  return runtime.inspect().dbPath;
}

function trySqlRead<T>(dbPath: string | null, read: (path: string) => T): T | undefined {
  if (!dbPath) return undefined;
  try {
    return read(dbPath);
  } catch {
    return undefined;
  }
}

async function tryFastListRead(
  runtime: ThingsRuntime,
  list: string,
  options: sqlread.SqlReadOptions,
  callOptions: RuntimeCallOptions,
): Promise<string | null> {
  try {
    return await runtime.fastListRead(list, options, callOptions);
  } catch {
    return null;
  }
}

function trySortListItems(
  runtime: ThingsRuntime,
  list: string,
  items: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  try {
    return runtime.sortListItems(list, items);
  } catch {
    return items;
  }
}

const TERMINAL_MARKDOWN_LISTS = new Set(["logbook", "trash"]);
const DEFAULT_RESULT_LIMIT = 100;
const MAX_RESULT_LIMIT = 500;

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const ADDITIVE_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const MUTATING_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DESTRUCTIVE_WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

function requestOptions(extra: { signal?: AbortSignal }): RuntimeCallOptions {
  return { signal: extra.signal };
}

function defaultLimit(limit: number | undefined): number {
  return limit ?? DEFAULT_RESULT_LIMIT;
}

// Reads a todo or project by id. childChecklists controls whether a project's
// child todos carry their checklist items (export_markdown wants them; the
// default read path does not, to keep payloads small).
async function readItemJson(
  runtime: ThingsRuntime,
  id: string,
  options: RuntimeCallOptions = {},
  childChecklists = false,
): Promise<string> {
  return normalizeThingsJson(
    await runtime.jxa(
      `var withChecklist = function(t) {
  var r = todoOf(t);
  try {
    r.checklistItems = t.toDoChecklistItems().map(function(c) {
      return {name: c.name(), done: c.status() === "completed"};
    });
  } catch(e) {}
  return r;
};
try {
  var p = app.projects.byId(P.id); p.id();
  var r = projectOf(p);
  r.todos = p.toDos().map(P.childChecklists ? withChecklist : todoOf);
  return JSON.stringify(r);
} catch(e) {
  var t = app.toDos.byId(P.id); t.id();
  return JSON.stringify(withChecklist(t));
}`,
      childChecklists ? { id, childChecklists: true } : { id },
      options,
    ),
  );
}

function readItemForExport(runtime: ThingsRuntime, id: string, options: RuntimeCallOptions = {}): Promise<string> {
  return readItemJson(runtime, id, options, true);
}

async function readProjectForExport(runtime: ThingsRuntime, name: string, options: RuntimeCallOptions = {}): Promise<string> {
  return normalizeThingsJson(
    await runtime.jxa(
      `var withChecklist = function(t) {
  var r = todoOf(t);
  try {
    r.checklistItems = t.toDoChecklistItems().map(function(c) {
      return {name: c.name(), done: c.status() === "completed"};
    });
  } catch(e) {}
  return r;
};
var p = app.projects.byName(P.n); p.id();
var r = projectOf(p);
r.todos = p.toDos().map(withChecklist);
return JSON.stringify(r);`,
      { n: name },
      options,
    ),
  );
}

async function readAreaProjectsJson(runtime: ThingsRuntime, name: string, options: RuntimeCallOptions = {}): Promise<string> {
  return normalizeThingsJson(
    await runtime.jxa(
      `var target = P.n;
var projs = app.projects().filter(function(p) {
  if (p.status() !== "open") return false;
  try { return p.area().name() === target; }
  catch(e) { return false; }
});
return JSON.stringify(projs.map(projectOf));`,
      { n: name },
      options,
    ),
  );
}

async function readBuiltinListJson(
  runtime: ThingsRuntime,
  list: string,
  options: {
    limit?: number;
    offset?: number;
    completed_after?: string;
    completed_before?: string;
  },
  callOptions: RuntimeCallOptions = {},
  skipSqlHelpers = false,
): Promise<MdItem[]> {
  if (!skipSqlHelpers) {
    const fast = await tryFastListRead(runtime, list, options, callOptions);
    if (fast != null) {
      return JSON.parse(fast) as MdItem[];
    }
  }

  const mixed = await runtime.jxa(
    `var list = app.lists.byName(P.n);
var todos = list.toDos().map(todoOf);
var projects = [];
try { projects = list.projects().map(projectOf); } catch(e) {}
var items = todos.concat(projects);
if (P.completedAfter || P.completedBefore) {
  items = items.filter(function(item) {
    var stamp = item.completionDate || item.cancellationDate;
    if (!stamp) return false;
    var value = new Date(stamp);
    if (P.completedAfter && value < new Date(P.completedAfter + "T00:00:00")) return false;
    if (P.completedBefore && value > new Date(P.completedBefore + "T23:59:59")) return false;
    return true;
  });
}
return JSON.stringify(items);`,
    {
      n: LIST_NAMES[list]!,
      completedAfter: options.completed_after ?? null,
      completedBefore: options.completed_before ?? null,
    },
    callOptions,
  );

  const items = JSON.parse(normalizeThingsJson(mixed)) as Array<Record<string, unknown>>;
  const sorted = skipSqlHelpers ? items as MdItem[] : trySortListItems(runtime, list, items) as MdItem[];
  const start = options.offset ?? 0;
  return options.limit != null ? sorted.slice(start, start + options.limit) : sorted.slice(start);
}

async function applyQuietUpdate(
  runtime: ThingsRuntime,
  kind: "todo" | "project",
  id: string,
  params: Record<string, string | undefined>,
  options: RuntimeCallOptions = {},
): Promise<void> {
  requireToken(runtime.token);
  await runtime.quietUrl(kind === "project" ? "update-project" : "update", {
    "auth-token": runtime.token,
    id,
    ...params,
  }, options);
}

async function buildDoctorReport(runtime: ThingsRuntime, options: RuntimeCallOptions = {}): Promise<string> {
  const inspection = runtime.inspect();
  const checks: Record<string, Record<string, unknown>> = {};
  let sqlReadOk = false;
  let jxaReadOk = false;

  if (!COSITAS_SQL_READS || !inspection.fastReadsEnabled) {
    checks.sql_read = {
      ok: false,
      enabled: false,
      available: false,
      db_path: inspection.dbPath,
      message: "SQLite reads are disabled by configuration",
    };
  } else if (!inspection.dbPath) {
    checks.sql_read = {
      ok: false,
      enabled: true,
      available: false,
      db_path: null,
      message: "No Things database found",
    };
  } else {
    try {
      sqlread.probeSqlRead(inspection.dbPath);
      sqlReadOk = true;
      checks.sql_read = {
        ok: true,
        enabled: true,
        available: true,
        db_path: inspection.dbPath,
        message: "SQLite reads are available",
      };
    } catch (error) {
      checks.sql_read = {
        ok: false,
        enabled: true,
        available: false,
        db_path: inspection.dbPath,
        message: errmsg(error),
      };
    }
  }

  try {
    await verifyThingsAccess(runtime, options);
    jxaReadOk = true;
    checks.jxa_read = {
      ok: true,
      app_path: inspection.appPath,
      message: "JXA reads are available",
    };
  } catch (error) {
    checks.jxa_read = {
      ok: false,
      app_path: inspection.appPath,
      message: errmsg(error),
    };
  }

  checks.json_writes = {
    ok: Boolean(runtime.token),
    configured: Boolean(runtime.token),
    message: runtime.token
      ? "THINGS_AUTH_TOKEN is configured for JSON writes"
      : "THINGS_AUTH_TOKEN is missing; JSON writes are unavailable",
  };

  return JSON.stringify({ ok: sqlReadOk || jxaReadOk, checks });
}

export function registerTools(server: McpServer, runtime: ThingsRuntime): Record<string, RegisteredTool> {
  const tools: Record<string, RegisteredTool> = {};

  tools.doctor = server.registerTool(
    "doctor",
    {
      description: "Report independent SQLite read, JXA read, and authenticated JSON write capabilities.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async (_params, extra) => {
      const options = requestOptions(extra);
      try {
        return ok(await buildDoctorReport(runtime, options));
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  tools.read = server.registerTool(
    "read",
    {
      description: "Read from Things 3. Returns JSON with full item details including IDs.",
      inputSchema: {
      list: z
        .enum([
          "inbox",
          "today",
          "anytime",
          "upcoming",
          "someday",
          "logbook",
          "trash",
          "projects",
          "areas",
          "tags",
        ])
        .optional()
        .describe("Built-in list, or 'projects'/'areas'/'tags' to list all"),
      project: z
        .string()
        .optional()
        .describe("Project name — returns its todos"),
      area: z
        .string()
        .optional()
        .describe("Area name — returns its projects"),
      id: z
        .string()
        .optional()
        .describe("Todo or project ID — returns full detail with checklist/child todos"),
      limit: z.number().int().nonnegative().max(MAX_RESULT_LIMIT).optional().describe("Max items to return"),
      offset: z.number().int().nonnegative().optional().describe("Items to skip before returning results"),
      completed_after: deadlineSchema.optional().describe("Only return items completed/canceled on or after yyyy-mm-dd"),
      completed_before: deadlineSchema.optional().describe("Only return items completed/canceled on or before yyyy-mm-dd"),
      },
      annotations: READ_ONLY,
    },
    async ({ list, project, area, id, limit, offset, completed_after, completed_before }, extra) => {
      const selectors = [list, project, area, id].filter((value) => value != null);
      if (selectors.length !== 1) {
        return fail("Provide exactly one of list, project, area, or id");
      }
      const options = requestOptions(extra);
      const db = sqlDbPath(runtime);

      try {
        if (list === "projects") {
          const projects = trySqlRead(db, sqlread.listProjects);
          if (projects !== undefined) return ok(JSON.stringify(projects));
          return ok(
            normalizeThingsJson(
              await runtime.jxa(
              `return JSON.stringify(app.projects().filter(function(p){
  return p.status()==="open";
}).map(projectOf));`,
                undefined,
                options,
            ),
            ),
          );
        }

        if (list === "areas") {
          const areas = trySqlRead(db, sqlread.listAreas);
          if (areas !== undefined) return ok(JSON.stringify(areas));
          return ok(
            await runtime.jxa(
              `return JSON.stringify(app.areas().map(function(a){
return {id:a.id(), name:a.name()};
}));`,
              undefined,
              options,
            ),
          );
        }

        if (list === "tags") {
          const tags = trySqlRead(db, sqlread.listTags);
          if (tags !== undefined) return ok(JSON.stringify(tags));
          return ok(
            await runtime.jxa(
              `return JSON.stringify(app.tags().map(function(t){
return {id:t.id(), name:t.name()};
}));`,
              undefined,
              options,
            ),
          );
        }

        if (id) {
          const item = trySqlRead(db, (path) => sqlread.readById(path, id));
          if (item) return ok(JSON.stringify(item));
          return ok(await readItemJson(runtime, id, options));
        }

        if (project) {
          const todos = trySqlRead(db, (path) =>
            sqlread.readProjectTodos(path, project, {
              limit: limit ?? undefined,
              offset: offset ?? 0,
              completed_after,
              completed_before,
            }),
          );
          if (todos != null) return ok(JSON.stringify(todos));
          return ok(
            normalizeThingsJson(
              await runtime.jxa(
              `var p = app.projects.byName(P.n); p.id();
return JSON.stringify(applyReadWindow(p.toDos()).map(todoOf));`,
              {
                n: project,
                limit: limit ?? null,
                offset: offset ?? 0,
                completedAfter: completed_after ?? null,
                completedBefore: completed_before ?? null,
              },
              options,
            ),
            ),
          );
        }

        if (area) {
          const projects = trySqlRead(db, (path) => sqlread.readAreaProjects(path, area));
          if (projects !== undefined) return ok(JSON.stringify(projects));
          return ok(await readAreaProjectsJson(runtime, area, options));
        }

        const pageLimit = defaultLimit(limit);
        const pageOffset = offset ?? 0;
        if (db && sqlread.SQL_SUPPORTED_LISTS.has(list!)) {
          const items = trySqlRead(db, (path) =>
            sqlread.readList(path, list!, {
              limit: pageLimit,
              offset: pageOffset,
              completed_after,
              completed_before,
            }),
          );
          if (items !== undefined) return ok(JSON.stringify(items));
          return ok(JSON.stringify(await readBuiltinListJson(runtime, list!, {
            limit: pageLimit,
            offset: pageOffset,
            completed_after,
            completed_before,
          }, options, true)));
        }
        const fast = await tryFastListRead(runtime, list!, {
          limit: pageLimit,
          offset: pageOffset,
          completed_after,
          completed_before,
        }, options);
        if (fast != null) {
          return ok(fast);
        }

        const mixed = await runtime.jxa(
          `var list = app.lists.byName(P.n);
var todos = list.toDos().map(todoOf);
var projects = [];
try { projects = list.projects().map(projectOf); } catch(e) {}
var items = todos.concat(projects);
if (P.completedAfter || P.completedBefore) {
  items = items.filter(function(item) {
    var stamp = item.completionDate || item.cancellationDate;
    if (!stamp) return false;
    var value = new Date(stamp);
    if (P.completedAfter && value < new Date(P.completedAfter + "T00:00:00")) return false;
    if (P.completedBefore && value > new Date(P.completedBefore + "T23:59:59")) return false;
    return true;
  });
}
return JSON.stringify(items);`,
          {
            n: LIST_NAMES[list!],
            completedAfter: completed_after ?? null,
            completedBefore: completed_before ?? null,
          },
          options,
        );

        const sorted = trySortListItems(
          runtime,
          list!,
          JSON.parse(normalizeThingsJson(mixed)) as Array<Record<string, unknown>>,
        );
        const start = pageOffset;
        const paged = sorted.slice(start, start + pageLimit);
        return ok(JSON.stringify(paged));
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  tools.search = server.registerTool(
    "search",
    {
      description: "Search Things 3 open todos by name or tag. Returns JSON.",
      inputSchema: {
      query: z.string().optional().describe("Text to search in todo names"),
      tag: z.string().optional().describe("Tag name to filter by"),
      limit: z.number().int().nonnegative().max(MAX_RESULT_LIMIT).optional().describe("Max items to return"),
      offset: z.number().int().nonnegative().optional().describe("Items to skip before returning results"),
      },
      annotations: READ_ONLY,
    },
    async ({ query, tag, limit, offset }, extra) => {
      if (!query && !tag) return fail("Provide query or tag");
      const options = requestOptions(extra);
      const pageLimit = defaultLimit(limit);
      const pageOffset = offset ?? 0;
      try {
        const db = sqlDbPath(runtime);
        const sqlResults = trySqlRead(db, (path) =>
          sqlread.search(path, { query, tag, limit: pageLimit, offset: pageOffset }),
        );
        if (sqlResults !== undefined) {
          return ok(
            JSON.stringify(sqlResults),
          );
        }
        return ok(
          normalizeThingsJson(
            await runtime.jxa(
            `var results = P.q ? app.toDos.whose({name: {_contains: P.q}})() : app.toDos();
results = results.filter(function(t) { return t.status() === "open"; });
if (P.t) {
  results = results.filter(function(t) {
    return tagsOf(t).some(function(tagName) { return tagName === P.t; });
  });
}
var start = P.offset || 0;
results = P.limit == null ? results.slice(start) : results.slice(start, start + P.limit);
return JSON.stringify(results.map(todoOf));`,
            { q: query ?? null, t: tag ?? null, limit: pageLimit, offset: pageOffset },
            options,
          ),
          ),
        );
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  tools.export_markdown = server.registerTool(
    "export_markdown",
    {
      description: "Export Things items as clean markdown for pasting into notes. Returns raw markdown text, not JSON.",
      inputSchema: {
      list: z
        .enum(["inbox", "today", "anytime", "upcoming", "someday", "logbook", "trash"])
        .optional()
        .describe("Built-in list to render as markdown"),
      project: z.string().optional().describe("Project name — renders its todos"),
      area: z.string().optional().describe("Area name — renders shallow per-project summaries"),
      id: z.string().optional().describe("Todo or project ID — renders detail"),
      include_notes: z.boolean().optional().describe("Include notes in the output (default true)"),
      include_completed: z.boolean().optional().describe("Include completed and canceled items (default false)"),
      limit: z.number().int().nonnegative().max(MAX_RESULT_LIMIT).optional().describe("Max items to return for list reads"),
      offset: z.number().int().nonnegative().optional().describe("Items to skip before returning results for list reads"),
      completed_after: deadlineSchema.optional().describe("For list reads: only include items completed/canceled on or after yyyy-mm-dd"),
      completed_before: deadlineSchema.optional().describe("For list reads: only include items completed/canceled on or before yyyy-mm-dd"),
      },
      annotations: READ_ONLY,
    },
    async ({ list, project, area, id, include_notes, include_completed, limit, offset, completed_after, completed_before }, extra) => {
      const selectors = [list, project, area, id].filter((value) => value != null);
      if (selectors.length !== 1) {
        return fail("Provide exactly one of list, project, area, or id");
      }
      const options = requestOptions(extra);

      const opts: MdRenderOptions = {
        includeNotes: include_notes ?? true,
        includeCompleted: include_completed ?? (list != null && TERMINAL_MARKDOWN_LISTS.has(list)),
      };
      const db = sqlDbPath(runtime);

      try {
        if (id) {
          const item = trySqlRead(db, (path) => sqlread.readItemForExport(path, id));
          if (item) return ok(renderItem(item as MdItem, opts));
          const jxaItem = JSON.parse(await readItemForExport(runtime, id, options)) as MdItem;
          return ok(renderItem(jxaItem, opts));
        }

        if (project) {
          const proj = trySqlRead(db, (path) => sqlread.readProjectForExport(path, project));
          if (proj) return ok(renderProject(proj as MdProject, opts));
          const jxaProject = JSON.parse(await readProjectForExport(runtime, project, options)) as MdProject;
          return ok(renderProject(jxaProject, opts));
        }

        if (area) {
          const projects = trySqlRead(db, (path) => sqlread.readAreaProjects(path, area));
          if (projects !== undefined) return ok(renderArea(area, projects as MdProject[], opts));
          const jxaProjects = JSON.parse(await readAreaProjectsJson(runtime, area, options)) as MdProject[];
          return ok(renderArea(area, jxaProjects, opts));
        }

        const listOptions = {
          limit: defaultLimit(limit),
          offset: offset ?? 0,
          completed_after,
          completed_before,
        };
        const sqlAttempted = db != null && sqlread.SQL_SUPPORTED_LISTS.has(list!);
        const sqlItems = sqlAttempted
          ? trySqlRead(db, (path) => sqlread.readList(path, list!, listOptions) as MdItem[])
          : undefined;
        const items = sqlItems ?? await readBuiltinListJson(runtime, list!, listOptions, options, sqlAttempted);
        return ok(renderList(list!, items, opts));
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  tools.stats = server.registerTool(
    "stats",
    {
      description: "Return Things counts: windowed (completed, canceled, created) and snapshot (overdue, inbox, today). SQL-first; requires THINGS_FAST_READS=1 and a reachable Things database. Windows use local-time calendar days.",
      inputSchema: {
      since: deadlineSchema.optional().describe("yyyy-mm-dd (default: until)"),
      until: deadlineSchema.optional().describe("yyyy-mm-dd (default: today, local time)"),
      },
      annotations: READ_ONLY,
    },
    async ({ since, until }, extra) => {
      const options = requestOptions(extra);
      const windowUntil = until ?? todayIso();
      const windowSince = since ?? windowUntil;

      if (windowSince > windowUntil) {
        return fail("until must be >= since");
      }

      const window: StatsWindow = { since: windowSince, until: windowUntil };

      try {
        const result = await runtime.statsQuery(window, options);
        if (result == null) {
          return fail(
            "stats requires THINGS_FAST_READS=1 and a reachable Things database. Run 'doctor' for diagnostics.",
          );
        }
        return ok(JSON.stringify(result));
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  tools.add_todo = server.registerTool(
    "add_todo",
    {
      description: "Create a todo in Things 3. Returns the created item with its ID.",
      inputSchema: {
      title: z.string(),
      notes: z.string().optional(),
      when: whenSchema
        .optional()
        .describe("today | tomorrow | evening | anytime | someday | yyyy-mm-dd"),
      deadline: deadlineSchema.optional().describe("yyyy-mm-dd"),
      tags: z.array(z.string()).optional(),
      list: z.string().optional().describe("Project name to add the todo to"),
      checklist_items: z.array(z.string()).optional(),
      },
      annotations: ADDITIVE_WRITE,
    },
    async (params, extra) => {
      const options = requestOptions(extra);
      try {
        const specialWhen = usesSpecialWhen(params.when) ? params.when : undefined;
        const tagsNeedJson = needsJsonTagWrite(params.tags);
        const needsJsonPatch = specialWhen != null || params.checklist_items?.length || tagsNeedJson;
        if (needsJsonPatch) {
          requireToken(runtime.token);
        }

        const result = await runtime.jxa(
          `var props = {name: P.title};
if (P.notes) props.notes = P.notes;
if (P.tags && P.tags.length && !P.tagsNeedJson) props.tagNames = P.tags.join(", ");
if (P.deadline) props.dueDate = new Date(P.deadline + "T12:00:00");
var todo = app.make({new: "toDo", withProperties: props});
if (P.list) {
  var project = app.projects.byName(P.list);
  project.id();
  todo.project = project;
}
scheduleWhen(todo, P.when);
return JSON.stringify({id: todo.id(), name: todo.name(), status: todo.status()});`,
          {
            ...params,
            tagsNeedJson,
          },
          options,
        );

        const created = JSON.parse(result) as { id: string };
        const operation = buildJsonUpdateOperation("todo", created.id, {
          when: specialWhen,
          tags: tagsNeedJson ? params.tags : undefined,
          checklist_items: params.checklist_items,
        });
        if (operation) {
          await runtime.quietJson([operation], undefined, options);
          return ok(await readItemJson(runtime, created.id, options));
        }

        return ok(result);
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  tools.add_project = server.registerTool(
    "add_project",
    {
      description: "Create a project in Things 3 with optional child todos. Returns the created project with ID.",
      inputSchema: {
      title: z.string(),
      notes: z.string().optional(),
      when: whenSchema
        .optional()
        .describe("today | tomorrow | evening | anytime | someday | yyyy-mm-dd"),
      deadline: deadlineSchema.optional().describe("yyyy-mm-dd"),
      tags: z.array(z.string()).optional(),
      area: z.string().optional().describe("Area name"),
      todos: z.array(z.string()).optional().describe("Child todo titles"),
      },
      annotations: ADDITIVE_WRITE,
    },
    async (params, extra) => {
      const options = requestOptions(extra);
      try {
        const specialWhen = usesSpecialWhen(params.when) ? params.when : undefined;
        const tagsNeedJson = needsJsonTagWrite(params.tags);
        const needsJsonPatch = specialWhen != null || tagsNeedJson;
        if (needsJsonPatch) {
          requireToken(runtime.token);
        }

        const result = await runtime.jxa(
          `var props = {name: P.title};
if (P.notes) props.notes = P.notes;
if (P.tags && P.tags.length && !P.tagsNeedJson) props.tagNames = P.tags.join(", ");
if (P.deadline) props.dueDate = new Date(P.deadline + "T12:00:00");
var proj = app.make({new: "project", withProperties: props});
if (P.area) {
  var area = app.areas.byName(P.area);
  area.id();
  proj.area = area;
}
if (P.todos && P.todos.length) {
  for (var i = 0; i < P.todos.length; i++) {
    var t = app.make({new: "toDo", withProperties: {name: P.todos[i]}});
    t.project = proj;
  }
}
scheduleWhen(proj, P.when);
return JSON.stringify({id: proj.id(), name: proj.name(), status: proj.status()});`,
          {
            ...params,
            tagsNeedJson,
          },
          options,
        );

        const created = JSON.parse(result) as { id: string };
        const operation = buildJsonUpdateOperation("project", created.id, {
          when: specialWhen,
          tags: tagsNeedJson ? params.tags : undefined,
        });
        if (operation) {
          await runtime.quietJson([operation], undefined, options);
          return ok(await readItemJson(runtime, created.id, options));
        }

        return ok(result);
      } catch (error) {
        return fail(errmsg(error));
      }
    },
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
      list: z
        .string()
        .optional()
        .describe("Move to project (todos) or area (projects) by name"),
      },
      annotations: MUTATING_WRITE,
    },
    async (params, extra) => {
      const updateFields = [
        params.title,
        params.notes,
        params.when,
        params.deadline,
        params.tags,
        params.checklist_items,
        params.completed,
        params.canceled,
        params.list,
      ];
      if (!updateFields.some((value) => value !== undefined)) {
        return fail("Provide at least one field to update");
      }
      if (params.title === "") {
        return fail("title must not be empty");
      }
      const options = requestOptions(extra);
      try {
        const specialWhen = usesSpecialWhen(params.when) ? params.when : undefined;
        const tagsNeedJson = needsJsonTagWrite(params.tags);
        const needsUrlWhenClear = params.when === "";
        const needsJsonPatch = specialWhen != null || params.checklist_items != null || tagsNeedJson;
        if (needsUrlWhenClear || needsJsonPatch) {
          requireToken(runtime.token);
        }

        const result = await runtime.jxa(
          `var item, type;
try { item = app.projects.byId(P.id); item.id(); type = "project"; }
catch(e) { item = app.toDos.byId(P.id); item.id(); type = "todo"; }
if (P.hasOwnProperty("title") && P.title) item.name = P.title;
if (P.hasOwnProperty("notes")) item.notes = P.notes || "";
if (P.hasOwnProperty("tags") && !P.tagsNeedJson) item.tagNames = P.tags ? P.tags.join(", ") : "";
if (P.hasOwnProperty("deadline")) item.dueDate = P.deadline ? new Date(P.deadline + "T12:00:00") : null;
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
return JSON.stringify({kind: type, item: type === "todo" ? todoOf(item) : projectOf(item)});`,
          {
            ...params,
            tagsNeedJson,
          },
          options,
        );

        const parsed = JSON.parse(result) as {
          kind: "todo" | "project";
          item: unknown;
        };

        if (needsUrlWhenClear) {
          await applyQuietUpdate(runtime, parsed.kind, params.id, { when: "" }, options);
          return ok(await readItemJson(runtime, params.id, options));
        }

        const operation = buildJsonUpdateOperation(parsed.kind, params.id, {
          tags: tagsNeedJson ? params.tags : undefined,
          when: specialWhen,
          checklist_items: params.checklist_items,
        });
        if (operation) {
          await runtime.quietJson([operation], undefined, options);
          return ok(await readItemJson(runtime, params.id, options));
        }

        return ok(JSON.stringify(normalizeThingsValue(parsed.item)));
      } catch (error) {
        return fail(errmsg(error));
      }
    },
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
      annotations: MUTATING_WRITE,
    },
    async (params, extra) => {
      const options = requestOptions(extra);
      try {
        requireToken(runtime.token);
        const detail = await runtime.jxa(
          `return JSON.stringify(P.ids.map(function(id) {
  try {
    var project = app.projects.byId(id); project.id();
    return {id: id, kind: "project"};
  } catch(e) {
    var todo = app.toDos.byId(id); todo.id();
    return {id: id, kind: "todo"};
  }
}));`,
          { ids: params.ids },
          options,
        );
        const items = JSON.parse(detail) as Array<{ id: string; kind: "todo" | "project" }>;
        const operations = items
          .map((item) =>
            buildJsonUpdateOperation(item.kind, item.id, {
              title: params.title,
              notes: params.notes,
              when: params.when,
              deadline: params.deadline,
              tags: params.tags,
              list: params.list,
              completed: params.completed,
              canceled: params.canceled,
              checklist_items: params.checklist_items,
            }),
          )
          .filter((operation): operation is Record<string, unknown> => operation != null);
        if (!operations.length) {
          return fail("Provide at least one field to update");
        }
        await runtime.quietJson(operations, undefined, options);
        return ok(JSON.stringify(items.map((item) => ({ id: item.id, kind: item.kind, updated: true }))));
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  tools.delete = server.registerTool(
    "delete",
    {
      description: "Move a todo, project, or area to Things Trash.",
      inputSchema: {
      id: z.string().describe("Todo, project, or area ID"),
      },
      annotations: DESTRUCTIVE_WRITE,
    },
    async ({ id }, extra) => {
      const options = requestOptions(extra);
      try {
        const result = await runtime.jxa(
          `try {
  var project = app.projects.byId(P.id); project.id();
  app.delete(project);
  return JSON.stringify({id: P.id, kind: "project", deleted: true});
} catch(e1) {
  try {
    var todo = app.toDos.byId(P.id); todo.id();
    app.delete(todo);
    return JSON.stringify({id: P.id, kind: "todo", deleted: true});
  } catch(e2) {
    var area = app.areas.byId(P.id); area.id();
    app.delete(area);
    return JSON.stringify({id: P.id, kind: "area", deleted: true});
  }
}`,
          { id },
          options,
        );
        return ok(result);
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  tools.empty_trash = server.registerTool(
    "empty_trash",
    {
      description: "Permanently delete everything currently in Things Trash.",
      inputSchema: {
      confirm: z.boolean().describe("Must be true to permanently empty Things Trash"),
      },
      annotations: DESTRUCTIVE_WRITE,
    },
    async ({ confirm }, extra) => {
      const options = requestOptions(extra);
      if (!confirm) return fail("Set confirm=true to permanently empty Things Trash");
      try {
        await runtime.jxa("app.emptyTrash();", undefined, options);
        return ok('{"emptied":true}');
      } catch (error) {
        return fail(errmsg(error));
      }
    },
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
      query: z
        .string()
        .optional()
        .describe("Project, area, or tag name to navigate to"),
      },
      annotations: READ_ONLY,
    },
    async ({ id, query }, extra) => {
      if (!id && !query) return fail("Provide id or query");
      const options = requestOptions(extra);
      try {
        await runtime.quietUrl("show", {
          id: id ?? undefined,
          query: query ?? undefined,
        }, options);
        return ok(`Showing: ${id ?? query}`);
      } catch (error) {
        return fail(errmsg(error));
      }
    },
  );

  return tools;
}
