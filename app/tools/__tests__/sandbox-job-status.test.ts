import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetOpentagSqlitePersistenceForTests } from "../../sandbox/opentag-persistence.js";
import { opentagSqlitePersistence } from "../../sandbox/opentag-persistence.js";
import { sandboxThreadId } from "../../sandbox/sandbox-thread-id.js";
import { sandboxJobStatusTool } from "../sandbox-job-status.js";

describe("sandbox_job_status tool", () => {
  beforeEach(() => {
    process.env.OPENTAG_SQLITE_URL = ":memory:";
    __resetOpentagSqlitePersistenceForTests();
  });

  afterEach(() => {
    __resetOpentagSqlitePersistenceForTests();
    delete process.env.OPENTAG_SQLITE_URL;
  });

  it("throws when conversationKey is missing", async () => {
    await expect(
      sandboxJobStatusTool.handler(
        {},
        { thread: { post: vi.fn() }, platform: "slack" } as never,
      ),
    ).rejects.toThrow(/conversationKey/i);
  });

  it("returns jobs for this Slack thread", async () => {
    const key = "slack:C:status";
    await opentagSqlitePersistence().stores.runs.createOrResume({
      runId: "tool-run",
      threadId: sandboxThreadId("promo", key),
      startedAt: 1,
    });

    const result = (await sandboxJobStatusTool.handler(
      {},
      {
        thread: { conversationKey: key, post: vi.fn() },
        platform: "slack",
      } as never,
    )) as {
      conversationKey: string;
      jobs: Array<{ kind: string }>;
    };

    expect(result.conversationKey).toBe(key);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.kind).toBe("promo");
  });
});
