import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Database } from "bun:sqlite";
import {
  THINGS_APP_PATH,
  THINGS_FAST_READS,
  THINGS_DB_PATH,
  compareNullableNumber,
  errmsg,
  ExecFn,
  isoDayToUnixEnd,
  isoDayToUnixStart,
  isSandboxAutomationError,
  normalizeThingsJson,
  requireToken,
  StatsResult,
  StatsWindow,
  ThingsRuntime,
} from "./shared";
import { stats as sqlStats } from "./sqlread";

const exec = promisify(execFile) as ExecFn;

export function discoverThingsDbPath(): string | null {
  if (THINGS_DB_PATH) {
    return existsSync(THINGS_DB_PATH) ? THINGS_DB_PATH : null;
  }
  const root = join(homedir(), "Library", "Group Containers", "JLMPQHK86H.com.culturedcode.ThingsMac");
  if (!existsSync(root)) return null;
  const dataDir = readdirSync(root, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.startsWith("ThingsData-"))
    ?.name;
  if (!dataDir) return null;
  const candidate = join(root, dataDir, "Things Database.thingsdatabase", "main.sqlite");
  return existsSync(candidate) ? candidate : null;
}

export function createRuntime({
  execFn = exec,
  token = process.env.THINGS_AUTH_TOKEN ?? "",
}: {
  execFn?: ExecFn;
  token?: string;
} = {}): ThingsRuntime {
  let dbPath: string | null | undefined;
  const getDbPath = (): string | null => {
    if (dbPath === undefined) {
      dbPath = discoverThingsDbPath();
    }
    return dbPath;
  };

  return {
    token,
    inspect() {
      return {
        appPath: THINGS_APP_PATH,
        appPathExists: existsSync(THINGS_APP_PATH),
        fastReadsEnabled: THINGS_FAST_READS,
        dbPath: getDbPath(),
      };
    },

    async jxa(body, args = {}, options = {}) {
      const { stdout } = await execFn("osascript", [
        "-l",
        "JavaScript",
        "-e",
        `function run(argv) {
var P = JSON.parse(argv[0]);
var app = Application(${JSON.stringify(THINGS_APP_PATH)});
var tagsOf = function(item) {
  try {
    return item.tags().map(function(tag) { return tag.name(); });
  } catch(e) {
    var raw = "";
    try { raw = item.tagNames(); } catch(inner) {}
    if (!raw) return [];
    return raw.split(/,\s*/);
  }
};
var asIso = function(d) {
  return d ? d.toISOString() : null;
};
var completedAtOf = function(item) {
  try {
    var done = item.completionDate();
    if (done) return done;
  } catch(e) {}
  try {
    var canceled = item.cancellationDate();
    if (canceled) return canceled;
  } catch(e) {}
  return null;
};
var applyReadWindow = function(items) {
  var filtered = items;
  if (P.completedAfter || P.completedBefore) {
    filtered = filtered.filter(function(item) {
      var stamp = completedAtOf(item);
      if (!stamp) return false;
      if (P.completedAfter && stamp < new Date(P.completedAfter + "T00:00:00")) return false;
      if (P.completedBefore && stamp > new Date(P.completedBefore + "T23:59:59")) return false;
      return true;
    });
  }
  var start = P.offset || 0;
  if (P.limit == null) return filtered.slice(start);
  return filtered.slice(start, start + P.limit);
};
var todoOf = function(t) {
  var proj = null, area = null;
  try { proj = t.project().name(); } catch(e) {}
  try { area = t.area().name(); } catch(e) {}
  return {kind:"todo", id:t.id(), name:t.name(), status:t.status(), notes:t.notes(),
    tags:tagsOf(t), dueDate:asIso(t.dueDate()),
    activationDate:asIso(t.activationDate()), completionDate:asIso(t.completionDate()),
    cancellationDate:asIso(t.cancellationDate()),
    project:proj, area:area};
};
var projectOf = function(pr) {
  var area = null;
  try { area = pr.area().name(); } catch(e) {}
  return {kind:"project", id:pr.id(), name:pr.name(), status:pr.status(), notes:pr.notes(),
    tags:tagsOf(pr), dueDate:asIso(pr.dueDate()),
    activationDate:asIso(pr.activationDate()), completionDate:asIso(pr.completionDate()),
    cancellationDate:asIso(pr.cancellationDate()),
    area:area, todoCount:pr.toDos().length};
};
var scheduleWhen = function(obj, w) {
  if (!w) return;
  if (w === "today") app.schedule(obj, {"for": new Date()});
  else if (w === "tomorrow") {
    var d = new Date(); d.setDate(d.getDate() + 1);
    app.schedule(obj, {"for": d});
  } else if (w !== "anytime" && w !== "someday" && w !== "evening") {
    app.schedule(obj, {"for": new Date(w + "T12:00:00")});
  }
};
${body}
}`,
        JSON.stringify(args),
      ] as string[], options);
      return stdout.trim();
    },

    async quietUrl(path, params, options = {}) {
      const qs = Object.entries(params)
        .filter((entry): entry is [string, string] => entry[1] != null)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");
      const url = `things:///${path}${qs ? "?" + qs : ""}`;
      await execFn("osascript", [
        "-l",
        "JavaScript",
        "-e",
        `ObjC.import("AppKit");
var u = $.NSURL.URLWithString(${JSON.stringify(url)});
var c = $.NSWorkspaceOpenConfiguration.configuration;
c.activates = false;
$.NSWorkspace.sharedWorkspace.openURLConfigurationCompletionHandler(u, c, null);
delay(0.5);`,
      ], options);
    },

    async quietJson(operations, reveal = false, options = {}) {
      const requiresAuth = operations.some((operation) => operation.operation === "update");
      if (requiresAuth) {
        requireToken(token);
      }
      await this.quietUrl("json", {
        "auth-token": requiresAuth ? token : undefined,
        reveal: reveal ? "true" : "false",
        data: JSON.stringify(operations),
      }, options);
    },

    async fastListRead(list, options = {}, callOptions = {}) {
      // SQL-first fast-read paths. Things JXA cannot reliably enumerate the
      // built-in Inbox and Today lists (list.toDos() returns empty), so we
      // resolve IDs from SQLite and hydrate via JXA by-id.
      const supported = list === "logbook" || list === "trash" || list === "today" || list === "inbox";
      if (!THINGS_FAST_READS || !supported) {
        return null;
      }

      const dbPath = getDbPath();
      if (!dbPath) {
        return null;
      }

      const db = new Database(dbPath, { readonly: true, create: false });
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        const where: string[] = ["type in (0, 1)"];
        const params: Array<string | number> = [];
        let orderBy = "userModificationDate desc";

        if (list === "logbook") {
          where.push("trashed = 0");
          where.push("status in (2, 3)");
          orderBy = "stopDate desc, userModificationDate desc";
        } else if (list === "trash") {
          where.push("trashed = 1");
        } else if (list === "today") {
          where.push("trashed = 0");
          where.push("status = 0");
          where.push("todayIndex != 0");
          orderBy = "todayIndex asc, userModificationDate desc";
        } else if (list === "inbox") {
          where.push("trashed = 0");
          where.push("status = 0");
          where.push("project is null");
          where.push("area is null");
          where.push("heading is null");
          where.push("start != 2");
          where.push("todayIndex = 0");
          orderBy = '"index" asc, userModificationDate desc';
        }

        if (options.completed_after) {
          where.push("stopDate >= ?");
          params.push(isoDayToUnixStart(options.completed_after));
        }
        if (options.completed_before) {
          where.push("stopDate <= ?");
          params.push(isoDayToUnixEnd(options.completed_before));
        }

        let sql = `
          select uuid as id
          from TMTask
          where ${where.join(" and ")}
          order by ${orderBy}
        `;

        if (options.limit != null) {
          sql += " limit ? offset ?";
          params.push(options.limit, options.offset ?? 0);
        } else if ((options.offset ?? 0) > 0) {
          sql += " limit -1 offset ?";
          params.push(options.offset ?? 0);
        }

        const rows = db.query(sql).all(...params) as Array<{ id: string }>;
        if (!rows.length) {
          return "[]";
        }

        return normalizeThingsJson(
          await this.jxa(
          `return JSON.stringify(P.ids.map(function(id) {
  try {
    var todo = app.toDos.byId(id); todo.id();
    return todoOf(todo);
  } catch(e) {
    var project = app.projects.byId(id); project.id();
    return projectOf(project);
  }
}));`,
            { ids: rows.map((row) => row.id) },
            callOptions,
          ),
        );
      } finally {
        db.close(false);
      }
    },

    sortListItems(list, items) {
      if (!items.length) return items;

      const dbPath = getDbPath();
      if (!dbPath) {
        return items;
      }

      const ids = items
        .map((item) => String(item.id ?? ""))
        .filter((id) => id.length > 0);
      if (!ids.length) {
        return items;
      }

      const placeholders = ids.map(() => "?").join(", ");
      const db = new Database(dbPath, { readonly: true, create: false });
      try {
        db.exec("PRAGMA busy_timeout = 5000");
        const rows = db
          .query(
            `select uuid as id, "index" as idx, todayIndex, startDate, deadline, stopDate, userModificationDate
             from TMTask
             where uuid in (${placeholders})`,
          )
          .all(...ids) as Array<{
          id: string;
          idx: number | null;
          todayIndex: number | null;
          startDate: number | null;
          deadline: number | null;
          stopDate: number | null;
          userModificationDate: number | null;
        }>;

        const meta = new Map(rows.map((row) => [row.id, row]));
        const original = new Map(items.map((item, index) => [String(item.id ?? index), index]));

        return [...items].sort((left, right) => {
          const l = meta.get(String(left.id ?? ""));
          const r = meta.get(String(right.id ?? ""));

          if (list === "today") {
            const byToday = compareNullableNumber(l?.todayIndex, r?.todayIndex);
            if (byToday !== 0) return byToday;
          }

          if (list === "upcoming") {
            const byStart = compareNullableNumber(l?.startDate, r?.startDate);
            if (byStart !== 0) return byStart;
            const byDeadline = compareNullableNumber(l?.deadline, r?.deadline);
            if (byDeadline !== 0) return byDeadline;
          }

          const byIndex = compareNullableNumber(l?.idx, r?.idx);
          if (byIndex !== 0) return byIndex;

          if (list === "logbook" || list === "trash") {
            const byStop = compareNullableNumber(-(l?.stopDate ?? 0), -(r?.stopDate ?? 0));
            if (byStop !== 0) return byStop;
          }

          if (l?.userModificationDate != null || r?.userModificationDate != null) {
            const byModified = compareNullableNumber(-(l?.userModificationDate ?? 0), -(r?.userModificationDate ?? 0));
            if (byModified !== 0) return byModified;
          }

          return (original.get(String(left.id ?? "")) ?? 0) - (original.get(String(right.id ?? "")) ?? 0);
        });
      } finally {
        db.close(false);
      }
    },

    async statsQuery(window: StatsWindow): Promise<StatsResult | null> {
      if (!THINGS_FAST_READS) return null;
      const dbPath = getDbPath();
      if (!dbPath) return null;
      return sqlStats(dbPath, window);
    },
  };
}

export async function verifyThingsAccess(runtime: ThingsRuntime, options = {}): Promise<void> {
  try {
    await runtime.jxa(
      `return JSON.stringify(app.lists().map(function(list) {
  return list.name();
}));`,
      undefined,
      options,
    );
  } catch (error) {
    if (isSandboxAutomationError(error)) {
      throw new Error(
        "Things 3 automation is blocked by the current sandbox. Run cositas outside the Codex sandbox or another restricted osascript environment.",
      );
    }
    throw new Error(`Things 3 startup check failed: ${errmsg(error)}`);
  }
}
