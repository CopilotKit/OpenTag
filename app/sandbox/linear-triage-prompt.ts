/**
 * Prompt for Linear investigate + triage (no code fix, no PR).
 */
import { COPILOTKIT_REPO } from "./github-codex-bootstrap.js";
import type { LinearTicketContext } from "./linear-fix-prompt.js";

export type { LinearTicketContext };

/**
 * Build the investigation-only Codex prompt.
 * Output must be a structured report (no PR, no code commits).
 */
export function buildLinearTriagePrompt(ticket: LinearTicketContext): string {
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
    `You are triaging a Linear ticket in a Daytona sandbox on ${COPILOTKIT_REPO}.`,
    "git is available for read-only inspection. Skills are under .tanstack-skills/.",
    "",
    "## Mission",
    `Investigate Linear ticket **${id}** and produce a root-cause triage report.`,
    "**Do NOT** implement a fix. **Do NOT** commit. **Do NOT** open a PR.",
    "You may read code, search, and run small read-only checks.",
    "Your output is a structured investigation report for Linear.",
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
    "   (find debugging-discipline under .tanstack-skills/ if the path differs).",
    "2. Form hypotheses, gather evidence in the repo, verify the root cause.",
    "3. Prefer clarity over speculation. Mark low-confidence claims as such.",
    "4. Use ponytail thinking for triage: name the smallest true root cause.",
    "5. If docs/product behavior is relevant, note docs impact (do not edit files).",
    "",
    "## Output format (required)",
    "Write the full report in markdown with EXACTLY these headings:",
    "",
    "## Summary",
    "(2–4 sentences)",
    "",
    "## Root cause",
    "(what is wrong and why — with file/path evidence when possible)",
    "",
    "## Evidence",
    "(bullet list of findings: files, behaviors, logs, repro steps)",
    "",
    "## Triage",
    "- Severity: critical | high | medium | low",
    "- Confidence: high | medium | low",
    "- Suggested status: <e.g. Todo / In Progress / Blocked / Canceled>",
    "- Suggested labels: <comma-separated or none>",
    "- Component / area: <package or product area>",
    "",
    "## Recommended fix",
    "(what should change — guidance only, no implementation)",
    "",
    "## Next steps",
    "(concrete follow-ups for a human or a fix agent)",
    "",
    "End with a final line that is exactly:",
    "REPORT_OK",
    "",
    "If you cannot determine a root cause, still fill the sections with best effort,",
    "state uncertainty under Root cause, and end with REPORT_OK.",
    "Only end with FAILED: <reason> if the environment blocks investigation entirely.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/**
 * Extract investigation report from agent text.
 * Prefers assistant narrative; requires REPORT_OK marker when possible.
 */
export function extractInvestigationReport(input: {
  assistantText: string;
  fullText: string;
}): { ok: true; report: string } | { ok: false; reason: string } {
  const source =
    input.assistantText.trim() || input.fullText.trim() || "";
  if (!source) {
    return { ok: false, reason: "No agent text" };
  }

  if (/^FAILED:/im.test(source) && !/REPORT_OK/i.test(source)) {
    const line =
      source
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("FAILED:")) || "FAILED: unknown";
    return { ok: false, reason: line };
  }

  // Prefer content ending with REPORT_OK
  const okIdx = source.lastIndexOf("REPORT_OK");
  let body = okIdx >= 0 ? source.slice(0, okIdx).trim() : source;

  // If there is a clear Summary heading, start from there
  const summaryIdx = body.search(/^##\s*Summary\b/im);
  if (summaryIdx >= 0) {
    body = body.slice(summaryIdx).trim();
  }

  if (!/^##\s*Root cause\b/im.test(body) && !/root cause/i.test(body)) {
    return {
      ok: false,
      reason: "Investigation report missing Root cause section",
    };
  }

  return { ok: true, report: body };
}

/** Format report for a Linear comment. */
export function formatLinearInvestigationComment(input: {
  issueId: string;
  report: string;
  runId: string;
}): string {
  return [
    `## OpenTag investigation — ${input.issueId}`,
    "",
    "_Automated triage from the OpenTag Linear investigate sandbox (Codex). No code was changed._",
    "",
    input.report.trim(),
    "",
    "---",
    `runId: \`${input.runId}\``,
  ].join("\n");
}
