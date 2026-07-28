# OpenTag — setup & configuration

Everything beyond the [quick start](./README.md#quick-start): the full Slack app walkthrough,
the complete environment reference, running standalone vs. from the monorepo, the Intelligence
Gateway channel mode, wiring up Linear / Notion / inline charts, the other chat platforms,
slash commands, tests, and how the pieces fit together.

- [How it fits together](#how-it-fits-together)
- [Running it](#running-it) — monorepo or standalone, self-hosted or Intelligence Gateway
- [Deep research (LangGraph deep agent)](#deep-research-langgraph-deep-agent)
- [Intelligence channel mode](#intelligence-channel-mode)
- [1. Create a Slack app](#1-create-a-slack-app)
- [2. Environment variables](#2-environment-variables)
- [3. Integrations](#3-integrations) — Linear, Notion, charts
- [Other platforms](#other-platforms) — Discord, Telegram, WhatsApp
- [Slash commands](#slash-commands)
- [Files → charts, diagrams & tables](#files--charts-diagrams--tables)
- [Tests](#tests)

## How it fits together

```
Slack / Discord / Telegram / WhatsApp ──@mention──▶  KiteBot (app/)  ──AG-UI──▶  runtime (runtime.ts)
                                                          │  BuiltInAgent (LLM)
                                                          ├── Linear  MCP  (hosted)
                                                          └── Notion  MCP  (sidecar)
```

Three moving parts: the **chat-platform app(s)** in `app/`, the **agent** (`runtime.ts`), and —
if you use Notion — a small **Notion MCP sidecar**. KiteBot speaks to the agent over
[AG-UI](https://docs.ag-ui.com); the agent is one CopilotKit `BuiltInAgent` (an LLM plus
optional MCP tools — no Python, no LangGraph).

KiteBot runs in one of two modes: **self-hosted** (`pnpm dev` → `app/index.ts`, holds the Slack
tokens directly) or **Intelligence Gateway** (`pnpm channel` → `app/managed.ts`, over the
CopilotKit Intelligence Realtime Gateway — see [Intelligence channel
mode](#intelligence-channel-mode)). Both modes talk to the same agent backend
(`pnpm runtime` → `runtime.ts`) via `AGENT_URL`.

| Concept                                                              | Where                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `createChannel({ adapters, agent, tools, context, commands })`       | [`app/index.ts`](./app/index.ts)                                   |
| Multi-adapter wiring (Slack/Discord/Telegram/WhatsApp, secret-gated) | [`app/index.ts`](./app/index.ts)                                   |
| `read_thread` — grounds the agent in the real conversation           | [`app/tools/read-thread.ts`](./app/tools/read-thread.ts)           |
| Render-tools + JSX components (issue card/list, Notion pages)        | [`app/tools/render-tools.tsx`](./app/tools/render-tools.tsx), [`app/components/`](./app/components/) |
| Chart / diagram rendering (Playwright → PNG)                         | [`app/tools/render-chart.tsx`](./app/tools/render-chart.tsx), `render-diagram.tsx`, [`app/render/`](./app/render/) |
| Table rendering (native `<Table>` block, monospace fallback)         | [`app/tools/render-table.tsx`](./app/tools/render-table.tsx)       |
| Status / incident / links showcase cards                             | [`app/tools/showcase-tools.tsx`](./app/tools/showcase-tools.tsx), [`app/components/_status.ts`](./app/components/_status.ts) |
| Blocking **human-in-the-loop** gate (`confirm_write`)                | [`app/human-in-the-loop/confirm-write.tsx`](./app/human-in-the-loop/confirm-write.tsx) |
| Slash commands (`/agent`, `/triage`, `/preview`, `/file-issue`)      | [`app/commands/index.ts`](./app/commands/index.ts)                 |
| A Block Kit **modal** (`/file-issue`)                                | [`app/modals/file-issue.tsx`](./app/modals/file-issue.tsx)         |
| The agent backend — one `BuiltInAgent` (LLM + Linear/Notion MCP)     | [`runtime.ts`](./runtime.ts)                                       |

- **`app/`** is the platform-agnostic KiteBot code. **This is the directory you copy to start your own bot.**
- **`runtime.ts`** is the agent backend, served over AG-UI.
- **`e2e/`** holds live test harnesses (the Slack harness is being migrated to the new
  `createChannel` API; the Telegram harness is a working manual-trigger smoke test — see
  [`e2e/TELEGRAM-README.md`](./e2e/TELEGRAM-README.md)).

It's built on:

- **[`@copilotkit/channels`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/channels)** — the platform-agnostic bot engine.
- **[`@copilotkit/channels-slack`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/channels-slack)** / **[`-discord`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/channels-discord)** / **[`-telegram`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/channels-telegram)** / **[`-whatsapp`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/channels-whatsapp)** — the platform adapters.
- **[`@copilotkit/channels-ui`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/channels-ui)** — a cross-platform JSX vocabulary for rich messages (Block Kit on Slack, Components V2 on Discord, HTML on Telegram).
- **[`@copilotkit/runtime`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/runtime)** — the AG-UI agent backend.

## Running it

### From the monorepo

If you're working inside the [CopilotKit monorepo](https://github.com/CopilotKit/CopilotKit),
this code runs there as `examples/slack`, whose `package.json` name is `slack-example` (this
standalone repo's `package.json` name is `opentag` — the `--filter` below only resolves inside
the monorepo), building the `@copilotkit/channels*` adapters from source:

```bash
pnpm install                              # repo root
pnpm --filter slack-example notion-mcp    # only if using Notion → http://127.0.0.1:3001/mcp
pnpm --filter slack-example runtime       # CopilotKit runtime on :8200, agent "triage"
pnpm --filter slack-example dev           # KiteBot (tsx watch app/index.ts)
```

### Standalone (npm)

The `@copilotkit/channels*` packages are published on npm, so a plain `npm install` here works
as-is — no monorepo required:

```bash
npm install
npm run notion-mcp     # terminal 1 — only if using Notion
npm run runtime        # terminal 2 — the agent backend on :8200
npm run dev            # terminal 3 — KiteBot, self-hosted (holds the Slack tokens)
```

The chart/diagram renderers need a Chromium binary: `npx playwright install chromium`.

## Deep research (LangGraph deep agent)

[`agent/`](./agent) is an alternative agent backend to `runtime.ts`: a Python
[`deepagents`](https://github.com/langchain-ai/deepagents) (LangGraph) planner with a virtual
filesystem and OPTIONAL Tavily web research, served over AG-UI on `:8123`. Instead of
`runtime.ts`'s single system-prompted `BuiltInAgent` call, it plans with `write_todos`,
reads/writes its own virtual files, and — when configured — researches the web before
synthesizing an answer, all while still calling KiteBot's forwarded generative-UI tools the same
way the TS runtime does.

**Setup** — requires [`uv`](https://docs.astral.sh/uv/) and Python 3.12:

```bash
cd agent && uv sync
```

Copy `agent/.env.example` to `agent/.env` and fill it in:

| Variable | What it's for |
| --- | --- |
| `OPENAI_API_KEY` | **Required** — the model. |
| `TAVILY_API_KEY` | **Optional** — turns on live web research. Without it the agent still chats and generates UI components, answering from its own knowledge. |
| `OPENAI_MODEL` | Defaults to `gpt-5.5`, matching the rest of OpenTag. |
| `SERVER_HOST` / `SERVER_PORT` | Defaults to `0.0.0.0:8123`. |

**Run it:**

```bash
pnpm agent   # cd agent && uv run python main.py (port from PORT/SERVER_PORT env, default 8123 —
             # PORT wins if both are set: a globally-exported PORT silently outranks SERVER_PORT)
```

Then point the bot at it instead of `runtime.ts` by setting in the root `.env`:

```bash
AGENT_URL=http://localhost:8123/
```

With the deep agent in the mix, a local setup is three processes: `pnpm agent` (the Python
deep-research brain, `:8123`), the bot (`pnpm channel` or `pnpm dev`), and — if you're using
`runtime.ts` instead — `pnpm runtime` (`:8200`). `agent` and `runtime` are two alternative brains
for the same bot; run whichever one `AGENT_URL` points at.

## Intelligence channel mode

`pnpm channel` (`app/managed.ts`) runs the same KiteBot over the **CopilotKit Intelligence
Realtime Gateway** instead of a native platform adapter — this process holds **no Slack tokens**;
Intelligence owns the Slack edge (signed ingress + Connector Outbox egress) and streams render
frames back. It's wired up on the `@copilotkit/runtime/v2` managed-channels runtime: a
`createChannel({ name })` (`@copilotkit/channels`) is handed, alongside a `CopilotKitIntelligence`
built from the API vars below, to `new CopilotRuntime({ intelligence, channels })`, then mounted
with `createCopilotNodeListener` (`@copilotkit/runtime/v2/node`) — mounting only **constructs**
the runtime's channel control surface (`listener.channels`); it does not open any connection.
Activation is lazy and happens on the first `channels.ready()` call, which is why `app/managed.ts`
awaits it during boot. There are no org/project/channel IDs to wire up; the runtime derives that
identity from the Intelligence API credentials plus the channel's registered name. It's the Intelligence Gateway
counterpart to the self-hosted `pnpm dev` mode described above — you still run this process
yourself and bring your own CopilotKit Intelligence project.

```bash
npm run runtime        # terminal 1 — the agent backend on :8200 (same as self-hosted)
npm run channel        # terminal 2 — the Intelligence Gateway KiteBot (tsx app/managed.ts)
```

Configure it with:

| Variable | What it's for |
| --- | --- |
| `INTELLIGENCE_API_URL` | Base URL of your CopilotKit Intelligence deployment's app API. |
| `INTELLIGENCE_GATEWAY_WS_URL` | The Intelligence Realtime Gateway websocket endpoint. |
| `INTELLIGENCE_API_KEY` | Auth for the gateway connection. |
| `INTELLIGENCE_CHANNEL_NAME` | The registered channel name (lowercase kebab). Defaults to `kite-opentag`. |
| `CHANNEL_HTTP_TOKEN` | Optional. The channel host's HTTP routes (`agent/run`, `threads/*`, `memories/*`) are **closed** (404) unless this is set; set it to open them behind `Authorization: Bearer <token>` for server-to-server or `curl` use. The managed channel activates over the gateway WebSocket and does not need them. No `cors` option is configured on this listener, so these routes are not reachable from a browser (preflight `OPTIONS` gets no `Access-Control-Allow-Origin`) — don't point a CopilotKit frontend at this runtime. |
| `PORT` | Port the channel host's HTTP listener binds. Defaults to `8300`; Railway injects its own. |

**The channel host is fail-fast, by design** — it never idles in a half-working state:

- Activation has a **30s per-channel timeout**. A gateway that accepts the socket but never
  settles the join is fatal, not a silent hang.
- Once activation settles, the host checks the channel's actual status. Anything other than
  `online` — most commonly `setup_required`, meaning the channel name exists in your
  Intelligence project but **no platform connector is bound to it** — is logged and the process
  **exits non-zero**. Finish the connector setup in the Intelligence dashboard, then restart the
  channel host (on Railway: redeploy the `channel` service).
- After a successful boot a watchdog re-checks channel health every **60s** and exits non-zero on
  either of two fatal triggers: the managed session reaching the terminal `error` state (dead for
  good and never re-activated), **or** the channel staying continuously non-`online` (e.g. wedged
  in `reconnecting`, never actually reaching `error`) for `CHANNEL_DEGRADED_FATAL_MS` — currently
  10 minutes — in [`app/managed.ts`](./app/managed.ts). Without that second trigger a channel
  stuck reconnecting would log one warning and then stay quiet forever, so either way a supervisor
  (Railway's `ON_FAILURE` restart policy, systemd, Docker `restart:`) rebuilds the host instead of
  leaving KiteBot silently offline. On Railway, the restart budget is **finite** — see `restartPolicyMaxRetries` in
  [`.railway/railway.ts`](./.railway/railway.ts) — so an outage long enough to exhaust the
  retries leaves the service stopped, with no healthcheck to surface it; watch deploy status or
  logs rather than assuming an indefinite auto-heal.

The agent backend is still required in this mode — `pnpm runtime` (`runtime.ts`) — the Intelligence
channel host points its `AGENT_URL` at it exactly like the self-hosted KiteBot does. `AGENT_URL`
itself is required in every mode (the process exits at startup if it's unset); `.env.example` ships
it pre-filled with the local runtime URL as a template, not as a code-level default. `AGENT_URL`
must also include an explicit `http://` or `https://` scheme — a bare `host:port` (the shape of a
Railway private hostname, e.g. `agent:8123`) parses as a URL with the host folded into the
protocol rather than a valid `http(s)` URL, and is now rejected at boot rather than failing on the
first turn. Use e.g. `http://agent.railway.internal:8123/` for a Railway private-network target.
See [`.env.example`](./.env.example) for the full annotated list.

## 1. Create a Slack app

1. Go to <https://api.slack.com/apps?new_app=1> → **From a manifest** → paste
   [`slack-app-manifest.yaml`](./slack-app-manifest.yaml). The manifest declares all four slash
   commands, the assistant pane, the `users:read.email` scope, and **Socket Mode** (so KiteBot
   connects outbound — no public URL needed).
2. **OAuth & Permissions** → **Install to Workspace** → copy the `xoxb-` **Bot User OAuth
   Token** → this is your `SLACK_BOT_TOKEN`.
3. **Basic Information → App-Level Tokens** → generate one with the `connections:write` scope →
   copy the `xapp-` token → this is your `SLACK_APP_TOKEN`.

(Discord, Telegram, and WhatsApp setup is documented inline in [`.env.example`](./.env.example)
and summarized under [Other platforms](#other-platforms).)

## 2. Environment variables

Copy the template and fill in the platform(s) and integrations you want — KiteBot starts an
adapter for each platform whose secrets are present, and the agent wires up whichever data
sources have credentials. (Running in [Intelligence channel mode](#intelligence-channel-mode)
instead uses the `INTELLIGENCE_*` variables in place of the platform tokens below.)

```bash
cp .env.example .env
```

| Variable | What it's for |
| --- | --- |
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` | Run on Slack (see [step 1](#1-create-a-slack-app)). |
| `OPENAI_API_KEY` | The model. Required — the runtime is OpenAI-only (it runs on the OpenAI Responses API, needed for `web_search`); `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` are not read by this runtime. |
| `AGENT_MODEL` | OpenAI model id override, optionally prefixed `openai/` (stripped). Defaults to `openai/gpt-5.5`. |
| `LINEAR_API_KEY` / `LINEAR_TEAM_KEY` | Wire up Linear (linear.app → Settings → API → Personal API keys). |
| `NOTION_TOKEN` / `NOTION_MCP_AUTH_TOKEN` | Wire up Notion (see [Notion](#notion)). |
| `DISCORD_BOT_TOKEN` / `DISCORD_APP_ID` | Run on Discord. |
| `TELEGRAM_BOT_TOKEN` | Run on Telegram. |
| `WHATSAPP_ACCESS_TOKEN` (+ siblings) | Run on WhatsApp Cloud API. |
| `INTELLIGENCE_API_URL` / `INTELLIGENCE_GATEWAY_WS_URL` / `INTELLIGENCE_API_KEY` / `INTELLIGENCE_CHANNEL_NAME` | Run in [Intelligence channel mode](#intelligence-channel-mode) instead of holding platform tokens directly. |
| `CHANNEL_HTTP_TOKEN` | Optional. Opens the channel host's HTTP runtime routes behind a bearer token for server-to-server or `curl` use; closed by default. Not CORS-enabled — not reachable from a browser. |
| `AGENT_URL` | Where KiteBot POSTs. **Required** — the process exits at startup if unset; the template value points at the local runtime (`…/agent/triage/run`). Must include an `http://` or `https://` scheme — a bare `host:port` (e.g. the Railway private-hostname shape `agent:8123`) fails boot; use e.g. `http://agent.railway.internal:8123/`. |

Every integration is independent — set only what you need. The full annotated list, including the
WhatsApp webhook details, is in [`.env.example`](./.env.example).

## 3. Integrations

### Linear

The hosted Linear MCP accepts a raw API key as a bearer token (no OAuth dance). Create one at
**linear.app → Settings → API → Personal API keys**, set `LINEAR_API_KEY`, and optionally
`LINEAR_TEAM_KEY` (the default team to file/query against). Leave `LINEAR_API_KEY` blank to run
without Linear. With it set, the agent can:

- **Query Linear** — _"what's open in CPK this cycle?"_ → renders the issues as a rich card.
- **File a Linear issue** — _"file this thread as a bug"_ → drafts it, asks you to **confirm**, then creates it.

### Notion

Notion runs as a small **Streamable-HTTP sidecar** wrapping the official
[`@notionhq/notion-mcp-server`](https://www.npmjs.com/package/@notionhq/notion-mcp-server). Start
it with `pnpm notion-mcp` (or `npm run notion-mcp`).

- `NOTION_TOKEN` — the Notion integration secret the sidecar uses to call the Notion API
  (notion.so → Settings → Connections → develop integrations).
- `NOTION_MCP_AUTH_TOKEN` — a bearer the sidecar requires on its HTTP transport; pick any strong
  string and set the same value here and when starting the sidecar. Leave it blank to run without
  Notion.

With it set, the agent can **find pages** (_"find the runbook for the auth outage"_) and
**write a postmortem** (_"write this thread up as a Notion doc"_ → reads, summarizes,
**confirms**, then creates the page).

### The human-in-the-loop write gate

Every write — Linear or Notion — goes through a blocking **`confirm_write`** gate: the agent must
call that tool and wait for a **Create / Cancel** click before it performs the write. See
[`app/human-in-the-loop/confirm-write.tsx`](./app/human-in-the-loop/confirm-write.tsx).

### Charts, diagrams & tables

The chart/diagram libraries load from a CDN into a **local** headless browser (override
`CHART_JS_URL` / `MERMAID_URL`) — your data is rendered locally and never sent to a rendering
service. Requires a Chromium binary: `npx playwright install chromium`.

## Other platforms

The same `app/` code runs on every platform — `createChannel` takes an array of adapters, and
`app/index.ts` starts one for each platform whose secrets are present. Everything else (tools,
components, the HITL gate, rendering) is shared verbatim.

- **Discord** — set `DISCORD_BOT_TOKEN` + `DISCORD_APP_ID` (and optionally `DISCORD_GUILD_ID` for
  instant slash-command registration in dev). Enable the **Message Content** and **Server
  Members** privileged intents.
- **Telegram** — message [@BotFather](https://t.me/BotFather) → `/newbot` → set `TELEGRAM_BOT_TOKEN`.
  Long-polling is the default ingress (no public URL needed).
- **WhatsApp** — set `WHATSAPP_ACCESS_TOKEN` + siblings from your Meta App → WhatsApp → API Setup.
  The server listens on `$PORT` for the webhook.

Per-platform details are documented inline in [`.env.example`](./.env.example).

## Slash commands

Four app-owned commands, registered via `createChannel({ commands })`
([`app/commands/index.ts`](./app/commands/index.ts)):

- **`/agent <text>`** — a mention-free entry point; runs the agent with the command text.
- **`/triage [note]`** — summarizes the conversation and proposes issues to file.
- **`/preview <title>`** — privately previews the issue KiteBot would file (only you see it);
  degrades to a DM where ephemerals aren't supported.
- **`/file-issue`** — opens a structured issue **modal**; degrades to a conversational flow on
  platforms without modals (e.g. Telegram).

On Slack, all four must be declared under **Slash Commands** — the manifest already does this.

## Files → charts, diagrams & tables

Upload a file and KiteBot analyzes it: images and **PDFs** go straight to the model; CSV/JSON/text
are decoded and handed over as text. Then ask it to visualize:

> chart revenue by month · diagram this incident flow · show it as a table

> **PDFs and images need a vision/document-capable model.** The runtime is OpenAI-only, and the
> default `openai/gpt-5.5` reads both natively. If you override `AGENT_MODEL`, pick another
> vision/document-capable OpenAI model — non-OpenAI model ids (Claude, Gemini, etc.) are not
> supported by this runtime.

## Tests

```bash
npm test               # unit: read_thread, render tools, components (+ a component scan),
                        # confirm_write, modals, commands, the channel host (app/managed.ts),
                        # the shared headless browser, and sender-context resolution
npm run check-types    # tsc --noEmit
```

The live-Slack e2e harness (`npm run e2e`) is being migrated to the new `createChannel` API and
doesn't run against this code as-is. The Telegram harness (`npm run e2e:telegram`) is a working
manual-trigger smoke test — see [`e2e/TELEGRAM-README.md`](./e2e/TELEGRAM-README.md).
