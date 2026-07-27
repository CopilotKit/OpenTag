import type {
  AgentContentPart,
  ContextEntry,
  IncomingMessage,
} from "@copilotkit/channels";
import { SanitizingHttpAgent } from "@copilotkit/channels/slack";
import { senderContext } from "./sender-context.js";

export function promptFromMessage(
  message: Pick<IncomingMessage, "contentParts" | "text">,
): string | AgentContentPart[] {
  return message.contentParts?.length ? message.contentParts : message.text;
}

export function buildAgentHeaders(
  authHeader?: string,
): { Authorization: string } | undefined {
  return authHeader ? { Authorization: authHeader } : undefined;
}

export function createAgentFactory(options: {
  url: string;
  authHeader?: string;
}): (threadId: string) => SanitizingHttpAgent {
  return (threadId) => {
    const agent = new SanitizingHttpAgent({
      url: options.url,
      headers: buildAgentHeaders(options.authHeader),
    });
    agent.threadId = threadId;
    return agent;
  };
}

export function mentionRunInput(
  message: IncomingMessage,
  transportPlatform: string,
): {
  prompt?: string | AgentContentPart[];
  context: ContextEntry[];
} {
  return {
    ...(transportPlatform === "intelligence"
      ? { prompt: promptFromMessage(message) }
      : {}),
    context: senderContext(message.user, message.platform),
  };
}
