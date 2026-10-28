<p align="center">
  <img src="assets/nico-things-mcp-icon.svg" width="96" height="96" alt="Nico Things MCP icon">
</p>

<h1 align="center">nico-things-mcp</h1>

A local [Model Context Protocol](https://modelcontextprotocol.io/) server for Things 3 on macOS. It exposes structured read, search, export, create, update, delete, show, health, and statistics tools while keeping Things data on the Mac.

## Requirements

- macOS with Things 3 installed
- [Bun](https://bun.sh/) 1.3 or newer

## Install and run

```sh
bun install --frozen-lockfile
bun run src/index.ts
```

Example MCP client entry:

```json
{
  "mcpServers": {
    "things": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/nico-things-mcp/src/index.ts"]
    }
  }
}
```

No credential is required for normal JXA reads and writes. Some authenticated JSON update paths require `THINGS_AUTH_TOKEN`; supply it through your MCP host's secure environment management, never in this repository.

## Tools

- `doctor`: report independent SQLite read, JXA read, and authenticated JSON write capabilities
- `read`, `search`: return structured Things data
- `export_markdown`: render lists, areas, projects, or items as Markdown
- `stats`: return SQLite-backed activity and snapshot counts
- `add_todo`, `add_project`, `update`, `bulk_update`: create or change items
- `delete`, `empty_trash`: destructive actions with MCP metadata and explicit trash confirmation
- `show`: open an item or search in Things without activating the app

Reads come straight from Things' local SQLite database. If the database can't be read, they fall back to asking Things over JXA. `stats` needs the database.

Checklist details require SQLite: Things' scripting interface cannot read them. Item reads and write replies return `checklistItems: null` when those details are unavailable, rather than claiming the checklist is empty. Write replies keep fresh fields from Things and wait up to two seconds for a changed checklist to reach SQLite.

`add_todo` and `add_project` require a `request_id` (for example, a UUID). Generate one for each intended item, and reuse it with identical arguments after a timeout. While the server runs, a caller's cancellation does not interrupt a started create; a retry returns the original result. Keep the connection open until the retry completes. New IDs allow intentional duplicate titles. A missing destination fails before reserving the ID, so corrected arguments can use that same ID.

Create outcomes are kept privately in `~/.local/state/nico-things-mcp/creates.sqlite`, shared by MCP server processes on that Mac. Do not delete this file to retry a failed create. A server shutdown can interrupt a create. Its uncertain request stays held: read/update its reported item ID, or search Things if no ID was saved. Retrying cannot restart that operation; it only retrieves an outcome if the original server saves one. Request IDs are local to the Mac; they do not deduplicate calls made on another Mac.

Things only updates the database while it runs, so the server opens Things hidden in the background when it starts. Right after that, reads can lag for the few seconds Things takes to sync. Settled 28 October 2026 by Nico. Rejected: leaving Things closed, with reads showing what it last synced.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `THINGS_APP_PATH` | Things application path | `/Applications/Things3.app` |
| `THINGS_DB_PATH` | Explicit Things SQLite path | Auto-detected |
| `THINGS_FAST_READS` | Set to `0` to read through JXA instead of SQLite | Enabled |

## Development

```sh
bun run typecheck
bun test
bun run check
bun audit
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [MIT License](LICENSE).
