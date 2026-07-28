import type {
  AgentContentPart,
  ChannelTool,
  ContextEntry,
  IncomingMessage,
  PlatformUser,
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
export function managedRunInput(message: IncomingMessage) {
  return {
    prompt: promptFromMessage(message),
    ...platformRunInput(message.platform, message.user),
  };
}

export function platformRunInput(
  platform: string,
  user: PlatformUser | undefined,
): {
  tools?: ChannelTool[];
  context: ContextEntry[];
} {
  const slack = platform === "slack";

  return {
    ...(slack ? { tools: [...defaultSlackTools] } : {}),
    context: [
      ...(slack ? defaultSlackContext : []),
      ...senderContext(user, platform),
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
