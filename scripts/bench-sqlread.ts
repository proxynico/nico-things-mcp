#!/usr/bin/env bun
// A/B: pure-SQL read path vs SQL-IDs-then-JXA-hydrate path, against the live
// Things database. Measures latency and checks field parity item-by-item.
//
//   bun run scripts/bench-sqlread.ts
//
// Read-only. Never writes to Things.

import { createRuntime, discoverThingsDbPath } from "../src/runtime";
import { normalizeThingsValue } from "../src/shared";
import * as sql from "../src/sqlread";

const dbPath = discoverThingsDbPath();
if (!dbPath) {
  console.error("No Things database found.");
  process.exit(1);
}
const runtime = createRuntime();

function now(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000; // ms
}

async function timed<T>(label: string, fn: () => Promise<T> | T): Promise<{ ms: number; value: T }> {
  const start = now();
  const value = await fn();
  return { ms: now() - start, value };
}

type Item = Record<string, unknown>;

// Fields expected to differ by representation, not by meaning.
const SOFT_FIELDS = new Set(["dueDate", "activationDate", "completionDate", "cancellationDate"]);

function dateOnly(value: unknown): unknown {
  if (typeof value === "string" && value.length >= 10) return value.slice(0, 10);
  return value;
}

// JXA renders calendar dates via a local-midnight Date -> toISOString(), which
// shifts them back by the local UTC offset (one day for UTC+). Treat date
// fields within 1 day as equal so the systematic JXA artifact is not flagged.
function dateWithinOneDay(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return a == null && b == null;
  const da = Date.parse(dateOnly(a) as string);
  const db = Date.parse(dateOnly(b) as string);
  if (Number.isNaN(da) || Number.isNaN(db)) return dateOnly(a) === dateOnly(b);
  return Math.abs(da - db) <= 24 * 3600 * 1000;
}

function diffItem(jxa: Item, sqlItem: Item): string[] {
  const diffs: string[] = [];
  const keys = new Set([...Object.keys(jxa), ...Object.keys(sqlItem)]);
  for (const key of keys) {
    const a = jxa[key];
    const b = sqlItem[key];
    if (SOFT_FIELDS.has(key)) {
      if (!dateWithinOneDay(a, b)) diffs.push(`${key}: jxa=${JSON.stringify(a)} sql=${JSON.stringify(b)}`);
      continue;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (JSON.stringify([...a].sort()) !== JSON.stringify([...b].sort())) {
        diffs.push(`${key}: jxa=${JSON.stringify(a)} sql=${JSON.stringify(b)}`);
      }
      continue;
    }
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) {
      diffs.push(`${key}: jxa=${JSON.stringify(a)} sql=${JSON.stringify(b)}`);
    }
  }
  return diffs;
}

function compareLists(name: string, jxaItems: Item[], sqlItems: Item[]): void {
  if (jxaItems.length !== sqlItems.length) {
    console.log(`  [!] ${name}: count mismatch jxa=${jxaItems.length} sql=${sqlItems.length}`);
  }
  const sqlById = new Map(sqlItems.map((i) => [String(i.id), i]));
  let mismatched = 0;
  const samples: string[] = [];
  for (const j of jxaItems) {
    const s = sqlById.get(String(j.id));
    if (!s) {
      mismatched++;
      if (samples.length < 3) samples.push(`  missing in sql: ${j.id} "${j.name}"`);
      continue;
    }
    const diffs = diffItem(j, s);
    if (diffs.length) {
      mismatched++;
      if (samples.length < 3) samples.push(`  ${j.id} "${j.name}": ${diffs.join(" | ")}`);
    }
  }
  const status = mismatched === 0 ? "PARITY OK" : `${mismatched}/${jxaItems.length} differ`;
  console.log(`  ${name}: ${status}`);
  samples.forEach((s) => console.log(`   ${s}`));
}

async function main(): Promise<void> {
  console.log(`db: ${dbPath}\n`);

  const lists = ["inbox", "today", "logbook", "trash"];
  for (const list of lists) {
    const opts = { limit: 100, offset: 0 };
    const jxa = await timed(`jxa:${list}`, async () => {
      const raw = await runtime.fastListRead(list, opts);
      return raw == null ? [] : (JSON.parse(raw) as Item[]);
    });
    const sqlRun = await timed(`sql:${list}`, () => sql.readList(dbPath!, list, opts));
    console.log(`${list}: jxa(hydrate)=${jxa.ms.toFixed(1)}ms  sql(pure)=${sqlRun.ms.toFixed(2)}ms  speedup=${(jxa.ms / Math.max(sqlRun.ms, 0.001)).toFixed(0)}x`);
    compareLists(list, jxa.value, sqlRun.value);
  }

  // by-id parity: take a logbook item
  const logbook = sql.readList(dbPath, "logbook", { limit: 1, offset: 0 });
  if (logbook[0]) {
    const id = String(logbook[0].id);
    const jxa = await timed("jxa:byId", async () => {
      const raw = await runtime.jxa(
        `try { var t = app.toDos.byId(P.id); t.id(); return JSON.stringify(todoOf(t)); }
         catch(e){ var p = app.projects.byId(P.id); p.id(); return JSON.stringify(projectOf(p)); }`,
        { id },
      );
      return normalizeThingsValue(JSON.parse(raw)) as Item;
    });
    const sqlRun = await timed("sql:byId", () => sql.readById(dbPath!, id));
    console.log(`\nby-id (${id}): jxa=${jxa.ms.toFixed(1)}ms  sql=${sqlRun.ms.toFixed(2)}ms`);
    const sqlItem = sqlRun.value as Item | null;
    if (sqlItem) {
      const diffs = diffItem(jxa.value, sqlItem);
      console.log(`  ${diffs.length === 0 ? "PARITY OK" : "diffs: " + diffs.join(" | ")}`);
    }
  }

  // search parity
  const probe = "report";
  const jxaSearch = await timed("jxa:search", async () => {
    const raw = await runtime.jxa(
      `var results = app.toDos.whose({name: {_contains: P.q}})();
       results = results.filter(function(t){ return t.status() === "open"; });
       return JSON.stringify(results.map(todoOf));`,
      { q: probe },
    );
    return JSON.parse(raw) as Item[];
  });
  const sqlSearch = await timed("sql:search", () => sql.search(dbPath!, { query: probe }));
  console.log(`\nsearch "${probe}": jxa=${jxaSearch.ms.toFixed(1)}ms  sql=${sqlSearch.ms.toFixed(2)}ms`);
  compareLists("search", jxaSearch.value, sqlSearch.value);
}

await main();
