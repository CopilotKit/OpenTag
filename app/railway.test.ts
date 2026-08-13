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
    watchPatterns?: string[] | null;
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
  it("ships the Python agent and Chromium-capable runtime services", () => {
    const resources = evaluateRailwayGraph();
    expect(resources.map(({ name }) => name).sort()).toEqual(["agent", "runtime"]);

    const agent = resources.find(({ name }) => name === "agent");
    expect(agent).toMatchObject({
      source: {
        repo: "CopilotKit/OpenTag",
        branch: "main",
        rootDirectory: "agent",
      },
      build: {
        builder: "RAILPACK",
      },
      deploy: {
        startCommand:
          'uvicorn main:app --host "" --port ${PORT:-8123}',
        healthcheckPath: "/health",
      },
    });
    expect(agent?.variables).toMatchObject({
      OPENAI_API_KEY: { type: "preserve" },
      TAVILY_API_KEY: { type: "preserve" },
      GITHUB_PERSONAL_ACCESS_TOKEN: { type: "preserve" },
      GITHUB_MCP_URL: { type: "preserve" },
      POSTHOG_PERSONAL_API_KEY: { type: "preserve" },
      POSTHOG_MCP_URL: { type: "preserve" },
      LINEAR_API_KEY: { type: "preserve" },
      NOTION_MCP_URL: { type: "preserve" },
      NOTION_MCP_AUTH_TOKEN: { type: "preserve" },
      PARALLEL_MCP_URL: { type: "preserve" },
    });

    const runtime = resources.find(({ name }) => name === "runtime");
    expect(runtime).toMatchObject({
      source: {
        repo: "CopilotKit/OpenTag",
        branch: "main",
      },
      build: {
        builder: "RAILPACK",
        buildCommand: "pnpm exec playwright install chromium",
        watchPatterns: [],
      },
      deploy: {
        startCommand: "pnpm runtime",
        healthcheckPath: "/api/copilotkit/info",
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
          value: "open-tag",
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
