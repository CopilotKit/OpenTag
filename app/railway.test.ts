import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createRailwayContext } from "railway/iac";
import {
  createDatadogTopology,
  datadogEnvironmentFor,
} from "../.railway/datadog.js";

interface RailwayVariable {
  type: "literal" | "preserve" | "reference" | "sharedReference";
  value?: string;
  name?: string;
  resource?: string;
  output?: string;
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
  networking?: unknown;
  domains?: unknown;
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
  it("ships both Kite services and the private Datadog Agent", () => {
    const resources = evaluateRailwayGraph();
    expect(resources.map(({ name }) => name).sort()).toEqual([
      "agent",
      "datadog-agent",
      "runtime",
    ]);

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
      DD_AGENT_HOST: {
        type: "reference",
        resource: "service.datadog-agent",
        output: "RAILWAY_PRIVATE_DOMAIN",
      },
      DD_AGENT_STATSD_PORT: { type: "literal", value: "8125" },
      DD_AGENT_SYSLOG_PORT: { type: "literal", value: "515" },
      DD_SERVICE: { type: "literal", value: "kite" },
      DD_COMPONENT: { type: "literal", value: "agent" },
      DD_PLATFORM: { type: "literal", value: "railway" },
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
      },
      deploy: {
        startCommand: "pnpm runtime",
        healthcheckPath: "/api/copilotkit/info",
      },
      variables: {
        AGENT_URL: { type: "preserve" },
        CI: { type: "preserve" },
        DISCORD_APP_ID: { type: "preserve" },
        DISCORD_BOT_TOKEN: { type: "preserve" },
        DISCORD_GUILD_ID: { type: "preserve" },
        INTELLIGENCE_API_KEY: { type: "preserve" },
        INTELLIGENCE_API_URL: { type: "preserve" },
        INTELLIGENCE_GATEWAY_WS_URL: { type: "preserve" },
        INTELLIGENCE_CHANNEL_NAME: { type: "preserve" },
        LEFTHOOK: { type: "preserve" },
        LINEAR_API_KEY: { type: "preserve" },
        LINEAR_TEAM_KEY: { type: "preserve" },
        OPENAI_API_KEY: { type: "preserve" },
        PLAYWRIGHT_BROWSERS_PATH: { type: "preserve" },
        RAILPACK_DEPLOY_APT_PACKAGES: { type: "preserve" },
        SLACK_APP_TOKEN: { type: "preserve" },
        SLACK_BOT_TOKEN: { type: "preserve" },
        TELEGRAM_BOT_TOKEN: { type: "preserve" },
        WHATSAPP_ACCESS_TOKEN: { type: "preserve" },
        WHATSAPP_APP_SECRET: { type: "preserve" },
        WHATSAPP_PATH: { type: "preserve" },
        WHATSAPP_PHONE_NUMBER_ID: { type: "preserve" },
        WHATSAPP_PORT: { type: "preserve" },
        WHATSAPP_VERIFY_TOKEN: { type: "preserve" },
        npm_config_ignore_scripts: { type: "preserve" },
      },
    });
    expect(runtime?.variables).toMatchObject({
      DD_AGENT_HOST: {
        type: "reference",
        resource: "service.datadog-agent",
        output: "RAILWAY_PRIVATE_DOMAIN",
      },
      DD_AGENT_STATSD_PORT: { type: "literal", value: "8125" },
      DD_AGENT_SYSLOG_PORT: { type: "literal", value: "514" },
      DD_SERVICE: { type: "literal", value: "kite" },
      DD_COMPONENT: { type: "literal", value: "runtime" },
      DD_PLATFORM: { type: "literal", value: "railway" },
      DD_VERSION: {
        type: "literal",
        value: "${{RAILWAY_DEPLOYMENT_ID}}",
      },
    });

    const datadog = resources.find(({ name }) => name === "datadog-agent");
    expect(datadog).toMatchObject({
      source: {
        repo: "CopilotKit/OpenTag",
        branch: "main",
        rootDirectory: ".railway/datadog-agent",
      },
      build: { builder: "DOCKERFILE" },
      variables: {
        DD_API_KEY: { type: "sharedReference", name: "DD_API_KEY" },
        DD_APM_ENABLED: { type: "literal", value: "false" },
        DD_LOGS_ENABLED: { type: "literal", value: "true" },
        DD_DOGSTATSD_NON_LOCAL_TRAFFIC: {
          type: "literal",
          value: "true",
        },
      },
    });
    expect(datadog).not.toHaveProperty("networking");
    expect(datadog).not.toHaveProperty("domains");
    expect(JSON.stringify(datadog)).not.toContain("RAILWAY_PUBLIC_DOMAIN");
    expect(datadog?.variables?.DD_API_KEY).not.toHaveProperty("value");
  });

  it.each([
    ["staging", "staging"],
    ["community", "community"],
    ["production", "prod"],
  ])("maps Railway %s to Datadog %s", (railway, datadog) => {
    expect(datadogEnvironmentFor(railway)).toBe(datadog);
  });

  it("rejects an environment that would create incorrectly tagged telemetry", () => {
    expect(() => datadogEnvironmentFor("preview-123")).toThrow(
      "Datadog is not configured",
    );
  });

  it("omits the Agent and all Kite DD_* variables when disabled", () => {
    const topology = createDatadogTopology(
      createRailwayContext({ environmentName: "staging" }),
      {
        enabled: false,
        repository: "CopilotKit/OpenTag",
        branch: "main",
      },
    );

    expect(topology).toEqual({ resources: [], runtimeEnv: {}, agentEnv: {} });
  });
});
