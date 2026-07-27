import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

interface RailwayVariable {
  type: "literal" | "preserve";
  value?: string;
}

interface RailwayResource {
  name: string;
  source?: {
    repo?: string;
    branch?: string;
    rootDirectory?: string;
  };
  build?: {
    builder?: string;
    buildCommand?: string;
  };
  deploy?: {
    startCommand?: string;
    healthcheckPath?: string;
  };
  variables?: Record<string, RailwayVariable>;
}

function evaluateRailwayGraph(): RailwayResource[] {
  const stdout = execFileSync(
    process.execPath,
    ["node_modules/railway/dist/iac/bin.js"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
  const result = JSON.parse(stdout) as {
    ok: boolean;
    diagnostics: unknown[];
    graph: { resources: RailwayResource[] };
  };
  expect(result.ok).toBe(true);
  expect(result.diagnostics).toEqual([]);
  return result.graph.resources;
}

describe("Railway deployment graph", () => {
  it("ships exactly the Python agent and Chromium-capable channel services", () => {
    const resources = evaluateRailwayGraph();
    expect(resources.map(({ name }) => name).sort()).toEqual([
      "agent",
      "channel",
    ]);

    const agent = resources.find(({ name }) => name === "agent");
    expect(agent).toMatchObject({
      source: {
        repo: "CopilotKit/OpenTag",
        branch: "main",
        rootDirectory: "agent",
      },
      deploy: {
        healthcheckPath: "/health",
      },
    });

    const channel = resources.find(({ name }) => name === "channel");
    expect(channel).toMatchObject({
      source: {
        repo: "CopilotKit/OpenTag",
        branch: "main",
      },
      build: {
        builder: "RAILPACK",
        buildCommand: "pnpm exec playwright install chromium",
      },
      deploy: {
        startCommand: "pnpm channel",
      },
      variables: {
        AGENT_URL: {
          type: "literal",
          value:
            "http://${{agent.RAILWAY_PRIVATE_DOMAIN}}:${{agent.PORT}}/",
        },
        INTELLIGENCE_API_KEY: { type: "preserve" },
        INTELLIGENCE_API_URL: {
          type: "literal",
          value: "https://api.intelligence.copilotkit.ai",
        },
        INTELLIGENCE_GATEWAY_WS_URL: {
          type: "literal",
          value: "wss://realtime.intelligence.copilotkit.ai",
        },
        INTELLIGENCE_CHANNEL_NAME: {
          type: "literal",
          value: "kite",
        },
        PLAYWRIGHT_BROWSERS_PATH: {
          type: "literal",
          value: "0",
        },
        RAILPACK_DEPLOY_APT_PACKAGES: {
          type: "literal",
          value: expect.stringContaining("libnss3"),
        },
      },
    });
  });
});
