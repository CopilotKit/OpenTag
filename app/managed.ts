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
 * either the TS runtime.ts triage backend (a BuiltInAgent) or the Python
 * agent/ LangGraph deep-research agent (the default AGENT_URL target on Railway).
 * The channel is created WITHOUT a native adapter (no `adapters`), so it is a
 * managed, no-adapter channel: the runtime attaches the managed transport at
 * activation.
 *
 * Run: `pnpm channel` with INTELLIGENCE_* + AGENT_URL set (see .env.example).
 */
import "dotenv/config";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
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
import { IncidentCard } from "./tools/showcase-tools.js";
import { appContext } from "./context/app-context.js";
import { appCommands } from "./commands/index.js";
import { ConfirmWrite } from "./human-in-the-loop/index.js";
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

/**
 * Every app component whose buttons carry an `onClick`, registered so the
 * channel can re-render it by name to resolve a click.
 *
 * On the managed path a click arrives as a FRESH delivery, so the in-process
 * handler cache backing an unregistered component is already gone — the runtime
 * re-renders from this registry instead. Leave a component out and its clicks
 * dead-letter (or degrade to "action expired" after a restart). `ConfirmWrite`
 * is the load-bearing one: it carries the HITL approve/cancel that gates every
 * write, so an unresolvable click silently strands the tool call.
 *
 * Adding a new interactive card? Add it here — `managed.test.ts` scans the app
 * source for `onClick` and fails if anything is missing.
 */
export const MANAGED_COMPONENTS = [ConfirmWrite, IncidentCard];

export interface CreateKiteChannelOptions {
  /** AG-UI agent endpoint the channel's HttpAgent posts to. */
  agentUrl: string;
  /** Optional Authorization header value forwarded to the agent. */
  agentAuthHeader?: string;
  /** Intelligence channel name (lowercase kebab). Defaults to "kite-opentag". */
  channelName?: string;
}

/**
 * Build the prompt for the current turn. Managed history does NOT include the
 * in-flight turn, so the current message is always passed explicitly.
 *
 * A turn can carry BOTH an instruction and attachments, and the transport keeps
 * them in SEPARATE fields — channels-core's `msgFromTurn` maps `turn.userText`
 * to `text` and `turn.contentParts` to `contentParts`, so the parts are built
 * from attachments only and never fold in the instruction. Returning the parts
 * alone (`contentParts ?? text`) therefore drops "chart this" and hands the
 * model a bare CSV, which it answers with "what would you like me to do?".
 * Lead with the instruction, then the attachments.
 */
export function promptFromMessage(message: {
  contentParts?: AgentContentPart[];
  text: string;
}): string | AgentContentPart[] {
  const parts = message.contentParts;
  if (!parts?.length) return message.text;
  return message.text
    ? [{ type: "text" as const, text: message.text }, ...parts]
    : parts;
}

/** Build the Authorization header object forwarded to the agent, if any. */
export function buildAgentHeaders(
  authHeader?: string,
): { Authorization: string } | undefined {
  return authHeader ? { Authorization: authHeader } : undefined;
}

