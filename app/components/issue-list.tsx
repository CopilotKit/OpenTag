/**
 * `issue_list` — renders a set of Linear issues as a compact Block Kit card:
 * a header, ONE section with one scannable line per issue (status dot + linked
 * identifier + title + assignee · priority · updated), and a count footer.
 *
 * This is deliberately a fixed THREE-block layout (header + section + context)
 * regardless of issue count: a card-per-issue layout (~3 blocks each) blows
 * past Slack's per-attachment block limit on long lists and gets rejected with
 * `invalid_attachments`. We instead inline up to `MAX` issues into a single
 * section and surface the overflow in the footer.
 *
 * That single section is itself budget-constrained: Slack's Block Kit caps a
 * section's mrkdwn text at `SECTION_CHAR_BUDGET` (3000) chars, and if that's
 * exceeded the `@copilotkit/channels-slack` renderer SILENTLY slices the text
 * to that length and appends "…" — it does not fail loud, and the cut can
 * land mid-line, mid-word. With realistic Linear URLs a single issue line
 * runs ~190-220 chars, so as few as ~15 of them can already be at/over that
 * budget — meaning a purely count-based cap (`issues.length > MAX`) could
 * report "Showing 15 of N issues" while Slack had actually rendered fewer,
 * partially-truncated lines. `fitLinesToBudget` below accumulates each
 * line's real length and stops BEFORE crossing the budget, so the footer's
 * count always matches what was actually rendered.
 *
 * The agent fetches issues from the Linear MCP server and passes the fields
 * it wants shown; the Slack formatting lives here. For a single issue (or
 * right after creating one) prefer `issue_card`, which shows a full grid.
 *
 * Authored with the `@copilotkit/channels-ui` JSX vocabulary.
 */
import { z } from "zod";
import { Context, Header, Message, Section } from "@copilotkit/channels-ui";
import type { ChannelNode } from "@copilotkit/channels-ui";
import { accentForIssues, stateGlyph } from "./_status.js";

const issueSchema = z.object({
  identifier: z.string().describe("Linear issue identifier, e.g. 'CPK-1234'."),
  title: z.string().describe("Issue title."),
  url: z.string().optional().describe("Link to the issue in Linear."),
  state: z
    .string()
    .optional()
    .describe("Workflow state name, e.g. 'Todo', 'In Progress', 'Done'."),
  assignee: z
    .string()
    .optional()
    .describe("Assignee display name, or omit if unassigned."),
  priority: z
    .string()
    .optional()
    .describe("Priority label, e.g. 'Urgent', 'High', 'Medium', 'Low'."),
  updated: z
    .string()
    .optional()
    .describe("Human-readable last-updated, e.g. '2d ago'."),
});

export const issueListSchema = z.object({
  heading: z
    .string()
    .optional()
    .describe("Optional heading, e.g. 'Open CPK issues this cycle'."),
  issues: z.array(issueSchema).min(1).describe("The issues to render."),
});

export type IssueListProps = z.infer<typeof issueListSchema>;
type Issue = z.infer<typeof issueSchema>;

/**
 * Max issues rendered inline; the rest are summarized in the footer. This is
 * a ceiling *on top of* the character budget below: with short lines (no
 * URL/assignee/priority) far fewer than `SECTION_CHAR_BUDGET` chars are used
 * by 15 of them, so this cap alone keeps the section a sane size. With long,
 * realistic lines it's the character budget — not this count — that ends up
 * binding first.
 */
const MAX = 15;

/**
 * Slack's per-section mrkdwn text budget (`sectionText` in
 * `@copilotkit/channels-slack`'s `render/budget.js`). See the module doc
 * above for why silently exceeding it is dangerous.
 */
export const SECTION_CHAR_BUDGET = 3000;

/**
 * Headroom subtracted from `SECTION_CHAR_BUDGET` before we stop adding
 * lines: covers the gap between our raw Markdown (`[**id**](url)`) and the
 * Slack mrkdwn (`<url|*id*>`) the channel renderer converts it to (in
 * practice slightly shorter, but we don't depend on the exact delta), and
 * leaves general headroom so the cutoff is conservative rather than exact.
 */
export const SECTION_CHAR_SAFETY_MARGIN = 200;

/** Max title length before trimming (keeps each line scannable). */
const TITLE_MAX = 70;

/**
 * Render one issue as a single scannable line: status dot, linked bold
 * identifier, (trimmed) title, then an em-dash and assignee · priority ·
 * updated meta. Exported so `fitLinesToBudget`'s accounting can be
 * unit-tested against real line text.
 */
export function formatIssueLine(issue: Issue): string {
  const idLink = issue.url
    ? `[**${issue.identifier}**](${issue.url})`
    : `**${issue.identifier}**`;
  const title =
    issue.title.length > TITLE_MAX
      ? `${issue.title.slice(0, TITLE_MAX)}…`
      : issue.title;
  const meta = `${issue.assignee ?? "unassigned"}${issue.priority ? ` · ${issue.priority}` : ""}${issue.updated ? ` · ${issue.updated}` : ""}`;
  return `${stateGlyph(issue.state)} ${idLink} ${title} — ${meta}`;
}

/**
 * Pick a prefix of `lines` that fits a single Slack section: at most
 * `maxLines`, and never so much text that the joined (`"\n"`-separated)
 * result would exceed `budget` chars — stopping BEFORE we'd cross it, not
 * after, so the channel renderer's own silent truncation never has to act.
 * Always keeps at least one line, even one that alone exceeds the budget,
 * rather than rendering an empty section.
 */
export function fitLinesToBudget(
  lines: string[],
  maxLines: number = MAX,
  budget: number = SECTION_CHAR_BUDGET - SECTION_CHAR_SAFETY_MARGIN,
): string[] {
  const shown: string[] = [];
  let total = 0;
  for (const line of lines) {
    if (shown.length >= maxLines) break;
    const joinCost = shown.length > 0 ? 1 : 0; // the "\n" this line would add
    const nextTotal = total + joinCost + line.length;
    if (shown.length > 0 && nextTotal > budget) break;
    total = nextTotal;
    shown.push(line);
  }
  return shown;
}

/** Render a list of Linear issues as a compact, fixed-size Block Kit card. */
export function IssueList({ heading, issues }: IssueListProps): ChannelNode {
  const shown = fitLinesToBudget(issues.map(formatIssueLine));

  const footer =
    shown.length < issues.length
      ? `Showing ${shown.length} of ${issues.length} issues`
      : `${issues.length} issue${issues.length === 1 ? "" : "s"}`;

  return (
    <Message accent={accentForIssues(issues)}>
      <Header>{`📋  ${heading ?? "Linear issues"}`}</Header>
      <Section>{shown.join("\n")}</Section>
      <Context>{footer}</Context>
    </Message>
  );
}
