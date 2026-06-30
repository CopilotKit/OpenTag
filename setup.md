# OpenTag — setup & configuration

Everything beyond the [quick start](./README.md#quick-start): the full Slack app walkthrough,
the complete environment reference, running standalone vs. from the monorepo, wiring up Linear /
Notion / inline charts, the other chat platforms, slash commands, tests, and how the
pieces fit together.

- [How it fits together](#how-it-fits-together)
- [Running it](#running-it) — monorepo today, standalone soon
- [1. Create a Slack app](#1-create-a-slack-app)
- [2. Environment variables](#2-environment-variables)
- [3. Integrations](#3-integrations) — Linear, Notion, charts
- [Other platforms](#other-platforms) — Discord, Telegram, WhatsApp
- [Slash commands](#slash-commands)
- [Files → charts, diagrams & tables](#files--charts-diagrams--tables)
- [Tests](#tests)

## How it fits together

```
Slack / Discord / Telegram / WhatsApp ──@mention──▶  bot (app/)  ──AG-UI──▶  runtime (runtime.ts)
                                                          │  BuiltInAgent (LLM)
                                                          ├── Linear  MCP  (hosted)
                                                          └── Notion  MCP  (sidecar)
```

Three moving parts: the **chat-platform app(s)** in `app/`, the **agent** (`runtime.ts`), and —
if you use Notion — a small **Notion MCP sidecar**. The bot speaks to the agent over
[AG-UI](https://docs.ag-ui.com); the agent is one CopilotKit `BuiltInAgent` (an LLM plus
optional MCP tools — no Python, no LangGraph).

| Concept                                                              | Where                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `createBot({ adapters, agent, tools, context, commands })`           | [`app/index.ts`](./app/index.ts)                                   |
| Multi-adapter wiring (Slack/Discord/Telegram/WhatsApp, secret-gated) | [`app/index.ts`](./app/index.ts)                                   |
| `read_thread` — grounds the agent in the real conversation           | [`app/tools/read-thread.ts`](./app/tools/read-thread.ts)           |
| Render-tools + JSX components (issue card/list, Notion pages)        | [`app/tools/render-tools.tsx`](./app/tools/render-tools.tsx), [`app/components/`](./app/components/) |
| Chart / diagram / table rendering (Playwright → PNG)                 | [`app/tools/render-chart.tsx`](./app/tools/render-chart.tsx), `render-diagram.tsx`, `render-table.tsx`, [`app/render/`](./app/render/) |
| Status / incident / links showcase cards                             | [`app/tools/showcase-tools.tsx`](./app/tools/showcase-tools.tsx), [`app/components/_status.ts`](./app/components/_status.ts) |
| Blocking **human-in-the-loop** gate (`confirm_write`)                | [`app/human-in-the-loop/confirm-write.tsx`](./app/human-in-the-loop/confirm-write.tsx) |
| Slash commands (`/agent`, `/triage`, `/preview`, `/file-issue`)      | [`app/commands/index.ts`](./app/commands/index.ts)                 |
| A Block Kit **modal** (`/file-issue`)                                | [`app/modals/file-issue.tsx`](./app/modals/file-issue.tsx)         |
| The agent backend — one `BuiltInAgent` (LLM + Linear/Notion MCP)     | [`runtime.ts`](./runtime.ts)                                       |

- **`app/`** is the platform-agnostic bot. **This is the directory you copy to start your own bot.**
- **`runtime.ts`** is the agent backend, served over AG-UI.
- **`e2e/`** holds live test harnesses (the Slack harness is being migrated to the new
  `createBot` API; the Telegram harness is a working manual-trigger smoke test — see
  [`e2e/TELEGRAM-README.md`](./e2e/TELEGRAM-README.md)).

It's built on:

- **[`@copilotkit/bot`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot)** — the platform-agnostic bot engine.
- **[`@copilotkit/bot-slack`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-slack)** / **[`-discord`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-discord)** / **[`-telegram`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-telegram)** / **[`-whatsapp`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-whatsapp)** — the platform adapters.
- **[`@copilotkit/bot-ui`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-ui)** — a cross-platform JSX vocabulary for rich messages (Block Kit on Slack, Components V2 on Discord, HTML on Telegram).
- **[`@copilotkit/runtime`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/runtime)** — the AG-UI agent backend.

## Running it

### From the monorepo (works today)

Until the bot SDK packages publish a coherent `0.1.x` set to npm, the dependable path is to run
this code as `examples/slack` inside the
[CopilotKit monorepo](https://github.com/CopilotKit/CopilotKit), which builds the adapters from
source:

```bash
pnpm install                              # repo root
pnpm --filter slack-example notion-mcp    # only if using Notion → http://127.0.0.1:3001/mcp
pnpm --filter slack-example runtime       # CopilotKit runtime on :8200, agent "triage"
pnpm --filter slack-example dev           # the bot (tsx watch app/index.ts)
```

### Standalone (once `@copilotkit/bot-*` publish)

`npm install` here, then run the same three processes via this repo's scripts:

```bash
npm install
npm run notion-mcp     # terminal 1 — only if using Notion
npm run runtime        # terminal 2 — the agent backend on :8200
npm run dev            # terminal 3 — the bot
```

The chart/diagram renderers need a Chromium binary: `npx playwright install chromium`.

> **Why not standalone yet?** `@copilotkit/bot-telegram` and `-whatsapp` aren't
> on npm yet, and the published bot packages need a coherent `0.1.x` release. The moment they
> land, `npm install` in this repo works as-is.

## 1. Create a Slack app

1. Go to <https://api.slack.com/apps?new_app=1> → **From a manifest** → paste
   [`slack-app-manifest.yaml`](./slack-app-manifest.yaml). The manifest declares all four slash
   commands, the assistant pane, the `users:read.email` scope, and **Socket Mode** (so the bot
   connects outbound — no public URL needed).
2. **OAuth & Permissions** → **Install to Workspace** → copy the `xoxb-` **Bot User OAuth
   Token** → this is your `SLACK_BOT_TOKEN`.
3. **Basic Information → App-Level Tokens** → generate one with the `connections:write` scope →
   copy the `xapp-` token → this is your `SLACK_APP_TOKEN`.

(Discord, Telegram, and WhatsApp setup is documented inline in [`.env.example`](./.env.example)
and summarized under [Other platforms](#other-platforms).)

## 2. Environment variables

Copy the template and fill in the platform(s) and integrations you want — the bot starts an
adapter for each platform whose secrets are present, and the agent wires up whichever data
sources have credentials.

```bash
cp .env.example .env
```

| Variable | What it's for |
| --- | --- |
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` | Run on Slack (see [step 1](#1-create-a-slack-app)). |
| `OPENAI_API_KEY` | The model. Or set `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` and `AGENT_MODEL`. |
| `AGENT_MODEL` | `provider/model` override. Defaults to `openai/gpt-5.5`. |
| `LINEAR_API_KEY` / `LINEAR_TEAM_KEY` | Wire up Linear (linear.app → Settings → API → Personal API keys). |
| `NOTION_TOKEN` / `NOTION_MCP_AUTH_TOKEN` | Wire up Notion (see [Notion](#notion)). |
| `DISCORD_BOT_TOKEN` / `DISCORD_APP_ID` | Run on Discord. |
| `TELEGRAM_BOT_TOKEN` | Run on Telegram. |
| `WHATSAPP_ACCESS_TOKEN` (+ siblings) | Run on WhatsApp Cloud API. |
| `AGENT_URL` | Where the bot POSTs (defaults to the local runtime: `…/agent/triage/run`). |

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

The same `app/` code runs on every platform — `createBot` takes an array of adapters, and
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

Four app-owned commands, registered via `createBot({ commands })`
([`app/commands/index.ts`](./app/commands/index.ts)):

- **`/agent <text>`** — a mention-free entry point; runs the agent with the command text.
- **`/triage [note]`** — summarizes the conversation and proposes issues to file.
- **`/preview <title>`** — privately previews the issue the bot would file (only you see it);
  degrades to a DM where ephemerals aren't supported.
- **`/file-issue`** — opens a structured issue **modal**; degrades to a conversational flow on
  platforms without modals (e.g. Telegram).

On Slack, all four must be declared under **Slash Commands** — the manifest already does this.

## Files → charts, diagrams & tables

Upload a file and the bot analyzes it: images and **PDFs** go straight to the model; CSV/JSON/text
are decoded and handed over as text. Then ask it to visualize:

> chart revenue by month · diagram this incident flow · show it as a table

> **PDFs and images need a vision/document-capable model.** The default `openai/gpt-5.5` reads
> both natively, as do recent Claude and Gemini models.

## Tests

```bash
npm test               # unit: read_thread, render tools, components, confirm_write, modals, commands
npm run check-types    # tsc --noEmit
```

The live-Slack e2e harness (`npm run e2e`) is being migrated to the new `createBot` API and
doesn't run against this code as-is. The Telegram harness (`npm run e2e:telegram`) is a working
manual-trigger smoke test — see [`e2e/TELEGRAM-README.md`](./e2e/TELEGRAM-README.md).
