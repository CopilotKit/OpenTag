import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinearFixJobInput } from "../../sandbox/linear-fix-job.js";
import type { LinearTriageJobInput } from "../../sandbox/linear-triage-job.js";
import type { PrFixJobInput } from "../../sandbox/pr-fix-job.js";
import type { PrMergeJobInput } from "../../sandbox/pr-merge-job.js";
import {
  __setLinearFixJobForRunCopilotkit,
  __setLinearTriageJobForRunCopilotkit,
  __setPrFixJobForRunCopilotkit,
  __setPrMergeJobForRunCopilotkit,
  dispatchRunCopilotkit,
} from "../run-copilotkit.js";

const PR_URL = "https://github.com/CopilotKit/CopilotKit/pull/3895";

function thread() {
  return {
    post: vi.fn(async () => ({})),
    conversationKey: "slack:C:ck",
  };
}

describe("run_copilotkit tool", () => {
  afterEach(() => {
    __setPrMergeJobForRunCopilotkit(null);
    __setPrFixJobForRunCopilotkit(null);
    __setLinearFixJobForRunCopilotkit(null);
    __setLinearTriageJobForRunCopilotkit(null);
  });

  it("awaits merge and returns the host push of the original PR", async () => {
    let finished = false;
    const calls: PrMergeJobInput[] = [];
    __setPrMergeJobForRunCopilotkit(async (input) => {
      calls.push(input);
      await Promise.resolve();
      finished = true;
      return {
        runId: input.runId ?? "merge-1",
        prUrl: PR_URL,
        dirty: true,
        conflictFiles: ["src/a.ts"],
      };
    });
    const slack = thread();

    const result = await dispatchRunCopilotkit(
      { action: "merge_main", target: "3895" },
      slack,
    );

    expect(finished).toBe(true);
    expect(result).not.toMatch(/STARTED/i);
    expect(result).toMatch(/pushed/i);
    expect(result).toContain(PR_URL);
    expect(slack.post).toHaveBeenCalledWith(expect.stringContaining("On it"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      conversationKey: "slack:C:ck",
      runId: expect.any(String),
      target: {
        kind: "pr",
        owner: "CopilotKit",
        repo: "CopilotKit",
        number: 3895,
      },
    });
  });

  it("surfaces a merge failure in the same turn", async () => {
    __setPrMergeJobForRunCopilotkit(async () => {
      throw new Error("PR #8 is closed");
    });

    await expect(
      dispatchRunCopilotkit(
        { action: "merge_main", target: "3895" },
        thread(),
      ),
    ).rejects.toThrow(/closed/i);
  });

  it("awaits PR fix and returns the original PR after Codex push", async () => {
    let finished = false;
    const calls: PrFixJobInput[] = [];
    __setPrFixJobForRunCopilotkit(async (input) => {
      calls.push(input);
      await Promise.resolve();
      finished = true;
      return { runId: input.runId ?? "fix-1", prUrl: PR_URL };
    });
    const slack = thread();

    const result = await dispatchRunCopilotkit(
      { action: "fix", target: "3895", note: "fix the red CI" },
      slack,
    );

    expect(finished).toBe(true);
    expect(result).not.toMatch(/STARTED/i);
    expect(result).toContain("Pushed to the original PR");
    expect(result).toContain(PR_URL);
    expect(slack.post).toHaveBeenCalledWith(expect.stringContaining("On it"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      conversationKey: "slack:C:ck",
      runId: expect.any(String),
      note: "fix the red CI",
      target: {
        kind: "pr",
        owner: "CopilotKit",
        repo: "CopilotKit",
        number: 3895,
      },
    });
  });

  it("does not start Linear fix when the target is a PR", async () => {
    let linearStarted = false;
    __setLinearFixJobForRunCopilotkit(async () => {
      linearStarted = true;
      throw new Error("Linear fix must not start");
    });
    __setPrFixJobForRunCopilotkit(async () => ({
      runId: "fix-1",
      prUrl: PR_URL,
    }));

    await dispatchRunCopilotkit(
      { action: "fix", target: "3895", note: "fix the red CI" },
      thread(),
    );
    expect(linearStarted).toBe(false);
  });

  it("routes Linear fix and investigate to the old job functions", async () => {
    const fixCalls: LinearFixJobInput[] = [];
    const triageCalls: LinearTriageJobInput[] = [];
    let prFixStarted = false;
    __setPrFixJobForRunCopilotkit(async () => {
      prFixStarted = true;
      throw new Error("PR fix must not start for Linear");
    });
    __setLinearFixJobForRunCopilotkit(async (input) => {
      fixCalls.push(input);
      return {
        runId: "fix-1",
        prUrl: "https://github.com/CopilotKit/CopilotKit/pull/1",
        agentText: "",
        logDir: "/tmp",
        issueId: "CPK-7204",
      };
    });
    __setLinearTriageJobForRunCopilotkit(async (input) => {
      triageCalls.push(input);
      return {
        runId: "triage-1",
        issueId: "CPK-7204",
        report: "",
        agentText: "",
        logDir: "/tmp",
        linearIssue: {
          id: "1",
          identifier: "CPK-7204",
          title: "ticket",
          url: "",
        },
        linearComment: { id: "c1", url: "" },
      };
    });
    const slack = thread();

    await dispatchRunCopilotkit({ action: "fix", target: "CPK-7204" }, slack);
    expect(prFixStarted).toBe(false);
    expect(fixCalls[0]).toMatchObject({
      conversationKey: "slack:C:ck",
      ticket: expect.objectContaining({ issueId: "CPK-7204" }),
    });

    await dispatchRunCopilotkit(
      { action: "investigate", target: "CPK-7204" },
      slack,
    );
    expect(triageCalls[0]).toMatchObject({
      conversationKey: "slack:C:ck",
      ticket: expect.objectContaining({ issueId: "CPK-7204" }),
    });
  });

  it("returns not shipped yet for review_pr and GitHub-issue fix", async () => {
    let mergeStarted = false;
    let prFixStarted = false;
    __setPrMergeJobForRunCopilotkit(async () => {
      mergeStarted = true;
      throw new Error("merge must not start");
    });
    __setPrFixJobForRunCopilotkit(async () => {
      prFixStarted = true;
      throw new Error("PR fix must not start");
    });
    const slack = thread();

    const review = await dispatchRunCopilotkit(
      { action: "review_pr", target: "3895" },
      slack,
    );
    expect(review).toMatch(/not shipped yet/i);
    expect(mergeStarted).toBe(false);
    expect(prFixStarted).toBe(false);

    const issueFix = await dispatchRunCopilotkit(
      {
        action: "fix",
        target: "https://github.com/CopilotKit/CopilotKit/issues/12",
      },
      slack,
    );
    expect(issueFix).toMatch(/not shipped yet/i);
  });

  it("starts a merge job for a PR outside CopilotKit", async () => {
    const calls: PrMergeJobInput[] = [];
    __setPrMergeJobForRunCopilotkit(async (input) => {
      calls.push(input);
      return {
        runId: input.runId ?? "merge-other",
        prUrl: "https://github.com/facebook/react/pull/1",
        dirty: false,
        conflictFiles: [],
      };
    });
    const result = await dispatchRunCopilotkit(
      {
        action: "merge_main",
        target: "https://github.com/facebook/react/pull/1",
      },
      thread(),
    );
    expect(result).toMatch(/pushed/i);
    expect(calls[0]?.target).toEqual({
      kind: "pr",
      owner: "facebook",
      repo: "react",
      number: 1,
    });
  });
});

