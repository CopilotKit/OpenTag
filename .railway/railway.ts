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
      // Pin the builder: RAILPACK_DEPLOY_APT_PACKAGES below is honored ONLY by
      // Railpack, and (since --with-deps was dropped) it is now the SOLE source
      // of the ~28 shared libs Chromium needs at runtime. Leaving `builder`
      // unset defaults to Railway's own choice, which could silently be a
      // non-Railpack builder — RAILPACK_DEPLOY_APT_PACKAGES would then do
      // nothing, and render_chart/render_diagram would die at runtime on a
      // missing .so with no build-time signal.
      builder: "RAILPACK",
      // `--frozen-lockfile` so a drifted pnpm-lock.yaml fails the build instead
      // of silently resolving different versions than the repo was tested with
      // (overriding buildCommand replaces Railpack's own install, which sets it).
      // Chromium is installed explicitly because pnpm 10 does not run the
      // playwright package's postinstall by default. NOT `--with-deps`: that
      // apt-installs into the BUILD layer, which Railpack strips — the runtime
      // libs come from RAILPACK_DEPLOY_APT_PACKAGES below, which is the layer
      // that actually launches the browser.
      buildCommand:
        "pnpm install --frozen-lockfile && npx playwright install chromium",
    },
    deploy: {
      // Parity with agent/notion-mcp: restart the long-running channel host on
      // crash instead of leaving KiteBot silently offline.
      restartPolicyType: "ON_FAILURE",
      // Higher than agent/notion-mcp's 5: app/managed.ts runs a 60s watchdog
      // that deliberately calls process.exit(1) when the managed session hits
      // the terminal `error` state, exiting so the platform restarts the host.
      // That design assumes the platform keeps restarting through a transient
      // outage (e.g. the Intelligence gateway), so this cap is an
      // outage-tolerance budget, not a crash-loop guard — it's raised to
      // survive a realistic outage lasting more than a few restart cycles.
      // Deliberately NOT ALWAYS: a genuine boot-time misconfiguration should
      // still crash-loop visibly rather than being masked.
      restartPolicyMaxRetries: 10,
      // Railway's SIGTERM->SIGKILL grace period (RAILWAY_DEPLOYMENT_DRAINING_SECONDS)
      // defaults to 0, which would give app/managed.ts's shutdown routine zero
      // time to run: it budgets ~10s of graceful teardown (channels.stop(),
      // bounded 5s; then closeServer()/closeBrowser() raced against a 5s
      // timer) before calling process.exit(exitCode), and four docstrings in
      // that file justify their bounds by reference to "the platform's grace
      // period." 15s covers that ~10s worst case with headroom.
      drainingSeconds: 15,
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
      // CHANNEL_HTTP_TOKEN is intentionally NOT set: the channel host's HTTP
      // routes are closed unless it is, and nothing here needs them (this
      // service has no public domain and no healthcheck, and the managed
      // channel activates over the gateway WebSocket). preserve() so a deployer
      // who does open the surface isn't clobbered by a later `config apply`.
      CHANNEL_HTTP_TOKEN: preserve(),
    },
  });

  return project("kitebot", { resources: [notionMcp, agent, channel] });
});
