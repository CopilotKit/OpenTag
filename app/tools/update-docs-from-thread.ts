/**
 * `update_docs_from_thread` — docs PR from thread feedback.
 *
 * Posts "On it" immediately, starts the sandbox job in the background, and
 * returns STARTED at once. The job posts the PR in this thread when ready.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineChannelTool } from "@copilotkit/channels";
import {
  runDocsPrJob,
  type DocsPrSandboxRunner,
} from "../sandbox/docs-pr-job.js";
import type { ThreadMessageForDocs } from "../sandbox/docs-pr-prompt.js";
import { runInBackground } from "./background-job.js";

export type { ThreadMessageForDocs };

let jobImpl: typeof runDocsPrJob = runDocsPrJob;

export function __setDocsPrJobForTests(
  impl: typeof runDocsPrJob | null,
): void {
  jobImpl = impl ?? runDocsPrJob;
}

export const updateDocsFromThreadTool = defineChannelTool({
  name: "update_docs_from_thread",
  description:
    "Update CopilotKit showcase docs from this Slack thread's feedback and open a PR. " +
    "Posts 'On it' immediately, starts Codex in a Daytona sandbox in the background, and returns STARTED. " +
    "The job posts the PR in this thread when ready (several minutes). " +
    "Call when the user wants docs updated from thread feedback. " +
    "Do not invent a PR URL.",
  parameters: z.object({
    note: z
      .string()
      .max(2000)
      .optional()
      .describe(
        "Optional extra instructions for the docs agent (focus area, tone).",
      ),
  }),
  async handler(args, { thread }) {
    const raw = await thread.getMessages();
    const messages: ThreadMessageForDocs[] = raw.map((m) => ({
      user: m.user?.name ?? m.user?.handle ?? (m.isBot ? "bot" : "unknown"),
      text: m.text,
      ts: m.ts,
    }));

    try {
      await thread.post(
        "On it — starting a docs PR from this thread in a Daytona sandbox " +
          "(CopilotKit/CopilotKit `showcase/`). This can take several minutes; " +
          "I'll post the PR link here when ready.",
      );
    } catch (error) {
      console.error("[update_docs_from_thread] status post failed", error);
    }

    const runId = randomUUID();
    runInBackground("docs-pr", () =>
      jobImpl({
        thread,
        messages,
        requestNote: args.note,
        // channels-ui Thread type omits conversationKey; concrete Thread has it.
        conversationKey:
          (thread as { conversationKey?: string }).conversationKey ?? "",
        runId,
      }),
    );
    return `STARTED. Docs PR job runId=${runId}. I will post the PR in this thread when it is ready.`;
  },
});

/** @internal tests */
export function __runDocsPrJobWithRunner(
  input: Parameters<typeof runDocsPrJob>[0],
  runner: DocsPrSandboxRunner,
) {
  return runDocsPrJob(input, runner);
}
