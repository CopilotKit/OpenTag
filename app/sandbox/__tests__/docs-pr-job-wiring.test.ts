import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chat = vi.fn((..._args: unknown[]) => (async function* () {})());

vi.mock("@tanstack/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/ai")>();
  return {
    ...actual,
    chat: (...args: unknown[]) => chat(...args),
  };
});

vi.mock("../docs-pr-sandbox.js", () => ({
  requireDocsPrEnv: () => {},
  createDocsPrSandbox: () => ({}),
}));

describe("defaultDocsPrSandboxRunner threadId", () => {
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
    "chats on docs-pr:<conversationKey>",
    async () => {
      const { defaultDocsPrSandboxRunner } = await import("../docs-pr-job.js");
      await defaultDocsPrSandboxRunner({
        prompt: "update docs",
        model: "gpt-5.5",
        runId: "docs-run-1",
        conversationKey: "slack:C:docs",
      });
      expect(chat).toHaveBeenCalled();
      const opts = chat.mock.calls[0]?.[0] as { threadId: string };
      expect(opts.threadId).toBe("docs-pr:slack:C:docs");
    },
    30_000,
  );
});