/** Constant-time compare of two strings, via fixed-length digests. */
function secretEquals(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Build the `onRequest` hook that guards the runtime's HTTP surface.
 *
 * `createCopilotNodeListener` publishes the whole v2 route set — `agent/:id/run`,
 * `threads/list`, `threads/messages`, `memories/*`, `transcribe`, … — with no
 * auth of its own, and this host registers `agents.kite` pointed straight at
 * AGENT_URL. Left open, anyone who can reach the port has an unauthenticated
 * proxy to the brain and to this bot's thread history.
 *
 * Nothing is meant to call those routes here: the managed channel activates over
 * the Intelligence gateway WS (`listener.channels.ready()`), not over HTTP, and
 * the Railway topology gives this service no public domain and no healthcheck.
 * So the surface is CLOSED by default; set CHANNEL_HTTP_TOKEN to open it behind
 * a bearer token (e.g. to point a local CopilotKit frontend at this runtime).
 */
export function httpAuthGate(
  token: string | undefined,
): (ctx: { request: Request }) => void {
  const expected = token?.trim();
  return ({ request }) => {
    // 404 rather than 403 when unconfigured: a surface nobody should be calling
    // shouldn't confirm that it exists.
    if (!expected) throw new Response("Not Found", { status: 404 });
    const provided = request.headers.get("authorization") ?? "";
    if (!secretEquals(provided, `Bearer ${expected}`)) {
      throw new Response("Unauthorized", { status: 401 });
    }
  };
}

/**
 * Structural view of `ChannelsControl.status()`. Declared locally rather than
 * imported so this module doesn't reach into the runtime's internal
 * channel-manager types; the real `Record<string, ChannelStatus>` is a union of
 * string literals and assigns cleanly to this.
 */
export interface ChannelHealth {
  overall: string;
  channels: Record<string, string>;
}

/**
 * Every declared channel that is not `online`, as `"<name>=<status>"`.
 *
 * `channels.ready()` resolving is NOT proof of liveness: it resolves once each
 * channel reaches a terminal state, and `setup_required` (declared, but no
 * managed provider bound yet) counts as terminal. `unmanaged` — a channel
 * carrying a direct adapter this handler doesn't own — resolves immediately and
 * likewise implies no health. Only `online` means the channel can actually
 * send, so the boot's success line must be gated on this returning empty.
 */
export function unhealthyChannels(health: ChannelHealth | undefined): string[] {
  if (!health) return [];
  return Object.entries(health.channels)
    .filter(([, status]) => status !== "online")
    .map(([name, status]) => `${name}=${status}`);
}

/** What a watchdog tick wants `main()` to do. */
export type WatchdogAction =
  | { kind: "quiet" }
  | { kind: "notice"; message: string }
  | { kind: "fatal"; message: string };

/**
 * Decide what to do about the channel's current health, given what was last
 * reported.
 *
 * Boot-time liveness (Task: `unhealthyChannels`) says nothing about the hours
 * that follow. A managed session that drops goes `reconnecting`; one that
 * exhausts its bounded reconnect window goes `error` and never comes back. The
 * manager does NOT re-activate — so `error` is terminal, and the only useful
 * response is to exit and let the platform's restart policy rebuild the host.
 *
 * Transitions are reported once, not once per tick, so a long reconnect doesn't
 * flood the logs.
 */
export function channelWatchdogTick(
  health: ChannelHealth | undefined,
  previousOverall: string | undefined,
): WatchdogAction {
  if (!health) return { kind: "quiet" };
  const { overall } = health;
  if (overall === "error") {
    return {
      kind: "fatal",
      message: `channel is dead: ${unhealthyChannels(health).join(", ")}`,
    };
  }
  if (overall === previousOverall) return { kind: "quiet" };
  if (overall === "online") {
    return { kind: "notice", message: "channel recovered: overall=online" };
  }
  return {
    kind: "notice",
    message: `channel degraded: ${unhealthyChannels(health).join(", ")}`,
  };
}

/**
 * Promisified `server.close()`.
 *
 * Resolves regardless of outcome: the only error `close` reports is
 * `ERR_SERVER_NOT_RUNNING` (the server never bound), which is not a shutdown
 * failure. Passing a callback also keeps that error off the server's `error`
 * event, where the bind handler would misreport it as a bind failure and exit
 * non-zero on an otherwise clean shutdown.
 */
export function closeServer(server: {
  close(cb: (err?: Error) => void): unknown;
}): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Build the KiteBot channel: same tools/context/commands/handlers as the native
 * bot, minus any platform adapter (the managed transport is attached at
 * activation when the runtime's node listener is mounted). Pure — no network,
 * no env reads — so it is unit-testable.
 */
export function createKiteChannel(opts: CreateKiteChannelOptions): Channel {
  // Normalize blank/whitespace-only names to the default. `main()` passes
  // process.env.INTELLIGENCE_CHANNEL_NAME straight through, so an env var set to
  // "" (or "   ") would otherwise reach createChannel({ name: "" }) — `??` only
  // guards nullish, not empty strings.
  const channelName = opts.channelName?.trim() || "kite-opentag";
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
    components: MANAGED_COMPONENTS,
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

/**
 * How long to wait for managed-channel activation before giving up. Applied
 * PER CHANNEL by `ready()`. Without it a gateway that accepts the socket but
 * never settles the join leaves the host bound, silent, and indistinguishable
 * from healthy — and this service has no Railway healthcheck to catch that.
 */
const CHANNEL_READY_TIMEOUT_MS = 30_000;

/** How often to re-check managed-channel health after a successful boot. */
const CHANNEL_WATCHDOG_INTERVAL_MS = 60_000;

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

  const httpToken = process.env.CHANNEL_HTTP_TOKEN?.trim();
  const listener = createCopilotNodeListener({
    runtime,
    basePath: "/api/copilotkit",
    hooks: { onRequest: httpAuthGate(httpToken) },
  });

  const server = createServer(listener);
  let watchdog: NodeJS.Timeout | undefined;
  let listening = false;
  // Fail loud on a bind failure. Without an 'error' handler an EADDRINUSE/EACCES
  // during listen() surfaces only as a logged-but-swallowed uncaughtException
  // while the process keeps running with no listener — Railway's ON_FAILURE
  // never fires. Attach BEFORE listen() so the bind error is caught here. The
  // `listening` flag keeps the message honest: after a successful bind, an
  // 'error' here is no longer a bind failure.
  server.on("error", (err) => {
    console.error(
      listening
        ? `[channel] HTTP server error on :${port}`
        : `[channel] HTTP listener failed to bind on :${port}`,
      err,
    );
    process.exit(1);
  });

  server.listen(port, async () => {
    listening = true;
    // The socket is bound, but the managed channel is not necessarily live yet.
    // `ready()` rejects if any declared channel settled to `error` (bad
    // INTELLIGENCE_API_KEY, unreachable INTELLIGENCE_GATEWAY_WS_URL) or — with
    // timeoutMs — if it never settles at all.
    try {
      await listener.channels?.ready?.({ timeoutMs: CHANNEL_READY_TIMEOUT_MS });
    } catch (err) {
      console.error("[channel] Intelligence channel activation failed", err);
      process.exit(1);
    }
    // …but resolving is not the same as live: `setup_required` and `unmanaged`
    // both settle terminally without the channel being able to send. Check the
    // status map before claiming success.
    const notLive = unhealthyChannels(listener.channels?.status());
    if (notLive.length > 0) {
      console.error(
        `[channel] activation settled but the channel is NOT live: ${notLive.join(", ")}. ` +
          `"setup_required" means the channel name exists in your Intelligence project but no ` +
          `platform connector is bound to it — finish the connector setup in the Intelligence ` +
          `dashboard, then redeploy this service.`,
      );
      process.exit(1);
    }
    console.log(
      `[channel] KiteBot channel "${channel.name}" mounted on :${port} → Intelligence gateway (channel live)`,
    );
    let previousOverall = "online";
    watchdog = setInterval(() => {
      const health = listener.channels?.status();
      const action = channelWatchdogTick(health, previousOverall);
      if (health) previousOverall = health.overall;
      if (action.kind === "fatal") {
        console.error(
          `[channel] ${action.message} — exiting so the platform restarts the host`,
        );
        process.exit(1);
      }
      if (action.kind === "notice") console.warn(`[channel] ${action.message}`);
    }, CHANNEL_WATCHDOG_INTERVAL_MS);
    // The HTTP server already holds the event loop open; don't let the timer be
    // the reason the process can't exit.
    watchdog.unref();
    // State the HTTP posture explicitly — a closed surface is the default, and a
    // deployer who opened it should see that in the logs rather than infer it.
    console.log(
      httpToken
        ? `[channel] HTTP runtime routes on :${port} require a CHANNEL_HTTP_TOKEN bearer`
        : `[channel] HTTP runtime routes on :${port} are closed (set CHANNEL_HTTP_TOKEN to open them)`,
    );
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[channel] received ${signal}, stopping…`);
    if (watchdog) clearInterval(watchdog);
    let exitCode = 0;
    // Tear down managed channel activation first (present only when the runtime
    // declared channels and activation wasn't opted out of).
    try {
      await listener.channels?.stop();
    } catch (err) {
      console.error("[channel] error stopping channel runtime", err);
      exitCode = 1;
    }
    await closeServer(server);
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

// Only build the runtime + mount the listener when this module is the process
// entry point (`pnpm channel` / `tsx app/managed.ts`), not when the test imports
// `createKiteChannel`. Compare the module URL to the entry URL rather than
// matching a filename: endsWith("managed.ts") silently fails to boot if the
// entry is ever compiled to .js/.mjs or renamed. Under a test import,
// import.meta.url is this module while process.argv[1] is the test runner, so
// they differ and main() does not run.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err: unknown) => {
    console.error("[channel] fatal: failed to start channel runtime", err);
    process.exit(1);
  });
}
