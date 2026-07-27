import type { AbstractAgent } from "@ag-ui/client";
import {
  createChannel,
  type Channel,
  type ChannelTool,
  type ContextEntry,
  type PlatformAdapter,
} from "@copilotkit/channels";
import { mentionRunInput } from "./agent.js";
import { appCommands } from "./commands/index.js";
import { IssueCard, IssueList, PageList } from "./components/index.js";
import { appContext } from "./context/app-context.js";
import { ConfirmWrite } from "./human-in-the-loop/index.js";
import { FILE_ISSUE_CALLBACK, fileIssueSubmit } from "./modals/file-issue.js";
import { appTools } from "./tools/index.js";

export interface CreateOpenTagChannelOptions {
  name: string;
  adapters: PlatformAdapter[];
  agent: AbstractAgent | ((threadId: string) => AbstractAgent);
  platformTools: ReadonlyArray<ChannelTool>;
  platformContext: ReadonlyArray<ContextEntry>;
}

/**
 * Build the single Channel shared by managed Intelligence delivery and
 * developer-owned direct adapters.
 */
export function createOpenTagChannel(
  options: CreateOpenTagChannelOptions,
): Channel {
  const channel = createChannel({
    name: options.name,
    provider: "slack",
    adapters: options.adapters,
    agent: options.agent,
    tools: [...appTools, ...options.platformTools],
    context: [...appContext, ...options.platformContext],
    commands: appCommands,
    components: [IssueCard, IssueList, PageList, ConfirmWrite],
  });

  channel.onMention(async ({ thread, message }) => {
    try {
      await thread.runAgent(mentionRunInput(message, thread.platform));
    } catch (error) {
      console.error("[channel] agent run failed", error);
      await thread
        .post("Sorry — I hit an error handling that. Please try again.")
        .catch((postError: unknown) =>
          console.error("[channel] failed to post agent error", postError),
        );
    }
  });

  channel.onModalSubmit(FILE_ISSUE_CALLBACK, fileIssueSubmit);

  channel.onThreadStarted(async ({ thread, user }) => {
    if (!user?.name) return;

    try {
      await thread.setSuggestedPrompts([
        {
          title: `Triage ${user.name}'s issues`,
          message: "Triage my open issues",
        },
        {
          title: "What shipped this week?",
          message: "Summarize what shipped this week",
        },
      ]);
    } catch (error) {
      console.error("[channel] onThreadStarted failed", error);
    }
  });

  return channel;
}
