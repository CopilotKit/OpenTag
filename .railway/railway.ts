import { defineRailway, github, preserve, project, service } from "railway/iac";

// KiteBot on CopilotKit Intelligence — one-click Railway topology.
// Three services build from this repo; the Python agent uses rootDirectory "agent".
// Inter-service URLs use Railway reference variables (${{svc.VAR}}), resolved at
// deploy over private networking. SECRETS are declared with preserve() so applying
// never clobbers deployer-set values — set their actual values in the Railway UI
// (see README "Deploy to Railway").
//
// Two topology invariants this file encodes:
//   1. Ports for peer-dialed services (agent, notion-mcp) are pinned as explicit
//      service variables (NOT left to Railway's auto-injected $PORT) so each
//      service's listen port and the ${{svc.PORT}} its peers dial always agree.
//      The outbound-only channel host has no peer dialing it, so it uses
//      Railway's injected $PORT (app/managed.ts defaults 8300).
//   2. Services reached over Railway private networking must bind :: (all
//      interfaces) — private DNS (RAILWAY_PRIVATE_DOMAIN) resolves to IPv6, and
//      legacy environments are IPv6-only. A service bound to 127.0.0.1/0.0.0.0
//      is unreachable by its peers.
const REPO = "CopilotKit/OpenTag";

