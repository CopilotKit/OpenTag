import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_MODEL_DEFAULT,
  AGENT_REASONING_DEFAULT,
  agentModelBadge,
  buildSessionUrl,
  canonicalThreadIdFrom,
  readSessionLinkConfig,
  sessionFooter,
  type SessionLinkConfig,
} from "./session-link.js";

const config: SessionLinkConfig = {
  consoleUrl: "https://intelligence.example.com",
  orgSlug: "acme-org",
  projectSlug: "acme-project",
  pathSegment: "threads",
};

const baseEnv = {
  INTELLIGENCE_CONSOLE_URL: "https://intelligence.example.com",
  INTELLIGENCE_ORG_SLUG: "acme-org",
  INTELLIGENCE_PROJECT_SLUG: "acme-project",
} satisfies NodeJS.ProcessEnv;

describe("readSessionLinkConfig", () => {
  it("reads a complete configuration", () => {
    expect(readSessionLinkConfig(baseEnv)).toEqual(config);
  });

  it("disables the footer when the console location is incomplete", () => {
    for (const omitted of [
      "INTELLIGENCE_CONSOLE_URL",
      "INTELLIGENCE_ORG_SLUG",
      "INTELLIGENCE_PROJECT_SLUG",
    ]) {
      const env: NodeJS.ProcessEnv = { ...baseEnv };
      delete env[omitted];
      expect(readSessionLinkConfig(env)).toBeUndefined();
    }
  });

  it("honors an explicit off switch", () => {
    expect(
      readSessionLinkConfig({ ...baseEnv, SESSION_FOOTER: "off" }),
    ).toBeUndefined();
  });

  it("rejects an unresolved env template rather than linking to it", () => {
    expect(() =>
      readSessionLinkConfig({
        ...baseEnv,
        INTELLIGENCE_CONSOLE_URL: "https://${INTEL_HOST}",
      }),
    ).toThrow(/Unresolved template/);
  });

  it("rejects a non-http scheme", () => {
    expect(() =>
      readSessionLinkConfig({
        ...baseEnv,
        INTELLIGENCE_CONSOLE_URL: "javascript:alert(1)",
      }),
    ).toThrow(/scheme/);
  });

  it("rejects a slug that would escape the path", () => {
    expect(() =>
      readSessionLinkConfig({
        ...baseEnv,
        INTELLIGENCE_ORG_SLUG: "../../etc",
      }),
    ).toThrow(/INTELLIGENCE_ORG_SLUG/);
  });

  it("reduces a console url with a path to its origin", () => {
    expect(
      readSessionLinkConfig({
        ...baseEnv,
        INTELLIGENCE_CONSOLE_URL: "https://intelligence.example.com/o/x",
      })?.consoleUrl,
    ).toBe("https://intelligence.example.com");
  });
});

describe("buildSessionUrl", () => {
  it("builds the console thread url", () => {
    expect(buildSessionUrl(config, "ed1f290b-f826-4275-b56e-a4d22850117d")).toBe(
      "https://intelligence.example.com/o/acme-org/acme-project/threads/ed1f290b-f826-4275-b56e-a4d22850117d",
    );
  });

  it("supports a dedicated sessions view without a code change", () => {
    expect(
      buildSessionUrl({ ...config, pathSegment: "sessions" }, "t1"),
    ).toContain("/acme-project/sessions/t1");
  });

  it("encodes the thread id", () => {
    expect(buildSessionUrl(config, "a b/c")).toContain("/threads/a%20b%2Fc");
  });

  it("requires a thread id", () => {
    expect(() => buildSessionUrl(config, "   ")).toThrow(/threadId/);
  });
});

describe("agentModelBadge", () => {
  it("falls back to the agent's own defaults", () => {
    expect(agentModelBadge({})).toBe(
      `${AGENT_MODEL_DEFAULT}[${AGENT_REASONING_DEFAULT}]`,
    );
  });

  it("reports configured overrides", () => {
    expect(
      agentModelBadge({
        OPENAI_MODEL: "gpt-5.4-mini",
        OPENAI_REASONING_EFFORT: "HIGH",
      }),
    ).toBe("gpt-5.4-mini[high]");
  });
});

const MANAGED_KEY = "ed1f290b-f826-4275-b56e-a4d22850117d";

describe("canonicalThreadIdFrom", () => {
  it("accepts a managed conversation key", () => {
    expect(canonicalThreadIdFrom(MANAGED_KEY)).toBe(MANAGED_KEY);
  });

  it("rejects a Slack provider key", () => {
    // A local adapter puts `${teamId}:${channel}:${threadTs}` here. Linking to
    // it would produce a console URL for a thread that does not exist.
    expect(canonicalThreadIdFrom("T123:C456:1785507740.811589")).toBeUndefined();
  });

  it("rejects absent or blank keys", () => {
    expect(canonicalThreadIdFrom(undefined)).toBeUndefined();
    expect(canonicalThreadIdFrom("   ")).toBeUndefined();
  });
});

describe("sessionFooter", () => {
  it("renders a Slack link and the model badge", () => {
    expect(
      sessionFooter({ config, conversationKey: MANAGED_KEY, env: {} }),
    ).toBe(
      `<${buildSessionUrl(config, MANAGED_KEY)}|Open session> · ${AGENT_MODEL_DEFAULT}[${AGENT_REASONING_DEFAULT}]`,
    );
  });

  it("omits the footer for a non-managed conversation", () => {
    expect(
      sessionFooter({ config, conversationKey: "T1:C1:123.456", env: {} }),
    ).toBeUndefined();
    expect(sessionFooter({ config, env: {} })).toBeUndefined();
  });

  it("omits the footer when unconfigured", () => {
    expect(
      sessionFooter({ conversationKey: MANAGED_KEY, env: {} }),
    ).toBeUndefined();
  });
});

describe("agent tuning defaults stay in sync with the agent", () => {
  // The badge claims what the agent resolved. If agent.py's defaults move and
  // these do not, the badge silently lies about the model that answered.
  const agentSource = readFileSync(
    resolve(process.cwd(), "agent/agent.py"),
    "utf8",
  );

  it("mirrors the model default", () => {
    expect(agentSource).toContain(`"OPENAI_MODEL", "${AGENT_MODEL_DEFAULT}"`);
  });

  it("mirrors the reasoning-effort default", () => {
    expect(agentSource).toContain(`default="${AGENT_REASONING_DEFAULT}"`);
  });
});
