/**
 * Managed (Intelligence-hosted) entrypoint — the same OpenTag bot, but its
 * ingress/egress are managed by CopilotKit Intelligence instead of a direct
 * platform connection.
 *
 * Where `app/index.ts` connects straight to Slack/Discord/… via Socket Mode and
 * owns the platform credentials, this entry attaches a single
 * `intelligenceAdapter()`: Intelligence receives the Slack event, persists it,
 * and delivers it to this long-running process over HTTP; this process runs the
 * *same* handlers/tools/agent and emits a reply, and Intelligence does the
 * credentialed Slack send. No Slack tokens live here.
 *
 * `intelligenceAdapter()` is config-free — it builds its HTTP transport to
 * Intelligence from the environment:
 *   COPILOTKIT_INTELLIGENCE_URL   e.g. http://localhost:7050
 *   COPILOTKIT_API_KEY            project runtime API key (cpk-…), minted in the
 *                                 Intelligence UI (project → API keys)
 * and the bot name from `createChannel({ name })` below.
 *
 * The agent backend is unchanged: this still POSTs each turn to `runtime.ts`
 * (AGENT_URL), exactly like the direct path.
 */
import "dotenv/config";
import { createChannel } from "@copilotkit/channels";
import { intelligenceAdapter } from "@copilotkit/channels-intelligence";
import { defaultSlackContext, SanitizingHttpAgent } from "@copilotkit/channels-slack";
import { appTools } from "./tools/index.js";
import { appContext } from "./context/app-context.js";
import { appCommands } from "./commands/index.js";
import { JokeCard, pickJoke } from "./components/index.js";
import { ConfirmWrite } from "./human-in-the-loop/index.js";
import { senderContext } from "./sender-context.js";
import { closeBrowser } from "./render/browser.js";

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
};

async function main() {
  const agentUrl = required("AGENT_URL");
  const agentHeaders = process.env.AGENT_AUTH_HEADER
    ? { Authorization: process.env.AGENT_AUTH_HEADER }
    : undefined;

  // Project-unique bot name. Must satisfy BOTH the SDK (`^[A-Za-z][A-Za-z0-9_]*$`)
  // and Intelligence (`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`) — the intersection is
  // lowercase letters/digits — and must match the bot created in the
  // Intelligence UI.
  const botName = process.env.MANAGED_BOT_NAME ?? "opentagbot";

  const channel = createChannel({
    name: botName,
    // Same BuiltInAgent backend as the direct path (runtime.ts on AGENT_URL).
    agent: (threadId) => {
      const a = new SanitizingHttpAgent({ url: agentUrl, headers: agentHeaders });
      a.threadId = threadId;
      return a;
    },
    tools: [...appTools],
    // App identity/policy + Slack output-formatting guidance (replies are
    // rendered for Slack by Intelligence). No Slack *tools* here: user lookup
    // needs a live Slack connection, which the managed path doesn't own.
    context: [...appContext, ...defaultSlackContext],
    commands: appCommands,
    // Register components rendered via `thread.post(<Component/>)` so their
    // interactive handlers survive the managed delivery boundary: the durable
    // snapshot re-renders the named component from this registry to resolve the
    // clicked action (the in-process hot cache is lost across deliveries).
    // ConfirmWrite carries the HITL approve/cancel `onClick`, so it MUST be here
    // or a Teams Action.Submit click can't resolve and the interaction
    // dead-letters (JokeCard is here for the same reason, for reactions).
    components: [JokeCard, ConfirmWrite],
    // The only adapter (managed adapters are exclusive). Config-free and
    // provider-agnostic: one runtime instance serves this bot across every
    // channel it has attached (Slack, Teams, ...). Intelligence decides the
    // outbound provider per delivery from the delivery's reply_context.
    adapters: [intelligenceAdapter()],
  });

  // Intelligence only delivers turns this bot should answer (the Slack app's
  // subscribed app_mention / DM events), so every delivered turn runs the
  // agent. `onMessage` fires for each delivered turn.
  channel.onMessage(async ({ thread, message }) => {
    try {
      await thread.runAgent({
        // The managed adapter delivers a single turn and reconstructs no prior
        // history (unlike the direct Slack adapter), so feed the turn text as
        // the prompt — otherwise the agent runs with empty input.
        //
        // A turn can carry BOTH the instruction (`message.text`, e.g. "draw me a
        // bar chart") AND file content parts (`message.contentParts`, e.g. an
        // uploaded CSV/image). The adapter builds contentParts from FILES ONLY —
        // it does not fold in the instruction — so `contentParts ?? text` would
        // drop the instruction and hand the model a bare data dump, which it
        // answers with "what would you like me to do?". Merge them: instruction
        // first, then the file parts.
        prompt: message.contentParts?.length
          ? [
              ...(message.text
                ? [{ type: "text" as const, text: message.text }]
                : []),
              ...message.contentParts,
            ]
          : message.text,
        context: senderContext(message.user, thread.platform),
      });
    } catch (err) {
      console.error("[managed] agent run failed", err);
      await thread
        .post("Sorry — I hit an error handling that. Please try again.")
        .catch(() => {});
    }
  });

  // 🔄 reaction demo — react with the counterclockwise-arrows emoji on ANY
  // message and the bot replies with a random joke. Registered as a GLOBAL
  // reaction handler (not `<Message onReaction>`): on the managed path the
  // per-message handler is keyed by the SDK's post-time ref, but the reaction
  // arrives keyed by the real Slack ts (which app-api doesn't map back yet), so
  // only a global handler resolves. Fires on ADD only, ignores other emoji.
  channel.onReaction(async ({ added, emoji, thread }) => {
    // `emoji` is the canonical cross-platform name (channels 0.2.1+): 🔄
    // normalizes to "refresh" whether it arrived as Slack
    // `arrows_counterclockwise`, Teams `1f504_refresh`, or the unicode form on
    // Discord/Telegram/WhatsApp — so the demo needs no per-platform matching.
    if (!added || emoji !== "refresh") {
      return;
    }
    try {
      await thread.post(`🎲 ${pickJoke()}`);
    } catch (err) {
      console.error("[managed] reaction joke failed", err);
    }
  });

  await channel.start();
  console.log(
    `[managed] bot "${botName}" listening for Intelligence-delivered events ` +
      `(intelligence=${process.env.COPILOTKIT_INTELLIGENCE_URL ?? "<unset>"})`,
  );

  // The Intelligence HTTP delivery source paces its poll loop with unref()'d
  // timers (0.2.0: so it composes under a hosted supervisor), so once it goes
  // idle between polls nothing else refs the event loop and Node would exit.
  // Hold the process open until a shutdown signal.
  // ponytail: a ref'd no-op interval is the minimal keep-alive; a supervising
  // ChannelManager (startChannels) would own this in a hosted deployment.
  const keepAlive = setInterval(() => {}, 1 << 30);

  const shutdown = async (signal: string) => {
    console.log(`\n[managed] received ${signal}, stopping…`);
    clearInterval(keepAlive);
    await channel.stop();
    await closeBrowser();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

process.on("unhandledRejection", (reason) => {
  console.error("[managed] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[managed] uncaughtException:", err);
});

main().catch((err) => {
  console.error("[managed] fatal", err);
  process.exit(1);
});
