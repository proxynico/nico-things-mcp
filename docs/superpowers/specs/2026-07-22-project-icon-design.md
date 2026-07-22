# Nico Things MCP Project Icon Design

**Date:** 2026-07-22
**Status:** Approved for implementation planning

## Goal

Create a clear project icon for `nico-things-mcp` that works as the repository identity now and as a browser favicon for a future web surface. The mark must remain understandable at 16–32 px.

## Chosen Direction

Use a literal checked-plug mark:

- a deep navy rounded-square background;
- one white plug body;
- two sky-blue prongs drawn behind the plug body, leaving a clean white top edge;
- one deep navy checkmark centered inside the plug body;
- no text, initials, secondary connector line, or extra symbol.

The plug makes the integration role explicit. The checkmark makes the Things/task purpose explicit. Keeping both ideas in one object avoids the ambiguity of the rejected abstract bridge and endpoint concepts.

## Visual System

Use these production colors, matching the approved mockup:

- deep navy: `#18324A`;
- sky blue: `#55B8FF`;
- white: `#FFFFFF`.

The master art uses simple filled shapes and round-ended strokes. It must not depend on fonts, filters, masks, gradients, or embedded raster images. The geometry should use generous spacing so the checkmark, body, and prongs remain distinct at favicon size.

## Source and Deliverables

Create one deterministic, hand-authored SVG master and derive raster formats from it. Do not use generated raster artwork for the master.

Store the project assets under `assets/`:

- `assets/nico-things-mcp-icon.svg` — editable master;
- `assets/nico-things-mcp-icon-512.png` — repository and profile use;
- `assets/favicon.svg` — browser-ready SVG favicon;
- `assets/favicon-32x32.png` — fallback PNG favicon;
- `assets/favicon.ico` — multi-size browser fallback.

The favicon SVG uses the same geometry as the master so the repository and browser marks stay consistent.

## Repository Integration

Add a minimal `README.md` header that centers the SVG icon at 96 px above the project name. Include one sentence identifying the repository as a Things 3 MCP server. Do not expand the README into unrelated product documentation in this change.

No runtime TypeScript, MCP behavior, dependencies, or package scripts should change.

## Export and Failure Handling

Use an installed deterministic SVG renderer for PNG exports. Use an installed icon conversion tool for the ICO file. Do not add a runtime or development dependency solely for asset conversion.

If the local toolchain cannot create a valid multi-size ICO, stop and report the missing tool instead of committing a mislabeled or single-format file. The SVG and PNG assets may still be prepared, but the requested deliverable set is not complete until the ICO validates.

## Verification

Verify the completed asset set with narrow, asset-specific checks:

1. Parse both SVG files successfully.
2. Confirm PNG dimensions and color mode.
3. Confirm the ICO contains valid 16, 32, and 48 px entries.
4. Render or inspect the mark at 16, 32, 128, and 512 px.
5. Check that the prongs remain behind the body, the top edge stays clean, and the checkmark does not close up.
6. Confirm the README image path resolves.
7. Run no project build unless a repository instruction or an implementation change requires it.

## Scope Boundaries

This change does not set external GitHub organization or repository avatars, build a web surface, add favicon HTML tags, imitate the Things app icon, or alter the MCP server. Those actions require separate scope and, where applicable, external authorization.
