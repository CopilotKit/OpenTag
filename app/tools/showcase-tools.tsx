/**
 * Showcase render-tools — three small JSX `ChannelTool`s that demonstrate the
 * `@copilotkit/channels-ui` vocabulary end-to-end:
 *
 *  - `show_incident` — an interactive card whose `Acknowledge`/`Escalate`
 *    buttons carry inline `onClick` handlers. These are FIRE-AND-FORGET
 *    interactions (not `awaitChoice`): the bot dispatches the handler on click
 *    with no waiter, so a render-tool can bind live actions directly.
 *  - `show_status` — a `Fields` grid with an accent and bold field labels.
 *    Clamped to Slack's 10-fields-per-section limit; the returned status
 *    notes it when fields are dropped.
 *  - `show_links` — a `Section` of markdown links (`[label](url)` →
 *    `<url|label>` via the mrkdwn bridge). Clamped to stay within Slack's
 *    section-text budget; the returned status notes it when links are
 *    dropped.
 */
import { z } from "zod";
import {
  Message,
  Header,
  Section,
  Context,
  Fields,
  Field,
  Actions,
  Button,
} from "@copilotkit/channels-ui";
import type { InteractionContext } from "@copilotkit/channels-ui";
import { defineChannelTool } from "@copilotkit/channels";

// ── show_incident ──────────────────────────────────────────────────────────

const incidentSchema = z.object({
  id: z.string().describe("Incident identifier, e.g. 'INC-4821'."),
  title: z.string().describe("Short incident title."),
  severity: z
    .enum(["SEV1", "SEV2", "SEV3"])
    .describe("Severity — drives the card's accent colour."),
  summary: z
    .string()
    .min(1)
    .describe("One-paragraph summary of what's happening."),
});

type IncidentProps = z.infer<typeof incidentSchema>;

export function IncidentCard({ id, title, severity, summary }: IncidentProps) {
  const accent =
    severity === "SEV1"
      ? "#EB5757"
      : severity === "SEV2"
        ? "#F2994A"
        : "#5E6AD2";
  return (
    <Message accent={accent}>
      <Header>{`🚨 ${severity} · ${title}`}</Header>
      {summary ? <Section>{summary}</Section> : null}
      <Context>{`Incident ${id}`}</Context>
      <Actions>
        <Button
          value={{ action: "ack", id }}
          style="primary"
          onClick={async ({ thread, user, message }: InteractionContext) => {
            try {
              await thread.update(
                message.ref,
                <Message accent="#27AE60">
                  <Header>{`✅ Acknowledged · ${title}`}</Header>
                  <Context>{`Ack'd by ${user?.name ?? user?.id ?? "someone"}`}</Context>
                </Message>,
              );
            } catch (err) {
              console.error("[showcase] onClick failed", err);
            }
          }}
        >
          Acknowledge
        </Button>
        <Button
          value={{ action: "escalate", id }}
          style="danger"
          onClick={async ({ thread }: InteractionContext) => {
            try {
              await thread.post(
                `🚨 Escalating *${title}* — paging the next on-call.`,
              );
            } catch (err) {
              console.error("[showcase] onClick failed", err);
            }
          }}
        >
          Escalate
        </Button>
      </Actions>
    </Message>
  );
}

export const showIncidentTool = defineChannelTool({
  name: "show_incident",
  description:
    "Render an interactive incident card with Acknowledge/Escalate buttons. " +
    "Pass id, title, severity (SEV1/SEV2/SEV3) and a one-paragraph summary. " +
    "The accent colour reflects severity; clicking Acknowledge updates the " +
    "card in place, clicking Escalate posts a paging notice.",
  parameters: incidentSchema,
  async handler(props, { thread }) {
    await thread.post(<IncidentCard {...props} />);
    return "Posted the incident card to the user.";
  },
});

// ── shared clamp helper ────────────────────────────────────────────────────

/**
 * Clamp `items` to fit within `budget`, where `size` reports the incremental
 * cost of adding the next item given what's already been kept. Keeps items
 * in their original order and stops as soon as the next one would overflow
 * the budget — so excess content is dropped explicitly here (and reported
 * back to the caller) instead of being silently truncated downstream by the
 * platform renderer.
 */
function clampWithinBudget<T>(
  items: T[],
  budget: number,
  size: (item: T, keptSoFar: T[]) => number,
): { kept: T[]; droppedCount: number } {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = size(item, kept);
    // Always keep at least one item — an empty result would render an empty
    // <Section>, which Slack rejects. If the first item alone exceeds the
    // budget, keep it and let the renderer's own truncation trim it.
    if (kept.length > 0 && used + cost > budget) break;
    kept.push(item);
    used += cost;
  }
  return { kept, droppedCount: items.length - kept.length };
}

