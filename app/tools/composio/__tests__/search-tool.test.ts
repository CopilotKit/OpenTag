import { describe, expect, it, vi } from "vitest";
import { createSearchTool } from "../search-tool.js";
import type { CachedSession } from "../sessions.js";

function cached(searchResult: unknown): CachedSession {
  return {
    session: { sessionId: "trs_1", search: vi.fn(async () => searchResult) },
    effects: new Map(),
    toolkits: ["gmail"],
    filledAt: Date.now(),
  } as unknown as CachedSession;
}

/** A scope whose Composio session is broken. */
function failing(): CachedSession {
  return {
    session: {
      sessionId: "trs_dead",
      search: vi.fn(async () => {
        throw new Error("session expired");
      }),
    },
    effects: new Map(),
    toolkits: ["linear"],
    filledAt: Date.now(),
  } as unknown as CachedSession;
}

/** A one-result scope offering `slugs`, each with a trivial input schema. */
function scopeOffering(...slugs: string[]): CachedSession {
  return cached({
    results: [{ primaryToolSlugs: slugs, relatedToolSlugs: [] }],
    toolSchemas: Object.fromEntries(
      slugs.map((s) => [s, { description: "d", inputSchema: { type: "object" } }]),
    ),
    toolkitConnectionStatuses: [],
  });
}

const ctx = { actor: { id: "U1" } } as never;

