/**
 * `investigate_linear_ticket` — alias of `run_copilotkit` with action=investigate.
 *
 * Kept so current callers still work. Prefer `run_copilotkit`.
 */
import { z } from "zod";
import { defineChannelTool } from "@copilotkit/channels";
import {
  runLinearTriageJob,
  type LinearTriageSandboxRunner,
} from "../sandbox/linear-triage-job.js";
import type { LinearTicketContext } from "../sandbox/linear-fix-prompt.js";
import {
  __setLinearTriageJobForRunCopilotkit,
  dispatchRunCopilotkit,
} from "./run-copilotkit.js";

export type { LinearTicketContext };

export function __setLinearTriageJobForTests(
  impl: typeof runLinearTriageJob | null,
): void {
  __setLinearTriageJobForRunCopilotkit(impl);
}

const ticketParams = {
  issueId: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "Linear issue identifier, e.g. CPK-7630. Enough by itself — the tool loads details from Linear if needed.",
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
  status: z.string().max(100).optional().describe("Optional status name."),
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
    .describe(
      "Optional extra research; Linear comments are fetched automatically.",
    ),
  note: z
    .string()
    .max(2000)
    .optional()
    .describe("Optional extra instructions for this triage run."),
};

export const investigateLinearTicketTool = defineChannelTool({
  name: "investigate_linear_ticket",
  description:
    "Alias of run_copilotkit with action=investigate. " +
    "Investigate and triage a Linear ticket WITHOUT fixing code or opening a PR. " +
    "Call ASAP with the issue id (e.g. CPK-7630) — do NOT stall on long MCP research; " +
    "the tool loads ticket details from Linear if missing. Posts 'On it' immediately, " +
    "returns STARTED, runs Codex in a Daytona sandbox (gpt-5.6-luna / xhigh) in the background, " +
    "and the job posts findings as a Linear comment and in Slack when ready. " +
    "Prefer run_copilotkit. For implement+PR use fix_linear_ticket instead.",
  parameters: z.object(ticketParams),
  async handler(args, { thread }) {
    return dispatchRunCopilotkit(
      {
        action: "investigate",
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
export function __runLinearTriageJobWithRunner(
  input: Parameters<typeof runLinearTriageJob>[0],
  runner: LinearTriageSandboxRunner,
) {
  return runLinearTriageJob(input, runner);
}
