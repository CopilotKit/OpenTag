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

describe("defaultLinearTriageSandboxRunner threadId", () => {
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
    "chats on linear-triage:<conversationKey>",
    async () => {
      const { defaultLinearTriageSandboxRunner } = await import(
        "../linear-triage-job.js"
      );
      await defaultLinearTriageSandboxRunner({
        prompt: "investigate",
        model: "gpt-5.6-luna",
        reasoning: "xhigh",
        runId: "lt-1",
        conversationKey: "slack:C:lt",
      });
      expect(chat).toHaveBeenCalled();
      const opts = chat.mock.calls[0]?.[0] as { threadId: string };
      expect(opts.threadId).toBe("linear-triage:slack:C:lt");
    },
    30_000,
  );
});
