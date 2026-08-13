import { EventType } from "@ag-ui/core";
import { memoryStream } from "@tanstack/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetOpentagSqlitePersistenceForTests } from "../opentag-persistence.js";
import { opentagSqlitePersistence } from "../opentag-persistence.js";
import { readSandboxJobsForSlackThread } from "../sandbox-job-status.js";
import { sandboxThreadId } from "../sandbox-thread-id.js";

const KEY = "slack:C:1.2";

async function seedRun(input: {
  kind: "promo" | "docs-pr" | "linear-fix" | "linear-triage" | "copilotkit";
  runId: string;
  startedAt: number;
  status?: "running" | "completed" | "failed";
  finishedAt?: number;
}) {
  const persistence = opentagSqlitePersistence();
  const threadId = sandboxThreadId(input.kind, KEY);
  await persistence.stores.runs.createOrResume({
    runId: input.runId,
    threadId,
    startedAt: input.startedAt,
    status: input.status ?? "running",
  });
  if (input.status && input.status !== "running") {
    await persistence.stores.runs.update(input.runId, {
      status: input.status,
      finishedAt: input.finishedAt ?? input.startedAt + 1,
    });
  }
  return threadId;
}

describe("readSandboxJobsForSlackThread", () => {
  beforeEach(() => {
    process.env.OPENTAG_SQLITE_URL = ":memory:";
    __resetOpentagSqlitePersistenceForTests();
  });

  afterEach(() => {
    __resetOpentagSqlitePersistenceForTests();
    delete process.env.OPENTAG_SQLITE_URL;
  });

  it("returns live text and reasoning when memoryStream has chunks", async () => {
    await seedRun({ kind: "promo", runId: "live-1", startedAt: 10 });
    await memoryStream({ runId: "live-1" }).append([
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "r1",
        delta: "planning scene 3 of 5",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "Rendering scene 3 of 5",
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "t1",
        toolCallName: "bash",
        toolName: "bash",
      },
    ]);

    const result = await readSandboxJobsForSlackThread(KEY);
    expect(result.jobs).toHaveLength(1);
    const job = result.jobs[0]!;
    expect(job.kind).toBe("promo");
    expect(job.threadId).toBe("promo:slack:C:1.2");
    expect(job.status).toBe("running");
    expect(job.liveLog).toBe("present");
    expect(job.source).toBe("live");
    expect(job.chunkCount).toBe(3);
    expect(job.streamComplete).toBe(false);
    expect(job.recentText).toContain("planning scene 3 of 5");
    expect(job.recentText).toContain("Rendering scene 3 of 5");
    expect(job.recentTools).toEqual(["bash"]);
  });

  it("prefers live chunks when a transcript also exists", async () => {
    const threadId = await seedRun({
      kind: "promo",
      runId: "live-wins",
      startedAt: 10,
    });
    await opentagSqlitePersistence().stores.messages.saveThread(threadId, [
      { role: "user", content: "old prompt" },
      { role: "assistant", content: "saved transcript text" },
    ]);
    await memoryStream({ runId: "live-wins" }).append([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "live wins",
      },
    ]);

    const result = await readSandboxJobsForSlackThread(KEY);
    expect(result.jobs[0]?.source).toBe("live");
    expect(result.jobs[0]?.liveLog).toBe("present");
    expect(result.jobs[0]?.recentText).toContain("live wins");
    expect(result.jobs[0]?.recentText).not.toContain("saved transcript text");
  });

  it("uses empty transcript when live log is empty and nothing is saved", async () => {
    await seedRun({ kind: "promo", runId: "empty-1", startedAt: 10 });

    const snap = await memoryStream({ runId: "empty-1" }).snapshot();
    expect(snap).toEqual([]);

    const result = await readSandboxJobsForSlackThread(KEY);
    const job = result.jobs[0]!;
    expect(job.liveLog).toBe("empty");
    expect(job.source).toBe("transcript");
    expect(job.chunkCount).toBe(0);
    expect(job.recentText).toBe("");
    expect(job.recentTools).toEqual([]);
    expect(job.status).toBe("running");
  });

  it("rebuilds thinking and tool names from the saved transcript", async () => {
    const threadId = await seedRun({
      kind: "promo",
      runId: "tx-1",
      startedAt: 10,
    });
    await opentagSqlitePersistence().stores.messages.saveThread(threadId, [
      { role: "user", content: "make a video" },
      {
        role: "assistant",
        content: "working on scene 3",
        thinking: [{ content: "I will render scene 3 next" }],
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "bash", arguments: "{}" },
          },
        ],
      },
      { role: "tool", toolCallId: "c1", content: "ok" },
    ]);

    const result = await readSandboxJobsForSlackThread(KEY);
    const job = result.jobs[0]!;
    expect(job.source).toBe("transcript");
    expect(job.liveLog).toBe("empty");
    expect(job.chunkCount).toBe(0);
    expect(job.recentText).toContain("I will render scene 3 next");
    expect(job.recentText).toContain("working on scene 3");
    expect(job.recentTools).toContain("bash");
  });

  it("returns jobs: [] when the Slack thread has no sandbox runs", async () => {
    const result = await readSandboxJobsForSlackThread(KEY);
    expect(result).toEqual({ conversationKey: KEY, jobs: [] });
  });

  it("keeps promo and docs-pr transcripts on the same Slack key apart", async () => {
    const promoId = await seedRun({
      kind: "promo",
      runId: "p1",
      startedAt: 1,
    });
    const docsId = await seedRun({
      kind: "docs-pr",
      runId: "d1",
      startedAt: 2,
    });
    await opentagSqlitePersistence().stores.messages.saveThread(promoId, [
      { role: "assistant", content: "promo only" },
    ]);
    await opentagSqlitePersistence().stores.messages.saveThread(docsId, [
      { role: "assistant", content: "docs only" },
    ]);

    const result = await readSandboxJobsForSlackThread(KEY);
    expect(result.jobs.map((j) => j.kind).sort()).toEqual([
      "docs-pr",
      "promo",
    ]);
    const promo = result.jobs.find((j) => j.kind === "promo");
    const docs = result.jobs.find((j) => j.kind === "docs-pr");
    expect(promo?.threadId).toBe("promo:slack:C:1.2");
    expect(docs?.threadId).toBe("docs-pr:slack:C:1.2");
    expect(promo?.recentText).toContain("promo only");
    expect(docs?.recentText).toContain("docs only");
    expect(promo?.recentText).not.toContain("docs only");
  });

  it("returns a completed job from the transcript after memoryStream eviction", async () => {
    const threadId = await seedRun({
      kind: "linear-fix",
      runId: "done-1",
      startedAt: 10,
      status: "completed",
      finishedAt: 20,
    });
    await opentagSqlitePersistence().stores.messages.saveThread(threadId, [
      { role: "assistant", content: "Opened PR #99" },
    ]);
    const snap = await memoryStream({ runId: "done-1" }).snapshot();
    expect(snap).toEqual([]);

    const result = await readSandboxJobsForSlackThread(KEY);
    expect(result.jobs).toHaveLength(1);
    const job = result.jobs[0]!;
    expect(job.status).toBe("completed");
    expect(job.streamComplete).toBe(true);
    expect(job.source).toBe("transcript");
    expect(job.liveLog).toBe("empty");
    expect(job.recentText).toContain("Opened PR #99");
  });

  it("does not throw when snapshot is for an unknown runId", async () => {
    await expect(
      memoryStream({ runId: "never-seen" }).snapshot(),
    ).resolves.toEqual([]);
  });
});
