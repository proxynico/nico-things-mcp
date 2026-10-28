import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { errmsg } from "./shared";

const recordFields = z.object({
  fingerprint: z.string(),
  item_id: z.string().nullable(),
});
const recordSchema = z.discriminatedUnion("state", [
  recordFields.extend({ state: z.literal("pending"), result: z.null() }),
  recordFields.extend({ state: z.literal("complete"), result: z.string() }),
  recordFields.extend({ state: z.literal("failed"), result: z.string() }),
]);

// Reservations survive reconnects and separate MCP server processes. Never expire a key:
// forgetting an uncertain create would make its next retry create a duplicate.
export class CreateRequests {
  private readonly path: string;
  private readonly running = new Map<string, Promise<string>>();

  constructor({ path = join(homedir(), ".local", "state", "nico-things-mcp", "creates.sqlite") }: { path?: string } = {}) {
    this.path = path;
  }

  private withDb<T>(fn: (db: Database) => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const db = new Database(this.path, { create: true });
    try {
      chmodSync(this.path, 0o600);
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
      db.exec(`CREATE TABLE IF NOT EXISTS requests (
        request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
        item_id TEXT, result TEXT
      )`);
      return fn(db);
    } finally {
      db.close();
    }
  }

  async run({ requestId, tool, params, signal, create }: {
    requestId: string;
    tool: string;
    params: Record<string, unknown>;
    signal?: AbortSignal;
    create: (recordId: (id: string) => void) => Promise<string>;
  }): Promise<string> {
    signal?.throwIfAborted();
    const fingerprint = createHash("sha256").update(JSON.stringify([
      tool, Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))),
    ])).digest("hex");
    const { inserted, record } = this.withDb((db) => {
      const inserted = db.query("INSERT OR IGNORE INTO requests VALUES (?, ?, 'pending', NULL, NULL)")
        .run(requestId, fingerprint).changes > 0;
      return { inserted, record: recordSchema.parse(db.query("SELECT * FROM requests WHERE request_id = ?").get(requestId)) };
    });
    if (record.fingerprint !== fingerprint) throw new Error("request_id was already used with different arguments; keep the original arguments when retrying");
    if (!inserted) {
      const running = this.running.get(requestId);
      if (running) return running;
      if (record.state === "complete") return record.result;
      if (record.state === "failed") throw new Error(record.result);
      throw new Error(`Create is still running or its outcome is uncertain.${record.item_id ? ` Item ID: ${record.item_id}. Read/update that item.` : " Search Things to reconcile it."} Retry only with this request_id; do not issue a new create.`);
    }

    let itemId: string | undefined;
    // Do not forward the caller's signal after reservation: finish any write already started.
    const operation = Promise.resolve().then(async () => {
      try {
        const result = await create((id) => {
          itemId = id;
          this.withDb((db) => db.query("UPDATE requests SET item_id = ? WHERE request_id = ?").run(id, requestId));
        });
        this.withDb((db) => db.query("UPDATE requests SET state = 'complete', result = ? WHERE request_id = ?").run(result, requestId));
        return result;
      } catch (error) {
        const message = itemId
          ? `Item created with ID ${itemId}, but the remaining work failed: ${errmsg(error)}. Read/update that ID; do not create again.`
          : `Create outcome is uncertain: ${errmsg(error)}. Search Things before doing anything else; do not retry with a new request_id.`;
        this.withDb((db) => db.query("UPDATE requests SET state = 'failed', result = ? WHERE request_id = ?").run(message, requestId));
        throw new Error(message);
      } finally {
        this.running.delete(requestId);
      }
    });
    this.running.set(requestId, operation);
    return operation;
  }
}
