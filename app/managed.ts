/**
 * Intelligence channel host for KiteBot — the "managed" run mode.
 *
 * Unlike app/index.ts (self-hosted: holds Slack tokens, talks to Slack
 * directly), this process holds NO platform credentials. It runs the SAME bot
 * over CopilotKit Intelligence: it declares one channel ("kite-opentag") to the
 * Intelligence runtime and mounts an HTTP listener. Mounting the listener only
 * CONSTRUCTS the channel-manager control surface — per the installed
 * `createCopilotNodeListener` (`@copilotkit/runtime/v2` `fetch-handler.d.mts`),
 * it "does NOT open any connection: activation is lazy and triggered by the
 * first `handler.channels.ready()`" (confirmed in `channel-manager.mjs`,
 * where `ready()` calls `this.activate()`). Activation is what derives the
 * org/project/channel binding from the Intelligence credentials + the channel
 * name and starts streaming render frames over the managed gateway; `main()`
 * below triggers it explicitly by awaiting `channels.ready(...)` after
 * `server.listen()`. Intelligence owns the Slack edge (signed ingress +
 * Connector Outbox egress).
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
import { createHash, timingSafeEqual } from "node:crypto";
import { writeSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { format } from "node:util";
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

/**
 * Validate a required env var's already-read value: trimmed and non-blank.
 *
 * `!v` alone rejects `""` and `undefined` but lets `"   "` through — trivially
 * produced by pasting into the Railway UI — so `AGENT_URL="   "` used to boot
 * green, the channel would activate, the host would log "(channel live)", and
 * every single turn would then fail inside `onMention` with "Sorry — I hit an
 * error handling that." `channelName` and `CHANNEL_HTTP_TOKEN` elsewhere in
 * this file are already `.trim()`-normalized; this was the missed one.
 *
 * Pure: takes the value instead of reading `process.env` itself, and throws
 * instead of exiting, so it stays unit-testable and `main()` (via `required`
 * below) remains the only place that owns `process.exit`.
 */
export function requireNonBlank(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return trimmed;
}

/**
 * Validate that a required URL-shaped env var actually parses as an
 * `http:`/`https:` URL with a non-empty host.
 *
 * AGENT_URL is otherwise never validated as a URL, so `AGENT_URL=not-a-url`
 * boots exactly as green as a correct value — the failure only surfaces later,
 * deep inside `SanitizingHttpAgent`, on the first turn. Fail fast at boot
 * instead and name the bad value, so a deployer doesn't have to reproduce a
 * live turn to find out why it was rejected.
 *
 * Bare `new URL()` is not enough: it accepts anything with a colon, so a
 * missing scheme — the single most likely paste error, and the literal shape
 * of a Railway private hostname (`agent:8123`) — parses "successfully" with
 * the hostname folded into the protocol (`new URL("localhost:8123").protocol
 * === "localhost:"`) and boots green, then fails every turn. Same story for a
 * non-HTTP scheme like `ftp://x`. Both are the exact failure this validator
 * exists to catch at boot, not deep inside the first live turn.
 *
 * Pure: throws rather than exiting, for the same reason as `requireNonBlank`.
 */
export function requireUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL: "${value}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `${name} must be an http:// or https:// URL — got "${value}" (did you forget the scheme? a bare "host:port" parses as a URL with the host folded into the protocol)`,
    );
  }
  if (!url.hostname) {
    throw new Error(`${name} is not a valid URL: "${value}"`);
  }
  return value;
}

/**
 * Build the diagnostic line `fatal()` writes — pure, so it's testable without
 * touching `process`. Mirrors `console.error`'s own formatting: `util.format`
 * is what `console.error` uses internally, so a message-plus-error pair reads
 * the same here as everywhere else in this file's logs.
 */
export function fatalText(message: string, err?: unknown): string {
  return err === undefined ? format(message) : format(message, err);
}

/**
 * Log a fatal diagnostic and exit. The one place every fail-fast path in this
 * file should route through, instead of its own `console.error(...)`
 * immediately followed by `process.exit()`.
 *
 * `console.error` writes through `process.stderr`, which Node buffers
 * ASYNCHRONOUSLY when it's a pipe on POSIX — exactly what Railway hands the
 * container. `process.exit()` does not wait for pending writes, so the
 * message explaining why the host died can be silently truncated in exactly
 * the deployment this file targets, undercutting the whole fail-loud design
 * this file otherwise commits to. `fs.writeSync` to fd 2 issues a raw,
 * synchronous `write(2)` syscall that blocks until it completes, sidestepping
 * the stream's buffering entirely — regardless of whether the fd is a pipe,
 * file, or TTY.
 *
 * Setting `process.exitCode` and letting the event loop drain naturally is
 * NOT an alternative: several call sites below must exit while a bound HTTP
 * server is still holding the loop open, so the loop would never drain on its
 * own.
 *
 * `main()`-layer machinery, not one of the pure helpers above — it performs
 * I/O and calls `process.exit`, so `unhealthyChannels`/`channelWatchdogTick`/
 * `closeServer`/`onceShutdown` stay clear of it. Not itself unit-tested: a
 * test can't call it without actually exiting the test process. `fatalText`
 * above carries the part of this that CAN be tested without that
 * restructuring.
 */
function fatal(message: string, err?: unknown, code = 1): never {
  writeSync(2, `${fatalText(message, err)}\n`);
  process.exit(code);
}

