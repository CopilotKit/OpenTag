import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createRailwayContext,
  projectDefinitionToGraph,
  type RailwayGraph,
} from "railway/iac";
import {
  createDatadogTopology,
  datadogEnvironmentFor,
} from "../.railway/datadog.js";
import { createOpenTagProject } from "../.railway/railway.js";

const ORIGINAL_KITE_RESOURCES = [
  {
    address: "service.agent",
    type: "service",
    kind: "github",
    name: "agent",
    source: {
      type: "github",
      repo: "CopilotKit/OpenTag",
      branch: "main",
      rootDirectory: "agent",
    },
    build: { builder: "RAILPACK" },
    deploy: {
      startCommand: 'uvicorn main:app --host "" --port ${PORT:-8123}',
      healthcheckPath: "/health",
      healthcheckTimeout: 300,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    variables: {
      PORT: { type: "literal", value: "8123" },
      OPENAI_API_KEY: { type: "preserve" },
      TAVILY_API_KEY: { type: "preserve" },
      GITHUB_PERSONAL_ACCESS_TOKEN: { type: "preserve" },
      GITHUB_MCP_URL: { type: "preserve" },
      POSTHOG_PERSONAL_API_KEY: { type: "preserve" },
      POSTHOG_MCP_URL: { type: "preserve" },
      LINEAR_API_KEY: { type: "preserve" },
      NOTION_MCP_URL: { type: "preserve" },
      NOTION_MCP_AUTH_TOKEN: { type: "preserve" },
    },
  },
  {
    address: "service.runtime",
    type: "service",
    kind: "github",
    name: "runtime",
    source: {
      type: "github",
      repo: "CopilotKit/OpenTag",
      branch: "main",
    },
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm exec playwright install chromium",
      watchPatterns: [],
    },
    deploy: {
      healthcheckPath: "/api/copilotkit/info",
      healthcheckTimeout: 300,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
      startCommand: "pnpm runtime",
    },
    variables: {
      PORT: { type: "literal", value: "3000" },
      AGENT_URL: {
        type: "literal",
        value: "http://${{agent.RAILWAY_PRIVATE_DOMAIN}}:${{agent.PORT}}/",
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
      INTELLIGENCE_CHANNEL_NAME: { type: "literal", value: "open-tag" },
      PLAYWRIGHT_BROWSERS_PATH: { type: "literal", value: "0" },
      RAILPACK_DEPLOY_APT_PACKAGES: {
        type: "literal",
        value:
          "fonts-liberation fonts-noto-color-emoji fonts-unifont libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libfontconfig1 libfreetype6 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxrender1 libxshmfence1",
      },
    },
  },
] as const;

function graphFor(enabled: boolean): RailwayGraph {
  const context = createRailwayContext({ environmentName: "staging" });
  return projectDefinitionToGraph(createOpenTagProject(context, enabled));
}

function evaluateDefaultRailwayFile(): void {
  const stdout = execFileSync(
    process.execPath,
    ["node_modules/railway/dist/iac/bin.js"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  const result = JSON.parse(stdout) as {
    ok: boolean;
    diagnostics: unknown[];
  };
  expect(result.ok).toBe(true);
  expect(result.diagnostics).toEqual([]);
}

describe("Railway deployment graph", () => {
  it("keeps the origin/main Kite graph identical when Datadog is enabled", () => {
    const graph = graphFor(true);
    expect(
      graph.resources.filter(({ name }) => name === "agent" || name === "runtime"),
    ).toEqual(ORIGINAL_KITE_RESOURCES);
    expect(graph.resources.map(({ name }) => name).sort()).toEqual([
      "agent",
      "datadog-agent",
      "datadog-agent-state",
      "runtime",
    ]);
  });

  it("omits only Datadog resources when disabled", () => {
    const graph = graphFor(false);
    expect(graph.resources).toEqual(ORIGINAL_KITE_RESOURCES);
    expect(graph.edges).toEqual([]);
  });

  it("evaluates the committed enabled Railway file without diagnostics", () => {
    evaluateDefaultRailwayFile();
  });

  it("creates an isolated logs-only Agent and private cursor volume", () => {
    const resources = graphFor(true).resources;
    const datadog = resources.find(({ name }) => name === "datadog-agent");
    expect(datadog?.type).toBe("service");
    if (!datadog || datadog.type !== "service") {
      throw new Error("datadog-agent service missing from Railway graph");
    }
    expect(datadog).toMatchObject({
      source: {
        repo: "CopilotKit/OpenTag",
        branch: "main",
        rootDirectory: ".railway/datadog-agent",
      },
      build: { builder: "DOCKERFILE" },
      deploy: { numReplicas: 1 },
      variables: {
        DD_API_KEY: { type: "sharedReference", name: "DD_API_KEY" },
        RAILWAY_LOGS_TOKEN: {
          type: "sharedReference",
          name: "RAILWAY_LOGS_TOKEN",
        },
        RAILWAY_RUNTIME_SERVICE_ID: {
          type: "reference",
          resource: "service.runtime",
          output: "RAILWAY_SERVICE_ID",
        },
        RAILWAY_AGENT_SERVICE_ID: {
          type: "reference",
          resource: "service.agent",
          output: "RAILWAY_SERVICE_ID",
        },
        DD_SITE: { type: "literal", value: "datadoghq.com" },
        DD_LOGS_ENABLED: { type: "literal", value: "true" },
        DD_APM_ENABLED: { type: "literal", value: "false" },
        DD_ENABLE_PAYLOADS_SERIES: { type: "literal", value: "false" },
        DD_ENABLE_PAYLOADS_EVENTS: { type: "literal", value: "false" },
        DD_ENABLE_PAYLOADS_SERVICE_CHECKS: {
          type: "literal",
          value: "false",
        },
        DD_ENABLE_PAYLOADS_SKETCHES: { type: "literal", value: "false" },
      },
      volumeAttachments: {
        "datadog-agent-state": {
          volume: "volume.datadog-agent-state",
          mountPath: "/opt/datadog-agent/run",
        },
      },
    });
    expect(datadog).not.toHaveProperty("networking");
    expect(datadog).not.toHaveProperty("domains");
    expect(JSON.stringify(datadog)).not.toContain("RAILWAY_PUBLIC_DOMAIN");
    expect(datadog?.variables?.DD_API_KEY).not.toHaveProperty("value");
    expect(datadog?.variables?.RAILWAY_LOGS_TOKEN).not.toHaveProperty("value");
    expect(
      resources.find(({ name }) => name === "datadog-agent-state"),
    ).toMatchObject({ type: "volume", config: { sizeMB: 100 } });
  });

  it.each([
    ["staging", "staging"],
    ["community", "community"],
    ["production", "prod"],
  ])("maps Railway %s to Datadog %s", (railway, datadog) => {
    expect(datadogEnvironmentFor(railway)).toBe(datadog);
  });

  it("rejects an environment that would create incorrectly tagged logs", () => {
    expect(() => datadogEnvironmentFor("preview-123")).toThrow(
      "Datadog is not configured",
    );
  });

  it("the disabled topology itself contains no resources", () => {
    const topology = createDatadogTopology(
      createRailwayContext({ environmentName: "staging" }),
      {
        enabled: false,
        repository: "CopilotKit/OpenTag",
        branch: "main",
        targets: {
          runtimeServiceId: "runtime-1",
          agentServiceId: "agent-1",
        },
      },
    );
    expect(topology).toEqual({ resources: [] });
  });
});
