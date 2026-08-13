import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventType } from "@ag-ui/core";
import { memoryStream } from "@tanstack/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetOpentagSqlitePersistenceForTests } from "../opentag-persistence.js";
import { runPrFixJob } from "../pr-fix-job.js";
import type { CopilotKitPr } from "../pr-merge-job.js";
import { readSandboxJobsForSlackThread } from "../sandbox-job-status.js";

const openPr: CopilotKitPr = {
  number: 3895,
  repo: "CopilotKit/CopilotKit",
  htmlUrl: "https://github.com/CopilotKit/CopilotKit/pull/3895",
  state: "open",
  baseRef: "main",
  headRef: "feat/foo",
  headRepo: "CopilotKit/CopilotKit",
  isFork: false,
};

function gitMock(input?: {
  before?: string;
  after?: string;
}) {
  const before = input?.before ?? "aaa111";
  const after = input?.after ?? "bbb222";
  let head = before;
  return {
    revParseHead: vi.fn(async () => head),
    advanceHead() {
      head = after;
    },
  };
}

describe("runPrFixJob", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pr-fix-job-"));
    prev = process.env.COPILOTKIT_RUNS_DIR;
    process.env.COPILOTKIT_RUNS_DIR = dir;
    process.env.OPENTAG_SQLITE_URL = ":memory:";
    __resetOpentagSqlitePersistenceForTests();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.COPILOTKIT_RUNS_DIR;
    else process.env.COPILOTKIT_RUNS_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
    __resetOpentagSqlitePersistenceForTests();
    delete process.env.OPENTAG_SQLITE_URL;
  });

  it("runs Codex with the note and succeeds when HEAD moved, even if leftover files are dirty", async () => {
    const post = vi.fn(async () => ({}));
    const git = gitMock();
    const runCodex = vi.fn(async (input: { prompt: string }) => {
      expect(input.prompt).toContain("fix the red CI");
      expect(input.prompt).toContain("git push origin HEAD:feat/foo");
      expect(input.prompt).not.toMatch(/failing check/i);
      git.advanceHead();
      return { agentText: "FIXED the type error. Pushed." };
    });
    const verifyHead = vi.fn(async () => ({
      ok: true as const,
      prUrl: openPr.htmlUrl,
      number: 3895,
      headRef: "feat/foo",
      headRepo: "CopilotKit/CopilotKit",
    }));

    const result = await runPrFixJob(
      {
        thread: { post },
        target: {
          kind: "pr",
          owner: "CopilotKit",
          repo: "CopilotKit",
          number: 3895,
        },
        note: "fix the red CI",
        conversationKey: "slack:C:fix",
        runId: "fix-ok-1",
      },
      {
        readPr: async () => openPr,
        git,
        runCodex,
        verifyHead,
      },
    );

    expect(result.prUrl).toBe(openPr.htmlUrl);
    expect(runCodex).toHaveBeenCalledOnce();
    expect(verifyHead).toHaveBeenCalledWith(
      expect.objectContaining({
        headRef: "feat/foo",
        expectedSha: "bbb222",
      }),
    );
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining("Pushed to the original PR"),
    );
    expect(post).toHaveBeenCalledWith(expect.stringContaining("/pull/3895"));
  });

  it("fails loud and does not push when Codex makes no commit", async () => {
    const post = vi.fn(async () => ({}));
    const git = gitMock({ after: "aaa111" });
    const runCodex = vi.fn(async () => ({ agentText: "nothing to do" }));

    await expect(
      runPrFixJob(
        {
          thread: { post },
          target: {
            kind: "pr",
            owner: "CopilotKit",
            repo: "CopilotKit",
            number: 3895,
          },
          conversationKey: "slack:C:fix",
          runId: "fix-no-commit",
        },
        {
          readPr: async () => openPr,
          git,
          runCodex,
        },
      ),
    ).rejects.toThrow(/no commit/i);
    expect(post).toHaveBeenCalledWith(expect.stringMatching(/^FAILED:/));
  });

  it("fails loud when Codex committed locally but did not push", async () => {
    const post = vi.fn(async () => ({}));
    const git = gitMock();
    const runCodex = vi.fn(async () => {
      git.advanceHead();
      return { agentText: "committed, no push" };
    });

    await expect(
      runPrFixJob(
        {
          thread: { post },
          target: {
            kind: "pr",
            owner: "CopilotKit",
            repo: "CopilotKit",
            number: 3895,
          },
          conversationKey: "slack:C:fix",
          runId: "fix-no-push",
        },
        {
          readPr: async () => openPr,
          git,
          runCodex,
          verifyHead: async () => ({
            ok: false,
            reason:
              "PR #3895 head sha is aaa111, expected bbb222",
          }),
        },
      ),
    ).rejects.toThrow(/head sha/i);
    expect(post).toHaveBeenCalledWith(expect.stringMatching(/^FAILED:/));
  });

  it("fork / closed PR: FAILED, no Codex, no push", async () => {
    const post = vi.fn(async () => ({}));
    const git = gitMock();
    const runCodex = vi.fn(async () => ({ agentText: "" }));

    await expect(
      runPrFixJob(
        {
          thread: { post },
          target: {
            kind: "pr",
            owner: "CopilotKit",
            repo: "CopilotKit",
            number: 9,
          },
          conversationKey: "slack:C:fix",
          runId: "fix-fork-1",
        },
        {
          readPr: async () => ({
            ...openPr,
            number: 9,
            isFork: true,
            headRepo: "someone/CopilotKit",
          }),
          git,
          runCodex,
        },
      ),
    ).rejects.toThrow(/fork/i);
    expect(runCodex).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(expect.stringMatching(/^FAILED:/));

    post.mockClear();
    await expect(
      runPrFixJob(
        {
          thread: { post },
          target: {
            kind: "pr",
            owner: "CopilotKit",
            repo: "CopilotKit",
            number: 8,
          },
          conversationKey: "slack:C:fix",
          runId: "fix-closed-1",
        },
        {
          readPr: async () => ({ ...openPr, number: 8, state: "closed" }),
          git,
          runCodex,
        },
      ),
    ).rejects.toThrow(/closed/i);
    expect(runCodex).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(expect.stringMatching(/^FAILED:/));
  });

  it("does not merge the base, fetch GitHub checks, or host-push", () => {
    const src = readFileSync(
      join(process.cwd(), "app/sandbox/pr-fix-job.ts"),
      "utf8",
    );
    expect(src).not.toContain("fetchBase");
    expect(src).not.toContain("mergeBase");
    expect(src).not.toContain("check-runs");
    expect(src).not.toContain("workflow-runs");
    expect(src).not.toContain("notBeforeMs");
    expect(src).not.toContain("verifyCopilotKitPrUrl");
    expect(src).not.toContain("pushHead");
    expect(src).not.toContain("statusPorcelain");
    expect(src).not.toContain("uncommitted changes");
  });

  it("throws when conversationKey is missing", async () => {
    await expect(
      runPrFixJob({
        thread: { post: vi.fn(async () => ({})) },
        target: {
          kind: "pr",
          owner: "CopilotKit",
          repo: "CopilotKit",
          number: 1,
        },
        conversationKey: "",
        runId: "fix-no-key",
      }),
    ).rejects.toThrow(/conversationKey/i);
  });

  it("destroys the sandbox after Codex finishes", async () => {
    const order: string[] = [];
    const git = gitMock();
    const runCodex = vi.fn(async () => {
      order.push("codex");
      git.advanceHead();
      return { agentText: "FIXED. Pushed." };
    });
    const destroySandbox = vi.fn(async () => {
      order.push("destroy");
    });

    await runPrFixJob(
      {
        thread: { post: vi.fn(async () => ({})) },
        target: {
          kind: "pr",
          owner: "CopilotKit",
          repo: "CopilotKit",
          number: 3895,
        },
        conversationKey: "slack:C:fix",
        runId: "fix-destroy",
      },
      {
        readPr: async () => openPr,
        git,
        runCodex,
        verifyHead: async () => ({
          ok: true,
          prUrl: openPr.htmlUrl,
          number: 3895,
          headRef: "feat/foo",
          headRepo: "CopilotKit/CopilotKit",
        }),
        destroySandbox,
      },
    );

    expect(order).toEqual(["codex", "destroy"]);
  });

  it("status after Codex push shows the original PR, not do-not-push text", async () => {
    const conversationKey = "slack:C:fix-status-push";
    const runId = "fix-status-codex-push";
    const git = gitMock();
    const runCodex = vi.fn(async (input: { runId: string }) => {
      git.advanceHead();
      await memoryStream({ runId: input.runId }).append([
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "codex-1",
          delta:
            "FIXED. Pushed to origin HEAD:feat/foo with GITHUB_TOKEN.",
        },
      ]);
      return { agentText: "FIXED. Pushed." };
    });

    await runPrFixJob(
      {
        thread: { post: vi.fn(async () => ({})) },
        target: {
          kind: "pr",
          owner: "CopilotKit",
          repo: "CopilotKit",
          number: 3895,
        },
        conversationKey,
        runId,
      },
      {
        readPr: async () => openPr,
        git,
        runCodex,
        verifyHead: async () => ({
          ok: true,
          prUrl: openPr.htmlUrl,
          number: 3895,
          headRef: "feat/foo",
          headRepo: "CopilotKit/CopilotKit",
        }),
      },
    );

    const result = await readSandboxJobsForSlackThread(conversationKey);
    expect(result.jobs).toHaveLength(1);
    const job = result.jobs[0]!;
    expect(job.status).toBe("completed");
    expect(job.recentText).toMatch(/pushed/i);
    expect(job.recentText).toContain(openPr.htmlUrl);
    expect(job.recentText).not.toMatch(/ready for the host to push/i);
  });
});
