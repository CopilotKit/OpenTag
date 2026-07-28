/**
 * Reconciles OpenTag's production Railway topology: a Python agent and the
 * CopilotRuntime process that embeds Channels. Platform credentials and
 * attachments stay in Intelligence.
 */
import { defineRailway, github, preserve, project, service } from "railway/iac";

const REPO = "CopilotKit/OpenTag";
const BRANCH = "main";

export default defineRailway(() => {
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
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    env: {
      PORT: "8123",
      OPENAI_API_KEY: preserve(),
      TAVILY_API_KEY: preserve(),
      LINEAR_API_KEY: preserve(),
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
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    env: {
      PORT: "3000",
      AGENT_URL:
        "http://${{agent.RAILWAY_PRIVATE_DOMAIN}}:${{agent.PORT}}/",
      INTELLIGENCE_API_KEY: preserve(),
      INTELLIGENCE_API_URL: "https://api.intelligence.copilotkit.ai",
      INTELLIGENCE_GATEWAY_WS_URL:
        "wss://realtime.intelligence.copilotkit.ai",
      INTELLIGENCE_CHANNEL_NAME: "kite",
      PLAYWRIGHT_BROWSERS_PATH: "0",
      RAILPACK_DEPLOY_APT_PACKAGES:
        "fonts-liberation fonts-noto-color-emoji fonts-unifont libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libfontconfig1 libfreetype6 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxrender1 libxshmfence1",
    },
  });

  return project("opentag", { resources: [agent, runtime] });
});
