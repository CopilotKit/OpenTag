# OpenTag: an open-source alternative to Claude in Slack

Run your own AI agent inside Slack: it reads a thread, answers, calls your tools, and
renders rich results right in the conversation. Think of it as having Claude in your
workspace, except **open-source and self-hosted**: you own the runtime, bring your own
model, and wire it to your own tools. No per-seat pricing, no lock-in.

It's built on **[`@copilotkit/channels`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/channels)** —
CopilotKit's open SDK for chat-platform agents (Slack first; the same code also runs on
Discord, Telegram, and WhatsApp). Clone it, point it at your model and tools, and you own
the whole stack.

## See it in action

https://github.com/user-attachments/assets/a74fa1cb-add0-463e-a23c-aa09b95d5135

▶️ **[Watch the demo](https://github.com/user-attachments/assets/a74fa1cb-add0-463e-a23c-aa09b95d5135)** (~50s) — a KiteBot agent working a Slack thread: it renders a breakdown, a table, and a bar chart inline (**generative UI**) and files a ticket only after an **Approve** gate (**human-in-the-loop**).

> **Two ways to run it:** **host it on your own** with the open-source SDK below — or skip the ops and **[sign up for the managed service →](https://go.copilotkit.ai/opentag-managed-gh)** coming soon from CopilotKit. The managed service will be part of our Enterprise Intelligence platform. You'll be able to use our cloud-hosting or enterprises can host it on their own infra.
>
> Note: the **Intelligence Gateway** mode below is part of "host it on your own" — you run that
> process yourself and bring your own CopilotKit Intelligence project. It's distinct from the
> fully-hosted **managed service** above, which is still on the waitlist.

## Quick start

OpenTag's packages are published on npm — a standalone `pnpm install` in this repo pulls in
everything you need, no monorepo required.

You'll run two processes: the **agent backend** (`pnpm runtime`) and **the bot**. For the bot,
pick one of two modes:

- **Intelligence Gateway — recommended.** `pnpm channel` runs the bot over the CopilotKit
  Intelligence Realtime Gateway. This process never holds a Slack token — Intelligence owns
  the Slack edge — so there's less for you to run and secure. You still run this process
  yourself and bring your own CopilotKit Intelligence project — it's not the fully-hosted
  managed service described below.
- **Self-hosted.** `pnpm dev` (or `pnpm start`) runs the bot locally and talks to Slack (and
  Discord/Telegram/WhatsApp) directly with your own platform tokens.

Both modes talk to the same agent backend over AG-UI.

### The packages

OpenTag is a thin layer on top of a handful of CopilotKit packages. The `pnpm install` in step 3 installs all of them for you — this is what each one does, so you know what you're running and which ones are optional.

**Required** — every OpenTag install needs these four:

| Package | Role |
| --- | --- |
| [`@copilotkit/channels`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/channels) | The platform-agnostic bot engine — threading, tool calls, the human-in-the-loop gate. |
| [`@copilotkit/runtime`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/runtime) | The AG-UI agent backend that runs your LLM and tools. |
| [`@copilotkit/channels-ui`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/channels-ui) | Cross-platform JSX for rich messages (Block Kit on Slack, Components V2 on Discord, HTML on Telegram). |
| [`@copilotkit/channels-slack`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/channels-slack) | The Slack adapter — or swap it for the platform you're targeting (below). |

**Optional** — add only what you use:

| Package | When you need it |
| --- | --- |
| [`@copilotkit/channels-discord`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/channels-discord) · [`-telegram`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/channels-telegram) · [`-whatsapp`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/channels-whatsapp) | Running on a platform other than Slack — one adapter per platform. |

**1. Create a Slack app.** At [api.slack.com/apps](https://api.slack.com/apps?new_app=1) →
*From a manifest* → paste [`slack-app-manifest.yaml`](./slack-app-manifest.yaml). Install it,
then grab the **Bot User OAuth Token** (`xoxb-…`) and an **App-Level Token** (`xapp-…`, with the
`connections:write` scope) — needed for self-hosted mode, or to register the app with your
CopilotKit Intelligence project for Intelligence mode. Step-by-step in
[setup.md](./setup.md#1-create-a-slack-app).

**2. Set your secrets** in `.env` (`cp .env.example .env`):

```bash
OPENAI_API_KEY=sk-...      # the TS runtime (runtime.ts) uses OpenAI's Responses API for web search;
                           # the Python agent/ uses Tavily instead (see "Deep research" below)

# Optional integrations (see setup.md):
LINEAR_API_KEY=lin_api_... # optional — lets the agent file Linear tickets

# Self-hosted mode:
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# Intelligence Gateway mode — full list in .env.example:
INTELLIGENCE_API_URL=https://...
INTELLIGENCE_GATEWAY_WS_URL=wss://...
INTELLIGENCE_API_KEY=cpk-...
```

**3. Run it:**

```bash
pnpm install
```

```bash
pnpm runtime    # terminal 1 — the agent backend, on :8200
```

```bash
pnpm channel    # terminal 2 — recommended — the bot over the Intelligence Gateway
# or
pnpm dev        # terminal 2 — alternative — the bot, self-hosted
```

**4. Talk to it.** @mention the bot in any channel thread:

> @KiteBot summarize this thread and file it as a bug

That's the whole loop. To wire up Linear, Notion, inline charts, or to run
on Discord / Telegram / WhatsApp, see **[setup.md](./setup.md)**.  

We won't lie to you, though. Setting up hosting for chat agents is not easy. To skip all of that heartache, go [join the waitlist](https://go.copilotkit.ai/opentag-managed-gh) for the CopilotKit managed service as part of our Intelligence platform, both cloud-hosted or self-hosted.

## Make it your own

OpenTag is deliberately small and hackable:

- **Change what it does.** The agent's behavior is steered by a single system prompt in
  [`runtime.ts`](./runtime.ts) — rewrite it and you have a different agent.
- **Copy `app/` to start your own bot.** It's the platform-agnostic bot (tools, components, the
  human-in-the-loop gate). `runtime.ts` is the agent backend: one CopilotKit `BuiltInAgent` (an
  LLM + optional MCP tools — no Python, no LangGraph), served over AG-UI.
- **One platform, or all of them.** `createChannel` takes an array of adapters; set the secrets for
  whichever platform(s) you want and the bot starts an adapter for each.

The full architecture, the file-by-file map, and every integration live in
**[setup.md](./setup.md)**.

## Deep research (LangGraph deep agent)

`agent/` is an alternative agent backend to `runtime.ts` — a Python
[`deepagents`](https://github.com/langchain-ai/deepagents) (LangGraph) planner with a virtual
filesystem and OPTIONAL Tavily web research, served over AG-UI on `:8123`. Instead of a single
system-prompted LLM call, it plans with `write_todos`, reads/writes its own virtual files, and
(when configured) researches the web before synthesizing an answer — while still calling
KiteBot's forwarded generative-UI tools like the TS runtime does.

Only `OPENAI_API_KEY` is required. `TAVILY_API_KEY` is **optional** — without it, chat and UI
generation still work (the agent answers from its own knowledge); with it, live web research
turns on.

To run it:

```bash
cd agent && uv sync   # requires uv: https://docs.astral.sh/uv/
pnpm agent            # cd agent && uv run python main.py — serves over AG-UI on :8123
                       # (port from PORT/SERVER_PORT env, default 8123)
```

Then point the bot at it instead of `runtime.ts` by setting in `.env`:

```bash
AGENT_URL=http://localhost:8123/
```

With `agent/` in the mix, the local setup is now three pieces: the deep-research agent
(`pnpm agent`, `:8123`), the bot (`pnpm channel` or `pnpm dev`), and whichever brain
`AGENT_URL` points at — the Python deep agent above, or the TS `runtime.ts` (`pnpm runtime`,
`:8200`) as before. `agent` and `runtime` are alternative brains for the same bot; run one or
the other depending on what `AGENT_URL` targets.

## Deploy to Railway (one-click)

The whole KiteBot stack deploys to [Railway](https://railway.com) as **three services**, all
built from this one repo and wired together automatically over Railway's private networking:

| Service | What it is | Build |
| --- | --- | --- |
| `agent` | the Python deep-research backend (`agent/`) | nixpacks, `uvicorn`, `/health` (root dir `agent/`) |
| `notion-mcp` | the Notion MCP sidecar (`pnpm notion-mcp`) | Node |
| `channel` | the KiteBot channel host (`pnpm channel`) | `RAILPACK` (pinned), custom `buildCommand` — installs Chromium + the apt libs it needs for `render_chart`/`render_diagram` |

`channel` reaches `agent` via `AGENT_URL`, and `agent` reaches `notion-mcp` via `NOTION_MCP_URL`
— both wired with Railway reference variables in [`.railway/railway.ts`](./.railway/railway.ts),
so you don't set them by hand.

> **Don't change the `channel` service's builder in the Railway UI.** The apt packages that give
> it a working Chromium (`RAILPACK_DEPLOY_APT_PACKAGES` in
> [`.railway/railway.ts`](./.railway/railway.ts)) are honored only by Railpack — switching to a
> different builder silently makes that a no-op and breaks `render_chart`/`render_diagram` at
> runtime with no build-time signal.

**Deploy via Infrastructure-as-Code (recommended):**

```bash
pnpm install                 # installs the `railway` SDK the CLI uses to evaluate .railway/railway.ts
npm i -g @railway/cli        # or: brew install railway
railway login
railway init                 # create a new Railway project (or `railway link` to select an existing one)
railway config apply         # from the repo root: provisions agent + notion-mcp + channel from .railway/railway.ts
```

**Set the secrets** (Railway → each service → *Variables*). The IaC declares them with
`preserve()` and never stores values — you fill them in:

- **`agent`** — `OPENAI_API_KEY` (required); `TAVILY_API_KEY` (optional — enables web research);
  `LINEAR_API_KEY` (optional). (`NOTION_MCP_AUTH_TOKEN` is **not** set here — the agent references
  it from `notion-mcp`, so you set it once, below.)
- **`notion-mcp`** — `NOTION_TOKEN` and `NOTION_MCP_AUTH_TOKEN` (any strong string; the agent
  reads the same value via a reference variable). **Both are required** for this service to
  start — its launcher exits if either is missing. Don't want Notion? Remove the `notion-mcp`
  service from `resources` in [`.railway/railway.ts`](./.railway/railway.ts) and delete the
  agent's `NOTION_MCP_URL` / `NOTION_MCP_AUTH_TOKEN` lines; the agent still runs (chat, UI, and —
  with `TAVILY_API_KEY` — web research).
- **`channel`** — `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, `INTELLIGENCE_API_KEY`
  (from your CopilotKit Intelligence project). `CHANNEL_HTTP_TOKEN` is also declared here with
  `preserve()`, but normally leave it **unset** — the channel host's HTTP routes are closed by
  default and the managed channel activates over the gateway WebSocket, not HTTP, so it doesn't
  need them. Only set it if you deliberately want to open those routes for server-to-server or
  `curl` use.

The inter-service URLs/ports are wired for you in [`.railway/railway.ts`](./.railway/railway.ts).
Two values are left unmanaged by the IaC so a UI override survives `railway config apply`: the
agent's `OPENAI_MODEL` (defaults to `gpt-5.5`) and the channel's `INTELLIGENCE_CHANNEL_NAME`
(defaults to `kite-opentag`). Set either in that service's *Variables* to change it — e.g. set
`INTELLIGENCE_CHANNEL_NAME` if your Intelligence channel isn't named `kite-opentag`.

Applying the config creates the services and their wiring; **KiteBot goes live only once the
secrets are set and the `channel` service connects** — that's when your Intelligence dashboard
flips *Waiting for runtime → live*.

> **Bind the connector before the first deploy — the `channel` host is fail-fast.** If
> activation settles with the channel not `online` — most commonly `setup_required`, meaning the
> channel name exists in your Intelligence project but no Slack connector is bound to it — the
> host logs the reason and **exits non-zero** rather than idling in a half-working state.
> Railway's `ON_FAILURE` policy then retries — see `restartPolicyMaxRetries` on the `channel`
> service in [`.railway/railway.ts`](./.railway/railway.ts) for the current budget (deliberately
> higher than the `agent`/`notion-mcp` services', since it's sized as an outage-tolerance budget
> rather than a crash-loop guard) — and once that's exhausted, leaves the service stopped. Finish
> the connector setup in the Intelligence dashboard, then **redeploy the `channel` service**.

> **Cold-start note (Notion):** the `agent` loads its Notion tools once, at startup. On a first
> cold deploy the `agent` can finish booting before `notion-mcp` is accepting connections, in
> which case Notion research is unavailable for that deployment — the agent logs a `WARNING` on
> its stderr (chat, UI, and Tavily web research still work). If KiteBot can't reach Notion after
> the first deploy, **redeploy the `agent` service** once `notion-mcp` is up. (A lazy/retrying
> MCP load would remove this race — tracked as a follow-up.)

**"Deploy on Railway" button (optional):** to get a literal one-click button, publish this repo
as a [Railway template](https://docs.railway.com/templates/create) from your Railway account,
then drop the generated button in:

```md
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/<your-template-id>)
```

## Don't want to host it yourself?

Self-hosting means you run and scale the runtime, persistence, and inspection tooling yourself.
A **managed CopilotKit service** is on its way. It's the same agent, without the ops: durable
threads, persistence, hosted inspection, and agents that improve from feedback (**Continuous
Learning from Human Feedback**). 

- **[Join the waitlist →](https://go.copilotkit.ai/opentag-managed-gh)** — be first in when the managed service opens.
- **[Talk to an engineer →](https://copilotkit.ai/talk-to-an-engineer)** — building something real on this? We'd love to help you ship it.

## Learn more

The **[CopilotKit Slack quickstart](https://docs.copilotkit.ai/slack)** is the canonical guide
to building a Slack agent — read it alongside this starter. Detailed setup and configuration
lives in **[setup.md](./setup.md)**.

## License

MIT — see [LICENSE](./LICENSE).
