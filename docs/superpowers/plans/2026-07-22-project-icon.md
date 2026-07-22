# Nico Things MCP Project Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved checked-plug project icon as deterministic SVG, PNG, and ICO assets and show it in a minimal repository README.

**Architecture:** Keep one hand-authored SVG geometry as the source of truth, copy that geometry into the browser-facing SVG favicon, and use the installed ImageMagick CLI for deterministic raster exports. The repository integration is a minimal README header; runtime TypeScript and package configuration remain unchanged.

**Tech Stack:** SVG 1.1-compatible XML, ImageMagick 7.1.2, `xmllint`, Markdown, Git

## Global Constraints

- Use deep navy `#18324A`, sky blue `#55B8FF`, and white `#FFFFFF`.
- Draw the blue prongs behind the white plug body so the body keeps a clean top edge.
- Include one navy checkmark inside the white plug body.
- Use no text, initials, secondary connector line, extra symbol, font, filter, mask, gradient, or embedded raster image in the mark.
- Keep the same geometry in the master SVG and SVG favicon.
- Add no runtime or development dependency for asset conversion.
- Do not change runtime TypeScript, MCP behavior, dependencies, or package scripts.
- Do not run a project build for this asset-only change.

---

### Task 1: Create the vector source of truth

**Files:**
- Create: `assets/nico-things-mcp-icon.svg`
- Create: `assets/favicon.svg`

**Interfaces:**
- Consumes: the approved colors and checked-plug geometry from `docs/superpowers/specs/2026-07-22-project-icon-design.md`
- Produces: two parseable SVG files with identical view boxes and mark geometry for raster export and README use

- [ ] **Step 1: Run the vector asset contract and verify it fails**

Run:

```bash
for asset in assets/nico-things-mcp-icon.svg assets/favicon.svg; do
  test -f "$asset" || { echo "missing: $asset"; exit 1; }
done
```

Expected: exit 1 with `missing: assets/nico-things-mcp-icon.svg`.

- [ ] **Step 2: Create the master SVG**

Create `assets/nico-things-mcp-icon.svg` with exactly:

```svg
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 100 100" fill="none" role="img" aria-labelledby="title description">
  <title id="title">Nico Things MCP</title>
  <desc id="description">A white plug with blue prongs and a navy checkmark on a navy rounded square.</desc>
  <rect width="100" height="100" rx="30" fill="#18324A"/>
  <rect x="35" y="14" width="8" height="23" rx="4" fill="#55B8FF"/>
  <rect x="57" y="14" width="8" height="23" rx="4" fill="#55B8FF"/>
  <path d="M27 30H73V59C73 72 63 82 50 82C37 82 27 72 27 59V30Z" fill="#FFFFFF"/>
  <path d="M34.82 53C34.82 51.85 35.26 50.7 36.14 49.82C37.9 48.06 40.74 48.06 42.5 49.82L47.07 54.39L60.5 37.8C62.06 35.87 64.89 35.58 66.82 37.14C68.75 38.7 69.04 41.53 67.48 43.46L50.9 63.94C50.1 64.93 48.91 65.54 47.64 65.59C46.37 65.65 45.13 65.16 44.23 64.26L36.14 56.17C35.26 55.29 34.82 54.15 34.82 53Z" fill="#18324A"/>
</svg>
```

- [ ] **Step 3: Create the SVG favicon with the same geometry**

Create `assets/favicon.svg` with exactly:

```svg
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" fill="none" role="img" aria-labelledby="title description">
  <title id="title">Nico Things MCP favicon</title>
  <desc id="description">A white plug with blue prongs and a navy checkmark on a navy rounded square.</desc>
  <rect width="100" height="100" rx="30" fill="#18324A"/>
  <rect x="35" y="14" width="8" height="23" rx="4" fill="#55B8FF"/>
  <rect x="57" y="14" width="8" height="23" rx="4" fill="#55B8FF"/>
  <path d="M27 30H73V59C73 72 63 82 50 82C37 82 27 72 27 59V30Z" fill="#FFFFFF"/>
  <path d="M34.82 53C34.82 51.85 35.26 50.7 36.14 49.82C37.9 48.06 40.74 48.06 42.5 49.82L47.07 54.39L60.5 37.8C62.06 35.87 64.89 35.58 66.82 37.14C68.75 38.7 69.04 41.53 67.48 43.46L50.9 63.94C50.1 64.93 48.91 65.54 47.64 65.59C46.37 65.65 45.13 65.16 44.23 64.26L36.14 56.17C35.26 55.29 34.82 54.15 34.82 53Z" fill="#18324A"/>
</svg>
```

