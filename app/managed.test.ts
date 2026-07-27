import { describe, it, expect } from "vitest";
import type { AgentContentPart } from "@copilotkit/channels-ui";
import {
  createKiteChannel,
  promptFromMessage,
  buildAgentHeaders,
  httpAuthGate,
  MANAGED_COMPONENTS,
  unhealthyChannels,
  channelWatchdogTick,
  CHANNEL_DEGRADED_FATAL_MS,
  closeServer,
  onceShutdown,
  uncaughtExceptionAction,
  requireNonBlank,
  requireUrl,
  fatalText,
} from "./managed.js";

describe("createKiteChannel", () => {
  it("defaults the channel name to kite-opentag", () => {
    const ch = createKiteChannel({ agentUrl: "http://localhost:8123/" });
    expect(ch.name).toBe("kite-opentag");
  });

  it("honors a custom channel name", () => {
    const ch = createKiteChannel({
      agentUrl: "http://localhost:8123/",
      channelName: "kite-staging",
    });
    expect(ch.name).toBe("kite-staging");
  });

  it("normalizes an empty channel name to the default", () => {
    // INTELLIGENCE_CHANNEL_NAME="" must not defeat the default the way `??`
    // would (an empty string is not nullish).
    const ch = createKiteChannel({
      agentUrl: "http://localhost:8123/",
      channelName: "",
    });
    expect(ch.name).toBe("kite-opentag");
  });

  it("normalizes a whitespace-only channel name to the default", () => {
    const ch = createKiteChannel({
      agentUrl: "http://localhost:8123/",
      channelName: "   ",
    });
    expect(ch.name).toBe("kite-opentag");
  });

  it("registers the app's slash commands on the channel", () => {
    const ch = createKiteChannel({ agentUrl: "http://localhost:8123/" });
    // createChannel normalizes slash-command names (hyphens -> underscores):
    // app/commands declares "file-issue"; commandNames reports "file_issue".
    expect(ch.commandNames).toContain("file_issue");
  });
});

describe("promptFromMessage", () => {
  it("leads with the instruction when a turn carries both text and attachments", () => {
    // The regression this guards: `contentParts ?? text` drops the instruction,
    // so "chart this" + a CSV reaches the model as a bare data dump and it
    // answers "what would you like me to do?".
    const csv: AgentContentPart = {
      type: "document",
      source: { type: "data", value: "YQ==", mimeType: "text/csv" },
    };
    expect(
      promptFromMessage({ contentParts: [csv], text: "chart this" }),
    ).toEqual([{ type: "text", text: "chart this" }, csv]);
  });

  it("returns attachments alone when the turn has no text", () => {
    const parts: AgentContentPart[] = [
      { type: "image", source: { type: "data", value: "iVB=", mimeType: "image/png" } },
    ];
    expect(promptFromMessage({ contentParts: parts, text: "" })).toBe(parts);
  });

  it("falls back to text when contentParts is empty", () => {
    expect(promptFromMessage({ contentParts: [], text: "hello" })).toBe(
      "hello",
    );
  });

  it("falls back to text when contentParts is absent", () => {
    expect(promptFromMessage({ text: "hello" })).toBe("hello");
  });
});

describe("MANAGED_COMPONENTS", () => {
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
          if (e.isDirectory())
            return e.name === "__tests__" ? [] : await walk(p);
          return p.endsWith(".tsx") && !p.includes(".test.") ? [p] : [];
        }),
      );
      return out.flat();
    };

    const interactive = new Set<string>();
    for (const file of await walk(appDir)) {
      for (const name of interactiveComponentNames(
        await readFile(file, "utf8"),
      )) {
        interactive.add(name);
      }
    }

    expect(interactive.size).toBeGreaterThan(0); // the scan itself still works
    const registered = new Set(MANAGED_COMPONENTS.map((c) => c.name));
    expect([...interactive].filter((n) => !registered.has(n))).toEqual([]);
  });
});

