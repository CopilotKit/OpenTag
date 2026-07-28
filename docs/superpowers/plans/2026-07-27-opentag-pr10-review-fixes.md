# PR #10 Review-Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 13 findings from the review of [PR #10](https://github.com/CopilotKit/OpenTag/pull/10) so the Intelligence v2 channel host never claims to be live when it isn't, notices when it stops being live, and ships with a build and a CI gate that can actually catch regressions.

**Architecture:** Every behavioral fix follows the pattern `app/managed.ts` already established — a small, exported, side-effect-free helper that `main()` calls. `main()` itself is untestable (it binds sockets and reads env), so all new logic lands in helpers with unit tests, and `main()` shrinks to wiring. The Railway, docs, and CI changes carry no unit tests; their verification steps are explicit.

**Tech Stack:** TypeScript (ESM, `tsx`), vitest 4, `@copilotkit/runtime@^1.63.2` (v2 managed channels), `@copilotkit/channels@^0.2.1`, Railway IaC (`railway/iac`), GitHub Actions.

## Before you start

This plan modifies the PR #10 branch, not `main`:

```bash
git fetch origin && git checkout jerel/opentag-intelligence-v2 && git pull
```

Confirm you are on it before Task 1 — `git branch --show-current` must print `jerel/opentag-intelligence-v2`. Every commit in this plan lands on that branch and updates PR #10 in place.

## Global Constraints

- **Node 22, pnpm 10.** `lockfileVersion: '9.0'`, `@types/node: ^22`. Do not bump either.
- **Never widen the dependency set.** No new runtime or dev dependencies are needed by any task in this plan.
- **Log prefix is `[channel] `** on every line `app/managed.ts` emits. Match it exactly.
- **`app/managed.ts` helpers must stay pure** — no network, no `process.env` reads, no `process.exit` inside a helper. `main()` owns all three. This is what makes the file testable and is stated in its own docstrings.
- **Test file layout:** `app/<area>/__tests__/<name>.test.ts(x)`, except `app/managed.test.ts` which sits at the top level. vitest collects `app/**/*.test.ts` and `app/**/*.test.tsx` only (see `vitest.config.ts`), so a non-`.test.ts` file under `__tests__/` is a helper, not a suite.
- **Full verification command** (run before every commit): `pnpm check-types && pnpm test`. `check-types` covers `app/**`, `runtime.ts`, `scripts/**`, and `.railway/**`.
- **Commit style:** conventional commits, matching the branch's existing history (`fix(channel):`, `fix(railway):`, `test(channel):`, `docs:`, `ci:`).

---

### Task 1: Fail loud when activation settles but the channel is not live

The blocking finding. `ChannelsControl.ready()` resolves once every channel settles to a *terminal* state — and per the SDK's own docs that includes `setup_required` ("the Channel is declared but has no managed provider yet — a valid degraded state, not a failure"). `channel-manager.mjs:215` confirms it: a `SETUP_REQUIRED` activation error sets the status and **resolves** the settle promise. So a channel that exists in the Intelligence dashboard with no Slack connector bound currently prints `(channel live)` and the host stays up pretending to work. `ready()` also takes a `timeoutMs` that is not being passed, so an activation that never settles hangs the boot silently — and the Railway `channel` service has no healthcheck to notice.

**Files:**
- Modify: `app/managed.ts` (add `ChannelHealth` + `unhealthyChannels` near the other helpers; rewire the `server.listen` callback at lines 281-306)
- Test: `app/managed.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface ChannelHealth { overall: string; channels: Record<string, string> }`
  - `export function unhealthyChannels(health: ChannelHealth | undefined): string[]` — returns `"<name>=<status>"` for every channel whose status is not `"online"`, `[]` when `health` is `undefined`.
  - Task 2 reuses both.

- [ ] **Step 1: Write the failing tests**

Append to `app/managed.test.ts`. Add `ChannelHealth`, `unhealthyChannels` to the existing import block from `./managed.js`.

