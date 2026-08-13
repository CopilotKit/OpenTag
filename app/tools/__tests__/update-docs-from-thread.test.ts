import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocsPrJobInput } from "../../sandbox/docs-pr-job.js";
import {
  __setDocsPrJobForTests,
  updateDocsFromThreadTool,
} from "../update-docs-from-thread.js";

describe("updateDocsFromThreadTool", () => {
  afterEach(() => {
    __setDocsPrJobForTests(null);
  });

  it("posts On it and starts the job in the background", async () => {
    const calls: DocsPrJobInput[] = [];
    const job = vi.fn(async (input: DocsPrJobInput) => {
      calls.push(input);
      throw new Error("job must not be awaited");
    });
    __setDocsPrJobForTests(job);

    const getMessages = vi.fn(async () => [
      {
        text: "please update the showcase docs",
        ts: "1",
        isBot: false,
        user: { name: "Ada" },
      },
    ]);
    const post = vi.fn(async () => ({}));
    const thread = {
      getMessages,
      post,
      conversationKey: "slack:C:docs",
    };

    const result = await updateDocsFromThreadTool.handler(
      { note: "focus on README" },
      { thread, platform: "slack" } as never,
    );

    expect(result).toMatch(/STARTED/i);
    expect(result).toMatch(/runId=/i);
    expect(post).toHaveBeenCalledWith(expect.stringContaining("docs PR"));
    expect(post).toHaveBeenCalledWith(expect.stringContaining("Daytona"));
    expect(job).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    const jobInput = calls[0]!;
    expect(jobInput.messages[0]?.text).toContain("update the showcase docs");
    expect(jobInput.requestNote).toBe("focus on README");
    expect(jobInput.conversationKey).toBe("slack:C:docs");
    expect(jobInput.runId).toBeTruthy();
  });

  it("returns STARTED even when the thread has no conversationKey", async () => {
    const job = vi.fn(async () => {
      throw new Error("job must not be awaited");
    });
    __setDocsPrJobForTests(job as never);
    const result = await updateDocsFromThreadTool.handler(
      {},
      {
        thread: {
          getMessages: vi.fn(async () => []),
          post: vi.fn(async () => ({})),
        },
        platform: "slack",
      } as never,
    );
    expect(result).toMatch(/STARTED/i);
    expect(job).toHaveBeenCalledWith(
      expect.objectContaining({ conversationKey: "" }),
    );
  });
});
