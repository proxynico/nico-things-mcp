import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type ExecFn,
  THINGS_APP_PATH,
  THINGS_DB_PATH,
  THINGS_FAST_READS,
  type ThingsRuntime,
  requireToken,
} from "./shared";

const execFileAsync = promisify(execFile);
// Large JXA fallback reads (a whole Logbook) can pass Node's 1 MB default.
const exec: ExecFn = (file, args, options) => execFileAsync(file, args, { ...options, maxBuffer: 64 * 1024 * 1024 });

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

// Helpers available to every JXA body. P holds the call's arguments, app is Things.
// Calendar dates come back as local yyyy-mm-dd, matching the SQLite reads.
const JXA_PRELUDE = `
var tagsOf = function(item) {
  try {
    return item.tags().map(function(tag) { return tag.name(); });
  } catch(e) {
    var raw = "";
    try { raw = item.tagNames(); } catch(inner) {}
    if (!raw) return [];
    return raw.split(/,\\s*/);
  }
};
var asIso = function(d) {
  return d ? d.toISOString() : null;
};
var asDay = function(d) {
  if (!d) return null;
  var pad = function(n) { return (n < 10 ? "0" : "") + n; };
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
};
var todoOf = function(t) {
  var proj = null, area = null;
  try { proj = t.project().name(); } catch(e) {}
  try { area = t.area().name(); } catch(e) {}
  return {kind:"todo", id:t.id(), name:t.name(), status:t.status(), notes:t.notes(),
    tags:tagsOf(t), dueDate:asDay(t.dueDate()),
    activationDate:asDay(t.activationDate()), completionDate:asIso(t.completionDate()),
    cancellationDate:asIso(t.cancellationDate()),
    project:proj, area:area};
};
var withChecklist = function(t) {
  var r = todoOf(t);
  try {
    r.checklistItems = t.toDoChecklistItems().map(function(c) {
      return {name: c.name(), done: c.status() === "completed"};
    });
  } catch(e) {}
  return r;
};
var projectOf = function(pr) {
  var area = null;
  try { area = pr.area().name(); } catch(e) {}
  return {kind:"project", id:pr.id(), name:pr.name(), status:pr.status(), notes:pr.notes(),
    tags:tagsOf(pr), dueDate:asDay(pr.dueDate()),
    activationDate:asDay(pr.activationDate()), completionDate:asIso(pr.completionDate()),
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
};`;

// Things only updates its database while it runs, so SQLite reads keep it open, hidden.
export async function openThingsHidden(execFn: ExecFn = exec): Promise<void> {
  await execFn("osascript", [
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import("AppKit");
if (!Application(${JSON.stringify(THINGS_APP_PATH)}).running()) {
  var c = $.NSWorkspaceOpenConfiguration.configuration;
  c.activates = false;
  c.hides = true;
  $.NSWorkspace.sharedWorkspace.openApplicationAtURLConfigurationCompletionHandler($.NSURL.fileURLWithPath(${JSON.stringify(THINGS_APP_PATH)}), c, null);
  delay(0.5);
}`,
  ]);
}

export function createRuntime({
  execFn = exec,
  token = process.env.THINGS_AUTH_TOKEN ?? "",
  dbPath = THINGS_FAST_READS ? discoverThingsDbPath() : null,
}: {
  execFn?: ExecFn;
  token?: string;
  dbPath?: string | null;
} = {}): ThingsRuntime {
  return {
    token,
    appPath: THINGS_APP_PATH,
    dbPath,

    async jxa(body, args = {}, options = {}) {
      const script = `function run(argv) {
var P = JSON.parse(argv[0]);
var app = Application(${JSON.stringify(THINGS_APP_PATH)});${JXA_PRELUDE}
${body}
}`;
      const { stdout } = await execFn("osascript", ["-l", "JavaScript", "-e", script, JSON.stringify(args)], options);
      return stdout.trim();
    },

    // Opens a things:/// URL without bringing Things to the front.
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

    async quietJson(operations, options = {}) {
      const requiresAuth = operations.some((operation) => operation.operation === "update");
      if (requiresAuth) requireToken(token);
      await this.quietUrl("json", {
        "auth-token": requiresAuth ? token : undefined,
        reveal: "false",
        data: JSON.stringify(operations),
      }, options);
    },
  };
}