/**
 * Read a required env var and exit the process if it is missing or blank.
 * The validation itself lives in the pure, exported `requireNonBlank` above;
 * this wrapper is the one place that reads `process.env` and calls
 * `process.exit` (via `fatal`), same as before.
 */
const required = (name: string): string => {
  try {
    return requireNonBlank(name, process.env[name]);
  } catch (err) {
    fatal(err instanceof Error ? err.message : String(err));
  }
};

/**
 * `required()` plus the URL-shape check from `requireUrl`, for AGENT_URL
 * specifically — the only required env var this host treats as a URL rather
 * than an opaque string.
 */
const requiredUrl = (name: string): string => {
  try {
    return requireUrl(name, requireNonBlank(name, process.env[name]));
  } catch (err) {
    fatal(err instanceof Error ? err.message : String(err));
  }
};

/**
 * Every app component whose buttons carry an `onClick`, registered so the
 * channel can re-render it by name to resolve a click after a process
 * restart.
 *
 * Per the installed `ActionRegistry.dispatch` (`@copilotkit/channels-core`
 * `dist/action-registry.js`), a click resolves through an in-process "hot"
 * cache FIRST (`this.hot.get(id)`) and only falls back to re-rendering the
 * named component on a miss. That cache is populated the moment a component
 * is bound for posting and is never cleared in production (`clearHotCache()`
 * exists but has no production call site), and `ActionRegistry` itself is
 * built once per `channel.start()` — so the cache stays warm for the whole
 * life of this long-lived process. The named-component fallback below is
 * therefore reached only across a PROCESS RESTART, never for an ordinary
 * click on something this process posted.
 *
 * A miss does NOT dead-letter, either: `create-channel.js`'s `onInteraction`
 * catches `ActionExpiredError` specifically and swallows it. The only
 * observable effect is that the cosmetic in-place card re-render skips.
 * `ConfirmWrite`'s HITL gate is not stranded by a miss: the `awaitChoice`
 * waiter resolves from `evt.value ?? dispatchedValue` — Slack's Block Kit
 * payload carries `value` directly, so the waiter resolves whether or not
 * `dispatch` succeeded. Named-component recovery of the value is the
 * *Telegram* fallback, for a callback payload that can't carry it.
 *
 * None of that makes registration free insurance, though: across a restart,
 * `dispatch` calls `store.get(id)` and throws `ActionExpiredError` BEFORE it
 * ever reads `this.components` — so the named-component path only helps if
 * the snapshot survives in a durable `ActionStore`. This channel configures
 * no `store`, and on the realtime-gateway path `IntelligenceAdapter`'s
 * default-store builder short-circuits (it only builds one when neither
 * `source` nor `egress` is injected, and this transport injects both), so
 * `createChannel`'s backend resolution falls through to an in-process
 * `MemoryStore` — the snapshot is gone with the process regardless.
 *
 * Net effect: today, registering these components is neither necessary
 * (misses don't dead-letter, and Slack's HITL gate resolves independently)
 * nor sufficient (the snapshot doesn't survive a restart without a durable
 * store configured). It is forward-looking insurance that only pays off once
 * a durable `store` adapter is wired up — keep registering new interactive
 * components here anyway, so that day-one work is already done.
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
 *
 * `message.text` is checked via `.trim()`, not raw truthiness: `"   "` is
 * truthy, so a whitespace-only `text` would otherwise get prepended as a
 * blank leading text part alongside the real attachments. This file already
 * treats `"   "` as absent everywhere else a truthy-blank check would
 * otherwise let it through (`requireNonBlank`, `buildAgentHeaders`,
 * `httpAuthGate`, `channelName` in `createKiteChannel`) — this was the one
 * un-trimmed path.
 */
export function promptFromMessage(message: {
  contentParts?: AgentContentPart[];
  text: string;
}): string | AgentContentPart[] {
  const parts = message.contentParts;
  if (!parts?.length) return message.text;
  return message.text.trim()
    ? [{ type: "text" as const, text: message.text }, ...parts]
    : parts;
}

/**
 * Build the Authorization header object forwarded to the agent, if any.
 *
 * `AGENT_AUTH_HEADER` reaches here raw from `process.env`, and `"   "` is
 * truthy — without trimming, a whitespace-only value would ship
 * `{ Authorization: "   " }` on every agent request instead of being treated
 * as unset. Trim first, the same way `channelName` and `CHANNEL_HTTP_TOKEN`
 * are normalized elsewhere in this file.
 */
