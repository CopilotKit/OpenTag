import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../sandbox/promo-video-job.js", () => ({
  runPromoVideoJob: vi.fn(async (input: { done?: boolean }) => {
    if (input.done) {
      return { status: "ended", detail: "session ended" };
    }
    throw new Error("job must not be awaited");
  }),
}));

import { launchPromoVideoTool } from "../launch-promo-video.js";
import * as job from "../../sandbox/promo-video-job.js";

type HandlerCtx = Parameters<typeof launchPromoVideoTool.handler>[1];

function makeCtx(): HandlerCtx {
  return {
    platform: "slack",
    thread: {
      conversationKey: "slack:C:1.2",
      post: vi.fn(async () => ({ ok: true })),
      postFile: vi.fn(async () => ({ ok: true, fileId: "F" })),
      getMessages: vi.fn(async () => []),
    },
  } as unknown as HandlerCtx;
}

describe("launch_promo_video", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts on it and starts the job in the background", async () => {
    const ctx = makeCtx();
    const out = await launchPromoVideoTool.handler(
      { prompt: "https://github.com/CopilotKit/OpenTag/pull/8 make a video" },
      ctx,
    );
    expect(String(out)).toMatch(/STARTED/i);
    expect(job.runPromoVideoJob).toHaveBeenCalled();
    expect(ctx.thread.post).toHaveBeenCalledWith(
      expect.stringContaining("Daytona"),
    );
    expect(ctx.thread.post).toHaveBeenCalledWith(
      expect.stringContaining("Grok Build"),
    );
  });

  it("ends when done=true without prompt", async () => {
    const ctx = makeCtx();
    const out = await launchPromoVideoTool.handler({ done: true }, ctx);
    expect(String(out)).toMatch(/end/i);
    expect(job.runPromoVideoJob).toHaveBeenCalledWith(
      expect.objectContaining({ done: true }),
    );
  });
});
