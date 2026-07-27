import { describe, it, expect } from "vitest";
import type { AgentContentPart } from "@copilotkit/channels-ui";
import {
  createKiteChannel,
  promptFromMessage,
  buildAgentHeaders,
  httpAuthGate,
  MANAGED_COMPONENTS,
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
    const appDir = new URL(".", import.meta.url).pathname;

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
      const src = await readFile(file, "utf8");
      if (!/\bonClick=/.test(src)) continue;
      for (const [, name] of src.matchAll(/^export function (\w+)\(/gm)) {
        if (!name) continue;
        // A component is interactive if an onClick appears in its body — i.e.
        // before the next top-level `export function`.
        const body = src.slice(src.indexOf(`export function ${name}(`));
        const end = body.indexOf("\nexport function ", 1);
        if (/\bonClick=/.test(end === -1 ? body : body.slice(0, end)))
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

describe("buildAgentHeaders", () => {
  it("returns undefined when no auth header is given", () => {
    expect(buildAgentHeaders(undefined)).toBeUndefined();
  });

  it("wraps the auth header value in an Authorization object", () => {
    expect(buildAgentHeaders("Bearer abc123")).toEqual({
      Authorization: "Bearer abc123",
    });
  });
});
