import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLinearFixJob } from "../linear-fix-job.js";

describe("runLinearFixJob", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "linear-fix-job-"));
    prev = process.env.LINEAR_FIX_RUNS_DIR;
    process.env.LINEAR_FIX_RUNS_DIR = dir;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.LINEAR_FIX_RUNS_DIR;
    else process.env.LINEAR_FIX_RUNS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("posts the PR URL when the runner succeeds and verify accepts it", async () => {
    const post = vi.fn(async () => ({}));
    const result = await runLinearFixJob(
      {
        thread: { post },
        ticket: {
          issueId: "ENG-99",
          title: "Bug",
          description: "Broken",
        },
        conversationKey: "test:linear-fix-1",
        runId: "lf-success-1",
      },
      async () => ({
        agentText:
          "Opened https://github.com/CopilotKit/CopilotKit/pull/200",
        prUrl: "https://github.com/CopilotKit/CopilotKit/pull/200",
      }),
      {
        verifyPr: async (url) => ({
          ok: true,
          prUrl: url,
          number: 200,
          title: "[ENG-99] fix",
          headRef: "fix/eng-99",
          headRepo: "CopilotKit/CopilotKit",
          author: "bot",
          createdAt: new Date().toISOString(),
        }),
      },
    );

    expect(result.prUrl).toContain("/pull/200");
    expect(result.issueId).toBe("ENG-99");
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining("ENG-99"),
    );
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining("pull/200"),
    );
  });

  it("posts a failure when no PR URL is found", async () => {
    const post = vi.fn(async () => ({}));
    await expect(
      runLinearFixJob(
        {
          thread: { post },
          ticket: { issueId: "ENG-1" },
          conversationKey: "test:linear-fix-1",
          runId: "lf-fail-1",
        },
        async () => ({ agentText: "FAILED: could not reproduce" }),
        {
          verifyPr: async () => {
            throw new Error("verify should not run");
          },
        },
      ),
    ).rejects.toThrow(/without a PR URL/i);

    expect(post).toHaveBeenCalledWith(
      expect.stringContaining("could not find a CopilotKit PR URL"),
    );
  });

  it("throws when conversationKey is missing", async () => {
    await expect(
      runLinearFixJob({
        thread: { post: vi.fn(async () => ({})) },
        ticket: { issueId: "ENG-99", title: "Bug", description: "Broken" },
        runId: "lf-no-key",
        conversationKey: "",
      }),
    ).rejects.toThrow(/conversationKey/i);
  });

  it("passes conversationKey to the runner", async () => {
    const runner = vi.fn(async () => ({
      agentText: "Opened https://github.com/CopilotKit/CopilotKit/pull/200",
      prUrl: "https://github.com/CopilotKit/CopilotKit/pull/200",
    }));
    await runLinearFixJob(
      {
        thread: { post: vi.fn(async () => ({})) },
        ticket: { issueId: "ENG-99", title: "Bug", description: "Broken" },
        conversationKey: "slack:C:lf",
        runId: "lf-key-1",
      },
      runner,
      {
        verifyPr: async (url) => ({
          ok: true,
          prUrl: url,
          number: 200,
          title: "[ENG-99] fix",
          headRef: "fix/eng-99",
          headRepo: "CopilotKit/CopilotKit",
          author: "bot",
          createdAt: new Date().toISOString(),
        }),
      },
    );
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: "slack:C:lf" }),
    );
  });
});
