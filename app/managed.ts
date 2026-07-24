/**
 * Intelligence channel host for KiteBot — the "managed" run mode.
 *
 * Unlike app/index.ts (self-hosted: holds Slack tokens, talks to Slack
 * directly), this process holds NO platform credentials. It runs the SAME bot
 * over CopilotKit Intelligence: it declares one channel ("kite-opentag") to the
 * Intelligence runtime and mounts an HTTP listener. Mounting the listener
 * activates the channel — the runtime derives the org/project/channel binding
 * from the Intelligence credentials + the channel name and streams render
 * frames over the managed gateway. Intelligence owns the Slack edge (signed
 * ingress + Connector Outbox egress).
 *
 * The bot's brain is an external AG-UI agent reached over HTTP at AGENT_URL —
 * for now the runtime.ts triage backend; in Phase 2 a LangGraph deep agent.
 * The channel is created WITHOUT a native adapter (no `adapters`), so it is a
 * managed, no-adapter channel: the runtime attaches the managed transport at
 * activation.
 *
 * Run: `pnpm channel` with INTELLIGENCE_* + AGENT_URL set (see .env.example).
 */
import "dotenv/config";
import { createServer } from "node:http";
import { createChannel } from "@copilotkit/channels";
import type { Channel } from "@copilotkit/channels";
import type { AgentContentPart } from "@copilotkit/channels-ui";
import {
  SanitizingHttpAgent,
  defaultSlackTools,
  defaultSlackContext,
} from "@copilotkit/channels-slack";
import { CopilotRuntime, CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";
import { appTools } from "./tools/index.js";
import { appContext } from "./context/app-context.js";
import { appCommands } from "./commands/index.js";
import { senderContext } from "./sender-context.js";
import { fileIssueSubmit, FILE_ISSUE_CALLBACK } from "./modals/file-issue.js";
import { closeBrowser } from "./render/browser.js";

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
};

export interface CreateKiteChannelOptions {
  /** AG-UI agent endpoint the channel's HttpAgent posts to. */
  agentUrl: string;
  /** Optional Authorization header value forwarded to the agent. */
  agentAuthHeader?: string;
  /** Intelligence channel name (lowercase kebab). Defaults to "kite-opentag". */
  channelName?: string;
}

/**
 * Pick the prompt to send to the agent for the current turn. Managed history
 * does NOT include the in-flight turn, so the current message is always
 * passed explicitly — preferring multimodal parts when present.
 */
export function promptFromMessage(message: {
  contentParts?: AgentContentPart[];
  text: string;
}): string | AgentContentPart[] {
  return message.contentParts?.length ? message.contentParts : message.text;
}

/** Build the Authorization header object forwarded to the agent, if any. */
export function buildAgentHeaders(
  authHeader?: string,
): { Authorization: string } | undefined {
  return authHeader ? { Authorization: authHeader } : undefined;
}

/**
 * Build the KiteBot channel: same tools/context/commands/handlers as the native
 * bot, minus any platform adapter (the managed transport is attached at
 * activation when the runtime's node listener is mounted). Pure — no network,
 * no env reads — so it is unit-testable.
 */
