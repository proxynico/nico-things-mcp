// Ready-made routines. Claude Code lists MCP prompts as slash commands, such as /mcp__things__plan_my_day.
// Each prompt tells the assistant which reads to run, then to wait for approval before changing Things.

import type { McpServer, RegisteredPrompt } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { isoDayToUnixStart, shiftIsoDay, todayIso } from "./shared";

const ASK_FIRST = "Propose changes first, and wait for my OK before calling any tool that changes Things.";

function weekday(isoDay: string): string {
  return new Date(isoDayToUnixStart(isoDay) * 1000).toLocaleDateString("en-US", { weekday: "long" });
}

function userMessage(text: string): GetPromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

function planMyDay(today: string): string {
  return `Help me plan today, ${weekday(today)} ${today}, in Things 3.

1. Call \`read\` with list "today", and \`stats\` with no arguments for the overdue and Inbox counts.
2. Show what's on Today. Put overdue to-dos first (deadline before ${today}) and mark anything due today.
3. Suggest an order for the day, and what to move off Today if it won't all fit, with a short reason for each.

${ASK_FIRST} Then apply the moves with \`update\` or \`bulk_update\`.`;
}

function weeklyReview(today: string): string {
  const since = shiftIsoDay(today, -6);
  return `Run my weekly review in Things 3 for ${since} to ${today}.

1. Done: call \`stats\` with since "${since}" and until "${today}", and \`read\` with list "logbook" and completed_after "${since}". Summarize what I finished, grouped by project or area.
2. Loose ends: \`read\` the "inbox" and "today" lists. Call out overdue to-dos and Inbox items that need a home.
3. Stalled projects: \`read\` with list "projects" and flag open projects with no open to-dos (todoCount 0).
4. Coming up: \`read\` with list "upcoming" and list what starts or is due by ${shiftIsoDay(today, 7)}.
5. Someday: \`read\` with list "someday" and suggest up to three items to start or drop.

Finish with a short summary and a numbered list of proposed changes. ${ASK_FIRST}`;
}

function clearInbox(): string {
  return `Help me clear my Things 3 Inbox.

1. Call \`read\` with list "inbox", then with list "projects", "areas", and "tags", so suggestions use names I already have.
2. For each Inbox item, suggest where it goes (a project or area), when (today, evening, tomorrow, a date, anytime, or someday), and any tags. Suggest deleting only items that look done or obsolete. Show it as a table.
3. ${ASK_FIRST} I may edit the table. Then apply it with \`update\` or \`bulk_update\`, and \`delete\` only the items I approved.`;
}

export function registerPrompts(server: McpServer, { today = todayIso }: { today?: () => string } = {}): Record<string, RegisteredPrompt> {
  return {
    plan_my_day: server.registerPrompt(
      "plan_my_day",
      { title: "Plan my day", description: "Review Today and overdue to-dos in Things and suggest a realistic plan." },
      () => userMessage(planMyDay(today())),
    ),
    weekly_review: server.registerPrompt(
      "weekly_review",
      {
        title: "Weekly review",
        description: "Summarize the last seven days in Things, flag loose ends and stalled projects, and look at the week ahead.",
      },
      () => userMessage(weeklyReview(today())),
    ),
    clear_inbox: server.registerPrompt(
      "clear_inbox",
      { title: "Clear my inbox", description: "Suggest a home, date, and tags for each Things Inbox item, then file them once approved." },
      () => userMessage(clearInbox()),
    ),
  };
}
