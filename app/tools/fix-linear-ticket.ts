/**
 * `fix_linear_ticket` — alias of `run_copilotkit` with action=fix.
 *
 * Kept so current callers still work. Prefer `run_copilotkit`.
 */
import { z } from "zod";
import { defineChannelTool } from "@copilotkit/channels";
import {
  runLinearFixJob,
  type LinearFixSandboxRunner,
} from "../sandbox/linear-fix-job.js";
import type { LinearTicketContext } from "../sandbox/linear-fix-prompt.js";
import {
  __setLinearFixJobForRunCopilotkit,
  dispatchRunCopilotkit,
} from "./run-copilotkit.js";

export type { LinearTicketContext };

export function __setLinearFixJobForTests(
  impl: typeof runLinearFixJob | null,
): void {
  __setLinearFixJobForRunCopilotkit(impl);
}

export const fixLinearTicketTool = defineChannelTool({
  name: "fix_linear_ticket",
  description:
    "Alias of run_copilotkit with action=fix. " +
    "Investigate and fix a Linear ticket in a Daytona sandbox with Codex, then open a GitHub PR. " +
    "Call ASAP with the issue id (e.g. CPK-7630) — do NOT stall on long MCP research; " +
    "the tool loads ticket details from Linear if missing. Posts 'On it' immediately, " +
    "returns STARTED, and the job posts the PR in this thread when ready (several minutes). " +
    "Prefer run_copilotkit. For triage-only (no PR) use investigate_linear_ticket.",
  parameters: z.object({
    issueId: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "Linear issue identifier, e.g. CPK-7630. Enough by itself — details are loaded if omitted.",
      ),
    title: z
      .string()
      .max(500)
      .optional()
      .describe("Optional; loaded from Linear if omitted."),
    description: z
      .string()
      .max(20000)
      .optional()
      .describe("Optional; loaded from Linear if omitted."),
    url: z.string().max(500).optional().describe("Optional Linear issue URL."),
    status: z.string().max(100).optional().describe("Optional status."),
    priority: z.string().max(50).optional().describe("Optional priority."),
    labels: z
      .array(z.string().max(80))
      .max(30)
      .optional()
      .describe("Optional labels."),
    agentContext: z
      .string()
      .max(30000)
      .optional()
      .describe("Optional extra research."),
    note: z
      .string()
      .max(2000)
      .optional()
      .describe("Optional extra instructions for this fix run."),
  }),
  async handler(args, { thread }) {
    return dispatchRunCopilotkit(
      {
        action: "fix",
        target: args.issueId,
        note: args.note,
        title: args.title,
        description: args.description,
        url: args.url,
        status: args.status,
        priority: args.priority,
        labels: args.labels,
        agentContext: args.agentContext,
      },
      thread,
    );
  },
});

/** @internal tests */
export function __runLinearFixJobWithRunner(
  input: Parameters<typeof runLinearFixJob>[0],
  runner: LinearFixSandboxRunner,
) {
  return runLinearFixJob(input, runner);
}
