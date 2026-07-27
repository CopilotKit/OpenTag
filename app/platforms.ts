import type {
  ChannelTool,
  ContextEntry,
  PlatformAdapter,
} from "@copilotkit/channels";
import {
  defaultSlackContext,
  defaultSlackTools,
  slack,
} from "@copilotkit/channels/slack";
import { teams } from "@copilotkit/channels/teams";
import type { AppEnvironment } from "./env.js";

export interface PlatformSetup {
  adapters: PlatformAdapter[];
  tools: ChannelTool[];
  context: ContextEntry[];
}

export function resolvePlatforms(env: AppEnvironment): PlatformSetup {
  const adapters: PlatformAdapter[] = [];
  const tools: ChannelTool[] = [];
  const context: ContextEntry[] = [];

  if (env.slackBotToken && env.slackAppToken) {
    adapters.push(
      slack({
        botToken: env.slackBotToken,
        appToken: env.slackAppToken,
        showToolStatus: false,
        respondTo: {
          directMessages: true,
          appMentions: { reply: "thread" },
          threadReplies: "mentionsOnly",
        },
        assistant: {
          greeting: "Hi! I can triage issues, search docs, and more.",
          suggestedPrompts: [
            {
              title: "Triage my open issues",
              message: "Triage my open issues",
            },
            {
              title: "What shipped this week?",
              message: "Summarize what shipped this week",
            },
          ],
        },
      }),
    );
    tools.push(...defaultSlackTools);
    context.push(...defaultSlackContext);
  }

  if (env.teamsClientId && env.teamsClientSecret) {
    adapters.push(
      teams({
        clientId: env.teamsClientId,
        clientSecret: env.teamsClientSecret,
        tenantId: env.teamsTenantId,
        port: env.teamsPort,
      }),
    );
  }

  if (adapters.length === 0) {
    tools.push(...defaultSlackTools);
    context.push(...defaultSlackContext);
  }

  return { adapters, tools, context };
}
