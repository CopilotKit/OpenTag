/**
 * `launch_promo_video` — session-aware promo/launch video via Grok Build + HyperFrames.
 *
 * Posts "On it", starts the render job in the background, and returns STARTED
 * at once. The job posts the mp4 in this thread when it finishes.
 * `done=true` still awaits session teardown.
 */
import { z } from "zod";
import { defineChannelTool } from "@copilotkit/channels";
import { runPromoVideoJob } from "../sandbox/promo-video-job.js";
import { runInBackground } from "./background-job.js";

let jobImpl: typeof runPromoVideoJob = runPromoVideoJob;

export function __setPromoVideoJobForTests(
  impl: typeof runPromoVideoJob | null,
): void {
  jobImpl = impl ?? runPromoVideoJob;
}

const parameters = z
  .object({
    prompt: z
      .string()
      .optional()
      .describe(
        "Brief: PR URL, feature notes, markdown, or feedback for a follow-up. Required unless done is true.",
      ),
    prUrl: z
      .string()
      .optional()
      .describe("Optional explicit GitHub PR URL if not in prompt."),
    done: z
      .boolean()
      .optional()
      .describe(
        "True when the user is finished (done / ship it / kill sandbox). Destroys the sandbox.",
      ),
  })
  .superRefine((val, ctx) => {
    if (val.done) return;
    if (!val.prompt?.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "prompt is required unless done is true",
        path: ["prompt"],
      });
    }
  });

export const launchPromoVideoTool = defineChannelTool({
  name: "launch_promo_video",
  description:
    "Generate or refine a 1:1 CopilotKit-branded promo/launch video in a Daytona sandbox " +
    "(Grok Build + HyperFrames). Call with a PR URL or freeform brief. " +
    "Posts 'On it', returns STARTED at once, and the job posts the mp4 in this thread " +
    "when ready (several minutes). Reuses the same sandbox for feedback. " +
    "Set done=true when the user is finished. Do not invent a video file.",
  parameters,
  async handler(args, { thread }) {
    if (args.done) {
      const result = await jobImpl({
        thread: thread as never,
        prompt: args.prompt?.trim() || "done",
        done: true,
      });
      return result.detail;
    }

    const prompt = args.prompt!.trim();
    try {
      await thread.post(
        "On it — starting a promo video in a Daytona sandbox " +
          "(Grok Build + HyperFrames, 1:1). This can take several minutes; " +
          "I'll post the mp4 here when ready.",
      );
    } catch (error) {
      console.error("[launch_promo_video] status post failed", error);
    }

    runInBackground("promo-video", () =>
      jobImpl({
        thread: thread as never,
        prompt,
        prUrl: args.prUrl,
      }),
    );
    return "STARTED. Promo video job is running. I will post the mp4 in this thread when it is ready.";
  },
});
