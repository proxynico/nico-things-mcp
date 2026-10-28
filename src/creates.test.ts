import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateRequests } from "./creates";

const dir = mkdtempSync(join(tmpdir(), "things-create-requests-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("retries join a cancelled caller's operation and survive a new server", async () => {
  const path = join(dir, "retry.sqlite");
  const requests = new CreateRequests({ path });
  const controller = new AbortController();
  let finish: () => void = () => {};
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let creates = 0;
  const args = {
    requestId: "one", tool: "add_todo", params: { title: "Same" },
    create: async (recordId: (id: string) => void) => {
      creates++;
      await gate;
      recordId("id-1");
      return '{"id":"id-1"}';
    },
  };
  const first = requests.run({ ...args, signal: controller.signal });
  controller.abort();
  const retry = requests.run(args);
  finish();
  expect(await first).toBe(await retry);
  expect(creates).toBe(1);
  expect(await new CreateRequests({ path }).run(args)).toBe('{"id":"id-1"}');
  expect(creates).toBe(1);
  await expect(requests.run({ ...args, params: { title: "Different" } })).rejects.toThrow("different arguments");
  await requests.run({ ...args, requestId: "intentional-second-item" });
  expect(creates).toBe(2);
});

test("an unfinished reservation in another server never creates again", async () => {
  const path = join(dir, "unfinished.sqlite");
  const requests = new CreateRequests({ path });
  let finish: () => void = () => {};
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const args = { requestId: "pending", tool: "add_project", params: { title: "Project" } };
  const first = requests.run({ ...args, create: async (recordId) => { recordId("project-1"); await gate; return "ok"; } });
  await expect(new CreateRequests({ path }).run({ ...args, create: async () => "must not run" }))
    .rejects.toThrow("Search Things");
  await Promise.resolve();
  let touched = false;
  await expect(new CreateRequests({ path }).run({ ...args, create: async () => { touched = true; return "bad"; } }))
    .rejects.toThrow("project-1");
  expect(touched).toBeFalse();
  finish();
  await first;
});

test("post-create failures retain the ID and cannot be retried as new creates", async () => {
  const path = join(dir, "failed.sqlite");
  const args = { requestId: "failure", tool: "add_todo", params: { title: "Partial" } };
  let creates = 0;
  const create = async (recordId: (id: string) => void) => { creates++; recordId("partial-1"); throw new Error("patch failed"); };
  await expect(new CreateRequests({ path }).run({ ...args, create })).rejects.toThrow("partial-1");
  await expect(new CreateRequests({ path }).run({ ...args, create })).rejects.toThrow("partial-1");
  expect(creates).toBe(1);
});

test("a request cancelled before creation does not reserve its key", async () => {
  const requests = new CreateRequests({ path: join(dir, "pre-cancel.sqlite") });
  const args = { requestId: "cancel", tool: "add_todo", params: {}, create: async () => "ok" };
  await expect(requests.run({ ...args, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(await requests.run(args)).toBe("ok");
});

test("failed preflight leaves a request ID free for corrected arguments", async () => {
  const requests = new CreateRequests({ path: join(dir, "preflight.sqlite") });
  let creates = 0;
  const args = { requestId: "fix-destination", tool: "add_todo", params: { list: "Missing" },
    create: async () => { creates++; return "created"; } };
  await expect(requests.run({ ...args, preflight: async () => { throw new Error("Project not found"); } }))
    .rejects.toThrow("Project not found");
  expect(creates).toBe(0);
  expect(await requests.run({ ...args, params: { list: "Exists" } })).toBe("created");
  expect(await requests.run({ ...args, params: { list: "Exists" }, preflight: async () => { throw new Error("Destination since removed"); } })).toBe("created");
  expect(creates).toBe(1);
});

test("subprocess arguments are absent from failed outcomes, stored records, and replays", async () => {
  const path = join(dir, "safe-errors.sqlite");
  const args = { requestId: "safe-error", tool: "add_todo", params: { title: "Partial" },
    create: async (recordId: (id: string) => void) => {
      recordId("safe-id");
      throw Object.assign(new Error("Command failed: private-test-argument"), { cmd: "private-test-argument", stderr: "" });
    } };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await new CreateRequests({ path }).run(args);
      throw new Error("Expected a failed create");
    } catch (error) {
      expect(String(error)).toContain("safe-id");
      expect(String(error)).not.toContain("private-test-argument");
    }
  }
  const db = new Database(path, { readonly: true });
  try {
    expect(JSON.stringify(db.query("select * from requests").all())).not.toContain("private-test-argument");
  } finally {
    db.close();
  }
});
