// Pure-TS markdown renderer for Things items.
// No runtime dependency — unit-testable standalone.

export type MdChecklistItem = { name: string; done: boolean };

export type MdTodo = {
  kind?: "todo";
  id: string;
  name: string;
  status: string;
  notes?: string;
  tags?: string[];
  dueDate?: string | null;
  checklistItems?: MdChecklistItem[];
};

export type MdProject = {
  kind: "project";
  id: string;
  name: string;
  status: string;
  notes?: string;
  tags?: string[];
  dueDate?: string | null;
  area?: string | null;
  todoCount?: number;
  todos?: MdTodo[];
};

export type MdItem = MdTodo | MdProject;

export type MdRenderOptions = {
  includeNotes: boolean;
  includeCompleted: boolean;
};

const DEFAULT_OPTS: MdRenderOptions = { includeNotes: true, includeCompleted: false };

function isProject(item: MdItem): item is MdProject {
  return (item as MdProject).kind === "project";
}

function isoDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

// Quote YAML strings to stay safe against colons, hashes, brackets, etc.
function yamlQuote(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// Escape leading list markers on note lines so they don't merge into the parent list.
// Trust inline markdown (*, _, #, backticks) — Things users write markdown on purpose.
function escapeListMarker(line: string): string {
  return line.replace(/^(\s*)([-*+]|\d+\.)(\s)/, "$1\\$2$3");
}

function indentNote(notes: string | undefined, indent: string): string[] {
  if (!notes) return [];
  return notes.split("\n").map((line) => {
    if (line.trim().length === 0) return "";
    return indent + escapeListMarker(line);
  });
}

function checkboxFor(status: string): string {
  return status === "open" ? "[ ]" : "[x]";
}

function cancelSuffix(status: string): string {
  return status === "canceled" ? " (canceled)" : "";
}

function tagSuffix(tags: string[] | undefined): string {
  const cleaned = (tags ?? []).filter(Boolean);
  if (!cleaned.length) return "";
  return " " + cleaned.map((t) => `#${t.replace(/\s+/g, "-")}`).join(" ");
}

function dueSuffix(dueDate: string | null | undefined): string {
  const d = isoDateOnly(dueDate);
  return d ? ` (due ${d})` : "";
}

function filterByCompleted<T extends { status: string }>(items: T[], opts: MdRenderOptions): T[] {
  if (opts.includeCompleted) return items;
  return items.filter((item) => item.status === "open");
}

export function renderTodo(item: MdTodo, opts: MdRenderOptions = DEFAULT_OPTS): string {
  const lines: string[] = [];
  const head = `- ${checkboxFor(item.status)} ${item.name}${cancelSuffix(item.status)}${dueSuffix(item.dueDate)}${tagSuffix(item.tags)}`;
  lines.push(head);

  if (opts.includeNotes && item.notes && item.notes.trim().length > 0) {
    lines.push(...indentNote(item.notes, "    "));
  }

  for (const checklist of item.checklistItems ?? []) {
    const subCheckbox = checklist.done ? "[x]" : "[ ]";
    lines.push(`    - ${subCheckbox} ${checklist.name}`);
  }

  return lines.join("\n");
}

export function renderFrontmatter(item: MdProject): string {
  const lines: string[] = ["---", `project: ${yamlQuote(item.name)}`];
  if (item.area) lines.push(`area: ${yamlQuote(item.area)}`);
  const due = isoDateOnly(item.dueDate);
  if (due) lines.push(`due: ${due}`);
  const tags = (item.tags ?? []).filter(Boolean);
  if (tags.length) {
    lines.push(`tags: [${tags.map(yamlQuote).join(", ")}]`);
  }
  lines.push("---");
  return lines.join("\n");
}

export function renderProject(item: MdProject, opts: MdRenderOptions = DEFAULT_OPTS): string {
  const parts: string[] = [renderFrontmatter(item), `## ${item.name}`];

  if (opts.includeNotes && item.notes && item.notes.trim().length > 0) {
    parts.push(item.notes);
  }

  const todos = filterByCompleted(item.todos ?? [], opts);
  if (todos.length) {
    parts.push(todos.map((t) => renderTodo(t, opts)).join("\n"));
  } else {
    parts.push("*(empty)*");
  }

  return parts.join("\n\n") + "\n";
}

function renderProjectShallow(project: MdProject): string {
  const parts: string[] = [renderFrontmatter(project), `## ${project.name}`];
  if (typeof project.todoCount === "number") {
    const suffix = project.todoCount === 1 ? "" : "s";
    parts.push(`*${project.todoCount} open todo${suffix}*`);
  }
  return parts.join("\n\n");
}

export function renderArea(
  areaName: string,
  projects: MdProject[],
  _opts: MdRenderOptions = DEFAULT_OPTS,
): string {
  if (!projects.length) {
    return `# ${areaName}\n\n*(no projects)*\n`;
  }
  const header = `# ${areaName}`;
  const blocks = projects.map(renderProjectShallow);
  return header + "\n\n" + blocks.join("\n\n---\n\n") + "\n";
}

function listDisplayName(list: string): string {
  return list.charAt(0).toUpperCase() + list.slice(1);
}

export function renderList(
  list: string,
  items: MdItem[],
  opts: MdRenderOptions = DEFAULT_OPTS,
): string {
  const header = `# ${listDisplayName(list)}`;
  const filtered = filterByCompleted(items, opts);
  if (!filtered.length) {
    return `${header}\n\n*(empty)*\n`;
  }
  const rendered = filtered.map((item) => {
    if (isProject(item)) {
      const count = typeof item.todoCount === "number" ? ` (${item.todoCount} todos)` : "";
      return `- ${checkboxFor(item.status)} **${item.name}**${cancelSuffix(item.status)}${count}${dueSuffix(item.dueDate)}${tagSuffix(item.tags)}`;
    }
    return renderTodo(item, opts);
  });
  return `${header}\n\n${rendered.join("\n")}\n`;
}

// Dispatch for the `id` selector — could be a project or a todo.
export function renderItem(item: MdItem, opts: MdRenderOptions = DEFAULT_OPTS): string {
  if (isProject(item)) {
    return renderProject(item, opts);
  }
  return renderTodo(item, opts) + "\n";
}
