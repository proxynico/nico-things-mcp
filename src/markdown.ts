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
  checklistItems?: MdChecklistItem[] | null;
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

// Quote YAML strings to stay safe against colons, hashes, brackets, etc.
function yamlQuote(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// Escape leading list markers on note lines so they don't merge into the parent list.
// Trust inline markdown (*, _, #, backticks) — Things users write markdown on purpose.
function escapeListMarker(line: string): string {
  return line.replace(/^(\s*)([-*+]|\d+\.)(\s)/, "$1\\$2$3");
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
  return dueDate ? ` (due ${dueDate})` : "";
}

function filterByCompleted<T extends { status: string }>(items: T[], opts: MdRenderOptions): T[] {
  if (opts.includeCompleted) return items;
  return items.filter((item) => item.status === "open");
}

export function renderTodo(item: MdTodo, opts: MdRenderOptions): string {
  const lines: string[] = [];
  const head = `- ${checkboxFor(item.status)} ${item.name}${cancelSuffix(item.status)}${dueSuffix(item.dueDate)}${tagSuffix(item.tags)}`;
  lines.push(head);

  if (opts.includeNotes && item.notes && item.notes.trim().length > 0) {
    lines.push(...item.notes.split("\n").map((line) => (line.trim() ? "    " + escapeListMarker(line) : "")));
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
  if (item.dueDate) lines.push(`due: ${item.dueDate}`);
  const tags = (item.tags ?? []).filter(Boolean);
  if (tags.length) {
    lines.push(`tags: [${tags.map(yamlQuote).join(", ")}]`);
  }
  lines.push("---");
  return lines.join("\n");
}

export function renderProject(item: MdProject, opts: MdRenderOptions): string {
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

export function renderArea(areaName: string, projects: MdProject[]): string {
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
  opts: MdRenderOptions,
): string {
  const header = `# ${listDisplayName(list)}`;
  const filtered = filterByCompleted(items, opts);
  if (!filtered.length) {
    return `${header}\n\n*(empty)*\n`;
  }
  const rendered = filtered.map((item) => {
    if (item.kind === "project") {
      const count = typeof item.todoCount === "number" ? ` (${item.todoCount} todos)` : "";
      return `- ${checkboxFor(item.status)} **${item.name}**${cancelSuffix(item.status)}${count}${dueSuffix(item.dueDate)}${tagSuffix(item.tags)}`;
    }
    return renderTodo(item, opts);
  });
  return `${header}\n\n${rendered.join("\n")}\n`;
}

// Dispatch for the `id` selector — could be a project or a todo.
export function renderItem(item: MdItem, opts: MdRenderOptions): string {
  if (item.kind === "project") {
    return renderProject(item, opts);
  }
  return renderTodo(item, opts) + "\n";
}
