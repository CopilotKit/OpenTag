import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDocsPrJob } from "../docs-pr-job.js";

describe("runDocsPrJob", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docs-pr-job-"));
    prev = process.env.DOCS_PR_RUNS_DIR;
    process.env.DOCS_PR_RUNS_DIR = dir;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.DOCS_PR_RUNS_DIR;
    else process.env.DOCS_PR_RUNS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("posts the PR URL when the runner succeeds and verify accepts it", async () => {
    const post = vi.fn(async () => ({}));
    const result = await runDocsPrJob(
      {
        thread: { post },
        messages: [{ user: "Ada", text: "fix the docs" }],
        conversationKey: "test:docs-pr-1",
        runId: "job-success-1",
      },
      async () => ({
        agentText:
          "Opened https://github.com/CopilotKit/CopilotKit/pull/99",
        prUrl: "https://github.com/CopilotKit/CopilotKit/pull/99",
      }),
      {
        verifyPr: async (url) => ({
          ok: true,
          prUrl: url,
          number: 99,
          title: "docs",
          headRef: "docs/x",
          headRepo: "CopilotKit/CopilotKit",
          author: "bot",
          createdAt: new Date().toISOString(),
        }),
      },
    );

    expect(result.prUrl).toBe(
      "https://github.com/CopilotKit/CopilotKit/pull/99",
    );
    expect(result.runId).toBe("job-success-1");
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining(
        "https://github.com/CopilotKit/CopilotKit/pull/99",
      ),
    );
  });

  it("posts a failure when no PR URL is found", async () => {
    const post = vi.fn(async () => ({}));
    await expect(
      runDocsPrJob(
        {
          thread: { post },
          messages: [{ user: "Ada", text: "fix the docs" }],
          conversationKey: "test:docs-pr-1",
          runId: "job-fail-1",
        },
        async () => ({ agentText: "I forgot the URL" }),
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

  it("rejects a stale scraped PR URL even if present in agent text", async () => {
    const post = vi.fn(async () => ({}));
    await expect(
      runDocsPrJob(
        {
          thread: { post },
          messages: [{ user: "Ada", text: "fix the docs" }],
          conversationKey: "test:docs-pr-1",
          runId: "job-stale-1",
        },
        async () => ({
          agentText:
            "See https://github.com/CopilotKit/CopilotKit/pull/5705 in RAILWAY.md",
          assistantText:
            "See https://github.com/CopilotKit/CopilotKit/pull/5705 in RAILWAY.md",
          prUrl: "https://github.com/CopilotKit/CopilotKit/pull/5705",
        }),
        {
          verifyPr: async () => ({
            ok: false,
            reason:
              "PR #5705 is closed, not open (likely a pre-existing / docs-scraped link)",
          }),
        },
      ),
    ).rejects.toThrow(/failed verification/i);

    expect(post).toHaveBeenCalledWith(
      expect.stringContaining("accepted as a new open PR"),
    );
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining("pull/5705"),
    );
  });

  it("throws when conversationKey is missing", async () => {
    await expect(
      runDocsPrJob({
        thread: { post: vi.fn(async () => ({})) },
        messages: [{ user: "Ada", text: "fix the docs" }],
        runId: "job-no-key",
        conversationKey: "",
      }),
    ).rejects.toThrow(/conversationKey/i);
  });

  it("passes conversationKey to the runner", async () => {
    const runner = vi.fn(async () => ({
      agentText: "Opened https://github.com/CopilotKit/CopilotKit/pull/99",
      prUrl: "https://github.com/CopilotKit/CopilotKit/pull/99",
    }));
    await runDocsPrJob(
      {
        thread: { post: vi.fn(async () => ({})) },
        messages: [{ user: "Ada", text: "fix the docs" }],
        conversationKey: "slack:C:docs",
        runId: "job-key-1",
      },
      runner,
      {
        verifyPr: async (url) => ({
          ok: true,
          prUrl: url,
          number: 99,
          title: "docs",
          headRef: "docs/x",
          headRepo: "CopilotKit/CopilotKit",
          author: "bot",
          createdAt: new Date().toISOString(),
        }),
      },
    );
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: "slack:C:docs" }),
    );
  });
});
