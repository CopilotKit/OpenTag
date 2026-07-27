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
    },
  });

  return project("opentag", { resources: [agent, channel] });
});
