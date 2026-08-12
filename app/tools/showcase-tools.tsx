/**
 * Showcase render-tools — JSX `ChannelTool`s that demonstrate the
 * `@copilotkit/channels` vocabulary end-to-end:
 *
 *  - `show_incident` — an interactive card whose `Acknowledge`/`Escalate`
 *    buttons carry inline `onClick` handlers. These are FIRE-AND-FORGET
 *    interactions (not `awaitChoice`): the bot dispatches the handler on click
 *    with no waiter, so a render-tool can bind live actions directly.
 *  - `show_status` — a `Fields` grid with an accent and bold field labels.
 *  - `show_links` — a `Section` of markdown links (`[label](url)` →
 *    `<url|label>` via the mrkdwn bridge).
 *  - `show_work_plan` — a purpose-built plan/checklist card with explicit
 *    status, ownership, and progress context.
 *  - `show_decision_brief` — options, recommendation, rationale, risks, and
 *    the next decision step.
 *  - `show_knowledge_summary` — synthesized findings, decisions, actions, and
 *    open questions from research or discussion.
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
} from "@copilotkit/channels";
import type { InteractionContext } from "@copilotkit/channels";
import { defineChannelTool } from "@copilotkit/channels";

// ── show_incident ──────────────────────────────────────────────────────────

const incidentSchema = z.object({
  id: z.string().describe("Incident identifier, e.g. 'INC-4821'."),
  title: z.string().describe("Short incident title."),
  severity: z
    .enum(["SEV1", "SEV2", "SEV3"])
    .describe("Severity — drives the card's accent colour."),
  summary: z.string().describe("One-paragraph summary of what's happening."),
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
      <Section>{summary}</Section>
      <Context>{`Incident ${id}`}</Context>
      <Actions>
        <Button
          value={{ action: "ack", id }}
          style="primary"
          onClick={async ({ thread, user, message }: InteractionContext) => {
            await thread.update(
              message.ref,
              <Message accent="#27AE60">
                <Header>{`✅ Acknowledged · ${title}`}</Header>
                <Context>{`Ack'd by ${user?.name ?? user?.id ?? "someone"}`}</Context>
              </Message>,
            );
          }}
        >
          Acknowledge
        </Button>
        <Button
          value={{ action: "escalate", id }}
          style="danger"
          onClick={async ({ thread }: InteractionContext) => {
            await thread.post(
              `🚨 Escalating *${title}* — paging the next on-call.`,
            );
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

// ── show_status ────────────────────────────────────────────────────────────

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
    .describe("Label/value pairs laid out as a two-column grid."),
});

type StatusProps = z.infer<typeof statusSchema>;

function StatusCard({ heading, fields }: StatusProps) {
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
    "of small key/value metrics.",
  parameters: statusSchema,
  async handler(props, { thread }) {
    await thread.post(<StatusCard {...props} />);
    return "Posted the status card to the user.";
  },
});

// ── show_links ─────────────────────────────────────────────────────────────

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
    .describe("Links rendered as a single dot-separated row."),
});

type LinksProps = z.infer<typeof linksSchema>;

function LinksCard({ heading, links }: LinksProps) {
  // `[label](url)` is rewritten to Slack's `<url|label>` link form by
  // `markdownToMrkdwn`; authoring the raw `<url|label>` here would have its
  // inner text mangled, so we author markdown links instead.
  return (
    <Message>
      <Header>{`🔗 ${heading}`}</Header>
      <Section>
        {links.map((l) => `[${l.label}](${l.url})`).join("  ·  ")}
      </Section>
    </Message>
  );
}

export const showLinksTool = defineChannelTool({
  name: "show_links",
  description:
    "Render a card of links: a heading plus a dot-separated row of clickable " +
    "links. Use to surface runbooks, dashboards, or related pages.",
  parameters: linksSchema,
  async handler(props, { thread }) {
    await thread.post(<LinksCard {...props} />);
    return "Posted the links to the user.";
  },
});

// ── show_work_plan ────────────────────────────────────────────────────────

const workPlanSchema = z.object({
  heading: z.string().describe("Short plan, review, or checklist heading."),
  summary: z
    .string()
    .optional()
    .describe("Optional one-sentence purpose or recommendation."),
  items: z
    .array(
      z.object({
        title: z.string().describe("Concise work item or checkpoint."),
        status: z
          .enum(["not_started", "in_progress", "blocked", "done"])
          .describe("Current status of the item."),
        owner: z.string().optional().describe("Owner name, if known."),
        detail: z
          .string()
          .optional()
          .describe("Optional supporting detail, evidence, or next step."),
      }),
    )
    .min(1)
    .max(12)
    .describe("Ordered plan items; preserve every item the user supplied."),
});

type WorkPlanProps = z.infer<typeof workPlanSchema>;

const workPlanStatus = {
  not_started: { icon: "○", label: "Not started" },
  in_progress: { icon: "◐", label: "In progress" },
  blocked: { icon: "⊘", label: "Blocked" },
  done: { icon: "●", label: "Done" },
} as const;

export function WorkPlanCard({ heading, summary, items }: WorkPlanProps) {
  const completed = items.filter(({ status }) => status === "done").length;

  return (
    <Message accent="#5E6AD2">
      <Header>{`🗺️ ${heading}`}</Header>
      {summary ? <Section>{summary}</Section> : null}
      {items.map((item) => {
        const status = workPlanStatus[item.status];
        const metadata = [status.label, item.owner && `Owner: ${item.owner}`]
          .filter(Boolean)
          .join(" · ");
        return (
          <Section>
            {`${status.icon} **${item.title}**\n${metadata}${item.detail ? `\n${item.detail}` : ""}`}
          </Section>
        );
      })}
      <Context>{`${completed} of ${items.length} complete`}</Context>
    </Message>
  );
}

export const showWorkPlanTool = defineChannelTool({
  name: "show_work_plan",
  description:
    "Render a purpose-built work plan, review, rollout, or checklist card " +
    "with status, optional owner and detail, and completion progress. Use " +
    "this instead of render_table when the content represents work to track.",
  parameters: workPlanSchema,
  async handler(props, { thread }) {
    await thread.post(<WorkPlanCard {...props} />);
    return "The work plan is the complete user-facing answer. Do not post a separate confirmation or restatement.";
  },
});

// ── show_decision_brief ───────────────────────────────────────────────────

const decisionBriefSchema = z.object({
  heading: z.string().describe("Concise name for the decision."),
  question: z.string().describe("The decision to make."),
  recommendation: z.string().describe("Recommended option or path forward."),
  options: z
    .array(
      z.object({
        name: z.string().describe("Option name."),
        assessment: z
          .string()
          .describe("Concise assessment, including the key trade-off."),
      }),
    )
    .min(2)
    .max(6),
  rationale: z.array(z.string()).min(1).max(6),
  risks: z.array(z.string()).max(6).optional(),
  nextStep: z
    .string()
    .describe("The immediate action that advances the decision."),
});

type DecisionBriefProps = z.infer<typeof decisionBriefSchema>;

export function DecisionBriefCard({
  heading,
  question,
  recommendation,
  options,
  rationale,
  risks,
  nextStep,
}: DecisionBriefProps) {
  return (
    <Message accent="#5E6AD2">
      <Header>{`⚖️ ${heading}`}</Header>
      <Section>{`**Decision**\n${question}`}</Section>
      <Section>{`**Recommendation**\n${recommendation}`}</Section>
      <Section>
        {`**Options considered**\n${options
          .map(({ name, assessment }) => `• **${name}** — ${assessment}`)
          .join("\n")}`}
      </Section>
      <Section>
        {`**Why**\n${rationale.map((reason) => `• ${reason}`).join("\n")}`}
      </Section>
      {risks?.length ? (
        <Section>
          {`**Risks to watch**\n${risks.map((risk) => `• ${risk}`).join("\n")}`}
        </Section>
      ) : null}
      <Section>{`**Next step**\n${nextStep}`}</Section>
    </Message>
  );
}

export const showDecisionBriefTool = defineChannelTool({
  name: "show_decision_brief",
  description:
    "Render a decision brief with the decision question, recommendation, " +
    "evaluated options, rationale, risks, and immediate next step. Use for " +
    "comparisons and decision support instead of a generic table.",
  parameters: decisionBriefSchema,
  async handler(props, { thread }) {
    await thread.post(<DecisionBriefCard {...props} />);
    return "The decision brief is the complete user-facing answer. Do not post a separate confirmation or restatement.";
  },
});

// ── show_knowledge_summary ────────────────────────────────────────────────

const knowledgeSummarySchema = z.object({
  heading: z.string().describe("Concise title for the synthesis."),
  summary: z.string().describe("One- or two-sentence executive synthesis."),
  findings: z.array(z.string()).min(1).max(8),
  decisions: z.array(z.string()).max(8).optional(),
  actions: z
    .array(
      z.object({
        task: z.string().describe("Concrete follow-up action."),
        owner: z.string().optional().describe("Owner, only when known."),
      }),
    )
    .max(8)
    .optional(),
  openQuestions: z.array(z.string()).max(8).optional(),
});

type KnowledgeSummaryProps = z.infer<typeof knowledgeSummarySchema>;

function bulletList(items: string[]): string {
  return items.map((item) => `• ${item}`).join("\n");
}

export function KnowledgeSummaryCard({
  heading,
  summary,
  findings,
  decisions,
  actions,
  openQuestions,
}: KnowledgeSummaryProps) {
  return (
    <Message accent="#27AE60">
      <Header>{`🧠 ${heading}`}</Header>
      <Section>{summary}</Section>
      <Section>{`**Key findings**\n${bulletList(findings)}`}</Section>
      {decisions?.length ? (
        <Section>{`**Decisions**\n${bulletList(decisions)}`}</Section>
      ) : null}
      {actions?.length ? (
        <Section>
          {`**Action items**\n${bulletList(
            actions.map(({ task, owner }) =>
              owner ? `${task} — **${owner}**` : task,
            ),
          )}`}
        </Section>
      ) : null}
      {openQuestions?.length ? (
        <Section>{`**Open questions**\n${bulletList(openQuestions)}`}</Section>
      ) : null}
    </Message>
  );
}

export const showKnowledgeSummaryTool = defineChannelTool({
  name: "show_knowledge_summary",
  description:
    "Render a synthesized knowledge artifact with an executive summary, key " +
    "findings, and optional decisions, action items, and open questions. Use " +
    "for research summaries, meeting notes, discussion synthesis, and briefs.",
  parameters: knowledgeSummarySchema,
  async handler(props, { thread }) {
    await thread.post(<KnowledgeSummaryCard {...props} />);
    return "The knowledge summary is the complete user-facing answer. Do not post a separate confirmation or restatement.";
  },
});