- [ ] **Step 4: Parse both SVG files and enforce the geometry contract**

Run:

```bash
xmllint --noout assets/nico-things-mcp-icon.svg assets/favicon.svg
test "$(rg -c 'viewBox="0 0 100 100"' assets/nico-things-mcp-icon.svg assets/favicon.svg | wc -l | tr -d ' ')" = "2"
test "$(rg -c '#18324A' assets/nico-things-mcp-icon.svg assets/favicon.svg | wc -l | tr -d ' ')" = "2"
test "$(rg -c '#55B8FF' assets/nico-things-mcp-icon.svg assets/favicon.svg | wc -l | tr -d ' ')" = "2"
```

Expected: exit 0 with no output.

- [ ] **Step 5: Render and inspect the master before generating deliverables**

Run:

```bash
magick -background none assets/nico-things-mcp-icon.svg -resize 256x256 .context/nico-things-mcp-icon-preview.png
```

Open `.context/nico-things-mcp-icon-preview.png` with the image viewer. Expected: a navy rounded square; two blue prongs disappear cleanly behind the white body; the navy checkmark is centered and open.

- [ ] **Step 6: Commit the vector assets**

```bash
git add assets/nico-things-mcp-icon.svg assets/favicon.svg
git commit -m "feat: add project icon vectors"
```

### Task 2: Export and validate browser and repository formats

**Files:**
- Create: `assets/nico-things-mcp-icon-512.png`
- Create: `assets/favicon-32x32.png`
- Create: `assets/favicon.ico`

**Interfaces:**
- Consumes: `assets/nico-things-mcp-icon.svg` and `assets/favicon.svg` from Task 1
- Produces: one 512 px RGBA repository image, one 32 px RGBA favicon, and one ICO containing 16, 32, and 48 px entries

- [ ] **Step 1: Run the raster asset contract and verify it fails**

Run:

```bash
for asset in assets/nico-things-mcp-icon-512.png assets/favicon-32x32.png assets/favicon.ico; do
  test -f "$asset" || { echo "missing: $asset"; exit 1; }
done
```

Expected: exit 1 with `missing: assets/nico-things-mcp-icon-512.png`.

- [ ] **Step 2: Export the PNG assets**

Run:

```bash
magick -background none assets/nico-things-mcp-icon.svg -resize 512x512 assets/nico-things-mcp-icon-512.png
magick -background none assets/favicon.svg -resize 32x32 assets/favicon-32x32.png
```

Expected: exit 0 and both PNG files exist.

- [ ] **Step 3: Export the multi-size ICO**

Run:

```bash
magick -background none assets/favicon.svg -define icon:auto-resize=48,32,16 assets/favicon.ico
```

Expected: exit 0 and `assets/favicon.ico` exists.

- [ ] **Step 4: Verify dimensions and ICO entries**

Run:

```bash
magick identify -format '%f %wx%h\n' assets/nico-things-mcp-icon-512.png assets/favicon-32x32.png
magick identify -format '%wx%h\n' assets/favicon.ico | sort -u
```

Expected:

```text
nico-things-mcp-icon-512.png 512x512
favicon-32x32.png 32x32
16x16
32x32
48x48
```

- [ ] **Step 5: Verify the PNGs contain transparent corners and opaque artwork**

Run:

```bash
for asset in assets/nico-things-mcp-icon-512.png assets/favicon-32x32.png; do
  test "$(magick "$asset" -alpha extract -format '%[fx:minima],%[fx:maxima]' info:)" = "0,1"
done
```

Expected: exit 0 with no output.

- [ ] **Step 6: Build and inspect the size comparison**

Run:

```bash
magick assets/nico-things-mcp-icon-512.png -resize 128x128 .context/icon-128.png
magick assets/nico-things-mcp-icon-512.png -resize 32x32 .context/icon-32.png
magick assets/nico-things-mcp-icon-512.png -resize 16x16 .context/icon-16.png
magick montage .context/icon-16.png .context/icon-32.png .context/icon-128.png assets/nico-things-mcp-icon-512.png -thumbnail '160x160>' -tile 4x1 -geometry +24+24 -background '#E9EDF1' -font /System/Library/Fonts/Helvetica.ttc .context/icon-size-check.png
```

