import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chat = vi.fn((..._args: unknown[]) => (async function* () {})());

vi.mock("@tanstack/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/ai")>();
  return {
    ...actual,
    chat: (...args: unknown[]) => chat(...args),
  };
});

vi.mock("../linear-fix-sandbox.js", () => ({
  requireLinearFixEnv: () => {},
  createLinearFixSandbox: () => ({}),
  resolveLinearFixModel: () => "gpt-5.6-luna",
  resolveLinearFixReasoning: () => "xhigh",
}));

describe("defaultLinearFixSandboxRunner threadId", () => {
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
    "chats on linear-fix:<conversationKey>",
    async () => {
      const { defaultLinearFixSandboxRunner } = await import(
        "../linear-fix-job.js"
      );
      await defaultLinearFixSandboxRunner({
        prompt: "fix it",
        model: "gpt-5.6-luna",
        reasoning: "xhigh",
        runId: "lf-1",
        conversationKey: "slack:C:lf",
      });
      expect(chat).toHaveBeenCalled();
      const opts = chat.mock.calls[0]?.[0] as { threadId: string };
      expect(opts.threadId).toBe("linear-fix:slack:C:lf");
    },
    30_000,
  );
});
