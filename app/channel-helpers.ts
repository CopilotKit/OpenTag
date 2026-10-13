import type {
  AgentContentPart,
  ChannelTool,
  ContextEntry,
  IncomingMessage,
  ProviderActor,
} from "@copilotkit/channels";
import {
  defaultSlackContext,
  defaultSlackTools,
} from "@copilotkit/channels/slack";
import { senderContext } from "./sender-context.js";

/**
 * Managed history does not include the in-flight turn, so pass it explicitly.
 * Multimodal content parts take precedence over the text fallback.
 */
export function promptFromMessage(
  message: Pick<IncomingMessage, "contentParts" | "text">,
): string | AgentContentPart[] {
  return message.contentParts?.length ? message.contentParts : message.text;
}

/**
 * Add only the source platform's defaults. Intelligence is the transport;
 * `message.platform` is the originating provider (`slack` or `teams`).
 */
export function managedRunInput(
  message: IncomingMessage,
  conditionalTools: ChannelTool[] = [],
) {
  return {
    prompt: promptFromMessage(message),
    ...platformRunInput(message.platform, message.actor, conditionalTools),
  };
}

export function platformRunInput(
  platform: string,
  actor: ProviderActor | undefined,
  conditionalTools: ChannelTool[] = [],
): {
  tools?: ChannelTool[];
  context: ContextEntry[];
} {
  const slack = platform === "slack";
  const tools = [
    ...(slack ? defaultSlackTools : []),
    ...conditionalTools,
  ];

  return {
    ...(tools.length > 0 ? { tools } : {}),
    context: [
      ...(slack ? defaultSlackContext : []),
      ...senderContext(actor, platform),
    ],
  };
}

export function reportRecoverableError(
  error: unknown,
  context: { operation: string; recovery: string },
): void {
  console.error("[channel] recoverable error", {
    error: error instanceof Error ? error : new Error(String(error)),
    context,
    timestamp: new Date().toISOString(),
  });
}

const TOKEN_RE = /(ghp|github_pat|gho)_[A-Za-z0-9_]+/g;

function errorText(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map(errorText).join(" ");
  }
  if (error instanceof Error) {
    const cause =
      error.cause instanceof Error ? ` ${error.cause.message}` : "";
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error ?? "");
}

function sanitizeReason(raw: string): string {
  const firstLine = raw.split("\n")[0]?.replace(TOKEN_RE, "$1_[redacted]") ?? "";
  const compact = firstLine.replace(/\s+/g, " ").trim();
  if (compact.length <= 180) {
    return compact;
  }
  return `${compact.slice(0, 177)}...`;
}

const GITHUB_PR_RE =
  /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const GITHUB_ISSUE_RE =
  /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/g;

export function githubPrUrls(text: string | undefined): string[] {
  if (!text) {
    return [];
  }
  return [...new Set(text.match(GITHUB_PR_RE) ?? [])];
}

export function githubIssueUrls(text: string | undefined): string[] {
  if (!text) {
    return [];
  }
  return [...new Set(text.match(GITHUB_ISSUE_RE) ?? [])];
}

function runFollowUpHint(sourceText?: string): string {
  const prUrls = githubPrUrls(sourceText);
  if (prUrls.length) {
    return ` Open ${prUrls.join(" or ")}. The work may already be done.`;
  }
  const issueUrls = githubIssueUrls(sourceText);
  if (issueUrls.length) {
    return (
      ` The job may still be running. Check ${issueUrls.join(" or ")} ` +
      `for a new draft PR. I cannot confirm one from here.`
    );
  }
  return " The job may still be running. I cannot confirm a PR from here.";
}

/** Short Slack text for a failed agent run. Do not dump stacks. */
export function userFacingRunError(
  error: unknown,
  extras: { sourceText?: string } = {},
): string {
  const raw = errorText(error);
  const text = raw.toLowerCase();
  const followUp = runFollowUpHint(extras.sourceText);

  if (text.includes("durably deliver runner events")) {
    return (
      "Slack cut the live update after about a minute. " +
      "I cannot show the last result here." +
      followUp
    );
  }
  if (
    text.includes("econnreset") ||
    text.includes("other side closed") ||
    text.includes("und_err_socket") ||
    /\bterminated\b/.test(text)
  ) {
    return "The connection to the agent dropped." + followUp;
  }
  if (text.includes("recursion limit") || text.includes("graphrecursionerror")) {
    return "The agent stopped after too many steps. Ask again with a smaller job.";
  }
  if (
    text.includes("body timeout") ||
    text.includes("und_err_body_timeout")
  ) {
    return "The agent reply took too long to arrive." + followUp;
  }
  if (text.includes("packet path is closed")) {
    return "Slack closed the message path." + followUp;
  }

  const reason = sanitizeReason(raw);
  if (reason && reason !== "Error") {
    return `I hit an error: ${reason}. Please try again.`;
  }
  return "I hit an error handling that. Please try again.";
}
