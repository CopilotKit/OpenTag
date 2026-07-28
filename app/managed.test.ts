import { describe, it, expect } from "vitest";
import type { AgentContentPart } from "@copilotkit/channels-ui";
import {
  createKiteChannel,
  promptFromMessage,
  buildAgentHeaders,
  httpAuthGate,
  MANAGED_COMPONENTS,
  isChannelLive,
  unhealthyChannels,
  notLiveMessage,
  channelWatchdogTick,
  CHANNEL_DEGRADED_FATAL_MS,
  nextDegradedSince,
  closeServer,
  onceShutdown,
  uncaughtExceptionAction,
  unhandledRejectionAction,
  guardedWrite,
  requireNonBlank,
  requireUrl,
  fatalText,
  type ChannelHealth,
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

  it("treats whitespace-only text as absent, not as an instruction to prepend", () => {
    // THE REGRESSION: `message.text ? [...] : parts` checked raw truthiness,
    // and "   " is truthy — so a whitespace-only `text` used to get prepended
    // as a blank leading text part alongside the real attachments. This file
    // trims everywhere else a truthy-blank check would let "   " through
    // (requireNonBlank, buildAgentHeaders, httpAuthGate, channelName); this
    // was the one un-trimmed path.
    const parts: AgentContentPart[] = [
      { type: "image", source: { type: "data", value: "iVB=", mimeType: "image/png" } },
    ];
    expect(promptFromMessage({ contentParts: parts, text: "   " })).toBe(
      parts,
    );
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
        file,
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

  describe("scheme-less and non-HTTP values", () => {
    // Bare `new URL()` accepts anything with a colon, folding whatever
    // precedes it into `protocol` — so a missing scheme (the single most
    // likely paste error) or a non-HTTP scheme both used to "pass" this
    // validator and only fail on the first live turn.
    it("rejects a scheme-less host:port (the literal shape of a Railway private hostname)", () => {
      // new URL("localhost:8123").protocol === "localhost:" — parses
      // "successfully" with the host folded into the protocol.
      expect(() => requireUrl("AGENT_URL", "localhost:8123")).toThrow(
        /http:\/\/ or https:\/\//,
      );
    });

    it("rejects agent:8123 — the literal shape of a Railway private hostname missing its scheme", () => {
      expect(() => requireUrl("AGENT_URL", "agent:8123")).toThrow(
        /http:\/\/ or https:\/\//,
      );
    });

    it("rejects a non-HTTP scheme like ftp://", () => {
      expect(() => requireUrl("AGENT_URL", "ftp://x")).toThrow(
        /http:\/\/ or https:\/\//,
      );
    });

    it("still rejects a value with no colon at all", () => {
      expect(() => requireUrl("AGENT_URL", "not-a-url")).toThrow(
        'AGENT_URL is not a valid URL: "not-a-url"',
      );
    });

    it("accepts http:// and https://", () => {
      expect(requireUrl("AGENT_URL", "http://x")).toBe("http://x");
      expect(requireUrl("AGENT_URL", "https://x")).toBe("https://x");
    });
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

describe("isChannelLive (the single definition of liveness)", () => {
  it("is false when there is no control surface", () => {
    expect(isChannelLive(undefined, "kite-opentag")).toBe(false);
  });

  it("is true when the declared channel is present and online", () => {
    expect(
      isChannelLive(
        { overall: "online", channels: { "kite-opentag": "online" } },
        "kite-opentag",
      ),
    ).toBe(true);
  });

  it("is false when the declared channel is present but not online", () => {
    expect(
      isChannelLive(
        { overall: "setup_required", channels: { "kite-opentag": "setup_required" } },
        "kite-opentag",
      ),
    ).toBe(false);
  });

  it("is false when the declared channel is absent, even if overall reports online", () => {
    // THE CRITICAL DISAGREEMENT (Finding 1): `ChannelManager.computeOverall`
    // returns "online" for a ZERO-length input, so `{ overall: "online",
    // channels: {} }` is a shape the manager genuinely produces — not only
    // for a host with no declared channels, but for THIS host's own declared
    // channel silently missing from `entries` after activation. `overall`
    // alone says "online"; this predicate must say "not live."
    expect(isChannelLive({ overall: "online", channels: {} }, "kite-opentag")).toBe(
      false,
    );
  });

  it("is false when a different channel is online but the declared one is absent", () => {
    expect(
      isChannelLive(
        { overall: "online", channels: { "some-other-channel": "online" } },
        "kite-opentag",
      ),
    ).toBe(false);
  });
});

describe("unhealthyChannels", () => {
  it("reports nothing when there is no control surface", () => {
    // Defensive purity only — NOT a success signal. `main()` resolves
    // `listener.channels` up front and exits 1 when it is absent, precisely so
    // a host with no channel can never reach the "(channel live)" log. This
    // helper stays total for an undefined input (it is also fed the watchdog's
    // polled status) rather than making a liveness claim of its own.
    expect(unhealthyChannels(undefined, "kite-opentag")).toEqual([]);
  });

  it("reports nothing when every channel is online", () => {
    expect(
      unhealthyChannels(
        {
          overall: "online",
          channels: { "kite-opentag": "online" },
        },
        "kite-opentag",
      ),
    ).toEqual([]);
  });

  it("reports a channel that settled to setup_required", () => {
    // THE REGRESSION: ready() RESOLVES on setup_required, so this is the state
    // that used to print "(channel live)" for a channel with no Slack
    // connector bound — the most likely first-run state for a deployer.
    expect(
      unhealthyChannels(
        {
          overall: "setup_required",
          channels: { "kite-opentag": "setup_required" },
        },
        "kite-opentag",
      ),
    ).toEqual(["kite-opentag=setup_required"]);
  });

  it("reports a channel the handler does not own", () => {
    // `unmanaged` means a direct adapter is attached; ready() resolves for it
    // immediately and implies NO health.
    expect(
      unhealthyChannels(
        {
          overall: "unmanaged",
          channels: { "kite-opentag": "unmanaged" },
        },
        "kite-opentag",
      ),
    ).toEqual(["kite-opentag=unmanaged"]);
  });

  it("reports only the channels that are not online", () => {
    expect(
      unhealthyChannels(
        {
          overall: "setup_required",
          channels: { a: "online", b: "setup_required", c: "reconnecting" },
        },
        "a",
      ),
    ).toEqual(["b=setup_required", "c=reconnecting"]);
  });

  it("reports the declared channel as absent (naming overall, not contradicting it) when activation hasn't produced any channel entries yet", () => {
    // THE REGRESSION: per the installed ChannelManager.status(), before
    // activation completes status() returns { overall: "connecting", channels:
    // {} } — an EMPTY map. Filtering only `channels` finds nothing to filter
    // and used to return [], so the boot gate logged "(channel live)" for a
    // channel that never activated. Also Finding 3: the OLD fold-in reported
    // this as the self-contradicting `overall=connecting` string with no
    // channel name in it at all; report the declared channel by name instead.
    expect(
      unhealthyChannels({ overall: "connecting", channels: {} }, "kite-opentag"),
    ).toEqual(["kite-opentag=absent (overall=connecting)"]);
  });

  it("reports the stopped channel by name once every managed channel has been torn down", () => {
    // THE REAL SHAPE: `stop()` does NOT clear `entries` — it only flips each
    // entry's own `status` to "stopped" (confirmed in the installed
    // channel-manager.mjs: `stopEntry` sets `entry.status = "stopped"`, and
    // `status()` builds `channels` from `entries` in every branch, including
    // the `this.stopped` one). So the post-stop map is non-empty and already
    // reads `{ "kite-opentag": "stopped" }` — `{ channels: {} }` is a shape
    // the manager cannot actually produce after stop(). This is the ordinary
    // "present but non-online" branch, not the "absent" one.
    expect(
      unhealthyChannels(
        { overall: "stopped", channels: { "kite-opentag": "stopped" } },
        "kite-opentag",
      ),
    ).toEqual(["kite-opentag=stopped"]);
  });

  it("does NOT report healthy when overall is online but the declared channel is absent from the map", () => {
    // THE BUG THIS GUARDS (Finding 1): `ChannelManager.computeOverall` returns
    // "online" for a ZERO-length input (confirmed in the installed
    // channel-manager.mjs: `if (values.length === 0) return "online"`), so `{
    // overall: "online", channels: {} }` is a shape the manager can genuinely
    // produce — not just for a host with no declared channels, but for the
    // pathological case of THIS host's own declared channel silently missing
    // from the manager's entries after activation. The old implementation
    // inferred health from the absence of bad entries and returned `[]` here
    // — the exact false-alive state the boot gate exists to kill.
    //
    // Finding 3: the message also must not contradict itself. The OLD
    // implementation printed the literal, self-contradicting
    // "overall=online" for this exact case ("NOT live: overall=online").
    // Name the channel and its real condition instead.
    expect(
      unhealthyChannels({ overall: "online", channels: {} }, "kite-opentag"),
    ).toEqual(["kite-opentag=absent (overall=online)"]);
  });

  it("does not report healthy when a different channel is online but the declared one is missing", () => {
    // Same hazard as above, but with an unrelated channel present: seeing
    // *some* online entry in the map must not be mistaken for the specific
    // declared channel being healthy.
    expect(
      unhealthyChannels(
        { overall: "online", channels: { "some-other-channel": "online" } },
        "kite-opentag",
      ),
    ).toEqual(["kite-opentag=absent (overall=online)"]);
  });

  it("surfaces the declared channel's absence even when every present per-channel entry reads online", () => {
    // The declared-channel check is now unconditional, not a fallback that
    // only fires when the per-channel filter over every OTHER entry finds
    // nothing — so a degraded `overall` (not just "online") sitting alongside
    // an all-clear-looking map for OTHER channels still surfaces the declared
    // channel's own absence.
    expect(
      unhealthyChannels(
        { overall: "setup_required", channels: { "some-other-channel": "online" } },
        "kite-opentag",
      ),
    ).toEqual(["kite-opentag=absent (overall=setup_required)"]);
  });

  it("surfaces the declared channel's absence AND another channel's bad status together, not one shadowing the other", () => {
    // THE BUG THIS GUARDS (Finding 3, "the buried fact"): with the OLD
    // implementation, a non-empty per-channel filter result short-circuited
    // before the by-name presence check ever ran — so if the map is `{
    // "some-other-channel": "reconnecting" }` and the declared channel is
    // absent entirely, only "some-other-channel=reconnecting" was reported.
    // The more serious fact — THIS host's own channel is missing — was never
    // surfaced. The by-name check must be unconditional, and the declared
    // channel's own absence must lead, not follow.
    expect(
      unhealthyChannels(
        { overall: "reconnecting", channels: { "some-other-channel": "reconnecting" } },
        "kite-opentag",
      ),
    ).toEqual([
      "kite-opentag=absent (overall=reconnecting)",
      "some-other-channel=reconnecting",
    ]);
  });
});

describe("notLiveMessage", () => {
  it("appends the setup_required remediation only when the declared channel's own status is setup_required", () => {
    expect(
      notLiveMessage(
        {
          overall: "setup_required",
          channels: { "kite-opentag": "setup_required" },
        },
        "kite-opentag",
      ),
    ).toBe(
      'activation settled but the channel is NOT live: kite-opentag=setup_required. "setup_required" means the channel name exists in your Intelligence project but no platform connector is bound to it — finish the connector setup in the Intelligence dashboard, then redeploy this service.',
    );
  });

  it("omits the setup_required remediation for the absent-from-entries false-alive shape", () => {
    // THE BUG THIS GUARDS (Finding 3): the OLD message unconditionally told
    // every operator to "finish the connector setup in the Intelligence
    // dashboard" — including for `{ overall: "online", channels: {} }`, where
    // that advice is not just unhelpful but wrong: there is no connector step
    // to finish, the channel's entry never got created at all.
    expect(
      notLiveMessage({ overall: "online", channels: {} }, "kite-opentag"),
    ).toBe(
      "activation settled but the channel is NOT live: kite-opentag=absent (overall=online).",
    );
  });

  it("omits the setup_required remediation for a stopped channel", () => {
    expect(
      notLiveMessage(
        { overall: "stopped", channels: { "kite-opentag": "stopped" } },
        "kite-opentag",
      ),
    ).toBe("activation settled but the channel is NOT live: kite-opentag=stopped.");
  });
});

describe("channelWatchdogTick", () => {
  // `previousLive` is now a boolean — the watchdog's dedup key is keyed on
  // the SAME shared `isChannelLive` predicate as the boot gate and
  // `nextDegradedSince`, not on raw `overall` (Finding 1).
  const health = (overall: ChannelHealth["overall"]): ChannelHealth => ({
    overall,
    channels: { "kite-opentag": overall },
  });

  it("is quiet when there is no control surface and degradedForMs is still low", () => {
    expect(channelWatchdogTick(undefined, true, 0, "kite-opentag")).toEqual({
      kind: "quiet",
    });
  });

  it("is quiet while the channel stays online", () => {
    expect(
      channelWatchdogTick(health("online"), true, 0, "kite-opentag"),
    ).toEqual({
      kind: "quiet",
    });
  });

  it("is fatal once the channel gives up reconnecting", () => {
    // `error` here means the session exhausted its bounded reconnect window.
    // Exiting is what lets Railway's ON_FAILURE policy restart the host.
    expect(
      channelWatchdogTick(health("error"), true, 0, "kite-opentag"),
    ).toEqual({
      kind: "fatal",
      message: "channel is dead: kite-opentag=error",
    });
  });

  it("notices the first tick of a degraded state", () => {
    expect(
      channelWatchdogTick(health("reconnecting"), true, 0, "kite-opentag"),
    ).toEqual({
      kind: "notice",
      message: "channel degraded: kite-opentag=reconnecting",
    });
  });

  it("does not repeat a degraded state it already reported", () => {
    // A drop that takes minutes to resolve must not emit one line per tick.
    expect(
      channelWatchdogTick(health("reconnecting"), false, 0, "kite-opentag"),
    ).toEqual({ kind: "quiet" });
  });

  it("notices recovery back to online", () => {
    expect(
      channelWatchdogTick(health("online"), false, 0, "kite-opentag"),
    ).toEqual({
      kind: "notice",
      message: "channel recovered: overall=online",
    });
  });

  describe("Finding 1: keyed on isChannelLive, not on raw overall", () => {
    it("treats { overall: online, channels: {} } as degraded, not quiet — the false-alive shape the boot gate was hardened to catch", () => {
      // THE BUG THIS GUARDS: the OLD implementation branched solely on
      // `health.overall`, so this exact shape — which `ChannelManager.
      // computeOverall` genuinely returns for a zero-length input, and which
      // is what THIS host's own declared channel silently missing from
      // `entries` looks like — read as `overall === "online"` forever:
      // `{ kind: "quiet" }` on every tick, no matter how long it persisted.
      const falseAlive: ChannelHealth = { overall: "online", channels: {} };
      expect(
        channelWatchdogTick(falseAlive, true, 0, "kite-opentag"),
      ).toEqual({
        kind: "notice",
        message: "channel degraded: kite-opentag=absent (overall=online)",
      });
    });

    it("escalates the false-alive shape to fatal once degradedForMs crosses the threshold", () => {
      const falseAlive: ChannelHealth = { overall: "online", channels: {} };
      expect(
        channelWatchdogTick(
          falseAlive,
          false,
          CHANNEL_DEGRADED_FATAL_MS,
          "kite-opentag",
        ),
      ).toEqual({
        kind: "fatal",
        message: `channel has been non-online for >= ${CHANNEL_DEGRADED_FATAL_MS / 60_000}m: kite-opentag=absent (overall=online)`,
      });
    });

    it("stays quiet (already reported) on a later tick of the false-alive shape below the threshold", () => {
      const falseAlive: ChannelHealth = { overall: "online", channels: {} };
      expect(
        channelWatchdogTick(
          falseAlive,
          false,
          CHANNEL_DEGRADED_FATAL_MS - 1,
          "kite-opentag",
        ),
      ).toEqual({ kind: "quiet" });
    });
  });

  describe("Finding 2: a missing health reading escalates too, instead of staying quiet forever", () => {
    it("escalates when the health reading itself is missing and degradedForMs crosses the threshold", () => {
      // THE BUG THIS GUARDS: the OLD implementation returned `{ kind: "quiet"
      // }` unconditionally whenever `health` was undefined — so a status
      // surface that stopped returning readings accumulated an
      // ever-growing `degradedForMs` (per `nextDegradedSince`, which
      // correctly preserves the clock on a missing reading) that could NEVER
      // trip the escalation, because this function never even looked at it
      // in that branch.
      expect(
        channelWatchdogTick(
          undefined,
          false,
          CHANNEL_DEGRADED_FATAL_MS,
          "kite-opentag",
        ),
      ).toEqual({
        kind: "fatal",
        message: `channel has been non-online for >= ${CHANNEL_DEGRADED_FATAL_MS / 60_000}m: no health reading`,
      });
    });

    it("stays quiet for a missing reading below the threshold", () => {
      expect(
        channelWatchdogTick(
          undefined,
          false,
          CHANNEL_DEGRADED_FATAL_MS - 1,
          "kite-opentag",
        ),
      ).toEqual({ kind: "quiet" });
    });
  });

  describe("escalation after CHANNEL_DEGRADED_FATAL_MS", () => {
    it("stays quiet just below the threshold, even on an already-reported degraded state", () => {
      // Regression this guards: a channel wedged in `reconnecting` used to
      // notice once and then stay quiet FOREVER — `live === previousLive`
      // suppressed every later tick. Confirm sub-threshold ticks are still
      // quiet (not yet fatal), not that the old silent-forever bug is back.
      expect(
        channelWatchdogTick(
          health("reconnecting"),
          false,
          CHANNEL_DEGRADED_FATAL_MS - 1,
          "kite-opentag",
        ),
      ).toEqual({ kind: "quiet" });
    });

    it("stays a notice, not fatal, on the FIRST degraded tick even if degradedForMs is (implausibly) already high", () => {
      // The duration check only matters once the state has actually been
      // observed as non-online more than once; a first-tick transition still
      // reports as a plain "degraded" notice via the general branch below —
      // this only holds while degradedForMs stays under threshold.
      expect(
        channelWatchdogTick(health("reconnecting"), true, 1_000, "kite-opentag"),
      ).toEqual({
        kind: "notice",
        message: "channel degraded: kite-opentag=reconnecting",
      });
    });

    it("escalates to fatal the instant degradedForMs reaches the threshold", () => {
      expect(
        channelWatchdogTick(
          health("reconnecting"),
          false,
          CHANNEL_DEGRADED_FATAL_MS,
          "kite-opentag",
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
          false,
          CHANNEL_DEGRADED_FATAL_MS + 60_000,
          "kite-opentag",
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
          false,
          CHANNEL_DEGRADED_FATAL_MS + 1,
          "kite-opentag",
        ).kind,
      ).toBe("fatal");
    });

    it("never escalates while online, no matter how large a stale degradedForMs is passed in", () => {
      // Models recovery resetting the clock: main() zeroes degradedSince the
      // moment the channel becomes live again, so a later degradation starts
      // counting from zero again. The pure function itself also refuses to
      // go fatal while live, as a defensive backstop.
      expect(
        channelWatchdogTick(
          health("online"),
          false,
          CHANNEL_DEGRADED_FATAL_MS + 1_000_000,
          "kite-opentag",
        ),
      ).toEqual({
        kind: "notice",
        message: "channel recovered: overall=online",
      });
    });
  });
});

describe("nextDegradedSince", () => {
  const health = (overall: ChannelHealth["overall"]): ChannelHealth => ({
    overall,
    channels: { "kite-opentag": overall },
  });

  it("sets the clock on the first degraded reading", () => {
    expect(
      nextDegradedSince(health("reconnecting"), undefined, 1_000, "kite-opentag"),
    ).toBe(1_000);
  });

  it("preserves the original timestamp across a continuing degradation", () => {
    expect(
      nextDegradedSince(health("reconnecting"), 500, 1_000, "kite-opentag"),
    ).toBe(500);
  });

  it("preserves an existing clock when the health reading is missing (undefined)", () => {
    // THE BUG THIS GUARDS: a missing reading is "no data this tick", not
    // "back online". The previous implementation's `else degradedSince =
    // undefined` treated a missing reading the same as an affirmative
    // recovery, wiping the clock every time the status surface happened to
    // return nothing — so a status surface that intermittently returns no
    // reading could never accumulate the continuous duration
    // CHANNEL_DEGRADED_FATAL_MS checks for, and the 10-minute escalation
    // would never fire.
    expect(nextDegradedSince(undefined, 500, 1_000, "kite-opentag")).toBe(500);
  });

  it("preserves undefined when there is no existing clock and the health reading is missing", () => {
    expect(
      nextDegradedSince(undefined, undefined, 1_000, "kite-opentag"),
    ).toBeUndefined();
  });

  it("clears the clock the moment the declared channel reports online", () => {
    expect(
      nextDegradedSince(health("online"), 500, 1_000, "kite-opentag"),
    ).toBeUndefined();
  });

  it("starts a fresh clock for a new degradation after a recovery", () => {
    const afterRecovery = nextDegradedSince(
      health("online"),
      500,
      1_000,
      "kite-opentag",
    );
    expect(afterRecovery).toBeUndefined();
    expect(
      nextDegradedSince(health("reconnecting"), afterRecovery, 2_000, "kite-opentag"),
    ).toBe(2_000);
  });

  describe("Finding 1: keyed on isChannelLive, not on raw overall === \"online\"", () => {
    it("does NOT clear the clock for { overall: online, channels: {} } — the declared channel is absent, not live", () => {
      // THE BUG THIS GUARDS: the OLD implementation reset the clock on raw
      // `health.overall === "online"`, which is true for this exact shape
      // even though the declared channel itself is absent from `entries`.
      // `ChannelManager.computeOverall` genuinely returns "online" for a
      // zero-length input, so the OLD code wiped `degradedSince` to
      // `undefined` on EVERY tick for a host whose declared channel silently
      // dropped out of the manager's entries — `degradedForMs` could never
      // accumulate, and `channelWatchdogTick`'s 10-minute escalation could
      // never fire for that shape.
      const falseAlive: ChannelHealth = { overall: "online", channels: {} };
      expect(nextDegradedSince(falseAlive, 500, 1_000, "kite-opentag")).toBe(
        500,
      );
    });

    it("starts the clock for { overall: online, channels: {} } when none was running yet", () => {
      const falseAlive: ChannelHealth = { overall: "online", channels: {} };
      expect(
        nextDegradedSince(falseAlive, undefined, 1_000, "kite-opentag"),
      ).toBe(1_000);
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

  it("guards against a run that synchronously re-enters the returned function", () => {
    // THE BUG: the memo (`inFlight`) used to be assigned only AFTER `run(...)`
    // was invoked, so a `run` whose synchronous body calls the returned
    // function again — before `run` itself has returned — saw no guard yet and
    // started a second, competing teardown. That contradicts the docstring's
    // unqualified "N signals run it exactly ONCE" / "the FIRST signal wins".
    const calls: string[] = [];
    let shutdown!: (signal: string, exitCode?: number) => void;
    let reentered = false;
    shutdown = onceShutdown(
      (signal) => {
        calls.push(signal);
        if (!reentered) {
          reentered = true;
          // Simulate a `run` whose synchronous body re-enters the returned
          // shutdown function before returning its promise.
          shutdown("SIGINT");
        }
        return Promise.resolve();
      },
      () => {},
    );

    shutdown("SIGTERM");
    expect(calls).toEqual(["SIGTERM"]);
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

  describe("exitCode passthrough for a non-signal fatal caller", () => {
    it("passes the exit code through to the run function for the signal that starts the run, without invoking onError on a clean run", async () => {
      // Models the watchdog's fatal path calling `runShutdown("watchdog", 1)`
      // instead of `process.exit(1)` directly — the exit code has to reach
      // the same `shutdown()` the SIGINT/SIGTERM handlers use.
      //
      // THE BUG THIS REWRITE FIXES: the previous version's `onError` callback
      // THREW ("onError must not fire on a clean run") instead of recording,
      // on the assumption that a throw would fail this test if `onError` ever
      // fired on a clean run. It doesn't: `onError` is only invoked from
      // inside `onceShutdown`'s `started.catch(...)` reaction, which runs a
      // full macrotask after this test's synchronous body — and therefore
      // after any assertion — already returned. A throw there surfaces (if at
      // all) as an unrelated "Unhandled Rejection" against whatever other
      // test happens to be running, never as a failure of THIS test. Proven
      // by mutating `onceShutdown` to call `onError` unconditionally (not
      // only on rejection): this test stayed GREEN while an unhandled
      // rejection was reported against an unrelated test elsewhere in this
      // file. Recording calls into an array and explicitly awaiting past the
      // reaction — instead of relying on a thrown error's incidental,
      // unrelated fallout — ties the "onError must not fire" claim to an
      // assertion this test actually makes.
      const calls: Array<{ signal: string; exitCode: number | undefined }> =
        [];
      const onErrorCalls: Array<{ signal: string; err: unknown }> = [];
      const run = onceShutdown(
        (signal, exitCode) => {
          calls.push({ signal, exitCode });
          return Promise.resolve();
        },
        (signal, err) => {
          onErrorCalls.push({ signal, err });
        },
      );

      run("watchdog", 1);
      expect(calls).toEqual([{ signal: "watchdog", exitCode: 1 }]);
      // A real macrotask boundary, not a microtask: `onceShutdown`'s memoized
      // `.catch(...)` reaction (or a mutant's `.then(...)`) only runs after
      // the run's promise settles, and needs a full tick past `run()`
      // returning to have done so.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onErrorCalls).toEqual([]);
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

describe("uncaughtExceptionAction (defers to an in-flight graceful shutdown)", () => {
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

describe("unhandledRejectionAction (Finding 4: proportionate, not blanket-fatal)", () => {
  it("treats a rejection during an in-flight graceful shutdown as non-preempting", () => {
    expect(
      unhandledRejectionAction(true, new Error("boom"), "managed.ts"),
    ).toEqual({ kind: "continue-shutdown" });
  });

  it("escalates to fatal when the rejected Error's stack names this host's own module", () => {
    // Simulates a rejection actually thrown from inside managed.ts itself —
    // the stack trace names where the Error was CONSTRUCTED, so a genuine
    // in-repo bug still fails loud exactly as before.
    const err = new Error("boom");
    err.stack = "Error: boom\n    at main (file:///app/managed.ts:900:1)";
    expect(unhandledRejectionAction(false, err, "managed.ts")).toEqual({
      kind: "fatal",
    });
  });

  it("logs without exiting when the rejected Error's stack does NOT name this host's own module", () => {
    // THE REGRESSION THIS GUARDS: every unhandled rejection anywhere in the
    // process — including one from the Slack SDK, Playwright, the Phoenix WS
    // transport, or an aborted fetch inside SanitizingHttpAgent — used to be
    // treated exactly like a bug in this repo's own boot/teardown code:
    // blanket fatal(). Combined with ON_FAILURE and a finite
    // restartPolicyMaxRetries, a RECURRING library-level stray rejection
    // would burn the whole restart budget in ~10 restarts and leave the
    // service permanently stopped, with no healthcheck to surface it.
    const err = new Error("ECONNRESET");
    err.stack =
      "Error: ECONNRESET\n    at TLSSocket.onerror (node:internal/tls:1:1)\n    at node_modules/@copilotkit/channels-slack/dist/index.js:42:7";
    expect(unhandledRejectionAction(false, err, "managed.ts")).toEqual({
      kind: "log",
    });
  });

  it("logs without exiting when the rejection reason is not an Error at all (no stack to confirm origin)", () => {
    // A bare string/plain-object rejection is legal and carries no stack, so
    // origin can never be confirmed — the conservative choice is to log
    // rather than let an unconfirmable reason keep escalating to a fatal
    // exit on every occurrence.
    expect(
      unhandledRejectionAction(false, "a plain string reason", "managed.ts"),
    ).toEqual({ kind: "log" });
    expect(
      unhandledRejectionAction(false, { some: "object" }, "managed.ts"),
    ).toEqual({ kind: "log" });
    expect(unhandledRejectionAction(false, undefined, "managed.ts")).toEqual({
      kind: "log",
    });
  });
});

describe("guardedWrite (Findings 1 and 6: a failed diagnostic write must never suppress what follows it)", () => {
  it("calls the write function", () => {
    let called = false;
    guardedWrite(() => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("swallows a throw from the write function instead of letting it escape", () => {
    // THE REGRESSION: fatal() used to call fs.writeSync(2, ...) directly and
    // unguarded. Node marks a pipe-backed fd 2 non-blocking, and fs.writeSync
    // does not retry on EAGAIN — with a full 64 KB pipe buffer (a stalled log
    // shipper, a large AggregateError from ready()), writeSync throws, and
    // the unguarded throw would escape past process.exit(code) entirely —
    // if it escaped into main().catch(err => fatal(...)), fatal would throw
    // AGAIN there, so a fail-fast path could survive with no listener bound.
    const eagain = Object.assign(new Error("EAGAIN"), { code: "EAGAIN" });
    expect(() =>
      guardedWrite(() => {
        throw eagain;
      }),
    ).not.toThrow();
  });
});

describe("fatalText (message formatting for the synchronous fatal exit path)", () => {
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
