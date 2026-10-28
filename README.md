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