Open `.context/icon-size-check.png` with the image viewer. Expected: the plug and check remain distinct at all four sizes; the blue prongs do not cover the white body.

- [ ] **Step 7: Commit the raster deliverables**

```bash
git add assets/nico-things-mcp-icon-512.png assets/favicon-32x32.png assets/favicon.ico
git commit -m "feat: add project icon exports"
```

### Task 3: Add the repository identity

**Files:**
- Create: `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `assets/nico-things-mcp-icon.svg` from Task 1
- Produces: a GitHub-renderable README header and an ignored `.superpowers/` brainstorming workspace

- [ ] **Step 1: Run the repository integration contract and verify it fails**

Run:

```bash
test -f README.md || { echo "missing: README.md"; exit 1; }
rg -qx '\.superpowers/' .gitignore
```

Expected: exit 1 with `missing: README.md`.

- [ ] **Step 2: Create the minimal README header**

Create `README.md` with exactly:

```markdown
<p align="center">
  <img src="assets/nico-things-mcp-icon.svg" width="96" height="96" alt="Nico Things MCP icon">
</p>

<h1 align="center">nico-things-mcp</h1>

<p align="center">A Things 3 MCP server.</p>
```

- [ ] **Step 3: Ignore visual companion state**

Append this exact line to `.gitignore`:

```gitignore
.superpowers/
```

- [ ] **Step 4: Verify the README reference and ignore rule**

Run:

```bash
test -f assets/nico-things-mcp-icon.svg
rg -q 'src="assets/nico-things-mcp-icon.svg"' README.md
rg -q 'width="96" height="96"' README.md
rg -qx '\.superpowers/' .gitignore
git check-ignore -q .superpowers/brainstorm
```

Expected: exit 0 with no output.

- [ ] **Step 5: Commit the repository integration**

```bash
git add README.md .gitignore
git commit -m "docs: show project icon"
```

### Task 4: Run the final asset-focused verification

**Files:**
- Verify: `assets/nico-things-mcp-icon.svg`
- Verify: `assets/nico-things-mcp-icon-512.png`
- Verify: `assets/favicon.svg`
- Verify: `assets/favicon-32x32.png`
- Verify: `assets/favicon.ico`
- Verify: `README.md`
- Verify: `.gitignore`

**Interfaces:**
- Consumes: every deliverable from Tasks 1–3
- Produces: verification evidence that the complete change matches the approved design without touching runtime behavior

- [ ] **Step 1: Run the complete machine-verifiable asset contract**

Run:

```bash
set -e
xmllint --noout assets/nico-things-mcp-icon.svg assets/favicon.svg
test "$(magick identify -format '%wx%h' assets/nico-things-mcp-icon-512.png)" = "512x512"
test "$(magick identify -format '%wx%h' assets/favicon-32x32.png)" = "32x32"
test "$(magick identify -format '%wx%h\n' assets/favicon.ico | sort -u)" = "16x16
32x32
48x48"
for asset in assets/nico-things-mcp-icon-512.png assets/favicon-32x32.png; do
  test "$(magick "$asset" -alpha extract -format '%[fx:minima],%[fx:maxima]' info:)" = "0,1"
done
rg -q 'src="assets/nico-things-mcp-icon.svg"' README.md
rg -qx '\.superpowers/' .gitignore
git diff --check origin/main...HEAD
```

Expected: exit 0 with no output.

- [ ] **Step 2: Review the final diff for scope**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
```

Expected changed paths are limited to:

```text
.gitignore
README.md
assets/favicon-32x32.png
assets/favicon.ico
assets/favicon.svg
assets/nico-things-mcp-icon-512.png
assets/nico-things-mcp-icon.svg
docs/superpowers/plans/2026-07-22-project-icon.md
docs/superpowers/specs/2026-07-22-project-icon-design.md
```

- [ ] **Step 3: Confirm the worktree is clean**

Run:

```bash
git status --short
```

Expected: no output. Do not run the project build or runtime test suite because runtime code and package configuration are unchanged.
