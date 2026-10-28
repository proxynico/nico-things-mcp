#!/usr/bin/env bun
// nico-things-mcp — Things 3 MCP server
// Reads come from Things' SQLite database, falling back to JXA; writes go through Things itself.
// Prompts offer ready-made routines built on those tools.

import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../package.json";
import { CreateRequests } from "./creates";
import { registerPrompts } from "./prompts";
import { createRuntime, openThingsHidden } from "./runtime";
import type { ThingsRuntime } from "./shared";
import { registerTools } from "./tools";

export function createServer(runtime: ThingsRuntime = createRuntime(), requests = new CreateRequests()): {
  server: McpServer;
  tools: Record<string, RegisteredTool>;
} {
  const server = new McpServer({ name: pkg.name, version: pkg.version });
  registerPrompts(server);
  return { server, tools: registerTools(server, runtime, requests) };
}

if (import.meta.main) {
  const runtime = createRuntime();
  if (runtime.dbPath) openThingsHidden().catch(() => {});
  await createServer(runtime).server.connect(new StdioServerTransport());
}
