import { z } from "zod";

export type RuntimeCallOptions = {
  signal?: AbortSignal;
};

export type ExecFn = (file: string, args: string[], options?: RuntimeCallOptions) => Promise<{ stdout: string }>;

export type ThingsRuntime = {
  token: string;
  appPath: string;
  // Things' SQLite database, or null when SQLite reads are off or no database was found.
  dbPath: string | null;
  jxa(body: string, args?: Record<string, unknown>, options?: RuntimeCallOptions): Promise<string>;
  quietUrl(path: string, params: Record<string, string | undefined>, options?: RuntimeCallOptions): Promise<void>;
  quietJson(operations: Array<Record<string, unknown>>, options?: RuntimeCallOptions): Promise<void>;
};

export type StatsWindow = { since: string; until: string };

export type StatsResult = {
  window: StatsWindow;
  completed: number;
  canceled: number;
  created: number;
  overdue: number;
  inbox: number;
  today: number;
};

export const THINGS_APP_PATH = process.env.THINGS_APP_PATH ?? "/Applications/Things3.app";
export const THINGS_DB_PATH = process.env.THINGS_DB_PATH;
export const THINGS_FAST_READS = process.env.THINGS_FAST_READS !== "0";

const WHEN_KEYWORDS = ["today", "tomorrow", "evening", "anytime", "someday"];
// Things scheduling that JXA cannot express; these go through a JSON update.
const JSON_ONLY_WHEN = new Set(["evening", "anytime", "someday"]);

const SANDBOX_FAILURE_MARKERS = [
  "com.apple.hiservices-xpcservice",
  "Connection Invalid",
  "Connection invalid",
  "Sandbox restriction",
];

function parseIsoDay(value: string): [number, number, number] {
  return value.split("-").map(Number) as [number, number, number];
}

function isValidIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = parseIsoDay(value);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

const dateOr = (keywords: string[], message: string) =>
  z.string().refine((value) => keywords.includes(value) || isValidIsoDay(value), { message });

export const whenSchema = dateOr(WHEN_KEYWORDS, "Use today, tomorrow, evening, anytime, someday, or yyyy-mm-dd");
export const updateWhenSchema = dateOr(
  [...WHEN_KEYWORDS, ""],
  "Use today, tomorrow, evening, anytime, someday, yyyy-mm-dd, or empty string",
);
export const deadlineSchema = dateOr([], "Use a real yyyy-mm-dd calendar date");
export const updateDeadlineSchema = dateOr([""], "Use yyyy-mm-dd or empty string");

export const errmsg = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
  if (stderr) {
    return stderr
      .replace(/^execution error: /, "")
      .replace(/ \(-?\d+\)$/, "");
  }
  // execFile's message includes argv, which can contain authenticated Things URLs.
  if ("cmd" in error) return "Things automation process failed without an error message";
  return error.message;
};

export const isSandboxAutomationError = (error: unknown): boolean => {
  const message = errmsg(error);
  return SANDBOX_FAILURE_MARKERS.some((marker) => message.includes(marker));
};

export function isoDayToUnixStart(value: string): number {
  const [year, month, day] = parseIsoDay(value);
  return Math.floor(new Date(year, month - 1, day, 0, 0, 0).getTime() / 1000);
}

export function isoDayToUnixEnd(value: string): number {
  const [year, month, day] = parseIsoDay(value);
  return Math.floor(new Date(year, month - 1, day, 23, 59, 59).getTime() / 1000);
}

export function todayIso(): string {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
}

// Things packs calendar dates (deadline, startDate) as integers:
// year << 16 | month << 12 | day << 7. Monotonic with the calendar date, so
// packed values can be compared directly for ordering (e.g. overdue checks).
export function isoDayToThingsDate(value: string): number {
  const [year, month, day] = parseIsoDay(value);
  return (year << 16) | (month << 12) | (day << 7);
}

// Things can report both terminal dates on one item; keep only the one that matches its status.
export function normalizeThingsValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeThingsValue(entry)) as T;
  }

  if (value != null && typeof value === "object") {
    const normalized = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeThingsValue(entry)]),
    ) as Record<string, unknown>;

    const status = typeof normalized.status === "string" ? normalized.status : null;
    if (status && ("completionDate" in normalized || "cancellationDate" in normalized)) {
      const stamp = normalized.completionDate ?? normalized.cancellationDate ?? null;
      normalized.completionDate = status === "completed" ? stamp : null;
      normalized.cancellationDate = status === "canceled" ? (normalized.cancellationDate ?? stamp) : null;
    }

    return normalized as T;
  }

  return value;
}

export function usesJsonOnlyWhen(value: string | undefined): value is string {
  return value != null && JSON_ONLY_WHEN.has(value);
}

export function requireToken(token: string): void {
  if (!token) {
    throw new Error("THINGS_AUTH_TOKEN is required for this operation");
  }
}

// JXA joins tags with ", ", so a tag containing a comma has to go through JSON.
export function needsJsonTagWrite(tags: string[] | undefined): boolean {
  return Boolean(tags?.some((tag) => tag.includes(",")));
}

export type JsonPatch = {
  title?: string;
  notes?: string;
  when?: string;
  deadline?: string;
  tags?: string[];
  list?: string;
  completed?: boolean;
  canceled?: boolean;
  checklist_items?: string[];
};

// Attributes for a Things JSON update, or null when nothing applies to this kind.
export function jsonUpdateAttributes(kind: "todo" | "project", patch: JsonPatch): Record<string, unknown> | null {
  const attributes: Record<string, unknown> = {};

  if (patch.title != null) attributes.title = patch.title;
  if (patch.notes != null) attributes.notes = patch.notes;
  if (patch.when) attributes.when = patch.when;
  if (patch.deadline) attributes.deadline = patch.deadline;
  if (patch.tags != null) attributes.tags = patch.tags;
  if (patch.canceled === true) attributes.canceled = true;
  else if (patch.completed === true) attributes.completed = true;
  else if (patch.completed === false || patch.canceled === false) {
    attributes.completed = false;
    attributes.canceled = false;
  }
  if (patch.list != null) attributes[kind === "todo" ? "list" : "area"] = patch.list;
  if (kind === "todo" && patch.checklist_items != null) {
    attributes["checklist-items"] = patch.checklist_items.map((title) => ({
      type: "checklist-item",
      attributes: { title },
    }));
  }

  return Object.keys(attributes).length ? attributes : null;
}

export function jsonUpdate(kind: "todo" | "project", id: string, attributes: Record<string, unknown>) {
  return { type: kind === "todo" ? "to-do" : "project", operation: "update", id, attributes };
}
