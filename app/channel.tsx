import {
  createChannel,
  type Channel,
  type ChannelTool,
  type CreateChannelOptions,
} from "@copilotkit/channels";
import { managedRunInput, reportRecoverableError } from "./channel-helpers.js";
import { appCommands } from "./commands/index.js";
import { IssueCard, IssueList, PageList } from "./components/index.js";
import { appContext } from "./context/app-context.js";
import { ConfirmWrite } from "./human-in-the-loop/index.js";
import { parseConfirmWriteInterrupt } from "./interrupt.js";
import { FILE_ISSUE_CALLBACK, fileIssueSubmit } from "./modals/file-issue.js";
import { IncidentCard } from "./tools/showcase-tools.js";
import { RenderChart } from "./tools/render-chart.js";
import { appTools } from "./tools/index.js";
import {
  subscribeThreadTool,
  unsubscribeThreadTool,
} from "./tools/thread-subscription.js";

type ChannelAgent = NonNullable<CreateChannelOptions["agent"]>;

/** Build the managed OpenTag Channel; Intelligence owns its platform adapters. */
export function createOpenTagChannel(
  name: string,
  agent: ChannelAgent,
): Channel {
  const channel = createChannel({
    name,
    agent,
    identifyUser: "platform",
    tools: appTools,
    context: [...appContext],
    commands: appCommands,
    components: [
      IssueCard,
      IssueList,
      PageList,
      IncidentCard,
      ConfirmWrite,
      RenderChart,
    ],
  });

  type MessageHandlerInput = Parameters<
    Parameters<typeof channel.onMessage>[0]
  >[0];

  const runAgentSafely = async (
    { thread, message }: MessageHandlerInput,
    conditionalTools: ChannelTool[],
  ) => {
    try {
      await thread.runAgent(managedRunInput(message, conditionalTools));
    } catch (error) {
      try {
        await thread.post(
          "Sorry — I hit an error handling that. Please try again.",
        );
      } catch (postError) {
        throw new AggregateError(
          [error, postError],
          "The agent run and its user-facing error reply both failed",
        );
      }

      // A failed turn is isolated from future turns. Once the user receives an
      // explicit failure response, the Channel can safely remain available.
      reportRecoverableError(error, {
        operation: "run_agent",
        recovery: "posted_user_facing_error",
      });
    }
  };

  channel.onMention(async ({ thread, message }) => {
    if (message.actor.kind === "bot" || message.actor.kind === "app") return;

    if (await thread.isSubscribed()) {
      await runAgentSafely({ thread, message }, [unsubscribeThreadTool]);
      return;
    }

    let isNewConversation = true;
    try {
      const history = await thread.getMessages();
      isNewConversation = !history || history.length <= 1;
    } catch (error) {
      reportRecoverableError(error, {
        operation: "get_thread_history",
        recovery: "treat_as_new_conversation",
      });
    }

    if (isNewConversation) {
      await thread.subscribe();
      await runAgentSafely({ thread, message }, [unsubscribeThreadTool]);
      return;
    }

    await runAgentSafely({ thread, message }, [subscribeThreadTool]);
  });

  channel.onMessage(async ({ thread, message }) => {
    if (message.actor.kind === "bot" || message.actor.kind === "app") return;

    if (await thread.isSubscribed()) {
      await runAgentSafely({ thread, message }, [unsubscribeThreadTool]);
    }
  });

  channel.onModalSubmit(FILE_ISSUE_CALLBACK, fileIssueSubmit);

  channel.onInterrupt("on_interrupt", async ({ payload, thread }) => {
    const { args } = parseConfirmWriteInterrupt(payload);
    await thread.post(
      <ConfirmWrite
        action={args.action}
        fields={args.fields}
        detail={args.detail ?? undefined}
        attempt={args.attempt}
        previousError={args.previous_error ?? undefined}
      />,
    );
  });

  channel.onThreadStarted(async ({ thread, user }) => {
    if (!user?.name) return;

    try {
      await thread.setSuggestedPrompts([
        {
          title: "Synthesize this discussion",
          message:
            "Summarize this thread into key findings, decisions, open questions, and next steps",
        },
        {
          title: "Help me make a decision",
          message:
            "Compare the options in this thread and recommend a path forward",
        },
      ]);
    } catch (error) {
      // Suggested prompts are an optional affordance; their absence does not
      // affect message delivery, agent execution, or later thread turns.
      reportRecoverableError(error, {
        operation: "set_suggested_prompts",
        recovery: "continue_without_suggested_prompts",
      });
    }
  });

  return channel;
}
