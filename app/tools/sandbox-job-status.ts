import { z } from "zod";
import { defineChannelTool } from "@copilotkit/channels";
import { readSandboxJobsForSlackThread } from "../sandbox/sandbox-job-status.js";

export const sandboxJobStatusTool = defineChannelTool({
  name: "sandbox_job_status",
  description:
    "Read the current Slack thread's sandbox jobs (promo video, docs PR, " +
    "Linear fix, Linear triage, CopilotKit merge) from SQLite plus the live " +
    "in-process stream. Call this when the user asks how far along a " +
    "sandbox job is, or for progress / status of a video, docs PR, Linear " +
    "sandbox, or CopilotKit merge in this thread. Do not guess. Returns " +
    "run status plus a tail of recent text, thoughts, and tool names.",
  parameters: z.object({}),
  async handler(_args, { thread }) {
    // channels-ui Thread type omits conversationKey; concrete Thread has it.
    const key = (thread as { conversationKey?: string }).conversationKey?.trim();
    if (!key) {
      throw new Error("sandbox_job_status needs thread.conversationKey");
    }
    return readSandboxJobsForSlackThread(key);
  },
});
