/**
 * Shared helpers: build LinearTicketContext from tool args, optionally
 * enriching from the Linear API when the agent only passed an id.
 */
import {
  fetchLinearIssueDetails,
  type LinearIssueDetails,
} from "../sandbox/linear-client.js";
import type { LinearTicketContext } from "../sandbox/linear-fix-prompt.js";

export interface LinearTicketToolArgs {
  issueId: string;
  title?: string;
  description?: string;
  url?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  agentContext?: string;
  note?: string;
}

/**
 * If title/description are missing, load them from Linear so the agent can
 * call the tool immediately with only an issue id.
 */
export async function resolveTicketContext(
  args: LinearTicketToolArgs,
  options?: {
    fetchDetails?: (id: string) => Promise<LinearIssueDetails>;
  },
): Promise<LinearTicketContext> {
  const base: LinearTicketContext = {
    issueId: args.issueId.trim(),
    title: args.title,
    description: args.description,
    url: args.url,
    status: args.status,
    priority: args.priority,
    labels: args.labels,
    agentContext: args.agentContext,
    note: args.note,
  };

  const needsFetch =
    !base.title?.trim() ||
    !base.description?.trim() ||
    !base.url?.trim();

  if (!needsFetch) return base;

  try {
    const fetchDetails =
      options?.fetchDetails ?? ((id) => fetchLinearIssueDetails(id));
    const details = await fetchDetails(base.issueId);
    const commentsBlock =
      details.commentsSummary &&
      details.commentsSummary !== "(no comments)"
        ? `## Linear comments\n${details.commentsSummary}`
        : "";
    const mergedContext = [base.agentContext?.trim(), commentsBlock]
      .filter(Boolean)
      .join("\n\n");

    return {
      issueId: details.identifier || base.issueId,
      title: base.title?.trim() || details.title,
      description: base.description?.trim() || details.description,
      url: base.url?.trim() || details.url,
      status: base.status?.trim() || details.status,
      priority: base.priority?.trim() || details.priority,
      labels:
        base.labels && base.labels.length > 0
          ? base.labels
          : details.labels,
      agentContext: mergedContext || undefined,
      note: base.note,
    };
  } catch (error) {
    // Keep going with what the agent provided — sandbox can still run.
    console.warn(
      "[linear-ticket] could not enrich from Linear API",
      error instanceof Error ? error.message : error,
    );
    return base;
  }
}