describe("httpAuthGate", () => {
  const req = (auth?: string) =>
    new Request("http://localhost/api/copilotkit/agent/kite/run", {
      headers: auth ? { authorization: auth } : {},
    });

  /** Run the gate and return the Response it threw, or null if it allowed. */
  const run = (token: string | undefined, auth?: string): Response | null => {
    try {
      httpAuthGate(token)({ request: req(auth) });
      return null;
    } catch (thrown) {
      if (thrown instanceof Response) return thrown;
      throw thrown;
    }
  };

  it("closes the surface with 404 when no token is configured", () => {
    // Default posture: agent/run + threads/* + memories/* must not be an open
    // proxy to AGENT_URL just because the port is reachable.
    expect(run(undefined)?.status).toBe(404);
    expect(run(undefined, "Bearer anything")?.status).toBe(404);
  });

  it("treats a blank token as unconfigured", () => {
    expect(run("   ")?.status).toBe(404);
  });

  it("rejects a missing or wrong bearer when a token is configured", () => {
    expect(run("s3cret")?.status).toBe(401);
    expect(run("s3cret", "Bearer wrong")?.status).toBe(401);
    expect(run("s3cret", "s3cret")?.status).toBe(401);
  });

  it("allows the matching bearer", () => {
    expect(run("s3cret", "Bearer s3cret")).toBeNull();
  });
});

describe("requireNonBlank", () => {
  it("rejects an undefined value", () => {
    expect(() => requireNonBlank("AGENT_URL", undefined)).toThrow(
      "Missing required env var: AGENT_URL",
    );
  });

  it("rejects an empty string", () => {
    expect(() => requireNonBlank("AGENT_URL", "")).toThrow(
      "Missing required env var: AGENT_URL",
    );
  });

  it("rejects a whitespace-only value", () => {
    // THE REGRESSION: `!v` alone lets "   " through — trivially pasted into
    // the Railway UI — so AGENT_URL="   " used to boot green and then fail
    // every single turn inside onMention instead of failing at boot.
    expect(() => requireNonBlank("AGENT_URL", "   ")).toThrow(
      "Missing required env var: AGENT_URL",
    );
  });

  it("trims and returns a valid value", () => {
    expect(requireNonBlank("AGENT_URL", "  http://localhost:8123/  ")).toBe(
      "http://localhost:8123/",
    );
  });
});

describe("requireUrl", () => {
  it("rejects a value that does not parse as a URL", () => {
    // AGENT_URL was never validated as a URL, so "not-a-url" used to boot just
    // as green as a correct value and only fail later, deep inside
    // SanitizingHttpAgent, on the first turn.
    expect(() => requireUrl("AGENT_URL", "not-a-url")).toThrow(
      'AGENT_URL is not a valid URL: "not-a-url"',
    );
  });

  it("returns the value unchanged when it parses as a URL", () => {
    expect(requireUrl("AGENT_URL", "http://localhost:8123/")).toBe(
      "http://localhost:8123/",
    );
  });
});

describe("buildAgentHeaders", () => {
  it("returns undefined when no auth header is given", () => {
    expect(buildAgentHeaders(undefined)).toBeUndefined();
  });

  it("wraps the auth header value in an Authorization object", () => {
    expect(buildAgentHeaders("Bearer abc123")).toEqual({
      Authorization: "Bearer abc123",
    });
  });

  it("treats a whitespace-only header as absent", () => {
    // THE REGRESSION: `authHeader ? ... : undefined` treats "   " as truthy,
    // so buildAgentHeaders used to ship `{ Authorization: "   " }` on every
    // agent request.
    expect(buildAgentHeaders("   ")).toBeUndefined();
  });

  it("trims surrounding whitespace from a real header value", () => {
    expect(buildAgentHeaders("  Bearer abc123  ")).toEqual({
      Authorization: "Bearer abc123",
    });
  });
});

