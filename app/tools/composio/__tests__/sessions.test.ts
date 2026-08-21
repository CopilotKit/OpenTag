import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionCache, getSession, invalidateSession } from "../sessions.js";

function makeSdk() {
  // The parameters are declared even though the fake ignores them: without them
  // vitest infers an empty argument tuple and `mock.calls` cannot be indexed.
  const create = vi.fn(async (_userId: string, _options: Record<string, unknown>) => ({
    sessionId: "trs_1",
    search: vi.fn(),
    execute: vi.fn(),
    authorize: vi.fn(),
    toolkits: vi.fn(),
  }));
  const getRawComposioTools = vi.fn(async () => [
    { slug: "LINEAR_LIST_ISSUES", tags: ["readOnlyHint"] },
    { slug: "LINEAR_CREATE_ISSUE", tags: ["createHint"] },
    { slug: "LINEAR_DELETE_ISSUE", tags: ["destructiveHint"] },
  ]);
  return { sessions: { create }, tools: { getRawComposioTools } };
}

beforeEach(() => clearSessionCache());

describe("getSession", () => {
  it("always disables the remote workbench, on every session it creates", async () => {
    const sdk = makeSdk();
    await getSession(sdk, "open-tag", ["linear"]);
    await getSession(sdk, "U2", ["gmail"]);

    const calls = sdk.sessions.create.mock.calls;
    expect(calls).toHaveLength(2);
    // Not `toHaveBeenCalledWith`, which passes when any single call matches. A
    // session without this flag exposes remote bash and a Python sandbox, so the
    // constraint has to hold for every call site, not just one of them.
    for (const [, options] of calls) {
      expect(options).toMatchObject({ workbench: { enable: false } });
    }
  });

  it("passes the requested toolkits", async () => {
    const sdk = makeSdk();
    await getSession(sdk, "open-tag", ["linear"]);
    expect(sdk.sessions.create).toHaveBeenCalledWith(
      "open-tag",
      expect.objectContaining({ toolkits: ["linear"] }),
    );
  });

  it("records whose identity the session acts as", async () => {
    // The approval gate reads this to decide who may approve a call routed to
    // this scope, so a session that does not know whose it is cannot be gated.
    const sdk = makeSdk();
    expect((await getSession(sdk, "open-tag", ["linear"])).userId).toBe("open-tag");
    expect((await getSession(sdk, "U_ALICE", ["gmail"])).userId).toBe("U_ALICE");
  });

  it("builds an effect map from tool tags", async () => {
    const sdk = makeSdk();
    const cached = await getSession(sdk, "open-tag", ["linear"]);
    expect(cached.effects.get("LINEAR_LIST_ISSUES")).toBe("read");
    expect(cached.effects.get("LINEAR_CREATE_ISSUE")).toBe("write");
    expect(cached.effects.get("LINEAR_DELETE_ISSUE")).toBe("destructive");
  });

  it("reuses a cached session for the same user", async () => {
    const sdk = makeSdk();
    await getSession(sdk, "open-tag", ["linear"]);
    await getSession(sdk, "open-tag", ["linear"]);
    expect(sdk.sessions.create).toHaveBeenCalledTimes(1);
  });

  it("keeps separate sessions per user", async () => {
    const sdk = makeSdk();
    await getSession(sdk, "U1", ["gmail"]);
    await getSession(sdk, "U2", ["gmail"]);
    expect(sdk.sessions.create).toHaveBeenCalledTimes(2);
  });

  it("keeps separate cache entries per toolkit set for one user", async () => {
    const sdk = makeSdk();
    await getSession(sdk, "U1", ["gmail"]);
    await getSession(sdk, "U1", ["linear"]);
    expect(sdk.sessions.create).toHaveBeenCalledTimes(2);
  });

  it("rebuilds after invalidation", async () => {
    const sdk = makeSdk();
    await getSession(sdk, "U1", ["gmail"]);
    invalidateSession("U1");
    await getSession(sdk, "U1", ["gmail"]);
    expect(sdk.sessions.create).toHaveBeenCalledTimes(2);
  });

  // The TTL is 10 minutes and the module reads the clock with `Date.now()`, which
  // vitest's fake timers replace. The pair matters: the "before" case proves the
  // cache is really caching, so the "after" case is evidence of expiry rather
  // than of a cache that never hit in the first place.
  it("still reuses the session just before the TTL lapses", async () => {
    vi.useFakeTimers();
    try {
      const sdk = makeSdk();
      await getSession(sdk, "U1", ["gmail"]);
      vi.advanceTimersByTime(9 * 60 * 1000);
      await getSession(sdk, "U1", ["gmail"]);
      expect(sdk.sessions.create).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds the session after the TTL lapses", async () => {
    vi.useFakeTimers();
    try {
      const sdk = makeSdk();
      await getSession(sdk, "U1", ["gmail"]);
      vi.advanceTimersByTime(11 * 60 * 1000);
      await getSession(sdk, "U1", ["gmail"]);
      expect(sdk.sessions.create).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
