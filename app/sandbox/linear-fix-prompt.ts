/**
 * Prompt for Linear ticket investigate + fix sandbox runs.
 */
import { COPILOTKIT_REPO } from "./github-codex-bootstrap.js";

export interface LinearTicketContext {
  /** Human id, e.g. ENG-123 */
  issueId: string;
  title?: string;
  description?: string;
  url?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  /** Extra research from Linear MCP / Slack / agent (comments, related PRs, etc.). */
  agentContext?: string;
  /** Optional extra user instructions for this run. */
  note?: string;
}

export function buildLinearFixPrompt(ticket: LinearTicketContext): string {
  const id = ticket.issueId.trim();
  const title = ticket.title?.trim() || "(no title)";
  const description =
    ticket.description?.trim() || "(no description provided)";
  const url = ticket.url?.trim() || "(no url)";
  const status = ticket.status?.trim() || "unknown";
  const priority = ticket.priority?.trim() || "unknown";
  const labels =
    ticket.labels && ticket.labels.length > 0
      ? ticket.labels.join(", ")
      : "(none)";
  const agentContext =
    ticket.agentContext?.trim() ||
    "(no extra agent context — use the ticket fields and the repo)";
  const note = ticket.note?.trim();

  return [
    `You are fixing a Linear ticket in a Daytona sandbox on ${COPILOTKIT_REPO}.`,
    "git and gh are authenticated. Skills are under .tanstack-skills/.",
    "",
    "## Mission",
    `Investigate and fix Linear ticket **${id}**.`,
    "Use systematic debugging to find the real root cause, then implement the correct fix.",
    "Open a GitHub PR and print only the PR URL as the last line of your final message.",
    "",
    "## Linear ticket",
    `- Id: ${id}`,
    `- Title: ${title}`,
    `- URL: ${url}`,
    `- Status: ${status}`,
    `- Priority: ${priority}`,
    `- Labels: ${labels}`,
    "",
    "### Description",
    description,
    "",
    "### Extra context (from Linear MCP / Slack / research)",
    agentContext,
    note ? `\n### Current request note\n${note}\n` : "",
    "## Method (required)",
    "1. Read the debugging-discipline skill:",
    "   `.tanstack-skills/internal-skills/skills/debugging-discipline/SKILL.md`",
    "   (path may vary slightly under .tanstack-skills/ — find debugging-discipline).",
    "2. Form a hypothesis, gather evidence in the repo, verify, fix the root cause.",
    "3. Prefer the simplest correct fix (ponytail skill under `.tanstack-skills/ponytail`).",
    "4. If product behavior changes, use the docs skill under AlemTuzlak/skills and update docs.",
    "5. Run the smallest useful check (targeted test/typecheck) when practical.",
    "6. Do not paper over the bug with an early return that only hides one case.",
    "",
    "## Git / PR (required)",
    `- Branch name: fix/${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-<short-slug>`,
    `- Commit with a clear message that mentions ${id}.`,
    "- Push: `git push -u origin HEAD`",
    "- Create PR:",
    `  gh pr create --repo ${COPILOTKIT_REPO} --base main \\`,
    `    --title "[${id}] <short imperative summary>" \\`,
    '    --body "$(cat <<\'EOF\'',
    `## Linear`,
    `${id}`,
    url !== "(no url)" ? url : "",
    "",
    "## Root cause",
    "<what was wrong and why — evidence from the investigation>",
    "",
    "## How it was fixed",
    "<what you changed and why this is the correct fix>",
    "",
    "## Test plan",
    "- [ ] <how you verified>",
    "EOF",
    ')"',
    "",
    `- PR title MUST start with or include [${id}].`,
    "- PR body MUST include **Root cause** and **How it was fixed**.",
    `- Final line of your message: only the PR URL on ${COPILOTKIT_REPO},`,
    `  e.g. https://github.com/${COPILOTKIT_REPO}/pull/1234`,
    "- NEVER paste an existing/old PR URL from docs or git log.",
    "- If you cannot fix or push, end with FAILED: <reason> (no fake PR URL).",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
