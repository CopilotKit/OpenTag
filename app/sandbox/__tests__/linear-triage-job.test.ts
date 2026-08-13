import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLinearTriageJob } from "../linear-triage-job.js";

describe("runLinearTriageJob", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "linear-triage-job-"));
    prev = process.env.LINEAR_TRIAGE_RUNS_DIR;
    process.env.LINEAR_TRIAGE_RUNS_DIR = dir;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.LINEAR_TRIAGE_RUNS_DIR;
    else process.env.LINEAR_TRIAGE_RUNS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("posts report to Linear and Slack on success", async () => {
    const post = vi.fn(async () => ({}));
    const report = [
      "## Summary",
      "Bug is X.",
      "## Root cause",
      "Missing guard.",
      "## Evidence",
      "- a.ts",
      "## Triage",
      "- Severity: high",
      "## Recommended fix",
      "Add guard",
      "## Next steps",
      "- Fix PR",
    ].join("\n");

    const result = await runLinearTriageJob(
      {
        thread: { post },
        ticket: { issueId: "ENG-5", title: "Bug" },
        conversationKey: "test:linear-triage-1",
        runId: "lt-1",
      },
      async () => ({
        agentText: `${report}\nREPORT_OK`,
        assistantText: `${report}\nREPORT_OK`,
        report,
      }),
      {
        postToLinear: async () => ({
          issue: {
            id: "uuid",
            identifier: "ENG-5",
            title: "Bug",
            url: "https://linear.app/x/issue/ENG-5",
          },
          comment: {
            id: "c1",
            url: "https://linear.app/x/comment/c1",
          },
        }),
      },
    );

    expect(result.issueId).toBe("ENG-5");
    expect(result.report).toContain("Root cause");
    expect(result.linearComment.id).toBe("c1");
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining("ENG-5"),
    );
  });

  it("fails when there is no report", async () => {
    const post = vi.fn(async () => ({}));
    await expect(
      runLinearTriageJob(
        {
          thread: { post },
          ticket: { issueId: "ENG-2" },
          conversationKey: "test:linear-triage-1",
          runId: "lt-fail",
        },
        async () => ({
          agentText: "I looked around and gave up",
          assistantText: "I looked around and gave up",
        }),
        {
          postToLinear: async () => {
            throw new Error("should not post");
          },
        },
      ),
    ).rejects.toThrow(/without a report/i);
  });

  it("throws when conversationKey is missing", async () => {
    await expect(
      runLinearTriageJob({
        thread: { post: vi.fn(async () => ({})) },
        ticket: { issueId: "ENG-5", title: "Bug" },
        runId: "lt-no-key",
        conversationKey: "",
      }),
    ).rejects.toThrow(/conversationKey/i);
  });

  it("passes conversationKey to the runner", async () => {
    const runner = vi.fn(async () => ({
      agentText: "REPORT_OK",
      assistantText: "REPORT_OK",
      report: "## Summary\nBug is X.",
    }));
    await runLinearTriageJob(
      {
        thread: { post: vi.fn(async () => ({})) },
        ticket: { issueId: "ENG-5", title: "Bug" },
        conversationKey: "slack:C:lt",
        runId: "lt-key-1",
      },
      runner,
      {
        postToLinear: async () => ({
          issue: {
            id: "u",
            identifier: "ENG-5",
            title: "Bug",
            url: "https://linear.app/x/issue/ENG-5",
          },
          comment: { id: "c", url: "https://linear.app/x/comment/c" },
        }),
      },
    );
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: "slack:C:lt" }),
    );
  });
});
