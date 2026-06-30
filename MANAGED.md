# Managed mode — OpenTag on CopilotKit Intelligence

Run the same OpenTag bot, but with **CopilotKit Intelligence** as the managed
bridge: Intelligence receives the Slack event, persists it, and delivers it to
this process over HTTP; this process runs the bot's normal handlers/tools/agent
and emits a reply; Intelligence does the credentialed Slack send. **No Slack
tokens live in this app** in managed mode.

The only OpenTag code is one entry — `app/managed.ts` — which attaches a single
config-free `intelligenceAdapter()`:

```ts
const bot = createBot({ name, agent, tools, context, commands,
  adapters: [intelligenceAdapter()] }); // env-driven HTTP transport to Intelligence
await bot.start();
```

## Prerequisites

1. A running **Intelligence app-api** with the hosted-bots routes (the
   `codex/hosted-bots-infra-vertical-slice` branch), `FF_MANAGED_BOTS=true`. See
   that repo's `local/README.md`. Default local base URL: `http://localhost:7050`.
2. In the Intelligence UI (`/o/:org/:project/bots`):
   - **Create a bot** with name `opentagbot` (lowercase letters/digits — the
     intersection of the SDK and Intelligence name rules).
   - **Attach a Slack adapter** with a real Slack app's `botToken` + `signingSecret`.
   - **Mint a runtime API key** (project → API keys); copy the `cpk-…` token once.
3. A **real Slack app** whose Event Subscriptions request URL points (via a
   tunnel, e.g. `ngrok http 7050`) at
   `https://<tunnel>/api/bots/adapters/slack/events`, subscribed to `app_mention`
   (+ `message.im`), scopes `app_mentions:read` + `chat:write`.

## Run

```bash
# agent backend (unchanged — same as the direct path)
pnpm runtime                 # http://localhost:8200

# managed bot
COPILOTKIT_INTELLIGENCE_URL=http://localhost:7050 \
COPILOTKIT_API_KEY=cpk-...  \
MANAGED_BOT_NAME=opentagbot \
AGENT_URL=http://localhost:8200/api/copilotkit/agent/triage/run \
pnpm managed
```

`pnpm managed` heartbeats Intelligence, polls for deliveries, runs the agent per
turn, and posts the reply back through Intelligence. @-mention the bot in a Slack
channel it's in; the reply comes back in-thread.

## ⚠️ Temporary dependency pin

`package.json` pins every `@copilotkit/*` package to the **PR #5761** pkg.pr.new
build, at an **immutable commit** (`…/@copilotkit/<pkg>@0641b63`) so the resolved
build can't drift (the mutable `@5761` tag can be cached stale). pkg.pr.new does
not publish `@copilotkit/bot-store-redis`, so the Redis demo was removed on this
branch. `pnpm-workspace.yaml` sets `blockExoticSubdeps: false` because pkg.pr.new
packages cross-reference each other by URL. **Revert to published versions and
drop these workarounds once #5761 merges and releases.**