```ts
describe("unhealthyChannels", () => {
  it("reports nothing when there is no control surface", () => {
    // `listener.channels` is absent when no managed channels are declared —
    // a bound socket alone is success there, exactly as before.
    expect(unhealthyChannels(undefined)).toEqual([]);
  });

  it("reports nothing when every channel is online", () => {
    expect(
      unhealthyChannels({
        overall: "online",
        channels: { "kite-opentag": "online" },
      }),
    ).toEqual([]);
  });

  it("reports a channel that settled to setup_required", () => {
    // THE REGRESSION: ready() RESOLVES on setup_required, so this is the state
    // that used to print "(channel live)" for a channel with no Slack
    // connector bound — the most likely first-run state for a deployer.
    expect(
      unhealthyChannels({
        overall: "setup_required",
        channels: { "kite-opentag": "setup_required" },
      }),
    ).toEqual(["kite-opentag=setup_required"]);
  });

  it("reports a channel the handler does not own", () => {
    // `unmanaged` means a direct adapter is attached; ready() resolves for it
    // immediately and implies NO health.
    expect(
      unhealthyChannels({
        overall: "unmanaged",
        channels: { "kite-opentag": "unmanaged" },
      }),
    ).toEqual(["kite-opentag=unmanaged"]);
  });

  it("reports only the channels that are not online", () => {
    expect(
      unhealthyChannels({
        overall: "setup_required",
        channels: { a: "online", b: "setup_required", c: "reconnecting" },
      }),
    ).toEqual(["b=setup_required", "c=reconnecting"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run app/managed.test.ts -t unhealthyChannels`
Expected: FAIL — `No "unhealthyChannels" export is defined on the "./managed.js" mock` / TypeScript reports the import does not exist.

- [ ] **Step 3: Add the helper**