// ── show_status ────────────────────────────────────────────────────────────

// A Slack section renders at most 10 fields (SLACK_LIMITS.fieldsPerSection);
// excess fields are silently dropped by the renderer if not clamped first.
const MAX_STATUS_FIELDS = 10;

const statusSchema = z.object({
  heading: z.string().describe("Card heading, e.g. 'Service health'."),
  fields: z
    .array(
      z.object({
        label: z.string().describe("Field label (rendered bold)."),
        value: z.string().describe("Field value."),
      }),
    )
    .min(1)
    .describe(
      "Label/value pairs laid out as a two-column grid. At most " +
        `${MAX_STATUS_FIELDS} are shown; extras are dropped.`,
    ),
});

type StatusProps = z.infer<typeof statusSchema>;

export function StatusCard({ heading, fields }: StatusProps) {
  return (
    <Message accent="#5E6AD2">
      <Header>{`📊 ${heading}`}</Header>
      <Fields>
        {fields.map((f) => (
          <Field>{`**${f.label}**\n${f.value}`}</Field>
        ))}
      </Fields>
    </Message>
  );
}

export const showStatusTool = defineChannelTool({
  name: "show_status",
  description:
    "Render a status card: a heading plus a grid of label/value fields " +
    "(labels shown bold). Use for service health, deploy status, or any set " +
    `of small key/value metrics. Max ${MAX_STATUS_FIELDS} fields.`,
  parameters: statusSchema,
  async handler({ heading, fields }, { thread }) {
    const { kept, droppedCount } = clampWithinBudget(
      fields,
      MAX_STATUS_FIELDS,
      () => 1,
    );
    await thread.post(<StatusCard heading={heading} fields={kept} />);
    return droppedCount > 0
      ? `Posted the status card to the user. Showing ${kept.length} of ${fields.length} fields.`
      : "Posted the status card to the user.";
  },
});

// ── show_links ─────────────────────────────────────────────────────────────

// Joiner between rendered `[label](url)` links in the single-row layout.
const LINK_JOINER = "  ·  ";

// A Slack section's text is truncated at ~3000 chars (SLACK_LIMITS.sectionText);
// clamp the joined links list to a budget with headroom below that limit so
// whole links are dropped (and reported back) instead of being cut off mid-link
// by the renderer's own truncation. The 200-char margin matches the sibling
// clamps (issue-list, render-table) and absorbs mrkdwn escape-expansion
// (e.g. `&`->`&amp;`), which can make the rendered text longer than the raw
// `[label](url)` length this budget measures.
const MAX_LINKS_SECTION_CHARS = 2800;

const linksSchema = z.object({
  heading: z.string().describe("Card heading, e.g. 'Runbooks'."),
  links: z
    .array(
      z.object({
        label: z.string().describe("Link text."),
        url: z.string().describe("Destination URL."),
      }),
    )
    .min(1)
    .describe(
      "Links rendered as a single dot-separated row. Enough are kept to " +
        "stay within Slack's section-text budget; extras are dropped.",
    ),
});

type LinksProps = z.infer<typeof linksSchema>;
type Link = LinksProps["links"][number];

/** Render a single link as the markdown `[label](url)` the mrkdwn bridge rewrites. */
function linkMarkdown(l: Link): string {
  return `[${l.label}](${l.url})`;
}

export function LinksCard({ heading, links }: LinksProps) {
  // `[label](url)` is rewritten to Slack's `<url|label>` link form by
  // `markdownToMrkdwn`; authoring the raw `<url|label>` here would have its
  // inner text mangled, so we author markdown links instead.
  return (
    <Message>
      <Header>{`🔗 ${heading}`}</Header>
      <Section>{links.map(linkMarkdown).join(LINK_JOINER)}</Section>
    </Message>
  );
}

export const showLinksTool = defineChannelTool({
  name: "show_links",
  description:
    "Render a card of links: a heading plus a dot-separated row of clickable " +
    "links. Use to surface runbooks, dashboards, or related pages. Enough " +
    "are kept to stay within Slack's section-text budget; extras are dropped.",
  parameters: linksSchema,
  async handler({ heading, links }, { thread }) {
    const { kept, droppedCount } = clampWithinBudget(
      links,
      MAX_LINKS_SECTION_CHARS,
      (link, keptSoFar) =>
        (keptSoFar.length > 0 ? LINK_JOINER.length : 0) +
        linkMarkdown(link).length,
    );
    await thread.post(<LinksCard heading={heading} links={kept} />);
    return droppedCount > 0
      ? `Posted the links to the user. Showing ${kept.length} of ${links.length} links.`
      : "Posted the links to the user.";
  },
});
