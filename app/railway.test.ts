import {
  createRailwayContext,
  project,
  projectDefinitionToGraph,
  validateGraph,
  type RailwayGraph,
  type ServiceNode,
} from "railway/iac";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import railwayProgram from "../.railway/railway.js";

/** The scripts `pnpm <name>` can actually resolve at the repository root. */
const packageScripts: Record<string, string> = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).scripts;

/**
 * The compiled deployment graph.
 *
 * Evaluated in this process rather than by shelling out to `railway`'s bin.
 * The subprocess booted a second Node, loaded the whole `railway` bundle again
 * and re-compiled the config through `tsx` — between 0.3s and 6.2s depending on
 * what else the machine was doing, which straddles vitest's default timeout and
 * went red on an unmodified config. Raising the timeout only moves the number
 * the flake has to beat; removing the second process removes the variance. This
 * is the same sequence the bin runs (`resolveDefinition` then
 * `projectDefinitionToGraph`), against the compiler vitest has already warmed.
 */
async function railwayGraph(): Promise<RailwayGraph> {
  const graph = projectDefinitionToGraph(
    await railwayProgram(createRailwayContext({}), project),
  );
  // What the bin reports as `ok: false` with diagnostics attached.
  expect(validateGraph(graph)).toEqual([]);
  return graph;
}

/** The one service called `name`, or a failure that says which one is missing. */
function serviceNamed(graph: RailwayGraph, name: string): ServiceNode {
  const service = graph.resources.find(
    (candidate): candidate is ServiceNode =>
      candidate.type === "service" && candidate.name === name,
  );
  if (!service) {
    throw new Error(
      `no service called ${name}; the graph has ${graph.resources
        .map((resource) => resource.name)
        .join(", ")}`,
    );
  }
  return service;
}

/**
 * Every variable name a service carries, sorted.
 *
 * `toMatchObject` only reads the keys it is handed, so it is blind to a
 * variable that should not be there at all — a credential belonging to one
 * service quietly added to the other passes it without complaint. The whole
 * name list is compared instead.
 */
function variableNames(service: ServiceNode): string[] {
  return Object.keys(service.variables ?? {}).sort();
}

/**
 * What both services must say about restarts and health checks.
 *
 * Its own constant because the previous version of this file typed `deploy` as
 * `{ startCommand, healthcheckPath }` and asserted nothing else: deleting the
 * restart policy from both services, or setting the health-check timeout to a
 * second, left the suite green. A service that never restarts after a crash is
 * the failure this deployment config exists to prevent.
 */
const RESILIENCE = {
  // Five minutes: the agent installs nothing at boot but does import the model
  // and MCP clients, and the runtime waits on the agent.
  healthcheckTimeout: 300,
  // Restart a crashed container, and stop after five so a container that
  // cannot start does not restart forever without anyone noticing.
  restartPolicyType: "ON_FAILURE",
  restartPolicyMaxRetries: 5,
} as const;