export function createKiteChannel(opts: CreateKiteChannelOptions): Channel {
  const channelName = opts.channelName ?? "kite-opentag";
  const agentHeaders = buildAgentHeaders(opts.agentAuthHeader);

  const channel = createChannel({
    name: channelName,
    agent: (threadId: string) => {
      const a = new SanitizingHttpAgent({
        url: opts.agentUrl,
        headers: agentHeaders,
      });
      a.threadId = threadId;
      return a;
    },
    tools: [...appTools, ...defaultSlackTools],
    context: [...appContext, ...defaultSlackContext],
    commands: appCommands,
  });

  // Managed history does NOT include the in-flight turn, so pass the current
  // message explicitly as `prompt` (prefer multimodal parts). Mirrors the
  // native bot's onMention otherwise.
  channel.onMention(async ({ thread, message }) => {
    try {
      await thread.runAgent({
        prompt: promptFromMessage(message),
        context: senderContext(message.user, thread.platform),
      });
    } catch (err) {
      console.error("[channel] agent run failed", err);
      await thread
        .post("Sorry — I hit an error handling that. Please try again.")
        .catch((postErr: unknown) =>
          console.error("[channel] failed to post agent error", postErr),
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
    } catch (err) {
      console.error("[channel] onThreadStarted failed", err);
    }
  });

  return channel;
}

async function main() {
  const agentUrl = required("AGENT_URL");
  const agentAuthHeader = process.env.AGENT_AUTH_HEADER;

  const channel = createKiteChannel({
    agentUrl,
    agentAuthHeader,
    channelName: process.env.INTELLIGENCE_CHANNEL_NAME,
  });

  const intelligence = new CopilotKitIntelligence({
    apiUrl: required("INTELLIGENCE_API_URL"),
    wsUrl: required("INTELLIGENCE_GATEWAY_WS_URL"),
    apiKey: required("INTELLIGENCE_API_KEY"),
  });

  const runtime = new CopilotRuntime({
    // `agents` is a required NON-EMPTY record (NonEmptyRecord) on the v2
    // runtime. This host's real work flows through `channel` (whose own
    // `agent` factory posts to AGENT_URL per turn), so there is no separate
    // top-level agent to register — but the type demands at least one entry.
    // Register the SAME AG-UI backend under a stable name so the runtime's
    // agent registry resolves to the identical brain the channel drives,
    // rather than a semantically-empty placeholder.
    agents: {
      kite: new SanitizingHttpAgent({
        url: agentUrl,
        headers: buildAgentHeaders(agentAuthHeader),
      }),
    },
    intelligence,
    // Per-turn platform user identity for channel messages is resolved by the
    // gateway/Slack adapter and passed to the agent via `senderContext`; this
    // callback only identifies the host for the runtime's own HTTP endpoints,
    // so a stable stub is sufficient here.
    identifyUser: () => ({ id: "opentag-kite", name: "OpenTag KiteBot" }),
    channels: [channel],
  });

  const rawPort = process.env["PORT"];
  const port = rawPort && rawPort.trim() !== "" ? Number(rawPort) : 8300;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(
      `Invalid PORT: "${rawPort}" is not a valid port number (must be an integer between 1 and 65535)`,
    );
    process.exit(1);
  }

  const listener = createCopilotNodeListener({
    runtime,
    basePath: "/api/copilotkit",
  });
  const server = createServer(listener).listen(port, () => {
    console.log(
      `[channel] KiteBot channel "${channel.name}" mounted on :${port} → Intelligence gateway`,
    );
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[channel] received ${signal}, stopping…`);
    let exitCode = 0;
    // Tear down managed channel activation first (present only when the runtime
    // declared channels and activation wasn't opted out of).
    try {
      await listener.channels?.stop();
    } catch (err) {
      console.error("[channel] error stopping channel runtime", err);
      exitCode = 1;
    }
    server.close();
    // Tear down the shared headless browser used for chart/diagram rendering.
    await closeBrowser().catch((err: unknown) =>
      console.error(
        "[channel] browser cleanup failed (continuing shutdown)",
        err,
      ),
    );
    process.exit(exitCode);
  };
  const runShutdown = (signal: string): void => {
    shutdown(signal).catch((err: unknown) => {
      console.error(`[channel] fatal during ${signal} shutdown`, err);
      process.exit(1);
    });
  };
  process.on("SIGINT", () => runShutdown("SIGINT"));
  process.on("SIGTERM", () => runShutdown("SIGTERM"));
}

// Fail loud, not silent: surface any stray async error (e.g. a throw deep in an
// interaction/callback path) instead of letting it kill the process with no
// log. Log and keep running — one bad turn shouldn't take the host down.
process.on("unhandledRejection", (reason) => {
  console.error("[channel] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[channel] uncaughtException:", err);
});

// Only build the runtime + mount the listener when executed directly
// (`pnpm channel`), not when the test imports `createKiteChannel`.
if (process.argv[1] && process.argv[1].endsWith("managed.ts")) {
  main().catch((err: unknown) => {
    console.error("[channel] fatal: failed to start channel runtime", err);
    process.exit(1);
  });
}