describe("search_my_tools", () => {
  it("returns slugs with their schemas", async () => {
    const tool = createSearchTool(async () => [
      cached({
        results: [{ primaryToolSlugs: ["GMAIL_SEND_EMAIL"], relatedToolSlugs: [] }],
        toolSchemas: {
          GMAIL_SEND_EMAIL: { description: "Sends an email.", inputSchema: { type: "object" } },
        },
        toolkitConnectionStatuses: [{ toolkit: "gmail", hasActiveConnection: true }],
      }),
    ]);
    const result = (await tool.handler({ query: "send email" }, ctx)) as {
      tools: Array<{ slug: string; inputSchema: unknown }>;
    };
    expect(result.tools[0]?.slug).toBe("GMAIL_SEND_EMAIL");
    expect(result.tools[0]?.inputSchema).toEqual({ type: "object" });
  });

  it("merges results across scopes", async () => {
    const tool = createSearchTool(async () => [
      cached({
        results: [{ primaryToolSlugs: ["LINEAR_LIST_ISSUES"], relatedToolSlugs: [] }],
        toolSchemas: { LINEAR_LIST_ISSUES: { description: "d", inputSchema: {} } },
        toolkitConnectionStatuses: [],
      }),
      cached({
        results: [{ primaryToolSlugs: ["GMAIL_SEND_EMAIL"], relatedToolSlugs: [] }],
        toolSchemas: { GMAIL_SEND_EMAIL: { description: "d", inputSchema: {} } },
        toolkitConnectionStatuses: [],
      }),
    ]);
    const result = (await tool.handler({ query: "x" }, ctx)) as { tools: Array<{ slug: string }> };
    expect(result.tools.map((t) => t.slug)).toEqual(["LINEAR_LIST_ISSUES", "GMAIL_SEND_EMAIL"]);
  });

  it("reports toolkits that still need connecting", async () => {
    const tool = createSearchTool(async () => [
      cached({
        results: [],
        toolSchemas: {},
        toolkitConnectionStatuses: [{ toolkit: "gmail", hasActiveConnection: false }],
      }),
    ]);
    const result = (await tool.handler({ query: "x" }, ctx)) as { needsConnection: string[] };
    expect(result.needsConnection).toEqual(["gmail"]);
  });

  it("caps results at five", async () => {
    const slugs = Array.from({ length: 12 }, (_, i) => `T_${i}`);
    const tool = createSearchTool(async () => [
      cached({
        results: [{ primaryToolSlugs: slugs, relatedToolSlugs: [] }],
        toolSchemas: Object.fromEntries(
          slugs.map((s) => [s, { description: "d", inputSchema: {} }]),
        ),
        toolkitConnectionStatuses: [],
      }),
    ]);
    const result = (await tool.handler({ query: "x" }, ctx)) as { tools: unknown[] };
    expect(result.tools).toHaveLength(5);
  });

  it("returns an error string when nothing resolves", async () => {
    const tool = createSearchTool(async () => []);
    expect(await tool.handler({ query: "x" }, ctx)).toContain("not configured");
  });

  it("gives every scope a share of the cap instead of letting the first fill it", async () => {
    // The shared workspace scope alone could fill all five slots. If it did,
    // the person's own calendar would be unreachable.
    const tool = createSearchTool(async () => [
      scopeOffering("W_0", "W_1", "W_2", "W_3", "W_4", "W_5", "W_6"),
      scopeOffering("P_0", "P_1", "P_2", "P_3", "P_4", "P_5", "P_6"),
    ]);
    const result = (await tool.handler({ query: "x" }, ctx)) as { tools: Array<{ slug: string }> };
    const slugs = result.tools.map((t) => t.slug);

    expect(slugs).toHaveLength(5);
    expect(slugs.some((s) => s.startsWith("W_"))).toBe(true);
    expect(slugs.some((s) => s.startsWith("P_"))).toBe(true);
    // Round-robin, so the two scopes alternate by rank.
    expect(slugs).toEqual(["W_0", "P_0", "W_1", "P_1", "W_2"]);
  });

  it("keeps each scope's own ranking: primary slugs before related ones", async () => {
    const tool = createSearchTool(async () => [
      cached({
        results: [{ primaryToolSlugs: ["A_PRIMARY"], relatedToolSlugs: ["A_RELATED"] }],
        toolSchemas: {
          A_PRIMARY: { description: "d", inputSchema: {} },
          A_RELATED: { description: "d", inputSchema: {} },
        },
      }),
    ]);
    const result = (await tool.handler({ query: "x" }, ctx)) as { tools: Array<{ slug: string }> };
    expect(result.tools.map((t) => t.slug)).toEqual(["A_PRIMARY", "A_RELATED"]);
  });

  it("still answers from the healthy scope when another scope's search rejects", async () => {
    const tool = createSearchTool(async () => [failing(), scopeOffering("GMAIL_SEND_EMAIL")]);
    const result = (await tool.handler({ query: "x" }, ctx)) as { tools: Array<{ slug: string }> };
    expect(result.tools.map((t) => t.slug)).toEqual(["GMAIL_SEND_EMAIL"]);
  });

  it("returns an empty result rather than throwing when every scope rejects", async () => {
    const tool = createSearchTool(async () => [failing(), failing()]);
    const result = (await tool.handler({ query: "x" }, ctx)) as {
      tools: unknown[];
      needsConnection: string[];
    };
    expect(result.tools).toEqual([]);
    expect(result.needsConnection).toEqual([]);
  });

  it("searches the scopes in parallel", async () => {
    // The first scope only finishes once the second has started, so a
    // sequential implementation deadlocks and this test times out.
    let releaseFirst!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = cached(undefined) as unknown as { session: { search: () => Promise<unknown> } };
    first.session.search = async () => {
      await secondStarted;
      return {
        results: [{ primaryToolSlugs: ["A"] }],
        toolSchemas: { A: { inputSchema: {} } },
      };
    };
    const second = cached(undefined) as unknown as { session: { search: () => Promise<unknown> } };
    second.session.search = async () => {
      releaseFirst();
      return {
        results: [{ primaryToolSlugs: ["B"] }],
        toolSchemas: { B: { inputSchema: {} } },
      };
    };

    const tool = createSearchTool(async () => [
      first as unknown as CachedSession,
      second as unknown as CachedSession,
    ]);
    const result = (await tool.handler({ query: "x" }, ctx)) as { tools: Array<{ slug: string }> };
    expect(result.tools.map((t) => t.slug)).toEqual(["A", "B"]);
  });

  it("does not treat a connected toolkit as needing connection", async () => {
    const tool = createSearchTool(async () => [
      cached({
        results: [],
        toolSchemas: {},
        toolkitConnectionStatuses: [{ toolkit: "gmail", hasActiveConnection: true }],
      }),
    ]);
    const result = (await tool.handler({ query: "x" }, ctx)) as { needsConnection: string[] };
    expect(result.needsConnection).toEqual([]);
  });

  it("does not treat an absent hasActiveConnection as needing connection", async () => {
    // Silence is not a negative answer. Reporting it would prompt the user to
    // reconnect an app that is already working.
    const tool = createSearchTool(async () => [
      cached({
        results: [],
        toolSchemas: {},
        toolkitConnectionStatuses: [{ toolkit: "gmail" }],
      }),
    ]);
    const result = (await tool.handler({ query: "x" }, ctx)) as { needsConnection: string[] };
    expect(result.needsConnection).toEqual([]);
  });

  it("reports a disconnected toolkit once even when several scopes see it", async () => {
    const disconnected = {
      results: [],
      toolSchemas: {},
      toolkitConnectionStatuses: [{ toolkit: "gmail", hasActiveConnection: false }],
    };
    const tool = createSearchTool(async () => [cached(disconnected), cached(disconnected)]);
    const result = (await tool.handler({ query: "x" }, ctx)) as { needsConnection: string[] };
    expect(result.needsConnection).toEqual(["gmail"]);
  });

  it("returns a slug missing from toolSchemas with a null inputSchema", async () => {
    const tool = createSearchTool(async () => [
      cached({
        results: [{ primaryToolSlugs: ["GMAIL_MYSTERY"], relatedToolSlugs: [] }],
        toolSchemas: {},
        toolkitConnectionStatuses: [],
      }),
    ]);
    const result = (await tool.handler({ query: "x" }, ctx)) as {
      tools: Array<{ slug: string; description: string; inputSchema: unknown }>;
    };
    expect(result.tools).toEqual([
      { slug: "GMAIL_MYSTERY", description: "", inputSchema: null },
    ]);
  });

  it("never lets an uncallable candidate displace a callable one", async () => {
    const schemaless = Array.from({ length: 5 }, (_, i) => `NO_SCHEMA_${i}`);
    const tool = createSearchTool(async () => [
      cached({
        results: [{ primaryToolSlugs: [...schemaless, "HAS_SCHEMA"], relatedToolSlugs: [] }],
        toolSchemas: { HAS_SCHEMA: { description: "d", inputSchema: { type: "object" } } },
        toolkitConnectionStatuses: [],
      }),
    ]);
    const result = (await tool.handler({ query: "x" }, ctx)) as { tools: Array<{ slug: string }> };
    // Ranked last by the scope, but the only one the model can actually call.
    expect(result.tools[0]?.slug).toBe("HAS_SCHEMA");
    expect(result.tools).toHaveLength(5);
  });

  it("returns one entry when two scopes offer the same slug", async () => {
    const tool = createSearchTool(async () => [
      scopeOffering("GMAIL_SEND_EMAIL"),
      scopeOffering("GMAIL_SEND_EMAIL"),
    ]);
    const result = (await tool.handler({ query: "x" }, ctx)) as { tools: Array<{ slug: string }> };
    expect(result.tools.map((t) => t.slug)).toEqual(["GMAIL_SEND_EMAIL"]);
  });

  it("tolerates a response with every field absent", async () => {
    const tool = createSearchTool(async () => [cached({})]);
    const result = (await tool.handler({ query: "x" }, ctx)) as {
      tools: unknown[];
      needsConnection: string[];
    };
    expect(result).toEqual({ tools: [], needsConnection: [] });
  });

  it("tolerates a result whose slug arrays are absent", async () => {
    const tool = createSearchTool(async () => [cached({ results: [{}] })]);
    const result = (await tool.handler({ query: "x" }, ctx)) as { tools: unknown[] };
    expect(result.tools).toEqual([]);
  });

  it("tolerates a null response", async () => {
    const tool = createSearchTool(async () => [cached(null)]);
    const result = (await tool.handler({ query: "x" }, ctx)) as {
      tools: unknown[];
      needsConnection: string[];
    };
    expect(result).toEqual({ tools: [], needsConnection: [] });
  });

  it("tolerates malformed field types", async () => {
    const tool = createSearchTool(async () => [
      cached({ results: "nope", toolSchemas: "nope", toolkitConnectionStatuses: "nope" }),
    ]);
    const result = (await tool.handler({ query: "x" }, ctx)) as {
      tools: unknown[];
      needsConnection: string[];
    };
    expect(result).toEqual({ tools: [], needsConnection: [] });
  });
});