export function buildAgentHeaders(
  authHeader?: string,
): { Authorization: string } | undefined {
  const trimmed = authHeader?.trim();
  return trimmed ? { Authorization: trimmed } : undefined;
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
 * Every declared channel that is not `online`, as `"<name>=<status>"` — plus
 * `overall` itself when it disagrees with an all-clear per-channel map.
 *
 * `channels.ready()` resolving is NOT proof of liveness: it resolves once each
 * channel reaches a terminal state, and `setup_required` (declared, but no
 * managed provider bound yet) counts as terminal. `unmanaged` — a channel
 * carrying a direct adapter this handler doesn't own — resolves immediately and
 * likewise implies no health. Only `online` means the channel can actually
 * send, so the boot's success line must be gated on this returning empty.
 *
 * That per-channel map is not the whole story, though: per the installed
 * `ChannelManager.status()`, before activation completes it returns
 * `{ overall: "connecting", channels: {} }` — an EMPTY map, because `channels`
 * is built from `entries`, which nothing has populated until `activate()`
 * runs. Filtering only `health.channels` sees nothing to filter and reports
 * `[]`, so the boot gate would log "(channel live)" for a channel that never
 * activated. Fold `overall` in: when the per-channel filter finds nothing
 * unhealthy to report — either because the map is empty, or because every
 * entry present in it already reads `online` — but `overall` itself is not
 * `online`, surface that as `"overall=<status>"` so the false-success case
 * this gate exists to catch can't slip through. (`stop()`, by contrast, does
 * NOT clear `entries` — it only flips each entry's own `status` to
 * `"stopped"` — so the post-stop map is non-empty and already reads e.g.
 * `{ "kite-opentag": "stopped" }`; that case is caught directly by the
 * per-channel filter itself, the same path as `setup_required` below, without
 * ever reaching this fold.)
 *
 * That `overall` fold is still not sufficient by itself, though:
 * `ChannelManager.computeOverall` returns `"online"` for a ZERO-length input
 * (`if (values.length === 0) return "online"`), so `{ overall: "online",
 * channels: {} }` is a shape the manager can genuinely produce — not only for
 * a host with no declared channels, but for the pathological case of this
 * host's own declared channel silently missing from `entries` after
 * activation. Neither the per-channel filter (nothing to filter) nor the
 * `overall !== "online"` fold (it IS "online") catches that; inferring health
 * from the absence of bad entries is exactly the hazard. So: when the
 * per-channel filter has nothing to report, don't stop there — confirm
 * `channelName` (the one channel THIS host declared) is actually present in
 * `health.channels` AND `online`, by name. An absent or non-online entry for
 * it is reported the same way a present-but-bad one would be. That same
 * "nothing unhealthy in the filtered map" condition is also what lets a
 * DEGRADED `overall` (e.g. `setup_required`) surface correctly even alongside
 * an all-`online` per-channel map, as long as the declared `channelName` is
 * missing from that map — not only the all-`online`-and-`overall: "online"`
 * case the tests below happened to spell out first.
 */
export function unhealthyChannels(
  health: ChannelHealth | undefined,
  channelName: string,
): string[] {
  if (!health) return [];
  const perChannel = Object.entries(health.channels)
    .filter(([, status]) => status !== "online")
    .map(([name, status]) => `${name}=${status}`);
  if (perChannel.length > 0) return perChannel;
  if (health.channels[channelName] !== "online") {
    return [`overall=${health.overall}`];
  }
  return [];
}

/** What a watchdog tick wants `main()` to do. */
export type WatchdogAction =
  | { kind: "quiet" }
  | { kind: "notice"; message: string }
  | { kind: "fatal"; message: string };

/**
 * How long a channel may stay continuously non-`online` before the watchdog
 * escalates a logged notice into `fatal`.
 *
 * Without this, a channel wedged in `reconnecting` (not `error` — that path
 * is already fatal above) emits exactly one `console.warn` on the first
 * degraded tick and then stays quiet forever: `overall === previousOverall`
 * short-circuits every later tick to `quiet`. This service has no healthcheck
 * and no public domain, so nothing else would ever notice — `setup.md`'s
 * promise that the watchdog "rebuilds the host instead of leaving KiteBot
 * silently offline" is false for exactly this case. 10 minutes is long enough
 * that a brief network blip's reconnect never trips it, but short enough that
 * the platform's restart policy rebuilds the host well within an on-call SLA.
 */
export const CHANNEL_DEGRADED_FATAL_MS = 10 * 60 * 1000;

/**
 * Decide what to do about the channel's current health, given what was last
 * reported and how long (in ms) the channel has been continuously
 * non-`online`.
 *
 * Boot-time liveness (Task: `unhealthyChannels`) says nothing about the hours
 * that follow. A managed session that drops goes `reconnecting`; one that
 * exhausts its bounded reconnect window goes `error` and never comes back. The
 * manager does NOT re-activate — so `error` is terminal, and the only useful
 * response is to exit and let the platform's restart policy rebuild the host.
 * A channel stuck `reconnecting` (never reaching `error`) is terminal in
 * effect, just slower, so it gets the same fatal treatment once
 * `degradedForMs` clears `CHANNEL_DEGRADED_FATAL_MS`.
 *
 * `degradedForMs` is supplied by the caller (`main()` tracks a first-degraded
 * timestamp and does the clock read) — this function stays pure, with no
 * clock of its own, so it's unit-testable without faking time.
 *
 * The duration check runs BEFORE the "already reported" early-return below,
 * so a channel that has been silently quiet for many ticks still escalates
 * the moment it crosses the threshold, rather than being permanently
 * suppressed by the first notice having already fired.
 *
 * Transitions are otherwise reported once, not once per tick, so a long
 * reconnect doesn't flood the logs.
 */
