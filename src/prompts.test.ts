import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "./index";
import { registerPrompts } from "./prompts";
import type { ThingsRuntime } from "./shared";

const runtime: ThingsRuntime = {
  token: "",
  appPath: "/Applications/Things3.app",
  dbPath: null,
  jxa: async () => "[]",
  quietUrl: async () => {},
  quietJson: async () => {},
};

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function promptText(today: string, name: string): Promise<string> {
  const server = new McpServer({ name: "test", version: "0" });
  registerPrompts(server, { today: () => today });
  const { messages } = await (await connect(server)).getPrompt({ name });
  expect(messages).toHaveLength(1);
  const [message] = messages;
  expect(message?.role).toBe("user");
  if (message?.content.type !== "text") throw new Error("expected a text message");
  return message.content.text;
}

describe("prompts", () => {
  test("the server offers the three routines", async () => {
    const client = await connect(createServer(runtime).server);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => [prompt.name, prompt.title])).toEqual([
      ["plan_my_day", "Plan my day"],
      ["weekly_review", "Weekly review"],
      ["clear_inbox", "Clear my inbox"],
    ]);
    expect(prompts.every((prompt) => !prompt.arguments?.length)).toBeTrue();
  });

  test("plan_my_day names today and its weekday", async () => {
    const text = await promptText("2026-10-28", "plan_my_day");
    expect(text).toContain("Wednesday 2026-10-28");
    expect(text).toContain('`read` with list "today"');
    expect(text).toContain("wait for my OK");
  });

  test("weekly_review covers the last seven days and the week ahead", async () => {
    const text = await promptText("2026-03-03", "weekly_review");
    expect(text).toContain("for 2026-02-25 to 2026-03-03");
    expect(text).toContain('since "2026-02-25" and until "2026-03-03"');
    expect(text).toContain('completed_after "2026-02-25"');
    expect(text).toContain("due by 2026-03-10");
    expect(text).toContain("wait for my OK");
  });

  test("clear_inbox reads existing names before suggesting homes", async () => {
    const text = await promptText("2026-10-28", "clear_inbox");
    expect(text).toContain('list "projects", "areas", and "tags"');
    expect(text).toContain("`delete` only the items I approved");
  });
});