export default defineRailway(() => {
  // Notion MCP sidecar — streamable-HTTP MCP server. Its launcher
  // (scripts/start-notion-mcp.ts) binds NOTION_MCP_PORT (default 3001) and does
  // NOT read Railway's injected $PORT, so we pin NOTION_MCP_PORT here and have
  // the agent dial that same variable. We also set NOTION_MCP_HOST=:: so the
  // sidecar binds all interfaces (its upstream default is 127.0.0.1, which is
  // unreachable across containers on the private network).
  //
  // Notion is an OPTIONAL research source: the agent runs fine (chat + UI + web
  // research) without it and drops the Notion tools if this sidecar is
  // unreachable. But if you deploy this service it REQUIRES NOTION_TOKEN and
  // NOTION_MCP_AUTH_TOKEN — its launcher exits non-zero without them. To skip
  // Notion entirely, remove this service from `resources` below and delete the
  // agent's NOTION_MCP_URL / NOTION_MCP_AUTH_TOKEN wiring.
  const notionMcp = service("notion-mcp", {
    source: github(REPO),
    start: "pnpm notion-mcp",
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    env: {
      NOTION_MCP_PORT: "3001",
      NOTION_MCP_HOST: "::",
      // secrets (set in Railway UI):
      NOTION_TOKEN: preserve(),
      NOTION_MCP_AUTH_TOKEN: preserve(),
    },
  });

  // Python deep-research agent — deepagents over AG-UI (uvicorn, /health).
  // This service owns its build + deploy config here (single source of truth):
  // there is deliberately NO agent/railway.toml, because Railway forbids a
  // service being managed by both IaC and config-as-code at once.
  const agent = service("agent", {
    source: github(REPO, { rootDirectory: "agent" }),
    build: { builder: "NIXPACKS" },
    deploy: {
      // Bind :: so the agent is reachable over Railway private networking (see
      // invariant 2 above). The Railway startCommand runs `uvicorn main:app`
      // directly, so agent/main.py's own __main__ port logic does NOT run here —
      // the port comes solely from this --port arg. The ${PORT:-8123} fallback
      // keeps the bind valid even if PORT were unset; PORT is pinned in env below
      // so this and ${{agent.PORT}} (dialed by channel) always agree.
      startCommand: "uvicorn main:app --host :: --port ${PORT:-8123}",
      healthcheckPath: "/health",
      healthcheckTimeout: 300,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    env: {
      // Pin PORT so uvicorn's bind and ${{agent.PORT}} (dialed by channel) agree.
      PORT: "8123",
      // internal research source (optional Notion), wired to the sidecar on its
      // pinned NOTION_MCP_PORT over private networking. The shared bearer is
      // referenced from notion-mcp so it has a single source of truth — set
      // NOTION_MCP_AUTH_TOKEN once, on the notion-mcp service.
      NOTION_MCP_URL:
        "http://${{notion-mcp.RAILWAY_PRIVATE_DOMAIN}}:${{notion-mcp.NOTION_MCP_PORT}}/mcp",
      NOTION_MCP_AUTH_TOKEN: "${{notion-mcp.NOTION_MCP_AUTH_TOKEN}}",
      // OPENAI_MODEL is intentionally NOT set here: the agent defaults to
      // gpt-5.5 (agent/agent.py), and leaving it unmanaged means a deployer can
      // override it in the Railway UI without a later `config apply` clobbering
      // the change. Set OPENAI_MODEL in the agent service's Variables to change it.
      //
      // secrets (set in Railway UI): OPENAI_API_KEY required; others optional:
      OPENAI_API_KEY: preserve(),
      TAVILY_API_KEY: preserve(),
      LINEAR_API_KEY: preserve(),
    },
  });

  // KiteBot channel host — runs the bot via CopilotKit Intelligence v2:
  // createChannel() feeds a CopilotRuntime({ channels }) into
  // createCopilotNodeListener(). There are no org/project/channel IDs to wire
  // up: the runtime derives that identity from the API credentials plus the
  // channel name below.
  const channel = service("channel", {
    source: github(REPO),
    start: "pnpm channel",
    // The channel host renders inline charts/diagrams via Playwright/Chromium
    // (app/render/browser.ts → chromium.launch). Install the browser at build
    // time; PLAYWRIGHT_BROWSERS_PATH=0 (env below) puts it in node_modules so it
    // persists into the deploy image, and RAILPACK_DEPLOY_APT_PACKAGES supplies
    // the shared libs Chromium needs at runtime. Without this, render_chart /
    // render_diagram fail on the deployed channel. Mirrors the kite reference.
    build: {
      buildCommand:
        "pnpm install && npx playwright install --with-deps chromium",
    },
    deploy: {
      // Parity with agent/notion-mcp: restart the long-running channel host on
      // crash instead of leaving KiteBot silently offline.
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    env: {
      // brain: points at the agent service over private networking. The agent
      // pins PORT=8123, so ${{agent.PORT}} resolves to the port uvicorn binds.
      AGENT_URL: "http://${{agent.RAILWAY_PRIVATE_DOMAIN}}:${{agent.PORT}}/",
      // Chromium for inline chart/diagram rendering: install the browser into
      // node_modules (0) so it ships with the app, and provide the shared libs
      // in the deploy image (Railpack strips build-layer apt packages).
      PLAYWRIGHT_BROWSERS_PATH: "0",
      RAILPACK_DEPLOY_APT_PACKAGES:
        "fonts-liberation fonts-noto-color-emoji fonts-unifont libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libfontconfig1 libfreetype6 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxrender1 libxshmfence1",
      // INTELLIGENCE_CHANNEL_NAME is intentionally NOT set here: app/managed.ts
      // already defaults it to "kite-opentag", and leaving it unmanaged means a
      // deployer can set their own channel name in the Railway UI without a
      // later `config apply` clobbering it. Set it in the channel service's
      // Variables if your Intelligence channel is named something else.
      //
      // All three INTELLIGENCE_* connection vars below are deployer-supplied
      // secrets/values (from your CopilotKit Intelligence project) — declared
      // with preserve() so they're never hardcoded here, and `railway config
      // apply` never clobbers what you set in the Railway UI (see README
      // "Deploy to Railway"):
      INTELLIGENCE_API_URL: preserve(),
      INTELLIGENCE_GATEWAY_WS_URL: preserve(),
      INTELLIGENCE_API_KEY: preserve(),
    },
  });

  return project("kitebot", { resources: [notionMcp, agent, channel] });
});