In `app/managed.ts`, directly after the `httpAuthGate` function:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run app/managed.test.ts -t unhealthyChannels`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into `main()`**

In `app/managed.ts`, add this constant immediately above `async function main() {`:

```ts
/**
 * How long to wait for managed-channel activation before giving up. Applied
 * PER CHANNEL by `ready()`. Without it a gateway that accepts the socket but
 * never settles the join leaves the host bound, silent, and indistinguishable
 * from healthy — and this service has no Railway healthcheck to catch that.
 */
const CHANNEL_READY_TIMEOUT_MS = 30_000;
```

Then replace the body of the `server.listen(port, async () => { … })` callback down to (and including) the `(channel live)` log with:

```ts
  server.listen(port, async () => {
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
```

Leave the two HTTP-posture `console.log` lines that follow untouched.

Exiting non-zero (rather than warning and staying up) is deliberate: nothing re-activates a channel that settled to `setup_required`, so the host would never recover without a restart. A crash under Railway's `ON_FAILURE` / `maxRetries: 5` puts the failure in front of the deployer instead of hiding it behind a green service.

- [ ] **Step 6: Verify the whole suite and types**

Run: `pnpm check-types && pnpm test`
Expected: 0 type errors; all tests pass (127 = the prior 122 + 5).

- [ ] **Step 7: Commit**

```bash
git add app/managed.ts app/managed.test.ts
git commit -m "fix(channel): gate the boot success line on channel status, not just ready()"
```

---

### Task 2: Notice when a live channel dies after boot

Task 1 only checks liveness once, at boot. Per `ChannelManager`, a managed session that drops moves to `reconnecting`, and one that exhausts its bounded reconnect window moves to `error`. Nothing observes either. KiteBot goes offline, the process stays healthy, and `restartPolicyType: ON_FAILURE` never fires — the same class of silent failure as Task 1, one lifecycle stage later.

**Files:**
- Modify: `app/managed.ts` (add `WatchdogAction` + `channelWatchdogTick`; start the interval in the `listen` callback; clear it in `shutdown`)
- Test: `app/managed.test.ts`

**Interfaces:**
- Consumes: `ChannelHealth`, `unhealthyChannels` from Task 1.
- Produces: `export type WatchdogAction = { kind: "quiet" } | { kind: "notice"; message: string } | { kind: "fatal"; message: string }` and `export function channelWatchdogTick(health: ChannelHealth | undefined, previousOverall: string | undefined): WatchdogAction`.

- [ ] **Step 1: Write the failing tests**

Append to `app/managed.test.ts`. Add `channelWatchdogTick` to the import block.

```ts
describe("channelWatchdogTick", () => {
  const health = (overall: string) => ({
    overall,
    channels: { "kite-opentag": overall },
  });

  it("is quiet when there is no control surface", () => {
    expect(channelWatchdogTick(undefined, "online")).toEqual({ kind: "quiet" });
  });

  it("is quiet while the channel stays online", () => {
    expect(channelWatchdogTick(health("online"), "online")).toEqual({
      kind: "quiet",
    });
  });

  it("is fatal once the channel gives up reconnecting", () => {
    // `error` here means the session exhausted its bounded reconnect window.
    // Exiting is what lets Railway's ON_FAILURE policy restart the host.
    expect(channelWatchdogTick(health("error"), "online")).toEqual({
      kind: "fatal",
      message: "channel is dead: kite-opentag=error",
    });
  });

  it("notices the first tick of a degraded state", () => {
    expect(channelWatchdogTick(health("reconnecting"), "online")).toEqual({
      kind: "notice",
      message: "channel degraded: kite-opentag=reconnecting",
    });
  });

  it("does not repeat a degraded state it already reported", () => {
    // A drop that takes minutes to resolve must not emit one line per tick.
    expect(
      channelWatchdogTick(health("reconnecting"), "reconnecting"),
    ).toEqual({ kind: "quiet" });
  });

  it("notices recovery back to online", () => {
    expect(channelWatchdogTick(health("online"), "reconnecting")).toEqual({
      kind: "notice",
      message: "channel recovered: overall=online",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run app/managed.test.ts -t channelWatchdogTick`
Expected: FAIL — `channelWatchdogTick` is not exported from `./managed.js`.

- [ ] **Step 3: Add the helper**

In `app/managed.ts`, directly after `unhealthyChannels`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run app/managed.test.ts -t channelWatchdogTick`
Expected: PASS, 6 tests.

- [ ] **Step 5: Start the watchdog in `main()`**

In `app/managed.ts`, add this constant next to `CHANNEL_READY_TIMEOUT_MS`:

```ts
/** How often to re-check managed-channel health after a successful boot. */
const CHANNEL_WATCHDOG_INTERVAL_MS = 60_000;
```

Declare the handle above `server.listen` so `shutdown` can reach it — put this line immediately after `const server = createServer(listener);`:

```ts
  let watchdog: NodeJS.Timeout | undefined;
```

Then, inside the `server.listen` callback, immediately after the `(channel live)` `console.log` from Task 1:

```ts
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
```

- [ ] **Step 6: Stop the watchdog on shutdown**

In the `shutdown` function in `app/managed.ts`, insert as the first statement after the `received ${signal}` log:

```ts
    if (watchdog) clearInterval(watchdog);
```

- [ ] **Step 7: Verify**

Run: `pnpm check-types && pnpm test`
Expected: 0 type errors; 133 tests pass.

- [ ] **Step 8: Commit**

```bash
git add app/managed.ts app/managed.test.ts
git commit -m "fix(channel): watch managed-channel health after boot, exit on a dead session"
```

---

### Task 3: Make server shutdown and error reporting honest

Two small lifecycle defects. `server.close()` at `app/managed.ts:319` is not awaited before `process.exit`, so shutdown races the close. And the `server.on("error")` handler at line 277 labels *every* server error `"HTTP listener failed to bind"` — including the `ERR_SERVER_NOT_RUNNING` that `close()` raises if a signal arrives before `listen` resolves, which then exits 1 on a shutdown that was going fine. Passing a callback to `close()` routes that error to the callback instead of the `error` event, which fixes the second problem as a side effect of fixing the first.

**Files:**
- Modify: `app/managed.ts` (add `closeServer`; set a `listening` flag; use `await closeServer(server)` in `shutdown`)
- Test: `app/managed.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export function closeServer(server: { close(cb: (err?: Error) => void): unknown }): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Append to `app/managed.test.ts`. Add `closeServer` to the import block.

```ts
describe("closeServer", () => {
  it("resolves once the server reports closed", async () => {
    let closed = false;
    await closeServer({
      close(cb) {
        closed = true;
        cb();
      },
    });
    expect(closed).toBe(true);
  });

  it("resolves even when the server was never listening", async () => {
    // node calls back with ERR_SERVER_NOT_RUNNING when close() is called on a
    // server that never bound — e.g. SIGTERM arriving during startup. Shutdown
    // must not stall or throw on that.
    await expect(
      closeServer({
        close(cb) {
          cb(Object.assign(new Error("not running"), { code: "ERR_SERVER_NOT_RUNNING" }));
        },
      }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run app/managed.test.ts -t closeServer`
Expected: FAIL — `closeServer` is not exported from `./managed.js`.

- [ ] **Step 3: Add the helper**

In `app/managed.ts`, directly after `channelWatchdogTick`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run app/managed.test.ts -t closeServer`
Expected: PASS, 2 tests.

- [ ] **Step 5: Use it, and fix the error label**

In `app/managed.ts`, replace the `server.on("error", …)` block with:

```ts
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
```

Set the flag as the first statement inside the `server.listen` callback:

```ts
  server.listen(port, async () => {
    listening = true;
```

And in `shutdown`, replace the bare `server.close();` with:

```ts
    await closeServer(server);
```

- [ ] **Step 6: Verify**

Run: `pnpm check-types && pnpm test`
Expected: 0 type errors; 135 tests pass.

- [ ] **Step 7: Commit**

```bash
git add app/managed.ts app/managed.test.ts
git commit -m "fix(channel): await server close on shutdown, stop mislabeling post-bind errors"
```

---

### Task 4: Close the gap in the interactive-component guard

`app/managed.test.ts` scans `app/**/*.tsx` for `onClick` and fails if a component isn't in `MANAGED_COMPONENTS`. Its declaration regex is `^export function (\w+)\(`, so `export const Foo = (...) => …` — a style already used elsewhere in the very files it scans (`fileIssueSubmit`, `showIncidentTool`, `showStatusTool`, `showLinksTool`) — slips through entirely. A future interactive card written as an arrow function would silently dead-letter its clicks, which is exactly what the guard exists to prevent. The scan also uses `new URL(".", import.meta.url).pathname`, which yields a percent-encoded path on any directory containing a space.

The fix extracts the scan into a helper so it can be tested against fixture source, then widens it.

**Files:**
- Create: `app/__tests__/component-scan.ts` (helper — not collected by vitest, which only picks up `*.test.ts`/`*.test.tsx`)
- Create: `app/__tests__/component-scan.test.ts`
- Modify: `app/managed.test.ts` (the `MANAGED_COMPONENTS` suite)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export function interactiveComponentNames(src: string): string[]` from `app/__tests__/component-scan.js` — the names of every top-level exported declaration in `src` whose body contains an `onClick=` attribute.

- [ ] **Step 1: Write the failing tests**

Create `app/__tests__/component-scan.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { interactiveComponentNames } from "./component-scan.js";

describe("interactiveComponentNames", () => {
  it("finds a component declared with `export function`", () => {
    const src = `
export function ConfirmWrite({ action }: Props) {
  return <Button onClick={async () => {}}>Create</Button>;
}
`;
    expect(interactiveComponentNames(src)).toEqual(["ConfirmWrite"]);
  });

  it("finds a component declared with `export const` and an arrow", () => {
    // THE GAP: the original scan only matched `export function`, so an
    // interactive card written this way was never required to be registered.
    const src = `
export const QuickReply = ({ label }: Props) => (
  <Button onClick={async () => {}}>{label}</Button>
);
`;
    expect(interactiveComponentNames(src)).toEqual(["QuickReply"]);
  });

  it("returns nothing for a file with no onClick", () => {
    const src = `
export function StatusCard({ heading }: Props) {
  return <Section>{heading}</Section>;
}
`;
    expect(interactiveComponentNames(src)).toEqual([]);
  });

  it("attributes an onClick to its own declaration, not a later sibling", () => {
    const src = `
export function IncidentCard({ id }: Props) {
  return <Button onClick={async () => {}}>{id}</Button>;
}

export function StatusCard({ heading }: Props) {
  return <Section>{heading}</Section>;
}
`;
    expect(interactiveComponentNames(src)).toEqual(["IncidentCard"]);
  });

  it("finds every interactive declaration in a file", () => {
    const src = `
export function CardA() {
  return <Button onClick={async () => {}}>a</Button>;
}

export const CardB = () => <Button onClick={async () => {}}>b</Button>;
`;
    expect(interactiveComponentNames(src)).toEqual(["CardA", "CardB"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run app/__tests__/component-scan.test.ts`
Expected: FAIL — `Failed to resolve import "./component-scan.js"`.

- [ ] **Step 3: Write the helper**

Create `app/__tests__/component-scan.ts`:

```ts
/**
 * Source scan backing the `MANAGED_COMPONENTS` guard in `app/managed.test.ts`.
 *
 * A component whose buttons carry an `onClick` must be registered via
 * `createChannel({ components })`, or a click that arrives as a fresh delivery
 * can't be resolved and dead-letters. Deriving the expectation from the source
 * — rather than restating the list — is what makes a NEW interactive card fail
 * the suite instead of failing in production.
 *
 * Matches BOTH declaration styles used in this codebase: `export function Foo(`
 * and `export const Foo = …`. An onClick belongs to the declaration it appears
 * under, i.e. before the next top-level `export`.
 */
const TOP_LEVEL_EXPORT = /^export (?:function|const) (\w+)/gm;

export function interactiveComponentNames(src: string): string[] {
  if (!/\bonClick=/.test(src)) return [];
  const decls = [...src.matchAll(TOP_LEVEL_EXPORT)].map((m) => ({
    name: m[1] as string,
    start: m.index as number,
  }));
  const names: string[] = [];
  for (const [i, decl] of decls.entries()) {
    const end = decls[i + 1]?.start ?? src.length;
    if (/\bonClick=/.test(src.slice(decl.start, end))) names.push(decl.name);
  }
  return names;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run app/__tests__/component-scan.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Rewire the guard in `app/managed.test.ts`**

Replace the whole body of the `it("registers every app component whose buttons carry an onClick", …)` test with:

```ts
  it("registers every app component whose buttons carry an onClick", async () => {
    // Registration is what lets a click resolve across the managed delivery
    // boundary, so derive the expectation from the source instead of restating
    // the list: a NEW interactive card that nobody registers must fail here
    // rather than dead-letter in production.
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { interactiveComponentNames } = await import(
      "./__tests__/component-scan.js"
    );
    // fileURLToPath, not .pathname — the latter stays percent-encoded on any
    // path containing a space.
    const appDir = fileURLToPath(new URL(".", import.meta.url));

    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const out = await Promise.all(
        entries.map(async (e) => {
          const p = join(dir, e.name);
          if (e.isDirectory()) return e.name === "__tests__" ? [] : await walk(p);
          return p.endsWith(".tsx") && !p.includes(".test.") ? [p] : [];
        }),
      );
      return out.flat();
    };

    const interactive = new Set<string>();
    for (const file of await walk(appDir)) {
      for (const name of interactiveComponentNames(await readFile(file, "utf8"))) {
        interactive.add(name);
      }
    }

    expect(interactive.size).toBeGreaterThan(0); // the scan itself still works
    const registered = new Set(MANAGED_COMPONENTS.map((c) => c.name));
    expect([...interactive].filter((n) => !registered.has(n))).toEqual([]);
  });
```

- [ ] **Step 6: Verify the guard still passes against real source**

Run: `pnpm vitest run app/managed.test.ts -t MANAGED_COMPONENTS`
Expected: PASS. It should find exactly `ConfirmWrite` and `IncidentCard` — the only two exported declarations in `app/**/*.tsx` containing an `onClick=`.

- [ ] **Step 7: Verify everything**

Run: `pnpm check-types && pnpm test`
Expected: 0 type errors; 140 tests pass.

- [ ] **Step 8: Commit**

```bash
git add app/__tests__/component-scan.ts app/__tests__/component-scan.test.ts app/managed.test.ts
git commit -m "test(channel): catch arrow-declared interactive components in the registry guard"
```

---

### Task 5: Correct three docstrings and document CHANNEL_HTTP_TOKEN

Three claims in the code are stronger than what the code delivers, and one env var is documented in two places but missing from the third.

1. The `MANAGED_COMPONENTS` docstring presents registration as sufficient for durability. Per `ActionRegistry`, resolution falls back to a durable snapshot in the `ActionStore` — and no `store` is configured, so the default in-process store still loses actions across a restart. Registration is necessary, not sufficient.
2. `identifyUser` returns one static identity. That's correct — `IdentifyUserCallback` takes a `Request`, so it only ever runs on the HTTP surface — but the consequence isn't stated: if a deployer sets `CHANNEL_HTTP_TOKEN`, every bearer holder shares one thread and memory namespace.
3. `CHANNEL_HTTP_TOKEN` appears in `.env.example` and `.railway/railway.ts` but in neither of `setup.md`'s two env tables.

No tests — these are comments and prose. Verification is `pnpm check-types && pnpm test` (nothing should change) plus reading the diff.

**Files:**
- Modify: `app/managed.ts` (the `MANAGED_COMPONENTS` docstring, the `identifyUser` comment)
- Modify: `setup.md` (the Intelligence-mode table ~line 159, the master env table ~line 205)

**Interfaces:** none — no code changes.

- [ ] **Step 1: Correct the `MANAGED_COMPONENTS` docstring**

In `app/managed.ts`, replace the paragraph beginning "On the managed path a click arrives as a FRESH delivery" with:

```
 * On the managed path a click arrives as a FRESH delivery, so the runtime
 * re-renders the component by name to re-derive its handler. Leave a component
 * out and its clicks dead-letter. `ConfirmWrite` is the load-bearing one: it
 * carries the HITL approve/cancel that gates every write, so an unresolvable
 * click silently strands the tool call.
 *
 * Registration is necessary but NOT sufficient for durability across a restart:
 * `ActionRegistry` falls back to a `{ component, props }` snapshot in the
 * `ActionStore`, and this channel declares no `store`, so the default
 * in-process one is lost with the process. Clicks on messages posted before a
 * restart still degrade to "action expired" — configure a durable store to fix
 * that.
```

- [ ] **Step 2: Correct the `identifyUser` comment**

In `app/managed.ts`, replace the comment above `identifyUser:` with:

```ts
    // Per-turn platform user identity for channel messages is resolved by the
    // gateway/Slack adapter and passed to the agent via `senderContext`.
    // `IdentifyUserCallback` takes a `Request`, so this only ever runs on the
    // runtime's own HTTP endpoints — which are closed unless CHANNEL_HTTP_TOKEN
    // is set. Note the consequence if a deployer does open them: a single static
    // identity means every bearer holder shares one thread + memory namespace.
```

- [ ] **Step 3: Document the token in `setup.md`**

In the Intelligence-channel-mode table, add as the last row:

```markdown
| `CHANNEL_HTTP_TOKEN` | Optional. The channel host's HTTP routes (`agent/run`, `threads/*`, `memories/*`) are **closed** (404) unless this is set; set it to open them behind `Authorization: Bearer <token>`. The managed channel activates over the gateway WebSocket and does not need them. |
```

And in the master env table further down, add after the `INTELLIGENCE_*` row:

```markdown
| `CHANNEL_HTTP_TOKEN` | Optional. Opens the channel host's HTTP runtime routes behind a bearer token; closed by default. |
```

- [ ] **Step 4: Verify nothing broke**

Run: `pnpm check-types && pnpm test`
Expected: 0 type errors; 140 tests pass (unchanged from Task 4).

- [ ] **Step 5: Commit**

```bash
git add app/managed.ts setup.md
git commit -m "docs(channel): scope the durability + identity claims, document CHANNEL_HTTP_TOKEN"
```

---

### Task 6: Harden the Railway channel build

Two problems with the `build.buildCommand` added for Chromium. It replaces Railpack's install step with a bare `pnpm install`, dropping `--frozen-lockfile` — so a drifted lockfile silently resolves different versions in production than the ones in the reviewed diff. And `--with-deps` shells out to `apt-get` as root inside the build layer, which is both fragile and redundant: every shared library Chromium needs is already enumerated in `RAILPACK_DEPLOY_APT_PACKAGES` for the deploy layer, which is the layer that actually runs the browser.

**Files:**
- Modify: `.railway/railway.ts` (the `channel` service's `build` block, ~lines 89-92)

**Interfaces:** none.

- [ ] **Step 1: Replace the build command**

In `.railway/railway.ts`, replace the `build:` block on the `channel` service with:

```ts
    build: {
      // `--frozen-lockfile` so a drifted pnpm-lock.yaml fails the build instead
      // of silently resolving different versions than the repo was tested with
      // (overriding buildCommand replaces Railpack's own install, which sets it).
      // Chromium is installed explicitly because pnpm 10 does not run the
      // playwright package's postinstall by default. NOT `--with-deps`: that
      // apt-installs into the BUILD layer, which Railpack strips — the runtime
      // libs come from RAILPACK_DEPLOY_APT_PACKAGES below, which is the layer
      // that actually launches the browser.
      buildCommand:
        "pnpm install --frozen-lockfile && npx playwright install chromium",
    },
```

- [ ] **Step 2: Verify the IaC still typechecks**

Run: `pnpm check-types`
Expected: 0 errors. (`tsconfig.json` includes `.railway/**/*.ts`, so this is a real check on this file.)

- [ ] **Step 3: Commit**

```bash
git add .railway/railway.ts
git commit -m "fix(railway): pin the channel build to the lockfile, drop redundant --with-deps"
```

- [ ] **Step 4: Manual deploy verification (operator, not automatable)**

This is the highest-risk unverified path in the PR and there is no unit test that can cover it. Before merge, run:

```bash
railway config apply && railway up --service channel
```

Then confirm in the build and deploy logs, in order:
1. `pnpm install --frozen-lockfile` completes without a lockfile-mismatch error.
2. `npx playwright install chromium` reports the download path under `node_modules/` — this is what proves `PLAYWRIGHT_BROWSERS_PATH=0` is visible at build time. If it reports `~/.cache/ms-playwright`, the browser will be stripped from the deploy image and `render_chart` / `render_diagram` will fail at runtime; move `PLAYWRIGHT_BROWSERS_PATH` into the build environment.
3. The deploy logs `[channel] KiteBot channel "kite-opentag" mounted on :<port> → Intelligence gateway (channel live)` — and, per Task 1, do **not** log the `activation settled but the channel is NOT live` line.

Record the outcome in a PR comment. If step 2 lands in the cache path, that is a follow-up commit on this branch, not a merge blocker for the rest of the plan.

---

### Task 7: Add CI so these checks run on every PR

The repo has no `.github/workflows` at all — `gh pr checks 10` reports nothing. Every "122 passing, 0 type errors" claim on this 38-file migration is a local-only assertion. A two-command workflow is worth more than another review round.

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:** none.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      # No `npx playwright install` here on purpose: every test that would need
      # a headless browser mocks the renderers (see the vi.mock in
      # app/tools/__tests__/render-tools.test.ts), so CI needs no Chromium.
      - run: pnpm install --frozen-lockfile

      - run: pnpm check-types

      - run: pnpm test
```

- [ ] **Step 2: Verify the same commands pass locally first**

Run: `pnpm install --frozen-lockfile && pnpm check-types && pnpm test`
Expected: install succeeds with no lockfile mismatch; 0 type errors; 140 tests pass. If the install fails here, the lockfile is drifted — commit the regenerated `pnpm-lock.yaml` before adding CI, or the first CI run will be red for an unrelated reason.

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run check-types and tests on every PR"
git push
```

- [ ] **Step 4: Confirm the run is green**

Run: `gh pr checks 10 --repo CopilotKit/OpenTag --watch`
Expected: the `check` job passes. If it fails, fix it on this branch — a red CI job introduced by the task that adds CI is not a follow-up.

---

## Out of scope

These were in the review but are pre-existing, already listed in the PR's own "Deferred" section, or belong to another PR. Do **not** fold them in:

- Everything under the PR description's "Deferred — pre-existing" heading (`app/index.ts` partial-creds handling, `confirm-write-tool.tsx` rejection unwrapping, `page-list.tsx` caps, the `render-chart` / `render-diagram` nits, astral-plane `.slice()`, `.env.example` non-blank placeholders, builder pinning across services, the dead `vitest.config.ts` esbuild block, the naming/docs cleanups).
- Everything under "Worth porting from #8" — child-process chart isolation, schema coercions, reaction normalization, `InMemoryAgentRunner`, Teams support.
- The #8-versus-#10 merge decision itself. That is a coordination call, not code.

## Verification summary

| Task | Automated | Manual |
| --- | --- | --- |
| 1 Channel liveness gate | 5 unit tests | — |
| 2 Post-boot watchdog | 6 unit tests | — |
| 3 Server lifecycle | 2 unit tests | — |
| 4 Component-scan guard | 5 unit tests + the real-source guard | — |
| 5 Docstrings + `setup.md` | suite unchanged | read the diff |
| 6 Railway build | `pnpm check-types` | `railway up --service channel`, 3 log assertions |
| 7 CI | the workflow itself | `gh pr checks 10` green |

Final state: 140 tests across 13 files (12 today, plus `app/__tests__/component-scan.test.ts`), 0 type errors, CI green on PR #10, and one operator-run deploy confirming the Chromium path.