export function channelWatchdogTick(
  health: ChannelHealth | undefined,
  previousOverall: string | undefined,
  degradedForMs: number,
  channelName: string,
): WatchdogAction {
  if (!health) return { kind: "quiet" };
  const { overall } = health;
  if (overall === "error") {
    return {
      kind: "fatal",
      message: `channel is dead: ${unhealthyChannels(health, channelName).join(", ")}`,
    };
  }
  if (overall !== "online" && degradedForMs >= CHANNEL_DEGRADED_FATAL_MS) {
    return {
      kind: "fatal",
      message: `channel has been non-online for >= ${CHANNEL_DEGRADED_FATAL_MS / 60_000}m: ${unhealthyChannels(health, channelName).join(", ")}`,
    };
  }
  if (overall === previousOverall) return { kind: "quiet" };
  if (overall === "online") {
    return { kind: "notice", message: "channel recovered: overall=online" };
  }
  return {
    kind: "notice",
    message: `channel degraded: ${unhealthyChannels(health, channelName).join(", ")}`,
  };
}

/**
 * Compute the watchdog's next `degradedSince` timestamp.
 *
 * A falsy/missing `health` reading is NOT evidence of recovery — it means "no
 * data this tick", not "back online". Resetting `degradedSince` on a missing
 * reading (as `else degradedSince = undefined` did) treats "I don't know" the
 * same as "I know it's fine": a status surface that intermittently returns
 * nothing would have its degraded clock wiped every other tick and could
 * never accumulate the continuous duration `CHANNEL_DEGRADED_FATAL_MS`
 * checks for, so the 10-minute escalation would never fire. Both
 * `channelWatchdogTick` and `unhealthyChannels` already treat a missing
 * reading as "nothing to report" rather than "healthy" — this makes the
 * clock consistent with that.
 *
 * Only an AFFIRMATIVE `overall === "online"` resets the clock; anything else
 * (degraded, or no reading at all) leaves an existing timestamp alone and
 * only starts a fresh one if none was running.
 *
 * Takes `now` as a parameter instead of reading `Date.now()` itself, so this
 * stays pure and unit-testable without faking the clock — `main()`'s
 * watchdog tick is the only caller and supplies the real timestamp.
 */
export function nextDegradedSince(
  health: ChannelHealth | undefined,
  degradedSince: number | undefined,
  now: number,
): number | undefined {
  if (!health) return degradedSince;
  if (health.overall === "online") return undefined;
  return degradedSince ?? now;
}

/**
 * Promisified `server.close()`.
 *
 * Resolves regardless of outcome: the only error `close` reports is
 * `ERR_SERVER_NOT_RUNNING` (the server never bound), which is not a shutdown
 * failure. Per Node's own `net.Server.prototype.close`, that error is
 * reported ONLY through the callback (`this.once("close", () =>
 * cb(new ERR_SERVER_NOT_RUNNING()))`); with no callback the error is simply
 * dropped and never emitted on `'error'` — so passing a callback here does
 * not "protect" the server's `error` event from anything; there was never a
 * hazard on that path to keep it off of.
 *
 * `close()` alone only stops accepting new connections and drops idle
 * keep-alive sockets — it does NOT end in-flight requests, so the callback
 * (and this promise) waits for every active response to finish. This runtime
 * streams agent runs over SSE (`/api/copilotkit/agent/:id/run`), so an open
 * stream at shutdown time would otherwise pin `shutdown` until the platform's
 * grace period expires and SIGKILLs the container — skipping `closeBrowser()`
 * and `process.exit(exitCode)`, and turning a clean exit into a kill that
 * Railway's `ON_FAILURE` policy may count as a failure. Force in-flight
 * sockets closed via `closeAllConnections` right after initiating `close()`,
 * so shutdown can't outlive the platform's grace period. Order matters: call
 * it AFTER `close()` so no new connection can be accepted in the gap between
 * the two calls. It's optional because it only exists on Node >= 18.2.
 */
export function closeServer(server: {
  close(cb: (err?: Error) => void): unknown;
  closeAllConnections?: () => void;
}): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/**
 * Wrap a shutdown routine so that N signals run it exactly ONCE.
 *
 * Signals are not exclusive: SIGTERM then a impatient Ctrl-C, or two SIGINTs,
 * each fire the handler again. Without memoization the body runs concurrently —
 * duplicate "stopping…" logs, a second `channels.stop()`, a second
 * `closeServer`, a second `closeBrowser`, and two `process.exit` calls racing
 * with independently-computed exit codes (the loser's code is simply lost).
 * That is benign today only because every downstream call happens to be
 * idempotent; nothing enforces that, and the first `process.exit` to land
 * truncates whatever the other run was still awaiting.
 *
 * The FIRST signal wins: it starts `run` and the resulting promise is stashed
 * in `inFlight` purely as a memo guard, not as a handle anyone gets back —
 * the returned function is `void`, `inFlight` is never read except by the
 * `??=` check, and nothing awaits it. Later signals arriving before the run
 * settles do NOT "attach" to it in any observable sense; they are silent
 * no-ops. `onError` is invoked at most once, for the signal that actually
 * started the run.
 *
 * `run` is called synchronously (so callers that assert on its side effects
 * without awaiting still see them), but a run that throws SYNCHRONOUSLY is
 * just as much a failure as one that rejects, and must be memoized and routed
 * to `onError` the same way — never left to escape into the caller (a signal
 * handler) and start a second, competing run on the next signal. The
 * try/catch below converts a synchronous throw into a rejected promise
 * BEFORE the `.catch` is attached, so both paths join the same memoized
 * promise with identical microtask timing — an `async () => run(...)`
 * wrapper would also catch the throw, but adds an extra microtask hop before
 * a rejecting `run` reaches `onError`, changing observable timing for every
 * caller (including ones that already await a fixed number of ticks).
 *
 * `exitCode` lets a non-signal caller (the watchdog's fatal path, below)
 * request a specific exit code from the SAME run — e.g. `1`, so a fatal
 * watchdog tick still exits non-zero after routing through graceful teardown
 * instead of calling `process.exit(1)` directly. Only the signal that starts
 * the run gets to pick; a later, memoized-away call's `exitCode` is ignored,
 * same as its `signal` is.
 *
 * The guard is set BEFORE `run` is invoked, not after: a `run` that
 * synchronously re-enters the returned function (e.g. it registers its own
 * signal handler that fires before `run` returns) must see the guard already
 * up, or "the FIRST signal wins" and "exactly ONCE" are false for exactly
 * that case. The placeholder is replaced with the real (or rejected) promise
 * immediately afterward, before any `await` — no code between the two
 * assignments can observe `inFlight` in the placeholder state, so this
 * doesn't change the memoized promise `onError` ultimately sees.
 *
 * Pure: all policy (logging, exiting) is injected, so this is unit-testable.
 */