describe("Railway deployment graph", () => {
  it("ships the Python agent and Chromium-capable runtime services", async () => {
    const graph = await railwayGraph();
    expect(graph.resources.map(({ name }) => name).sort()).toEqual([
      "agent",
      "runtime",
    ]);

    const agent = serviceNamed(graph, "agent");
    // The whole source object, not a subset: `rootDirectory` is what decides
    // which tree Railpack builds, and `toMatchObject` reads only the keys it is
    // handed — so it is blind to the one that should not be there. The runtime
    // builds the repository root and the agent builds `agent/`; swapping either
    // gives a service that builds and then cannot start.
    expect(agent.source).toEqual({
      type: "github",
      repo: "CopilotKit/OpenTag",
      branch: "main",
      rootDirectory: "agent",
    });
    expect(agent).toMatchObject({
      build: {
        builder: "RAILPACK",
      },
      deploy: {
        startCommand: 'uvicorn main:app --host "" --port ${PORT:-8123}',
        healthcheckPath: "/health",
        ...RESILIENCE,
      },
    });
    expect(agent.variables).toMatchObject({
      AGENT_DISPLAY_NAME: { type: "preserve" },
      OPENAI_API_KEY: { type: "preserve" },
      TAVILY_API_KEY: { type: "preserve" },
      GITHUB_PERSONAL_ACCESS_TOKEN: { type: "preserve" },
      GITHUB_CODER_TOKEN: { type: "preserve" },
      GITHUB_APP_ID: { type: "preserve" },
      GITHUB_APP_INSTALLATION_ID: { type: "preserve" },
      GITHUB_APP_PRIVATE_KEY_BASE64: { type: "preserve" },
      GITHUB_MCP_URL: { type: "preserve" },
      POSTHOG_PERSONAL_API_KEY: { type: "preserve" },
      POSTHOG_MCP_URL: { type: "preserve" },
      LINEAR_API_KEY: { type: "preserve" },
      NOTION_MCP_URL: { type: "preserve" },
      NOTION_MCP_AUTH_TOKEN: { type: "preserve" },
      COMPOSIO_API_KEY: { type: "preserve" },
      COMPOSIO_TOOLKITS: { type: "preserve" },
      COMPOSIO_USER_TOOLKITS: { type: "preserve" },
      COMPOSIO_APPROVALS: { type: "preserve" },
      COMPOSIO_WORKSPACE_USER_ID: { type: "preserve" },
      COMPOSIO_AUTH_CONFIGS: { type: "preserve" },
      AGENT_AUTH_HEADER: { type: "preserve" },
      // The agent derives the default Composio workspace user id from this, so
      // it has to reach the agent and not only the runtime.
      INTELLIGENCE_CHANNEL_NAME: { type: "literal", value: "open-tag" },
      // The port the start command falls back to and the port the runtime is
      // told to reach it on.
      PORT: { type: "literal", value: "8123" },
    });

    // The agent holds the Composio key and every source credential; the
    // runtime must not. Named exhaustively so a credential added to the wrong
    // service is a failure rather than an unread key.
    expect(variableNames(agent)).toEqual([
      "AGENT_AUTH_HEADER",
      "AGENT_DISPLAY_NAME",
      "COMPOSIO_API_KEY",
      "COMPOSIO_APPROVALS",
      "COMPOSIO_AUTH_CONFIGS",
      "COMPOSIO_TOOLKITS",
      "COMPOSIO_USER_TOOLKITS",
      "COMPOSIO_WORKSPACE_USER_ID",
      "DAYTONA_API_KEY",
      "DAYTONA_SNAPSHOT",
      "DAYTONA_TTL_MINUTES",
      "GITHUB_APP_ID",
      "GITHUB_APP_INSTALLATION_ID",
      "GITHUB_APP_PRIVATE_KEY_BASE64",
      "GITHUB_CODER_TOKEN",
      "GITHUB_MCP_URL",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "INTELLIGENCE_CHANNEL_NAME",
      "LINEAR_API_KEY",
      "NOTION_MCP_AUTH_TOKEN",
      "NOTION_MCP_URL",
      "OPENAI_API_KEY",
      "PORT",
      "POSTHOG_MCP_URL",
      "POSTHOG_PERSONAL_API_KEY",
      "TAVILY_API_KEY",
    ]);

    const runtime = serviceNamed(graph, "runtime");
    // No `rootDirectory`, asserted by absence: the runtime is the repository
    // root, and a subset match passes just as happily with it pointed at
    // `agent/` — where `pnpm runtime` is not a script and the deploy restarts
    // until it gives up.
    expect(runtime.source).toEqual({
      type: "github",
      repo: "CopilotKit/OpenTag",
      branch: "main",
    });
    expect(runtime).toMatchObject({
      build: {
        builder: "RAILPACK",
        buildCommand: "pnpm exec playwright install chromium",
        watchPatterns: [],
      },
      deploy: {
        startCommand: "pnpm runtime",
        healthcheckPath: "/api/copilotkit/info",
        ...RESILIENCE,
      },
      variables: {
        AGENT_DISPLAY_NAME: { type: "preserve" },
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
        INTELLIGENCE_LEARNING_CONTAINER_ID: { type: "preserve" },
        INTELLIGENCE_CHANNEL_NAME: {
          type: "literal",
          value: "open-tag",
        },
        AGENT_AUTH_HEADER: { type: "preserve" },
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

    // The runtime carries the shared secret it presents to the agent, and no
    // platform or Composio credential: Intelligence owns the Slack and Teams
    // edges, and the toolkits live on the agent. Asserted as the complete set
    // so a token added back here fails rather than passes unnoticed.
    expect(variableNames(runtime)).toEqual([
      "AGENT_AUTH_HEADER",
      "AGENT_DISPLAY_NAME",
      "AGENT_URL",
      "INTELLIGENCE_API_KEY",
      "INTELLIGENCE_API_URL",
      "INTELLIGENCE_CHANNEL_NAME",
      "INTELLIGENCE_GATEWAY_WS_URL",
      "INTELLIGENCE_LEARNING_CONTAINER_ID",
      "PLAYWRIGHT_BROWSERS_PATH",
      "PORT",
      "RAILPACK_DEPLOY_APT_PACKAGES",
    ]);
  });

  it("starts each service with an entry point this repository actually has", async () => {
    // Replaces a cross-check that compared the two services'
    // `INTELLIGENCE_CHANNEL_NAME` values. Both are pinned to the literal
    // `open-tag` by the exhaustive assertions above, so the comparison could
    // not fail unless one of those failed first — it read as a drift guard and
    // was arithmetic on two constants.
    //
    // This is the part of the config nothing else can see: the start commands
    // are strings here and names elsewhere. Renaming the `runtime` script in
    // `package.json`, or moving the agent's ASGI module, leaves every
    // assertion above green and every deploy exiting at boot — which Railway
    // then restarts five times and stops.
    const graph = await railwayGraph();

    const runtimeStart = serviceNamed(graph, "runtime").deploy?.startCommand;
    const scriptName = /^pnpm (?:run )?([\w:-]+)$/.exec(runtimeStart ?? "")?.[1];
    expect({ runtimeStart, scriptName }).toMatchObject({
      scriptName: expect.any(String),
    });
    expect(Object.keys(packageScripts)).toContain(scriptName);

    // `uvicorn <module>:<attribute>`, resolved from the agent's own
    // `rootDirectory`, so the module is a file in `agent/`.
    const agentStart = serviceNamed(graph, "agent").deploy?.startCommand ?? "";
    const moduleName = /^uvicorn ([\w.]+):(\w+)/.exec(agentStart)?.[1];
    expect({ agentStart, moduleName }).toMatchObject({
      moduleName: expect.any(String),
    });
    expect(
      existsSync(new URL(`../agent/${moduleName}.py`, import.meta.url)),
    ).toBe(true);
  });
});
