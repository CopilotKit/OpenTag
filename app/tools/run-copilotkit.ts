import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineChannelTool } from "@copilotkit/channels";
import { parseCopilotkitTarget } from "../sandbox/copilotkit-target.js";
import { runPrMergeJob } from "../sandbox/pr-merge-job.js";
import { runPrFixJob } from "../sandbox/pr-fix-job.js";
import { runLinearFixJob } from "../sandbox/linear-fix-job.js";
import { runLinearTriageJob } from "../sandbox/linear-triage-job.js";
import { resolveTicketContext } from "./linear-ticket-args.js";
import { runInBackground } from "./background-job.js";

let mergeImpl = runPrMergeJob;
let prFixImpl = runPrFixJob;
let fixImpl = runLinearFixJob;
let triageImpl = runLinearTriageJob;

export function __setPrMergeJobForRunCopilotkit(
  impl: typeof runPrMergeJob | null,
) {
  mergeImpl = impl ?? runPrMergeJob;
}
export function __setPrFixJobForRunCopilotkit(
  impl: typeof runPrFixJob | null,
) {
  prFixImpl = impl ?? runPrFixJob;
}
export function __setLinearFixJobForRunCopilotkit(
  impl: typeof runLinearFixJob | null,
) {
  fixImpl = impl ?? runLinearFixJob;
}
export function __setLinearTriageJobForRunCopilotkit(
  impl: typeof runLinearTriageJob | null,
) {
  triageImpl = impl ?? runLinearTriageJob;
}

export async function dispatchRunCopilotkit(
  args: {
    action: "merge_main" | "review_pr" | "fix" | "investigate";
    target: string;
    note?: string;
    title?: string;
    description?: string;
    url?: string;
    status?: string;
    priority?: string;
    labels?: string[];
    agentContext?: string;
  },
  thread: {
    post: (content: string) => Promise<unknown>;
    conversationKey?: string;
  },
): Promise<string> {
  const parsed = parseCopilotkitTarget(args.target);
  if (!parsed.ok) throw new Error(parsed.reason);

  const conversationKey = thread.conversationKey ?? "";
  const runId = randomUUID();

  if (args.action === "review_pr") {
    return "not shipped yet: review_pr";
  }
  if (args.action === "fix" && parsed.target.kind === "gh-issue") {
    return "not shipped yet: GitHub issue fix";
  }

  if (args.action === "fix" && parsed.target.kind === "pr") {
    try {
      await thread.post(
        `On it — fixing \`${parsed.target.repo}#${parsed.target.number}\` in Daytona.`,
      );
    } catch (error) {
      console.error("[run_copilotkit] status post failed", error);
    }
    const target = parsed.target;
    const result = await prFixImpl({
      thread,
      target,
      note: args.note,
      conversationKey,
      runId,
    });
    return `Pushed to the original PR\n${result.prUrl}`;
  }

  if (args.action === "merge_main") {
    if (parsed.target.kind !== "pr") {
      throw new Error("merge_main needs a CopilotKit pull request target");
    }
    try {
      await thread.post(
        `On it — merging \`${parsed.target.repo}#${parsed.target.number}\` base into the PR head in Daytona.`,
      );
    } catch (error) {
      console.error("[run_copilotkit] status post failed", error);
    }
    const target = parsed.target;
    const result = await mergeImpl({
      thread,
      target,
      note: args.note,
      conversationKey,
      runId,
    });
    return result.dirty
      ? `Resolved ${result.conflictFiles.length} files, pushed.\n${result.prUrl}`
      : `Pushed to the original PR\n${result.prUrl}`;
  }

  if (args.action === "fix" || args.action === "investigate") {
    if (parsed.target.kind !== "linear") {
      throw new Error(`${args.action} needs a Linear ticket id`);
    }
    const ticket = await resolveTicketContext({
      issueId: parsed.target.issueId,
      title: args.title,
      description: args.description,
      url: args.url,
      status: args.status,
      priority: args.priority,
      labels: args.labels,
      agentContext: args.agentContext,
      note: args.note,
    });
    const verb = args.action === "fix" ? "fixing" : "investigating";
    try {
      await thread.post(
        `On it — ${verb} Linear \`${ticket.issueId}\` now.`,
      );
    } catch (error) {
      console.error("[run_copilotkit] status post failed", error);
    }
    const job = args.action === "fix" ? fixImpl : triageImpl;
    runInBackground(
      args.action === "fix" ? "linear-fix" : "linear-triage",
      () =>
        job({
          thread,
          ticket,
          conversationKey,
          runId,
        }),
    );
    return `STARTED. Linear ${args.action} for ${ticket.issueId} runId=${runId}.`;
  }

  throw new Error(`Unsupported action: ${args.action}`);
}

export const runCopilotkitTool = defineChannelTool({
  name: "run_copilotkit",
  description:
    "Do CopilotKit org work in Daytona + Codex. " +
    "action=merge_main merges the PR base into a same-repo CopilotKit PR head. " +
    "action=fix on a PR number/URL/repo#n clones that PR head, does what note says (CI, PR feedback / review comments, or other asked work), and Codex pushes the same branch with GITHUB_TOKEN. " +
    "action=fix on a Linear id (CPK-7204) implements a fix and opens a new PR. " +
    "action=investigate on a Linear id triages with no PR. " +
    "action=review_pr and GitHub-issue fix are not shipped yet. " +
    "target is 3895, a PR URL, repo#n, or a Linear id. " +
    "Call ASAP. merge_main and fix+PR post On it, wait until the original PR URL is ready, and return it. " +
    "Linear fix/investigate post On it and return STARTED.",
  parameters: z.object({
    action: z.enum(["merge_main", "review_pr", "fix", "investigate"]),
    target: z.string().min(1).max(500),
    note: z.string().max(2000).optional(),
  }),
  async handler(args, { thread }) {
    return dispatchRunCopilotkit(args, thread);
  },
});
