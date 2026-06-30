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
 * and the bot name from `createBot({ name })` below.
 *
 * The agent backend is unchanged: this still POSTs each turn to `runtime.ts`
 * (AGENT_URL), exactly like the direct path.
 */
import "dotenv/config";
import { createBot } from "@copilotkit/bot";
import { intelligenceAdapter } from "@copilotkit/bot-intelligence";
import { defaultSlackContext, SanitizingHttpAgent } from "@copilotkit/bot-slack";
import { appTools } from "./tools/index.js";
import { appContext } from "./context/app-context.js";
import { appCommands } from "./commands/index.js";
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

  const bot = createBot({
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
    // The only adapter (managed adapters are exclusive). Config-free: the HTTP
    // transport to Intelligence is resolved from env + this bot's name.
    adapters: [intelligenceAdapter()],
  });

  // Intelligence only delivers turns this bot should answer (the Slack app's
  // subscribed app_mention / DM events), so every delivered turn runs the
  // agent. `onMessage` fires for each delivered turn.
  bot.onMessage(async ({ thread, message }) => {
    try {
      await thread.runAgent({
        // The managed adapter delivers a single turn and reconstructs no prior
        // history (unlike the direct Slack adapter), so feed the turn text as
        // the prompt — otherwise the agent runs with empty input.
        prompt: message.contentParts ?? message.text,
        context: senderContext(message.user, thread.platform),
      });
    } catch (err) {
      console.error("[managed] agent run failed", err);
      await thread
        .post("Sorry — I hit an error handling that. Please try again.")
        .catch(() => {});
    }
  });

  await bot.start();
  console.log(
    `[managed] bot "${botName}" listening for Intelligence-delivered events ` +
      `(intelligence=${process.env.COPILOTKIT_INTELLIGENCE_URL ?? "<unset>"})`,
  );

  const shutdown = async (signal: string) => {
    console.log(`\n[managed] received ${signal}, stopping…`);
    await bot.stop();
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
