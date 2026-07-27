/**
 * Reconciles OpenTag's production Railway topology: one Python agent and one
 * Intelligence-connected Channel host, both deployed from `main`. Platform
 * credentials and attachments stay in Intelligence, so Railway owns only the
 * application services and their private AG-UI connection.
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
    build: { builder: "NIXPACKS" },
    deploy: {
      startCommand: "uvicorn main:app --host :: --port ${PORT:-8123}",
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

  const channel = service("channel", {
    source: github(REPO, { branch: BRANCH }),
    start: "pnpm channel",
    // render_chart and render_diagram launch Playwright's Chromium binary.
    // Keep the browser in the deploy artifact and install its shared libraries
    // in the runtime image; Railpack otherwise drops build-layer apt packages.
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm exec playwright install chromium",
    },
    deploy: {
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

  return project("opentag", { resources: [agent, channel] });
});