export function onceShutdown(
  run: (signal: string, exitCode?: number) => Promise<void>,
  onError: (signal: string, err: unknown) => void,
): (signal: string, exitCode?: number) => void {
  let inFlight: Promise<void> | undefined;
  return (signal: string, exitCode?: number): void => {
    if (inFlight) return;
    inFlight = Promise.resolve(); // placeholder: blocks synchronous re-entry
    let started: Promise<void>;
    try {
      started = run(signal, exitCode);
    } catch (err) {
      started = Promise.reject(err as unknown);
    }
    inFlight = started.catch((err: unknown) => onError(signal, err));
  };
}

/**
 * What to do when an uncaught exception fires, given whether a graceful
 * shutdown is already running.
 *
 * `uncaughtException` catches EVERYTHING uncaught, not just a turn-scoped
 * throw — a throw inside the watchdog's `setInterval` callback, corrupted
 * state after a partial activation, an assertion deep in the transport. Left
 * running, the process continues in an undefined state with its socket still
 * bound, and the platform's restart policy never fires — KiteBot looks up
 * while being broken. The per-turn tolerance a bad turn deserves already
 * exists in the right place: the try/catch inside `onMention`.
 *
 * But an exception raised WHILE a graceful shutdown is already in flight must
 * not preempt it — same reasoning as the server `error` handler above: the
 * process is already on its way out via a bounded, orderly teardown, and
 * treating this as a fresh fatal event would race a second exit against the
 * first.
 *
 * Extracted as a pure decision (instead of inlining `stopping ? ... : ...`
 * directly in the `process.on("uncaughtException", ...)` callback) so this
 * policy is unit-testable without registering a real listener or exiting the
 * test process.
 */
export type UncaughtExceptionAction =
  | { kind: "continue-shutdown" }
  | { kind: "fatal" };

export function uncaughtExceptionAction(
  stopping: boolean,
): UncaughtExceptionAction {
  return stopping ? { kind: "continue-shutdown" } : { kind: "fatal" };
}

