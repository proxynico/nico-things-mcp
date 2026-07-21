# Contributing

Thanks for helping improve nico-things-mcp.

## Development setup

Use Bun and the checked-in lockfile:

```sh
bun install --frozen-lockfile
```

Keep changes small and focused. Add a failing test before changing behavior, then run:

```sh
bun run typecheck
bun test
bun run check
bun audit
git diff --check
```

Do not commit Things data, database files, tokens, credentials, or machine-specific paths. Do not add `THINGS_AUTH_TOKEN` to repository or shared workspace settings.

## Pull requests

Explain the user-visible change, the tests added, and any macOS or Things version assumptions. Preserve SQLite-to-JXA fallback behavior unless the change explicitly targets it; `stats` must remain clear when SQLite is unavailable.
