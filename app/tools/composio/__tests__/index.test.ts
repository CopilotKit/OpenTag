/**
 * Covers index.ts — which tools a deployment exposes, and what an unconfigured
 * one costs.
 *
 * The SDK is mocked so the assertions can see construction itself: the central
 * promise of this module is that an unconfigured deployment constructs nothing,
 * and that is invisible from the returned array.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Shared across constructions so a test can decide, per user id, whether that
 * scope's session comes up at all — which is the only way to see what one
 * failing scope costs the others.
 */
const sessionsCreate = vi.fn();
const getRawComposioTools = vi.fn();

const ComposioConstructor = vi.fn(function fakeComposio() {
  return {
    sessions: { create: sessionsCreate },
    tools: { getRawComposioTools },
  };
});

vi.mock("@composio/core", () => ({ Composio: ComposioConstructor }));

const { composioTools } = await import("../index.js");
const { resetComposioClient } = await import("../client.js");
const { clearSessionCache } = await import("../sessions.js");

beforeEach(() => {
  resetComposioClient();
  clearSessionCache();
  ComposioConstructor.mockClear();
  sessionsCreate.mockReset();
  getRawComposioTools.mockReset();
  vi.restoreAllMocks();
});

function toolNames(env: NodeJS.ProcessEnv): string[] {
  return composioTools(env, "open-tag").map((tool) => tool.name);
}

describe("composioTools", () => {
  it("returns nothing without a key", () => {
    expect(composioTools({ COMPOSIO_TOOLKITS: "linear" }, "open-tag")).toEqual(
      [],
    );
  });

  it("returns nothing without toolkits", () => {
    expect(composioTools({ COMPOSIO_API_KEY: "ak_x" }, "open-tag")).toEqual([]);
  });

  it("constructs no SDK client when unconfigured", () => {
    composioTools({}, "open-tag");
    composioTools({ COMPOSIO_TOOLKITS: "linear" }, "open-tag");
    composioTools({ COMPOSIO_API_KEY: "ak_x" }, "open-tag");

    expect(ComposioConstructor).not.toHaveBeenCalled();
  });

  it("returns search and run for a workspace-only config", () => {
    expect(toolNames({ COMPOSIO_API_KEY: "ak_x", COMPOSIO_TOOLKITS: "linear" })).toEqual(
      ["search_my_tools", "run_my_tool"],
    );
  });

  it("adds connect_my_app when personal toolkits are configured", () => {
    expect(
      toolNames({ COMPOSIO_API_KEY: "ak_x", COMPOSIO_USER_TOOLKITS: "gmail" }),
    ).toContain("connect_my_app");
  });

  it("omits connect_my_app when every toolkit is shared", () => {
    expect(
      toolNames({ COMPOSIO_API_KEY: "ak_x", COMPOSIO_TOOLKITS: "linear" }),
    ).not.toContain("connect_my_app");
  });

  /**
   * The warnings are a boot-time diagnostic. Emitting them from the per-turn
   * path would bury a real misconfiguration under one repetition per message.
   */
  it("emits startup warnings once per call, not once per turn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const tools = composioTools(
      {
        COMPOSIO_API_KEY: "ak_x",
        COMPOSIO_TOOLKITS: "gmail",
        COMPOSIO_USER_TOOLKITS: "gmail",
      },
      "open-tag",
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(
      "is in both COMPOSIO_TOOLKITS and COMPOSIO_USER_TOOLKITS",
    );
    // The tools exist and were built without warning again.
    expect(tools.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never logs the API key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    composioTools(
      {
        COMPOSIO_API_KEY: "ak_secret",
        COMPOSIO_TOOLKITS: "gmail",
        LINEAR_API_KEY: "lin_x",
        COMPOSIO_USER_TOOLKITS: "linear",
      },
      "open-tag",
    );

    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("ak_secret");
    }
  });
});

/**
 * The per-turn scope resolution, reached through `search_my_tools` because that
 * is the only door to it — `resolve` is a closure, and the thing worth asserting
 * is what a turn gets when one identity's session cannot be created.
 */
describe("a scope whose session fails", () => {
  const BOTH = {
    COMPOSIO_API_KEY: "ak_secret",
    COMPOSIO_TOOLKITS: "linear",
    COMPOSIO_USER_TOOLKITS: "gmail",
  };

  /** A session that answers one search with one candidate slug. */
  function workingSession(slug: string) {
    return {
      sessionId: "trs_1",
      search: vi.fn(async () => ({
        results: [{ primaryToolSlugs: [slug] }],
        toolSchemas: { [slug]: { description: "d", inputSchema: {} } },
      })),
    };
  }

  async function searchAsAlice(): Promise<{ tools: Array<{ slug: string }> }> {
    const tool = composioTools(BOTH, "open-tag").find((t) => t.name === "search_my_tools");
    if (!tool) throw new Error("search_my_tools was not exposed");
    return (await tool.handler({ query: "anything" }, {
      actor: { id: "U_ALICE" },
      thread: { post: vi.fn() },
    } as never)) as { tools: Array<{ slug: string }> };
  }

  beforeEach(() => {
    getRawComposioTools.mockResolvedValue([{ slug: "LINEAR_LIST_ISSUES", tags: ["readOnlyHint"] }]);
    // Alice's personal session is the one that cannot be created.
    sessionsCreate.mockImplementation(async (userId: string) => {
      if (userId === "U_ALICE") throw new Error("connection refused");
      return workingSession("LINEAR_LIST_ISSUES");
    });
  });

  it("costs only its own tools, not the other scope's", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await searchAsAlice();

    expect(result.tools.map((t) => t.slug)).toEqual(["LINEAR_LIST_ISSUES"]);
  });

  it("warns, naming the scope and no credential", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await searchAsAlice();

    const lines = warn.mock.calls.map((call) => String(call[0]));
    const reported = lines.filter((line) => line.includes("no session for"));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("U_ALICE");
    expect(reported[0]).toContain("gmail");
    expect(reported[0]).toContain("connection refused");
    for (const line of lines) expect(line).not.toContain("ak_secret");
  });
});
