/**
 * Reconciles OpenTag's production Railway topology: a Python agent and the
 * CopilotRuntime process that embeds Channels. Platform credentials and
 * attachments stay in Intelligence.
 */
import { defineRailway, github, preserve, project, service } from "railway/iac";
import { createDatadogTopology, DD_ENABLED } from "./datadog.js";

const REPO = "CopilotKit/OpenTag";
const BRANCH = "main";

export default defineRailway((context) => {
  const datadog = createDatadogTopology(context, {
    enabled: DD_ENABLED,
    repository: REPO,
    branch: BRANCH,
  });

  const agent = service("agent", {
    source: github(REPO, {
      branch: BRANCH,
      rootDirectory: "agent",
    }),
    build: { builder: "RAILPACK" },
    deploy: {
      startCommand: 'uvicorn main:app --host "" --port ${PORT:-8123}',
      healthcheckPath: "/health",
      healthcheckTimeout: 300,
      restartPolicyMaxRetries: 5,
    },
    env: {
      PORT: "8123",
      OPENAI_API_KEY: preserve(),
      TAVILY_API_KEY: preserve(),
      GITHUB_PERSONAL_ACCESS_TOKEN: preserve(),
      GITHUB_MCP_URL: preserve(),
      POSTHOG_PERSONAL_API_KEY: preserve(),
      POSTHOG_MCP_URL: preserve(),
      LINEAR_API_KEY: preserve(),
      NOTION_MCP_URL: preserve(),
      NOTION_MCP_AUTH_TOKEN: preserve(),
      ...datadog.agentEnv,
    },
  });

  const runtime = service("runtime", {
    source: github(REPO, { branch: BRANCH }),
    start: "pnpm runtime",
    // Rich rendering needs Chromium and its runtime libraries.
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm exec playwright install chromium",
    },
    deploy: {
      healthcheckPath: "/api/copilotkit/info",
      healthcheckTimeout: 300,
      restartPolicyMaxRetries: 5,
    },
    env: {
      PORT: "3000",
      AGENT_URL: preserve(),
      CI: preserve(),
      DISCORD_APP_ID: preserve(),
      DISCORD_BOT_TOKEN: preserve(),
      DISCORD_GUILD_ID: preserve(),
      INTELLIGENCE_API_KEY: preserve(),
      INTELLIGENCE_API_URL: preserve(),
      INTELLIGENCE_GATEWAY_WS_URL: preserve(),
      INTELLIGENCE_CHANNEL_NAME: preserve(),
      LEFTHOOK: preserve(),
      LINEAR_API_KEY: preserve(),
      LINEAR_TEAM_KEY: preserve(),
      OPENAI_API_KEY: preserve(),
      PLAYWRIGHT_BROWSERS_PATH: preserve(),
      RAILPACK_DEPLOY_APT_PACKAGES: preserve(),
      SLACK_APP_TOKEN: preserve(),
      SLACK_BOT_TOKEN: preserve(),
      TELEGRAM_BOT_TOKEN: preserve(),
      WHATSAPP_ACCESS_TOKEN: preserve(),
      WHATSAPP_APP_SECRET: preserve(),
      WHATSAPP_PATH: preserve(),
      WHATSAPP_PHONE_NUMBER_ID: preserve(),
      WHATSAPP_PORT: preserve(),
      WHATSAPP_VERIFY_TOKEN: preserve(),
      npm_config_ignore_scripts: preserve(),
      ...datadog.runtimeEnv,
    },
  });

  return project("opentag", {
    resources: [agent, runtime, ...datadog.resources],
  });
});
