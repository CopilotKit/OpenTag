import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chat = vi.fn((..._args: unknown[]) => (async function* () {})());

vi.mock("@tanstack/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/ai")>();
  return {
    ...actual,
    chat: (...args: unknown[]) => chat(...args),
  };
});

// HEAD job imports Claude Code; WT job imports Grok Build. Mock both.
vi.mock("@tanstack/ai-claude-code", () => ({
  claudeCodeText: () => ({}),
  SESSION_ID_EVENT: "SESSION_ID",
}));

vi.mock("@tanstack/ai-grok-build", () => ({
  grokBuildText: () => ({}),
  SESSION_ID_EVENT: "SESSION_ID",
}));

vi.mock("../promo-video-sandbox.js", () => ({
  requirePromoVideoEnv: () => ({ model: "test-model" }),
  promoGrokBuildOptions: () => ({}),
  createPromoVideoSandbox: () => ({
    destroy: vi.fn(async () => {}),
    ensure: vi.fn(async () => ({
      workspaceRoot: "/workspace",
      fs: {
        exists: vi.fn(async () => false),
        read: vi.fn(async () => ""),
        readBytes: vi.fn(async () => new Uint8Array()),
      },
    })),
  }),
}));

vi.mock("../promo-video-pr-url.js", () => ({
  resolvePrRepo: () => null,
  repoSlug: () => null,
}));

describe("runPromoVideoJob conversationKey", () => {
  it(
    "throws when thread.conversationKey is missing",
    async () => {
    const { runPromoVideoJob } = await import("../promo-video-job.js");
    await expect(
      runPromoVideoJob({
        thread: {
          post: vi.fn(async () => ({})),
          postFile: vi.fn(async () => ({ ok: true })),
        },
        prompt: "make a video",
      }),
    ).rejects.toThrow(/conversationKey/i);
    },
    15_000,
  );
});

describe("runPromoVideoJob chat wiring", () => {
  beforeEach(() => {
    process.env.OPENTAG_SQLITE_URL = ":memory:";
    chat.mockClear();
    chat.mockImplementation(() => (async function* () {})());
  });

  afterEach(async () => {
    const { __resetOpentagSqlitePersistenceForTests } = await import(
      "../opentag-persistence.js"
    );
    __resetOpentagSqlitePersistenceForTests();
    delete process.env.OPENTAG_SQLITE_URL;
  });

  // Dynamic import + mocked chat can exceed 5s under full-suite load.
  it(
    "uses sandboxThreadId and shared persistence",
    async () => {
      const { runPromoVideoJob } = await import("../promo-video-job.js");
      await runPromoVideoJob({
        thread: {
          conversationKey: "slack:C:1.2",
          post: vi.fn(async () => ({})),
          postFile: vi.fn(async () => ({ ok: true })),
        },
        prompt: "make a video",
      });

      expect(chat).toHaveBeenCalled();
      const opts = chat.mock.calls[0]?.[0] as {
        threadId: string;
        runId: string;
      };
      expect(opts.threadId).toBe("promo:slack:C:1.2");
    },
    30_000,
  );
});
