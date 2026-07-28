/**
 * Slash commands for this bot. Each is registered with the engine via
 * `createChannel({ commands })`; the Slack adapter forwards every `/command` it
 * receives and the engine routes by name (ignoring unregistered ones).
 *
 * NOTE: a slash command only fires if it's also declared in the Slack app
 * config ("Slash Commands" / manifest) with the same name — Slack won't
 * deliver an unregistered command, even over Socket Mode.
 *
 * Args arrive as free text (`ctx.text`) on Slack; `ctx.options` is for
 * surfaces with native structured args (e.g. Discord). The `options` schema
 * is optional and used there for registration/typing.
 */
import { defineChannelCommand } from "@copilotkit/channels";
import type { ChannelCommand } from "@copilotkit/channels";
import type { Thread as BotThread } from "@copilotkit/channels-ui";
import { senderContext } from "../sender-context.js";
import { IssueCard } from "../components/index.js";
import { FileIssueModal } from "../modals/file-issue.js";

/**
 * Every awaited call in the handlers below — `runAgent`, `post`,
 * `postEphemeral`, `openModal` — is a network round-trip to the platform API
 * and can reject (backend failure, rate limit, network error). Left bare, a
 * rejection only surfaces as an `unhandledRejection` and the user sees
 * nothing, breaking these handlers' own "Degrade, never throw" contract.
 * `safely` and `safePost` are the shared guards: they log the failure and
 * turn it into the same user-facing feedback a normal "unavailable" result
 * would get, instead of throwing.
 */

/**
 * Await a platform round-trip that can reject, logging the failure and
 * resolving to `fallback` instead of letting the rejection propagate.
 * `fallback` should be whatever resolved-but-unavailable value the caller
 * already knows how to degrade for (e.g. `null`, `{ ok: false }`), so a
 * rejection is absorbed by the caller's existing resolved-outcome handling
 * rather than needing a separate branch.
 */
async function safely<T>(
  commandName: string,
  op: string,
  call: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    console.error(`[command] ${commandName} ${op} failed`, err);
    return fallback;
  }
}

/**
 * Post to the thread, logging (never throwing) if the post itself rejects.
 * These status/usage/error messages are fire-and-forget — nothing branches
 * on the resulting `MessageRef` — so on rejection there's nowhere further to
 * degrade to; this just guarantees it's logged instead of a silent
 * unhandledRejection.
 */
async function safePost(
  commandName: string,
  thread: Pick<BotThread, "post">,
  ui: Parameters<BotThread["post"]>[0],
): Promise<void> {
  await safely<void>(
    commandName,
    "post",
    async () => {
      await thread.post(ui);
    },
    undefined,
  );
}

/**
 * `thread.runAgent` can reject (backend failure, network error, etc). Unlike
 * `onMention` (which wraps its own call), the slash-command handlers below
 * called it bare, so a failure only surfaced as an unhandledRejection and the
 * user saw nothing. This wraps the call so we always log and tell the user
 * something went wrong instead of going silent.
 */
async function runAgentSafely(
  commandName: string,
  thread: Pick<BotThread, "runAgent" | "post">,
  input: Parameters<BotThread["runAgent"]>[0],
): Promise<void> {
  try {
    await thread.runAgent(input);
  } catch (err) {
    console.error(`[command] ${commandName} run failed`, err);
    await safePost(
      commandName,
      thread,
      "Sorry — I hit an error handling that. Please try again.",
    );
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
    async handler({ thread, text, user }) {
      if (!text) {
        await safePost("agent", thread, "Usage: `/agent <your question>`");
        return;
      }
      await runAgentSafely("agent", thread, {
        prompt: text,
        context: senderContext(user, thread.platform),
      });
    },
  }),

  // `/triage [note]` — summarize the current channel/thread and propose Linear
  // issues to file. Demonstrates a command with its own intent.
  defineChannelCommand({
    name: "triage",
    description:
      "Summarize the conversation and propose Linear issues to file.",
    async handler({ thread, text, user }) {
      const prompt = text
        ? `Triage this and propose Linear issues to file: ${text}`
        : "Triage the current conversation: summarize it and propose Linear issues to file.";
      await runAgentSafely("triage", thread, {
        prompt,
        context: senderContext(user, thread.platform),
      });
    },
  }),

  // `/preview <title>` — ephemeral demo. Show the invoker a private draft of the
  // issue we'd file BEFORE anything is posted publicly or written to Linear.
  // `postEphemeral` is capability-gated with an explicit DM fallback: Slack shows
  // a native only-you message; Discord and Telegram have no ephemeral surface, so
  // `fallbackToDM: true` sends it as a direct message instead. We narrate which
  // path was taken so the degradation is visible, never silent.
  defineChannelCommand({
    name: "preview",
    description: "Privately preview the issue I'd file (only you see it).",
    async handler({ thread, text, user, platform }) {
      if (!text) {
        await safePost("preview", thread, "Usage: `/preview <issue title>`");
        return;
      }
      if (!user) {
        await safePost(
          "preview",
          thread,
          "I couldn't tell who you are, so I can't send a private preview here.",
        );
        return;
      }
      const invoker = user;
      const draft = IssueCard({
        identifier: "DRAFT",
        title: text,
        state: "Triage",
        description: "_Draft — nothing is filed until you run_ `/file-issue`.",
      });
      const res = await safely(
        "preview",
        "postEphemeral",
        () => thread.postEphemeral(invoker, draft, { fallbackToDM: true }),
        null,
      );
      // Degrade, never throw: report what actually happened (this also
      // covers a rejected postEphemeral, which `safely` normalizes to the
      // same `null` this branch already handles).
      if (!res || !res.ok) {
        await safePost(
          "preview",
          thread,
          `I couldn't send a private preview on ${platform}. Run \`/file-issue\` to file it.`,
        );
        return;
      }
      if (res.usedFallback) {
        await safePost(
          "preview",
          thread,
          "📬 I sent you the draft as a direct message (this surface has no private messages).",
        );
      }
    },
  }),

  // `/file-issue` — modal demo. Open a structured issue form, or degrade
  // honestly where modals aren't available.
  //  - Slack   → rich modal (dropdowns + radio).
  //  - Discord → text-only modal (discord.js modals take only text inputs); the
  //              dropdowns/radio drop and defaults apply (see FileIssueModal).
  //  - Telegram→ no modal trigger at all (`ctx.openModal` is undefined), so we
  //              say so and continue the same job conversationally via the agent.
  defineChannelCommand({
    name: "file-issue",
    description: "Open a form to file a Linear issue.",
    async handler({ thread, openModal, platform, user }) {
      if (!openModal) {
        await safePost(
          "file-issue",
          thread,
          "Modals aren't supported here — let's do it in chat instead. " +
            "Tell me the issue title and a short description and I'll file it.",
        );
        await runAgentSafely("file-issue", thread, {
          prompt:
            "The user wants to file a Linear issue but this platform has no modal form. " +
            "Ask them for a title and description, then (after the usual confirm) file it.",
          context: senderContext(user, platform),
        });
        return;
      }
      const openModalFn = openModal;
      const res = await safely(
        "file-issue",
        "openModal",
        () => openModalFn(FileIssueModal({ rich: platform === "slack" })),
        { ok: false, error: "unexpected error" },
      );
      if (!res.ok) {
        await safePost(
          "file-issue",
          thread,
          `I couldn't open the form${res.error ? `: ${res.error}` : ""}.`,
        );
      }
    },
  }),
];
