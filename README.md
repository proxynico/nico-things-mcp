# nico-things-mcp

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

Reads use Things' local SQLite database first when supported and fall back to JXA if SQLite is unavailable. Computed lists use JXA. `stats` is intentionally SQLite-only.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `THINGS_APP_PATH` | Things application path | `/Applications/Things3.app` |
| `THINGS_DB_PATH` | Explicit Things SQLite path | Auto-detected |
| `THINGS_FAST_READS` | Set to `0` to disable SQLite reads | Enabled |
| `COSITAS_SQL_READS` | Set to `0` to route supported reads through JXA | Enabled |
| `COSITAS_FAIL_FAST` | Set to `1` to require a successful JXA startup probe | Disabled |

## Development

```sh
bun run typecheck
bun test
bun run check
bun audit
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [MIT License](LICENSE).
