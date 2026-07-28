/**
 * Slash commands for this bot. Each is registered with the engine via
 * `createChannel({ commands })`; the Slack adapter forwards every `/command` it
 * receives and the engine routes by name (ignoring unregistered ones).
 *
 * NOTE: a slash command only fires if it's also declared in the Slack app
 * config ("Slash Commands" / manifest) with the same name — Slack won't
 * deliver an unregistered command, even over Socket Mode.
 *
 * Args arrive as free text (`ctx.text`) on Slack; `ctx.options` is available
 * to surfaces that deliver native structured arguments.
 */
import {
  defineChannelCommand,
  type ChannelCommand,
  type Thread as ChannelThread,
} from "@copilotkit/channels";
import {
  platformRunInput,
  reportRecoverableError,
} from "../channel-helpers.js";
import { IssueCard } from "../components/index.js";
import { FileIssueModal } from "../modals/file-issue.js";

/**
 * `thread.runAgent` can reject (backend failure, network error, etc). Unlike
 * `onMention` (which wraps its own call), the slash-command handlers below
 * called it bare, so a failure only surfaced as an unhandledRejection and the
 * user saw nothing. This wraps the call so we always log and tell the user
 * something went wrong instead of going silent.
 */
async function runAgentSafely(
  commandName: string,
  thread: Pick<ChannelThread, "runAgent" | "post">,
  input: Parameters<ChannelThread["runAgent"]>[0],
): Promise<void> {
  try {
    await thread.runAgent(input);
  } catch (error) {
    try {
      await thread.post(
        "Sorry — I hit an error handling that. Please try again.",
      );
    } catch (postError) {
      throw new AggregateError(
        [error, postError],
        `The /${commandName} agent run and its error reply both failed`,
      );
    }

    reportRecoverableError(error, {
      operation: `command_${commandName}_run_agent`,
      recovery: "posted_user_facing_error",
    });
  }
}

export const appCommands: ChannelCommand[] = [
  // `/agent <text>` — a mention-free entry point. (Previously hardcoded in the
  // adapter; now an ordinary, app-owned command.) Runs the agent with the
  // command text as the user prompt, since slash-command args are never
  // posted to the channel for the agent to read from history.
  defineChannelCommand({
    name: "agent",
    description: "Ask the triage agent anything (no @mention needed).",
    async handler({ thread, text, user, platform }) {
      if (!text) {
        await thread.post("Usage: `/agent <your question>`");
        return;
      }
      await runAgentSafely("agent", thread, {
        prompt: text,
        ...platformRunInput(platform, user),
      });
    },
  }),

  // `/triage [note]` — summarize the current channel/thread and propose Linear
  // issues to file. Demonstrates a command with its own intent.
  defineChannelCommand({
    name: "triage",
    description:
      "Summarize the conversation and propose Linear issues to file.",
    async handler({ thread, text, user, platform }) {
      const prompt = text
        ? `Triage this and propose Linear issues to file: ${text}`
        : "Triage the current conversation: summarize it and propose Linear issues to file.";
      await runAgentSafely("triage", thread, {
        prompt,
        ...platformRunInput(platform, user),
      });
    },
  }),

  // `/preview <title>` — ephemeral demo. Show the invoker a private draft of the
  // issue we'd file BEFORE anything is posted publicly or written to Linear.
  // `postEphemeral` is capability-gated with an explicit DM fallback. Slack
  // shows a native only-you message; other surfaces report their actual support.
  defineChannelCommand({
    name: "preview",
    description: "Privately preview the issue I'd file (only you see it).",
    async handler({ thread, text, user, platform }) {
      if (!text) {
        await thread.post("Usage: `/preview <issue title>`");
        return;
      }
      if (!user) {
        await thread.post(
          "I couldn't tell who you are, so I can't send a private preview here.",
        );
        return;
      }
      const draft = IssueCard({
        identifier: "DRAFT",
        title: text,
        state: "Triage",
        description: "_Draft — nothing is filed until you run_ `/file-issue`.",
      });
      const res = await thread.postEphemeral(user, draft, {
        fallbackToDM: true,
      });
      // Degrade, never throw: report what actually happened.
      if (!res || !res.ok) {
        await thread.post(
          `I couldn't send a private preview on ${platform}. Run \`/file-issue\` to file it.`,
        );
        return;
      }
      if (res.usedFallback) {
        await thread.post(
          "📬 I sent you the draft as a direct message (this surface has no private messages).",
        );
      }
    },
  }),

  // `/file-issue` — modal demo. Open a structured issue form, or degrade
  // honestly where modals aren't available.
  // Slack opens the rich modal. Teams currently has no modal trigger, so we say
  // so and continue the same job conversationally via the agent.
  defineChannelCommand({
    name: "file-issue",
    description: "Open a form to file a Linear issue.",
    async handler({ thread, openModal, platform, user }) {
      if (!openModal) {
        await thread.post(
          "Modals aren't supported here — let's do it in chat instead. " +
            "Tell me the issue title and a short description and I'll file it.",
        );
        await runAgentSafely("file-issue", thread, {
          prompt:
            "The user wants to file a Linear issue but this platform has no modal form. " +
            "Ask them for a title and description, then (after the usual confirm) file it.",
          ...platformRunInput(platform, user),
        });
        return;
      }
      const res = await openModal(
        FileIssueModal({
          rich: platform === "slack",
          sourcePlatform: platform,
        }),
      );
      if (!res.ok) {
        await thread.post(
          `I couldn't open the form${res.error ? `: ${res.error}` : ""}.`,
        );
      }
    },
  }),
];
