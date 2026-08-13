import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventType } from "@ag-ui/core";
import { memoryStream } from "@tanstack/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetOpentagSqlitePersistenceForTests } from "../opentag-persistence.js";
import { runPrMergeJob } from "../pr-merge-job.js";
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

function gitMock(merge: { dirty: boolean; conflictFiles: string[] }) {
  return {
    fetchBase: vi.fn(async () => {}),
    checkoutHead: vi.fn(async () => {}),
    mergeBase: vi.fn(async () => merge),
    commitMergeIfNeeded: vi.fn(async () => {}),
    pushHead: vi.fn(async () => {}),
  };
}

describe("runPrMergeJob", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pr-merge-job-"));
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

  it("clean merge: no Codex, push same branch, Slack merged base", async () => {
    const post = vi.fn(async () => ({}));
    const git = gitMock({ dirty: false, conflictFiles: [] });
    const runCodex = vi.fn(async () => {
      throw new Error("Codex must not run on a clean merge");
    });

    const result = await runPrMergeJob(
      {
        thread: { post },
        target: {
          kind: "pr",
          owner: "CopilotKit",
          repo: "CopilotKit",
          number: 3895,
        },
        conversationKey: "slack:C:merge",
        runId: "merge-clean-1",
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

    expect(result.prUrl).toBe(openPr.htmlUrl);
    expect(result.dirty).toBe(false);
    expect(runCodex).not.toHaveBeenCalled();
    expect(git.pushHead).toHaveBeenCalledWith("feat/foo");
    expect(post).toHaveBeenCalledWith(expect.stringContaining("Merged `main`"));
    expect(post).toHaveBeenCalledWith(expect.stringContaining("/pull/3895"));
  });

  it("dirty merge: Codex runs with the conflict prompt, then push", async () => {
    const post = vi.fn(async () => ({}));
    const git = gitMock({ dirty: true, conflictFiles: ["src/a.ts"] });
    const runCodex = vi.fn(async (input: { prompt: string }) => {
      expect(input.prompt).toContain("src/a.ts");
      expect(input.prompt).not.toMatch(/gh pr create/i);
      return { agentText: "RESOLVED 1 files." };
    });

    const result = await runPrMergeJob(
      {
        thread: { post },
        target: {
          kind: "pr",
          owner: "CopilotKit",
          repo: "CopilotKit",
          number: 3895,
        },
        conversationKey: "slack:C:merge",
        runId: "merge-dirty-1",
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

    expect(result.dirty).toBe(true);
    expect(runCodex).toHaveBeenCalledOnce();
    expect(git.pushHead).toHaveBeenCalledWith("feat/foo");
    expect(post).toHaveBeenCalledWith(
      expect.stringMatching(/Resolved 1 files, pushed/i),
    );
  });

  it("fork / closed PR: FAILED, no push", async () => {
    const post = vi.fn(async () => ({}));
    const git = gitMock({ dirty: false, conflictFiles: [] });
    const runCodex = vi.fn(async () => ({ agentText: "" }));

    await expect(
      runPrMergeJob(
        {
          thread: { post },
          target: {
            kind: "pr",
            owner: "CopilotKit",
            repo: "CopilotKit",
            number: 9,
          },
          conversationKey: "slack:C:merge",
          runId: "merge-fork-1",
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
    expect(git.pushHead).not.toHaveBeenCalled();
    expect(runCodex).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(expect.stringMatching(/^FAILED:/));
  });

  it("merges a same-repo PR that is not in the CopilotKit org", async () => {
    const post = vi.fn(async () => ({}));
    const git = gitMock({ dirty: false, conflictFiles: [] });
    const seen: string[] = [];
    const otherPr: CopilotKitPr = {
      number: 51,
      repo: "AlemTuzlak/OpenTag",
      htmlUrl: "https://github.com/AlemTuzlak/OpenTag/pull/51",
      state: "open",
      baseRef: "main",
      headRef: "feat/sandboxes",
      headRepo: "AlemTuzlak/OpenTag",
      isFork: false,
    };

    const result = await runPrMergeJob(
      {
        thread: { post },
        target: {
          kind: "pr",
          owner: "AlemTuzlak",
          repo: "OpenTag",
          number: 51,
        },
        conversationKey: "slack:C:merge",
        runId: "merge-other-org",
      },
      {
        readPr: async (repo, number) => {
          seen.push(`${repo}#${number}`);
          return otherPr;
        },
        git,
        runCodex: async () => {
          throw new Error("Codex must not run on a clean merge");
        },
        verifyHead: async (input) => ({
          ok: true,
          prUrl: otherPr.htmlUrl,
          number: 51,
          headRef: "feat/sandboxes",
          headRepo: input.repo,
        }),
      },
    );

    expect(seen).toEqual(["AlemTuzlak/OpenTag#51"]);
    expect(result.prUrl).toBe(otherPr.htmlUrl);
    expect(git.pushHead).toHaveBeenCalledWith("feat/sandboxes");
    expect(post).not.toHaveBeenCalledWith(expect.stringMatching(/CopilotKit org/i));
  });

  it("closed PR: FAILED, no push", async () => {
    const post = vi.fn(async () => ({}));
    const git = gitMock({ dirty: false, conflictFiles: [] });
    const runCodex = vi.fn(async () => ({ agentText: "" }));

    await expect(
      runPrMergeJob(
        {
          thread: { post },
          target: {
            kind: "pr",
            owner: "CopilotKit",
            repo: "CopilotKit",
            number: 8,
          },
          conversationKey: "slack:C:merge",
          runId: "merge-closed-1",
        },
        {
          readPr: async () => ({ ...openPr, number: 8, state: "closed" }),
          git,
          runCodex,
        },
      ),
    ).rejects.toThrow(/closed/i);
    expect(git.pushHead).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(expect.stringMatching(/^FAILED:/));
  });

  it("does not call verifyCopilotKitPrUrl with notBeforeMs", () => {
    expect(String(runPrMergeJob)).not.toMatch(/notBeforeMs/);
  });

  it("does not import verifyCopilotKitPrUrl", () => {
    const src = readFileSync(
      join(process.cwd(), "app/sandbox/pr-merge-job.ts"),
      "utf8",
    );
    expect(src).not.toContain("verifyCopilotKitPrUrl");
    expect(src).not.toContain("notBeforeMs");
  });

  it("throws when conversationKey is missing", async () => {
    await expect(
      runPrMergeJob({
        thread: { post: vi.fn(async () => ({})) },
        target: {
          kind: "pr",
          owner: "CopilotKit",
          repo: "CopilotKit",
          number: 1,
        },
        conversationKey: "",
        runId: "merge-no-key",
      }),
    ).rejects.toThrow(/conversationKey/i);
  });

  it("destroys the sandbox after push, not before, on a clean merge", async () => {
    const order: string[] = [];
    const post = vi.fn(async () => ({}));
    const git = gitMock({ dirty: false, conflictFiles: [] });
    git.pushHead = vi.fn(async () => {
      order.push("push");
    });
    const destroySandbox = vi.fn(async () => {
      order.push("destroy");
    });

    await runPrMergeJob(
      {
        thread: { post },
        target: {
          kind: "pr",
          owner: "CopilotKit",
          repo: "CopilotKit",
          number: 3895,
        },
        conversationKey: "slack:C:merge",
        runId: "merge-destroy-clean",
      },
      {
        readPr: async () => openPr,
        git,
        runCodex: async () => {
          throw new Error("Codex must not run on a clean merge");
        },
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

    expect(destroySandbox).toHaveBeenCalledOnce();
    expect(order).toEqual(["push", "destroy"]);
  });

  it("destroys the sandbox after Codex and push on a dirty merge", async () => {
    const order: string[] = [];
    const git = gitMock({ dirty: true, conflictFiles: ["src/a.ts"] });
    git.pushHead = vi.fn(async () => {
      order.push("push");
    });
    const runCodex = vi.fn(async () => {
      order.push("codex");
      return { agentText: "RESOLVED 1 files." };
    });
    const destroySandbox = vi.fn(async () => {
      order.push("destroy");
    });

    await runPrMergeJob(
      {
        thread: { post: vi.fn(async () => ({})) },
        target: {
          kind: "pr",
          owner: "CopilotKit",
          repo: "CopilotKit",
          number: 3895,
        },
        conversationKey: "slack:C:merge",
        runId: "merge-destroy-dirty",
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

    expect(order).toEqual(["codex", "push", "destroy"]);
  });

  it("destroys the sandbox when verify fails after push", async () => {
    const order: string[] = [];
    const git = gitMock({ dirty: false, conflictFiles: [] });
    git.pushHead = vi.fn(async () => {
      order.push("push");
    });
    const destroySandbox = vi.fn(async () => {
      order.push("destroy");
    });

    await expect(
      runPrMergeJob(
        {
          thread: { post: vi.fn(async () => ({})) },
          target: {
            kind: "pr",
            owner: "CopilotKit",
            repo: "CopilotKit",
            number: 3895,
          },
          conversationKey: "slack:C:merge",
          runId: "merge-destroy-fail",
        },
        {
          readPr: async () => openPr,
          git,
          runCodex: async () => ({ agentText: "" }),
          verifyHead: async () => ({
            ok: false,
            reason: "PR is closed",
          }),
          destroySandbox,
        },
      ),
    ).rejects.toThrow(/closed/i);

    expect(order).toEqual(["push", "destroy"]);
  });

  it("status after dirty merge shows host pushed the original PR, not Codex do-not-push", async () => {
    const conversationKey = "slack:C:merge-status-push";
    const runId = "merge-status-host-push";
    const git = gitMock({ dirty: true, conflictFiles: ["src/a.ts"] });
    const runCodex = vi.fn(async (input: { runId: string }) => {
      await memoryStream({ runId: input.runId }).append([
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "codex-1",
          delta:
            "RESOLVED 4 files. Left the merge commit ready for the host to push. Do not push. The host pushes.",
        },
      ]);
      return { agentText: "RESOLVED 4 files." };
    });

    await runPrMergeJob(
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

    expect(git.pushHead).toHaveBeenCalledWith("feat/foo");
    const result = await readSandboxJobsForSlackThread(conversationKey);
    expect(result.jobs).toHaveLength(1);
    const job = result.jobs[0]!;
    expect(job.status).toBe("completed");
    expect(job.recentText).toMatch(/pushed/i);
    expect(job.recentText).toContain(openPr.htmlUrl);
    expect(job.recentText).not.toMatch(/ready for the host to push/i);
  });

  it("registers a SQLite run before chat so status can see a pre-chat failure", async () => {
    const post = vi.fn(async () => ({}));
    await expect(
      runPrMergeJob(
        {
          thread: { post },
          target: {
            kind: "pr",
            owner: "CopilotKit",
            repo: "CopilotKit",
            number: 8,
          },
          conversationKey: "slack:C:merge",
          runId: "merge-status-pre-chat",
        },
        {
          readPr: async () => ({ ...openPr, number: 8, state: "closed" }),
          git: gitMock({ dirty: false, conflictFiles: [] }),
          runCodex: async () => ({ agentText: "" }),
        },
      ),
    ).rejects.toThrow(/closed/i);

    const result = await readSandboxJobsForSlackThread("slack:C:merge");
    expect(result.jobs).toHaveLength(1);
    const job = result.jobs[0]!;
    expect(job.kind).toBe("copilotkit");
    expect(job.status).toBe("failed");
    expect(job.runId).toBe("merge-status-pre-chat");
    expect(job.error).toMatch(/closed/i);
  });
});
