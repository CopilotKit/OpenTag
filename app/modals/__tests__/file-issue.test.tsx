import { describe, it, expect, vi } from "vitest";
import { renderToIR, type ChannelNode } from "@copilotkit/channels";
import {
  defaultSlackContext,
  defaultSlackTools,
} from "@copilotkit/channels/slack";
import {
  FileIssueModal,
  fileIssueSubmit,
  issueFromValues,
  FILE_ISSUE_CALLBACK,
} from "../file-issue.js";

function tags(node: ChannelNode | unknown, acc: string[] = []): string[] {
  if (!node || typeof node !== "object") return acc;
  const n = node as ChannelNode;
  if (typeof n.type === "string") acc.push(n.type);
  for (const c of (n.props?.children as ChannelNode[] | undefined) ?? []) {
    tags(c, acc);
  }
  return acc;
}

describe("FileIssueModal", () => {
  it("rich variant (Slack) includes selects and radios", () => {
    const ir = renderToIR(
      FileIssueModal({ rich: true, sourcePlatform: "slack" }),
    );
    const root = ir[0]!;
    const t = tags(root);
    expect(root.type).toBe("modal");
    expect(root.props.callbackId).toBe(FILE_ISSUE_CALLBACK);
    expect(root.props.privateMetadata).toBe("slack");
    expect(t).toContain("modal_text_input");
    expect(t).toContain("modal_select");
    expect(t).toContain("modal_radio");
  });

  it("text-only variant drops selects and radios", () => {
    const ir = renderToIR(
      FileIssueModal({ rich: false, sourcePlatform: "teams" }),
    );
    const root = ir[0]!;
    const t = tags(root);
    expect(t).not.toContain("modal_select");
    expect(t).not.toContain("modal_radio");
    expect(t.filter((x) => x === "modal_text_input").length).toBe(2);
  });
});

describe("issueFromValues", () => {
  it("reads submitted values", () => {
    expect(
      issueFromValues({
        title: "Login broken",
        description: "500 on submit",
        type: "bug",
        priority: "High",
      }),
    ).toEqual({
      title: "Login broken",
      description: "500 on submit",
      type: "bug",
      priority: "High",
    });
  });

  it("applies defaults when optional controls were absent", () => {
    expect(issueFromValues({ title: "X", description: "Y" })).toEqual({
      title: "X",
      description: "Y",
      type: "bug",
      priority: "Medium",
    });
  });
});

describe("fileIssueSubmit", () => {
  it("returns a title error and does not run the agent on a blank title", async () => {
    const thread = { runAgent: vi.fn(() => new Promise<void>(() => {})) };
    const result = await fileIssueSubmit({
      values: { title: "" },
      thread,
      user: { id: "U1" },
    } as never);
    expect(result).toEqual({ errors: { title: expect.any(String) } });
    expect(thread.runAgent).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only title as blank", async () => {
    const thread = { runAgent: vi.fn(() => new Promise<void>(() => {})) };
    const result = await fileIssueSubmit({
      values: { title: "   ", description: "x" },
      thread,
      user: { id: "U1" },
    } as never);
    expect(result).toEqual({ errors: { title: expect.any(String) } });
    expect(thread.runAgent).not.toHaveBeenCalled();
  });

  it("resolves immediately even though runAgent never settles (fire-and-forget)", async () => {
    // A never-resolving runAgent: if the handler awaited it, this would hang and
    // the test would time out — that is the regression guard for the ~3s ack bug.
    const thread = { runAgent: vi.fn(() => new Promise<void>(() => {})) };
    await expect(
      fileIssueSubmit({
        values: { title: "T", description: "D", type: "bug", priority: "High" },
        thread,
        user: { id: "U1" },
      } as never),
    ).resolves.toBeUndefined();
    expect(thread.runAgent).toHaveBeenCalledTimes(1);
  });

  it("acks without running the agent when there is no thread", async () => {
    await expect(
      fileIssueSubmit({
        values: { title: "T", description: "D" },
        thread: undefined,
        user: { id: "U1" },
      } as never),
    ).resolves.toBeUndefined();
  });

  it("uses the command's managed Slack origin for defaults and sender context on submit", async () => {
    const runAgent = vi.fn(
      (_input?: { prompt: string; tools?: unknown; context: unknown }) =>
        new Promise<void>(() => {}),
    );
    const thread = { runAgent, platform: "intelligence" };
    const user = { id: "U1", name: "Ada Lovelace", email: "ada@example.com" };
    await fileIssueSubmit({
      values: {
        title: "Login broken",
        description: "500 on submit",
        type: "bug",
        priority: "High",
      },
      thread,
      user,
      privateMetadata: "slack",
    } as never);

    expect(runAgent).toHaveBeenCalledTimes(1);
    const call = runAgent.mock.calls[0]![0]!;
    expect(call.prompt).toContain("- Title: Login broken");
    expect(call.prompt).toContain("- Type: bug");
    expect(call.prompt).toContain("- Priority: High");
    expect(call.prompt).toContain("- Description: 500 on submit");
    expect(call.prompt).toContain("confirm_write");
    expect(call.prompt).not.toContain("already confirmed");
    expect(call.tools).toEqual(defaultSlackTools);
    expect(call.context).toEqual([
      ...defaultSlackContext,
      {
        description: "Requesting slack user",
        value: "Ada Lovelace <ada@example.com> (slack id U1)",
      },
    ]);
  });

  it("posts a failure message to the thread when runAgent rejects", async () => {
    const post = vi.fn().mockResolvedValue({ id: "m1" });
    const thread = {
      runAgent: vi.fn(() => Promise.reject(new Error("LLM timeout"))),
      post,
    };
    await fileIssueSubmit({
      values: { title: "T", description: "D", type: "bug", priority: "High" },
      thread,
      user: { id: "U1" },
    } as never);
    // Let the fire-and-forget .catch() run before asserting.
    await new Promise((r) => setTimeout(r, 0));
    expect(post).toHaveBeenCalledWith(
      expect.stringMatching(/couldn.t file|try again/i),
    );
  });
});
