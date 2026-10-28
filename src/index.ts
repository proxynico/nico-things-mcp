#!/usr/bin/env bun
// nico-things-mcp — Things 3 MCP server
// Reads come from Things' SQLite database, falling back to JXA; writes go through Things itself.

import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../package.json";
import { createRuntime } from "./runtime";
import type { ThingsRuntime } from "./shared";
import { registerTools } from "./tools";

export function createServer(runtime: ThingsRuntime = createRuntime()): {
  server: McpServer;
  tools: Record<string, RegisteredTool>;
} {
  const server = new McpServer({ name: pkg.name, version: pkg.version });
  return { server, tools: registerTools(server, runtime) };
}

if (import.meta.main) {
  await createServer().server.connect(new StdioServerTransport());
}