/**
 * Build the KiteBot channel: same tools/context/commands/handlers as the native
 * bot, minus any platform adapter (the managed transport is attached at
 * activation — NOT when the runtime's node listener is mounted, but lazily on
 * the first `channels.ready()` call; see the module docstring above and
 * `main()`'s explicit `await channels.ready(...)`). Pure — no network,
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
    // `provider` defaults to "slack" when unset — NOT in channels-core.
    // `create-channel.js` simply omits the key when `opts.provider` is
    // undefined (`...(opts.provider !== undefined ? { provider: opts.provider
    // } : {})`), and its `.d.ts` only documents the closed
    // `ManagedChannelProvider` union, not a default. The default is applied
    // downstream, in the installed `@copilotkit/runtime`'s
    // `dist/v2/runtime/core/channel-activation-config.mjs`
    // (`deriveChannelActivationConfig`): `adapter: trimmedProvider ?
    // trimmedProvider : "slack"`. This host was already relying on that
    // downstream default implicitly. State it explicitly: the
    // Slack-only `tools`/`context` spread below (`defaultSlackTools` /
    // `defaultSlackContext`, which mandate `lookup_slack_user` before any
    // @-mention) should be justified by a declared provider, not by an
    // unstated SDK default this host happens to match. This channel is
    // Slack-only by design, so the spread stays unconditional — see
    // `app/index.ts`, which gates the identical spread on Slack secrets being
    // present for its multi-platform direct-adapter case; this host has no
    // such branch to gate on.
    provider: "slack",
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
  const agentUrl = requiredUrl("AGENT_URL");
  const agentAuthHeader = process.env.AGENT_AUTH_HEADER;

  const channel = createKiteChannel({
    agentUrl,
    agentAuthHeader,
    channelName: process.env.INTELLIGENCE_CHANNEL_NAME,
  });
  // `channel.name` is typed `string | undefined` upstream (the SDK's general
  // `Channel` shape allows an unnamed channel), but `createKiteChannel` above
  // always normalizes and passes an explicit non-blank name, so it is always
  // set in practice for a channel THIS host built. The fallback documents
  // that guarantee for the type checker rather than asserting past it.
  const channelName = channel.name ?? "kite-opentag";

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
    // gateway/Slack adapter and passed to the agent via `senderContext`.
    // `IdentifyUserCallback` takes a `Request`, so this only ever runs on the
    // runtime's own HTTP endpoints — which are closed unless CHANNEL_HTTP_TOKEN
    // is set. Note the consequence if a deployer does open them: a single static
    // identity means every bearer holder shares one thread + memory namespace.
    identifyUser: () => ({ id: "opentag-kite", name: "OpenTag KiteBot" }),
    channels: [channel],
  });

  const rawPort = process.env["PORT"];
  const port = rawPort && rawPort.trim() !== "" ? Number(rawPort) : 8300;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fatal(
      `Invalid PORT: "${rawPort}" is not a valid port number (must be an integer between 1 and 65535)`,
    );
  }

  const httpToken = process.env.CHANNEL_HTTP_TOKEN?.trim();
  const listener = createCopilotNodeListener({
    runtime,
    basePath: "/api/copilotkit",
    hooks: { onRequest: httpAuthGate(httpToken) },
  });

  // Resolve the channels control surface ONCE, up front, and treat its absence
  // as fatal. It is optional on the listener (a runtime with no declared
  // channels has none), but this host exists to run exactly one managed
  // channel: with no surface there is nothing to call `ready()` on, so the boot
  // gate would skip activation entirely, `unhealthyChannels(undefined)` would
  // return `[]`, and the process would log "(channel live)" for a host that has
  // no channel at all — then arm a watchdog that stays permanently quiet. That
  // false success is the exact failure this boot gate exists to kill, so the
  // fallback must be "die loudly", never "claim success".
  const channels = listener.channels;
  if (!channels) {
    fatal(
      "[channel] runtime exposed no channels control surface — the managed channel cannot activate",
    );
  }

  const server = createServer(listener);
  let watchdog: NodeJS.Timeout | undefined;
  let listening = false;
  // Set by `shutdown` before its first await, so the async boot path can tell a
  // deliberate stop from a real failure. Without it a signal that lands inside
  // the activation window turns a graceful shutdown into `process.exit(1)`.
  let stopping = false;
  // Fail loud on a bind failure. Without an 'error' handler an EADDRINUSE/EACCES
  // during listen() surfaces only as a logged-but-swallowed uncaughtException
  // while the process keeps running with no listener — Railway's ON_FAILURE
  // never fires. Attach BEFORE listen() so the bind error is caught here. The
  // `listening` flag keeps the message honest: after a successful bind, an
  // 'error' here is no longer a bind failure.
  server.on("error", (err) => {
    // Do NOT exit on an error emitted while shutdown is running: `closeServer`
    // is mid-flight (it force-closes in-flight sockets via
    // `closeAllConnections`), and exiting here would preempt the rest of
    // shutdown — skipping `closeBrowser()` and replacing the computed exit code
    // with 1, so Railway's ON_FAILURE policy restarts a host that was asked to
    // stop. Log it and let `shutdown` finish and own the exit.
    if (stopping) {
      console.error(
        `[channel] HTTP server error on :${port} during shutdown (continuing shutdown)`,
        err,
      );
      return;
    }
    if (!listening) {
      // Genuine bind failure (EADDRINUSE/EACCES): nothing bound yet, nothing to
      // tear down, no listener to close. Exit directly — simple and immediate,
      // same as before.
      fatal(`[channel] HTTP listener failed to bind on :${port}`, err);
    }
    // A live, post-bind socket error is the same hazard class as the
    // watchdog's fatal path above: exiting straight here (the old behavior)
    // bypasses `channels.stop()` and `closeBrowser()`, leaving Intelligence to
    // time out this runtime's lease and orphaning Chromium. Route through the
    // SAME memoized teardown the signal handlers and watchdog use, with a
    // non-zero exit code, instead of calling `fatal()` directly.
    console.error(`[channel] HTTP server error on :${port}`, err);
    runShutdown("server-error", 1);
  });

  // Fail loud, not silent: surface any stray uncaught throw (a bad turn's
  // exception is already caught inside `onMention`'s own try/catch — this is
  // for everything ELSE: a throw inside the watchdog's `setInterval`
  // callback, corrupted state after a partial activation, an assertion deep
  // in the transport) instead of logging it and leaving the process running
  // in an undefined state with its socket still bound, where the platform's
  // restart policy never fires. Registered here (inside `main()`, not at
  // module scope) so it can consult `stopping` via `uncaughtExceptionAction`
  // — an exception raised while a graceful shutdown is already in flight must
  // not preempt it, exactly like the server `error` handler just above.
  process.on("uncaughtException", (err) => {
    const action = uncaughtExceptionAction(stopping);
    if (action.kind === "continue-shutdown") {
      console.error(
        "[channel] uncaughtException during shutdown (continuing shutdown)",
        err,
      );
      return;
    }
    fatal(
      "[channel] uncaughtException — exiting so the platform restarts the host",
      err,
    );
  });

  // Same policy as `uncaughtException` above, via the SAME `uncaughtExceptionAction`
  // decision — not a separate, softer one. An unhandled rejection is just as
  // capable of leaving this process in the exact undefined, still-bound-socket
  // state that motivated making `uncaughtException` fatal: the `server.listen`
  // callback below is `async`, and nothing awaits or attaches to its returned
  // promise, so a throw from anything in it AFTER the try/catch around
  // `channels.ready()` (the status check, the `channel.name` getter in the
  // success log, `setInterval`, `watchdog.unref()`) would otherwise surface only
  // here — as a logged-but-survived rejection — with the socket bound, no
  // watchdog armed, no "(channel live)" line, and no exit. That is the exact
  // false-alive state the boot gate, the status fold, the `channels` presence
  // check, and the watchdog were all written to eliminate, so this handler must
  // not treat it any differently than `uncaughtException` does. Registered
  // here (inside `main()`, not at module scope, and not in the entry-point
  // guard below where it used to live) for the same reason as
  // `uncaughtException`: it needs to consult `main()`'s local `stopping` flag.
  process.on("unhandledRejection", (reason) => {
    const action = uncaughtExceptionAction(stopping);
    if (action.kind === "continue-shutdown") {
      console.error(
        "[channel] unhandledRejection during shutdown (continuing shutdown)",
        reason,
      );
      return;
    }
    fatal(
      "[channel] unhandledRejection — exiting so the platform restarts the host",
      reason,
    );
  });

  server.listen(port, () => {
    // The callback itself must stay synchronous: `server.listen` discards
    // whatever a listener callback returns, so an `async` callback's promise
    // (and any throw inside it) would otherwise go unobserved — exactly the
    // hole `unhandledRejection` above documents. Run the actual boot-completion
    // logic in this explicitly-tracked async IIFE instead, with its own
    // terminal `.catch` so any throw becomes a fatal exit via the same path
    // every other fail-fast branch in this file uses, instead of surfacing
    // only as a logged-and-ignored unhandled rejection.
    void (async () => {
      listening = true;
      // The socket is bound, but the managed channel is not necessarily live yet.
      // `ready()` rejects if any declared channel settled to `error` (bad
      // INTELLIGENCE_API_KEY, unreachable INTELLIGENCE_GATEWAY_WS_URL) or — with
      // timeoutMs — if it never settles at all.
      try {
        await channels.ready({ timeoutMs: CHANNEL_READY_TIMEOUT_MS });
      } catch (err) {
        // A rejection that lands after shutdown began is expected fallout, not a
        // boot failure: the per-channel timeout can fire while `shutdown` is
        // awaiting `closeBrowser()`. Exiting here would preempt that await —
        // leaving Chromium alive — and report 1 for a deliberate stop. Do NOT
        // "simplify" this guard away.
        if (stopping) return;
        fatal("[channel] Intelligence channel activation failed", err);
      }
      // Same window, the resolve side. `channels.stop()` marks entries `stopped`
      // but does NOT settle in-flight activations, so a signal arriving inside
      // the 30s activation window (a Railway redeploy, or Ctrl-C during boot)
      // lets this `ready()` resolve afterwards with `overall: "stopped"`. Without
      // this guard the status gate below reads that as "NOT live", prints advice
      // about finishing a connector setup that is perfectly fine, and exits 1 —
      // preempting shutdown's in-flight `closeServer`/`closeBrowser()` and
      // handing Railway's ON_FAILURE policy a restart. It also stops the watchdog
      // below from being CREATED after shutdown already ran its `clearInterval`.
      // One guard, three hazards: do NOT "simplify" it away.
      if (stopping) return;
      // …but resolving is not the same as live: `setup_required` and `unmanaged`
      // both settle terminally without the channel being able to send. Check the
      // status map before claiming success.
      const notLive = unhealthyChannels(channels.status(), channelName);
      if (notLive.length > 0) {
        fatal(
          `[channel] activation settled but the channel is NOT live: ${notLive.join(", ")}. ` +
            `"setup_required" means the channel name exists in your Intelligence project but no ` +
            `platform connector is bound to it — finish the connector setup in the Intelligence ` +
            `dashboard, then redeploy this service.`,
        );
      }
      console.log(
        `[channel] KiteBot channel "${channel.name}" mounted on :${port} → Intelligence gateway (channel live)`,
      );
      let previousOverall = "online";
      // First-degraded timestamp: unset while the channel is online, set to
      // `Date.now()` the moment it first isn't (via the pure `nextDegradedSince`
      // above — a missing reading leaves it untouched rather than resetting it,
      // and only an affirmative `overall === "online"` resets it).
      // `channelWatchdogTick` stays pure (no clock of its own) by taking the
      // elapsed duration as a plain number — this is the one place that reads
      // the clock and does the subtraction.
      let degradedSince: number | undefined;
      watchdog = setInterval(() => {
        const health = channels.status();
        degradedSince = nextDegradedSince(health, degradedSince, Date.now());
        const degradedForMs =
          degradedSince === undefined ? 0 : Date.now() - degradedSince;
        const action = channelWatchdogTick(
          health,
          previousOverall,
          degradedForMs,
          channelName,
        );
        if (health) previousOverall = health.overall;
        if (action.kind === "fatal") {
          console.error(
            `[channel] ${action.message} — exiting so the platform restarts the host`,
          );
          // Route through the SAME teardown the signal handlers use, with a
          // non-zero exit code, rather than `process.exit(1)` directly. This
          // watchdog fires after arbitrary uptime — precisely when Chromium is
          // most likely running (launched by render_chart/render_diagram) — so
          // exiting straight here would skip `channels.stop()` (Intelligence
          // then has to time out this runtime's lease instead of getting a
          // clean disconnect) and skip `closeBrowser()` (orphaning the
          // browser). `runShutdown`/`onceShutdown` are in scope by the time
          // this interval fires; its memoization means a concurrent SIGTERM
          // can't start a second, competing teardown.
          runShutdown("watchdog", 1);
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
    })().catch((err: unknown) => {
      // A throw during an in-flight graceful shutdown must not preempt it —
      // same reasoning as every other guard in this callback: `shutdown` may
      // already be awaiting `channels.stop()`/`closeServer`/`closeBrowser()`,
      // and racing a second exit against it would only truncate that teardown.
      if (stopping) return;
      fatal(
        "[channel] fatal error after HTTP listener bound (Finding 1: previously an unobserved rejection)",
        err,
      );
    });
  });

  const shutdown = async (signal: string, exitCode = 0) => {
    // FIRST, before any await and before the first log: from here on this
    // process is stopping, and the boot path's `process.exit(1)`/`fatal(...)`
    // calls must stand down. Anything that lands between here and
    // `process.exit(exitCode)` — a late `ready()` settlement, a server
    // 'error' emitted by `closeAllConnections`, an uncaught exception — would
    // otherwise preempt this function mid-await.
    stopping = true;
    console.log(`\n[channel] received ${signal}, stopping…`);
    // Also before the first await: a watchdog tick that fires mid-shutdown
    // would see `overall: "stopped"` and could exit non-zero on its own.
    if (watchdog) clearInterval(watchdog);
    // Tear down managed channel activation first. Bounded: `ChannelManager.stop`
    // caps each handle's teardown at 5s. No try/catch here: the installed
    // `ChannelManager.stop()` wraps every per-handle teardown in
    // `withTimeout(...).catch((err) => this.log?.(...))` and awaits them all
    // via `Promise.allSettled`, so `stop()` itself cannot reject — a catch
    // here would be dead code that can never run, silently implying a
    // failure mode that doesn't exist. A per-handle teardown failure is
    // swallowed by CONTRACT inside `ChannelManager` (it logs via its own
    // `log` option, which this host does not wire up) — that is where an
    // operator should look for a stuck handle, not here.
    await channels.stop();
    // Bounded by `closeAllConnections` — see the `closeServer` docstring.
    await closeServer(server);
    // Tear down the shared headless browser used for chart/diagram rendering,
    // under a deadline. `browser.close()` has none of its own: a wedged or
    // unresponsive Chromium would hang here indefinitely and reproduce exactly
    // the failure `closeServer` was hardened against — shutdown outliving the
    // platform's grace period, SIGKILL, and `process.exit(exitCode)` never
    // reached, so a clean stop is recorded as a kill. Every other step above is
    // already bounded; this was the last unbounded await. `.unref()` is
    // load-bearing: a ref'd timer would itself hold the event loop open for the
    // full 5s even when the browser closes immediately.
    await Promise.race([
      closeBrowser().catch((err: unknown) =>
        console.error(
          "[channel] browser cleanup failed (continuing shutdown)",
          err,
        ),
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref()),
    ]);
    process.exit(exitCode);
  };
  const runShutdown = onceShutdown(shutdown, (signal, err) => {
    fatal(`[channel] fatal during ${signal} shutdown`, err);
  });
  process.on("SIGINT", () => runShutdown("SIGINT"));
  process.on("SIGTERM", () => runShutdown("SIGTERM"));
}

// Only build the runtime + mount the listener when this module is the process
// entry point (`pnpm channel` / `tsx app/managed.ts`), not when the test imports
// `createKiteChannel`. Compare the module URL to the entry URL rather than
// matching a filename: endsWith("managed.ts") silently fails to boot if the
// entry is ever compiled to .js/.mjs or renamed. Under a test import,
// import.meta.url is this module while process.argv[1] is the test runner, so
// they differ and main() does not run.
//
// This same guard is where dotenv's load belongs, for the identical reason
// `main()` itself is gated here: a plain module-scope `import "dotenv/config"`
// call fires on IMPORT, not on execution as the entry point. Without this,
// `managed.test.ts` importing this module for its pure helpers would load the
// developer's local `.env` into the test run — a process-global side effect
// this file goes to trouble to avoid for `main()` itself.
//
// Both `uncaughtException` and `unhandledRejection` are registered separately,
// INSIDE `main()` (not here), because their handling needs to consult
// `main()`'s local `stopping` flag via `uncaughtExceptionAction` — see the
// registrations next to the server `error` handler for why. (Earlier,
// `unhandledRejection` was registered here instead, on the reasoning that
// nothing demonstrated an unhandled rejection could leave the process in the
// same undefined, still-bound-socket state that motivated making
// `uncaughtException` fatal. That reasoning was wrong: the `server.listen`
// callback's own unobserved promise (see its `.catch` below) is exactly that
// demonstration, so both handlers now share one policy.)
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // Load .env BEFORE anything reads `process.env` — `main()` (via `required`/
  // `requiredUrl`) is the first thing to do so, and a dynamic import's promise
  // only resolves once dotenv/config's own top-level code (which populates
  // `process.env` synchronously) has already run, so awaiting it here is
  // sufficient ordering.
  await import("dotenv/config");

  main().catch((err: unknown) => {
    fatal("[channel] fatal: failed to start channel runtime", err);
  });
}