describe("unhealthyChannels", () => {
  it("reports nothing when there is no control surface", () => {
    // Defensive purity only — NOT a success signal. `main()` resolves
    // `listener.channels` up front and exits 1 when it is absent, precisely so
    // a host with no channel can never reach the "(channel live)" log. This
    // helper stays total for an undefined input (it is also fed the watchdog's
    // polled status) rather than making a liveness claim of its own.
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

  it("reports overall=connecting when activation hasn't produced any channel entries yet", () => {
    // THE REGRESSION: per the installed ChannelManager.status(), before
    // activation completes status() returns { overall: "connecting", channels:
    // {} } — an EMPTY map. Filtering only `channels` finds nothing to filter
    // and used to return [], so the boot gate logged "(channel live)" for a
    // channel that never activated.
    expect(
      unhealthyChannels({ overall: "connecting", channels: {} }),
    ).toEqual(["overall=connecting"]);
  });

  it("reports overall=stopped once every managed channel has been torn down", () => {
    expect(unhealthyChannels({ overall: "stopped", channels: {} })).toEqual([
      "overall=stopped",
    ]);
  });

  it("reports nothing when overall is online and there are no declared channels", () => {
    // Per ChannelManager.status(): with no declared channels at all, overall
    // is "online" (nothing is degraded) — this must not be mistaken for the
    // connecting/stopped false-success case above.
    expect(unhealthyChannels({ overall: "online", channels: {} })).toEqual([]);
  });
});

describe("channelWatchdogTick", () => {
  const health = (overall: string) => ({
    overall,
    channels: { "kite-opentag": overall },
  });

  it("is quiet when there is no control surface", () => {
    expect(channelWatchdogTick(undefined, "online", 0)).toEqual({
      kind: "quiet",
    });
  });

  it("is quiet while the channel stays online", () => {
    expect(channelWatchdogTick(health("online"), "online", 0)).toEqual({
      kind: "quiet",
    });
  });

  it("is fatal once the channel gives up reconnecting", () => {
    // `error` here means the session exhausted its bounded reconnect window.
    // Exiting is what lets Railway's ON_FAILURE policy restart the host.
    expect(channelWatchdogTick(health("error"), "online", 0)).toEqual({
      kind: "fatal",
      message: "channel is dead: kite-opentag=error",
    });
  });

  it("notices the first tick of a degraded state", () => {
    expect(channelWatchdogTick(health("reconnecting"), "online", 0)).toEqual({
      kind: "notice",
      message: "channel degraded: kite-opentag=reconnecting",
    });
  });

  it("does not repeat a degraded state it already reported", () => {
    // A drop that takes minutes to resolve must not emit one line per tick.
    expect(
      channelWatchdogTick(health("reconnecting"), "reconnecting", 0),
    ).toEqual({ kind: "quiet" });
  });

  it("notices recovery back to online", () => {
    expect(channelWatchdogTick(health("online"), "reconnecting", 0)).toEqual({
      kind: "notice",
      message: "channel recovered: overall=online",
    });
  });

  describe("Finding 2: escalation after CHANNEL_DEGRADED_FATAL_MS", () => {
    it("stays quiet just below the threshold, even on an already-reported degraded state", () => {
      // Regression this guards: a channel wedged in `reconnecting` used to
      // notice once and then stay quiet FOREVER — `overall === previousOverall`
      // suppressed every later tick. Confirm sub-threshold ticks are still
      // quiet (not yet fatal), not that the old silent-forever bug is back.
      expect(
        channelWatchdogTick(
          health("reconnecting"),
          "reconnecting",
          CHANNEL_DEGRADED_FATAL_MS - 1,
        ),
      ).toEqual({ kind: "quiet" });
    });

    it("stays a notice, not fatal, on the FIRST degraded tick even if degradedForMs is (implausibly) already high", () => {
      // The duration check only matters once the state has actually been
      // observed as non-online more than once; a first-tick transition still
      // reports as a plain "degraded" notice via the general branch below —
      // this only holds while degradedForMs stays under threshold.
      expect(
        channelWatchdogTick(health("reconnecting"), "online", 1_000),
      ).toEqual({
        kind: "notice",
        message: "channel degraded: kite-opentag=reconnecting",
      });
    });

    it("escalates to fatal the instant degradedForMs reaches the threshold", () => {
      expect(
        channelWatchdogTick(
          health("reconnecting"),
          "reconnecting",
          CHANNEL_DEGRADED_FATAL_MS,
        ),
      ).toEqual({
        kind: "fatal",
        message: `channel has been non-online for >= ${CHANNEL_DEGRADED_FATAL_MS / 60_000}m: kite-opentag=reconnecting`,
      });
    });

    it("stays fatal well past the threshold", () => {
      expect(
        channelWatchdogTick(
          health("reconnecting"),
          "reconnecting",
          CHANNEL_DEGRADED_FATAL_MS + 60_000,
        ),
      ).toEqual({
        kind: "fatal",
        message: `channel has been non-online for >= ${CHANNEL_DEGRADED_FATAL_MS / 60_000}m: kite-opentag=reconnecting`,
      });
    });

    it("escalates even when the degraded state was already reported (not suppressed by the quiet-repeat rule)", () => {
      // The duration check must run BEFORE the "already reported" early
      // return, or a channel that already got its one notice would stay
      // quiet forever instead of ever escalating.
      expect(
        channelWatchdogTick(
          health("reconnecting"),
          "reconnecting",
          CHANNEL_DEGRADED_FATAL_MS + 1,
        ).kind,
      ).toBe("fatal");
    });

    it("never escalates while online, no matter how large a stale degradedForMs is passed in", () => {
      // Models recovery resetting the clock: main() zeroes degradedSince the
      // moment overall goes back to "online", so a later degradation starts
      // counting from zero again. The pure function itself also refuses to
      // go fatal while online, as a defensive backstop.
      expect(
        channelWatchdogTick(
          health("online"),
          "reconnecting",
          CHANNEL_DEGRADED_FATAL_MS + 1_000_000,
        ),
      ).toEqual({
        kind: "notice",
        message: "channel recovered: overall=online",
      });
    });
  });
});

describe("closeServer", () => {
  it("does not resolve until the server reports closed", async () => {
    // Categorical, not a microtask race: after a full macrotask turn, a correct
    // implementation is still pending because the close callback has not fired.
    // (A Promise.race against a sentinel only catches a synchronously-resolved
    // mutant — one resolving a few microtasks late would still win.)
    let finish: (() => void) | undefined;
    let settled = false;
    const pending = closeServer({
      close(cb) {
        finish = () => cb();
      },
    });
    void pending.then(() => {
      settled = true;
    });
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);
    finish?.();
    await expect(pending).resolves.toBeUndefined();
  });

  it("force-closes in-flight connections only after close() is initiated", () => {
    // Order is the invariant: closeAllConnections() must come AFTER close(), so
    // no new connection is accepted in the gap. A boolean flag cannot catch a
    // swap of the two lines — a call log can.
    const calls: string[] = [];
    void closeServer({
      close(cb) {
        calls.push("close");
        cb();
      },
      closeAllConnections() {
        calls.push("closeAllConnections");
      },
    });
    expect(calls).toEqual(["close", "closeAllConnections"]);
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

describe("onceShutdown", () => {
  it("runs the shutdown routine once across repeated signals", async () => {
    const signals: string[] = [];
    // Recorded instead of thrown: `onError` runs inside `.catch(...)` on a
    // promise nobody awaits, so a throw in here would surface (if at all) as
    // an out-of-band unhandled rejection, never as a failure of THIS `it()`.
    // Asserting on the array is the only way this block can actually fail.
    const errors: Array<{ signal: string; err: unknown }> = [];
    let release: (() => void) | undefined;
    const run = onceShutdown(
      (signal) => {
        signals.push(signal);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      (signal, err) => {
        errors.push({ signal, err });
      },
    );

    // SIGTERM from the platform, then an impatient Ctrl-C while the first run
    // is still awaiting its teardown steps.
    run("SIGTERM");
    run("SIGINT");
    run("SIGINT");
    expect(signals).toEqual(["SIGTERM"]);

    release?.();
    // A single microtask tick is NOT enough to settle the memoized promise
    // through its `.catch` reaction — a real macrotask boundary is required,
    // otherwise a "resets on settle" mutant (e.g.
    // `.finally(() => { inFlight = undefined })`) would let a signal arriving
    // here start a second run and this test would still pass.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Signals arriving AFTER the run settled must still not start a second one:
    // the first run owns the process exit.
    run("SIGTERM");
    expect(signals).toEqual(["SIGTERM"]);
    expect(errors).toEqual([]);
  });

  it("reports a rejecting shutdown once, for the signal that started it", async () => {
    const boom = new Error("teardown blew up");
    const errors: Array<{ signal: string; err: unknown }> = [];
    const run = onceShutdown(
      () => Promise.reject(boom),
      (signal, err) => errors.push({ signal, err }),
    );

    run("SIGTERM");
    run("SIGINT");
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toEqual([{ signal: "SIGTERM", err: boom }]);
  });

  it("does not surface the shutdown rejection as an unhandled rejection", async () => {
    // The memoized promise is handed to every later caller, so the catch has to
    // live INSIDE the memo — otherwise a rejecting shutdown escapes.
    //
    // `expect(...).not.toThrow()` alone is trivially true for any
    // void-returning synchronous function and cannot detect an unhandled
    // rejection at all — that failure mode is invisible to the channel this
    // `it()` observes. Install a real `process.on("unhandledRejection")` spy
    // for the test's duration and assert it never fired.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const run = onceShutdown(
        () => Promise.reject(new Error("teardown blew up")),
        () => {},
      );
      expect(() => run("SIGTERM")).not.toThrow();
      // Node only fires `unhandledRejection` after the rejection survives to
      // the end of the current macrotask with no handler attached — a real
      // timer boundary is required to give it that chance.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  describe("Finding 3: exitCode passthrough for a non-signal fatal caller", () => {
    it("passes the exit code through to the run function for the signal that starts the run", () => {
      // Models the watchdog's fatal path calling `runShutdown("watchdog", 1)`
      // instead of `process.exit(1)` directly — the exit code has to reach
      // the same `shutdown()` the SIGINT/SIGTERM handlers use.
      const calls: Array<{ signal: string; exitCode: number | undefined }> =
        [];
      const run = onceShutdown(
        (signal, exitCode) => {
          calls.push({ signal, exitCode });
          return Promise.resolve();
        },
        () => {
          throw new Error("onError must not fire on a clean run");
        },
      );

      run("watchdog", 1);
      expect(calls).toEqual([{ signal: "watchdog", exitCode: 1 }]);
    });

    it("defaults to no explicit exit code for a plain signal (SIGINT/SIGTERM never pass one)", () => {
      const calls: Array<number | undefined> = [];
      const run = onceShutdown(
        (_signal, exitCode) => {
          calls.push(exitCode);
          return Promise.resolve();
        },
        () => {},
      );

      run("SIGTERM");
      expect(calls).toEqual([undefined]);
    });

    it("ignores a later call's exit code once a run is already in flight", () => {
      // Memoization covers exitCode too, not just signal: whichever call
      // started the run owns both.
      let release: (() => void) | undefined;
      const calls: Array<{ signal: string; exitCode: number | undefined }> =
        [];
      const run = onceShutdown(
        (signal, exitCode) => {
          calls.push({ signal, exitCode });
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
        () => {},
      );

      run("SIGTERM"); // starts the run with no explicit exit code
      run("watchdog", 1); // arrives while the first run is still in flight
      expect(calls).toEqual([{ signal: "SIGTERM", exitCode: undefined }]);
      release?.();
    });
  });
});

describe("uncaughtExceptionAction (Finding 1)", () => {
  it("treats an exception during an in-flight graceful shutdown as non-preempting", () => {
    // THE REGRESSION this guards against being reintroduced: an exception
    // raised while `shutdown()` is already tearing down must not race a
    // second exit against the one already in progress.
    expect(uncaughtExceptionAction(true)).toEqual({
      kind: "continue-shutdown",
    });
  });

  it("treats an exception outside of shutdown as fatal", () => {
    // THE REGRESSION: the old handler logged EVERY uncaught exception and
    // kept running — a throw inside the watchdog's setInterval callback, a
    // corrupted post-activation state, an assertion deep in the transport —
    // leaving the process alive in an undefined state with its socket still
    // bound, so the platform's restart policy never fired.
    expect(uncaughtExceptionAction(false)).toEqual({ kind: "fatal" });
  });
});

describe("fatalText (Finding 5)", () => {
  it("returns the message unchanged when there is no error", () => {
    expect(fatalText("[channel] boom")).toBe("[channel] boom");
  });

  it("appends the error detail when one is given", () => {
    const err = new Error("teardown blew up");
    const text = fatalText("[channel] boom", err);
    expect(text).toContain("[channel] boom");
    expect(text).toContain("teardown blew up");
  });

  it("formats a non-Error thrown value too", () => {
    const text = fatalText("[channel] boom", "a plain string reason");
    expect(text).toContain("[channel] boom");
    expect(text).toContain("a plain string reason");
  });
});

describe("module import safety", () => {
  it("does not register process-global exception handlers merely by importing the module", async () => {
    // THE REGRESSION: process.on("unhandledRejection"/"uncaughtException")
    // used to be registered at module scope, so importing this module for its
    // pure helpers (as every test in this file does) installed global
    // exception handlers into the vitest worker process. Both must now live
    // behind the entry-point guard, so importing the module — even a fresh,
    // uncached copy of it — must be a no-op on `process`'s listener counts.
    const before = {
      unhandled: process.listenerCount("unhandledRejection"),
      uncaught: process.listenerCount("uncaughtException"),
    };
    // A query-suffixed specifier forces Vitest's Vite-backed loader to
    // evaluate a fresh copy of the module (bypassing the module cache used by
    // the static import at the top of this file), so this exercises the
    // module's top-level code again rather than reusing the already-imported
    // instance.
    await import(/* @vite-ignore */ `./managed.js?import-safety-check=${Date.now()}`);
    const after = {
      unhandled: process.listenerCount("unhandledRejection"),
      uncaught: process.listenerCount("uncaughtException"),
    };
    expect(after).toEqual(before);
  });
});
