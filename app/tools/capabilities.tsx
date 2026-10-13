import { z } from "zod";
import {
  Actions,
  Button,
  Context,
  Divider,
  Field,
  Fields,
  Header,
  Message,
  Section,
  defineChannelTool,
  type InteractionContext,
} from "@copilotkit/channels";
import { Slack } from "@copilotkit/channels/slack";
import { DEFAULT_AGENT_DISPLAY_NAME } from "../env.js";

interface CapabilitiesCardProps {
  agentDisplayName?: string;
  showExamples?: boolean;
  platform?: InteractionContext["platform"];
}

export function CapabilitiesCard({
  agentDisplayName = DEFAULT_AGENT_DISPLAY_NAME,
  showExamples = false,
  platform,
}: CapabilitiesCardProps = {}) {
  return (
    <Message accent="#010507">
      <Header>{`✨ Meet ${agentDisplayName}`}</Header>
      <Section>
        A general-purpose knowledge-work agent that turns scattered team context
        into clear answers, useful artifacts, and connected action.
      </Section>
      <Fields>
        <Field>
          **🧠 Synthesize context**{`\n`}Threads, notes, files, research, and
          connected sources
        </Field>
        <Field>
          **⚖️ Support decisions**{`\n`}Options, trade-offs, recommendations,
          risks, and next steps
        </Field>
        <Field>
          **🗺️ Plan and create**{`\n`}Briefs, plans, checklists, drafts, and
          reusable knowledge
        </Field>
        <Field>
          **📊 Visualize ideas and data**{`\n`}Native charts, polished diagrams,
          status views, and purpose-built cards
        </Field>
        <Field>
          **⚡ Take connected action**{`\n`}Use available tools and pause for
          approval before data-changing work
        </Field>
      </Fields>
      {!showExamples ? (
        <Actions>
          <Button
            value={{ action: "show_examples" }}
            style="primary"
            onClick={async ({
              thread,
              message,
              platform,
            }: InteractionContext) => {
              await thread.update(
                message.ref,
                <CapabilitiesCard
                  agentDisplayName={agentDisplayName}
                  showExamples
                  platform={platform}
                />,
              );
            }}
          >
            Show me examples
          </Button>
        </Actions>
      ) : null}
      {showExamples ? <Divider /> : null}
      {showExamples ? (
        <Header>{`🪄 ${agentDisplayName} in action`}</Header>
      ) : null}
      {showExamples ? (
        <Section>
          **⚖️ Decision brief**{`\n`}**Recommendation:** A staged launch
          balances learning speed with operational risk. Start with the support
          team before expanding company-wide.{`\n`}
          **Why:** It validates the workflow with a high-context group while
          keeping rollback simple.
        </Section>
      ) : null}
      {showExamples ? (
        <Section>
          **📈 Knowledge synthesis**{`\n`}Onboarding completion rose 18% after
          setup guidance moved into the product. The largest remaining drop-off
          is connecting the first data source.
        </Section>
      ) : null}
      {showExamples ? (
        <Section>
          **🗺️ Execution plan**{`\n`}1. Pilot with the support team{`\n`}2.
          Review adoption and failure signals after one week{`\n`}3. Resolve the
          top two blockers, then expand the rollout
        </Section>
      ) : null}
      {showExamples && platform === "slack" ? (
        <Slack.Block.DataVisualization
          title="Example · Onboarding completion"
          chart={{
            type: "bar",
            series: [
              {
                name: "Completion",
                data: [
                  { label: "Before", value: 62 },
                  { label: "After", value: 80 },
                ],
              },
            ],
            axis_config: {
              categories: ["Before", "After"],
              x_label: "Guided setup",
              y_label: "Completion %",
            },
          }}
        />
      ) : null}
      {showExamples && platform === "slack" ? (
        <Slack.Block.DataVisualization
          title="Example · Knowledge-work mix"
          chart={{
            type: "pie",
            segments: [
              { label: "Synthesis", value: 35 },
              { label: "Planning", value: 30 },
              { label: "Research", value: 20 },
              { label: "Follow-up", value: 15 },
            ],
          }}
        />
      ) : null}
      {showExamples && platform !== "slack" ? (
        <Section>
          **🎨 Visual analysis**{`\n`}Onboarding completion: 62% before guided
          setup → 80% after. Example work mix: 35% synthesis, 30% planning, 20%
          research, and 15% follow-up.
        </Section>
      ) : null}
      {showExamples ? (
        <Context>
          {`These are representative outputs—${agentDisplayName} adapts the artifact and level of detail to the work at hand.`}
        </Context>
      ) : null}
    </Message>
  );
}

export function createShowCapabilitiesTool(
  agentDisplayName = DEFAULT_AGENT_DISPLAY_NAME,
) {
  return defineChannelTool({
    name: "show_capabilities",
    description:
      `Show ${agentDisplayName}'s interactive identity and capability showcase. Always use ` +
      "for identity, capability, or demo-introduction questions such as " +
      "'who are you?', 'what can you do?', 'how can you help?', or 'introduce yourself'.",
    parameters: z.object({}),
    async handler(_props, { thread }) {
      await thread.post(
        <CapabilitiesCard agentDisplayName={agentDisplayName} />,
      );
      return "The capabilities showcase is the complete user-facing answer. Do not post a separate confirmation or restatement.";
    },
  });
}

export const showCapabilitiesTool = createShowCapabilitiesTool();
