# OpenTag

OpenTag is an open-source research and triage agent for Slack and Microsoft
Teams. It runs on CopilotKit Channels, connects to CopilotKit Intelligence, and
uses a Python LangGraph deep agent over AG-UI.

The launch supports:

- Slack through Intelligence, including the existing production `@kite` app.
- Microsoft Teams through Intelligence.
- Optional direct Slack and Teams adapters for local development.

Discord, Telegram, and WhatsApp are coming soon.

## Architecture

```text
Slack / Microsoft Teams
          │
          ▼
CopilotKit Intelligence
          │ realtime
          ▼
channel (Node + CopilotRuntime + Channels)
          │ AG-UI
          ▼
agent (Python + LangGraph deepagents)
          ├── OpenAI
          ├── Tavily (optional)
          ├── Linear MCP (optional)
          └── Notion MCP (optional local sidecar)
```

There is one canonical Channel host: [`server.ts`](./server.ts). It creates one
`CopilotKitIntelligence`, one `CopilotRuntime`, and an adapter-free managed
OpenTag Channel. Platform attachments are normally configured in Intelligence.
Supplying local Slack or Teams credentials adds a separately named direct
Channel to that same runtime; it does not create a separate lifecycle or
disable managed delivery.

The launch pins the requested canaries:

- `@copilotkit/channels@0.2.2-canary.rc-1`
- `@copilotkit/runtime@1.63.3-canary.rc-1`

## Quick start

Prerequisites: Node.js 22+, pnpm, Python 3.12, and
[`uv`](https://docs.astral.sh/uv/).

1. Install dependencies.

   ```bash
   pnpm install --frozen-lockfile
   cd agent && uv sync && cd ..
   ```

2. Configure the Python agent.

   ```bash
   cp agent/.env.example agent/.env
   ```

   Set `OPENAI_API_KEY`. Tavily, Linear, and Notion are optional.

3. Configure the Channel host.

   ```bash
   cp .env.example .env
   ```

   Set:

   ```dotenv
   AGENT_URL=http://localhost:8123/
   INTELLIGENCE_API_KEY=cpk-...
   ```

   `INTELLIGENCE_API_URL` and `INTELLIGENCE_GATEWAY_WS_URL` default to the
   production Intelligence endpoints. `INTELLIGENCE_CHANNEL_NAME` defaults to
   `opentag`.

4. In Intelligence, create the Channel that matches
   `INTELLIGENCE_CHANNEL_NAME` and attach managed Slack and/or Microsoft Teams.

5. Run both services.

   ```bash
   pnpm agent
   pnpm channel
   ```

The Channel waits for its Intelligence connection to become ready before its
HTTP listener accepts traffic.

## What OpenTag includes

- Mentions and app-owned commands.
- Sender-aware context and Slack tools scoped to Slack turns.
- Rich issue, page, status, incident, link, table, chart, and diagram output.
- File-aware prompts.
- A LangGraph interrupt and resumable confirmation card before Linear or Notion
  writes.
- Graceful, idempotent shutdown for Channels, HTTP, and the rendering browser.
- Nullable parent-message ID normalization through `SanitizingHttpAgent`.

The Python agent is the only supported backend. Its identity and behavior live
in [`agent/agent.py`](./agent/agent.py); the Channel UI and behavior live under
[`app/`](./app/).

## Platform setup

### Intelligence (recommended)

Use the normal Intelligence flow for both launch platforms:

1. Create one OpenTag project and Channel in Intelligence.
2. Issue a runtime API key.
3. Configure the Slack and/or Microsoft Teams attachment in Intelligence.
4. Run one `pnpm channel` process with that Channel name and key.

No organization, project, Channel ID, or runtime-instance ID environment
variables are required.

### Optional direct adapters

For local development, set either complete pair in the root `.env`:

```dotenv
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

TEAMS_CLIENT_ID=...
TEAMS_CLIENT_SECRET=...
```

`TEAMS_TENANT_ID` and `TEAMS_PORT` are optional. Incomplete credential pairs
fail at startup instead of silently disabling an adapter. The Intelligence
connection remains the owner of the runtime, while each direct adapter stays
isolated from the managed Channel.

### Slack manifests

[`slack-app-manifest.yaml`](./slack-app-manifest.yaml) and
[`slack-app-manifest.json`](./slack-app-manifest.json) describe OpenTag for new
installations.

For the production migration, **do not recreate or reinstall the existing
Slack app**. Reusing it preserves the bot user, workspace installation, and
`@kite` handle. Stop the old Socket Mode consumer before attaching its existing
`xapp` and `xoxb` tokens in Intelligence so only one consumer is active.

## Optional research sources

- `TAVILY_API_KEY` enables live web research. Without it, OpenTag still chats,
  plans, uses its virtual filesystem, and renders UI from model knowledge.
- `LINEAR_API_KEY` enables the hosted Linear MCP.
- Notion can be used locally with `pnpm notion-mcp`; copy the same
  `NOTION_MCP_AUTH_TOKEN` into the root `.env` and `agent/.env`. The Railway
  launch intentionally has no Notion sidecar.

Every Linear and Notion mutation is intercepted in code before the MCP request
runs. The interceptor emits `confirm_write` and proceeds only after approval;
reads and rendering do not pause.

## Railway

[`.railway/railway.ts`](./.railway/railway.ts) defines exactly two services,
both sourced from `CopilotKit/OpenTag` on `main`:

| Service | Root | Start | Health |
| --- | --- | --- | --- |
| `agent` | `agent` | `uvicorn main:app --host :: --port ${PORT:-8123}` | `/health` |
| `channel` | repository root | `pnpm channel` | Channels readiness before listen |

The Channel reaches the agent over Railway private networking. Railway sets
`INTELLIGENCE_CHANNEL_NAME=kite` for the production cutover and preserves the
runtime API key. OpenAI is required on `agent`; Tavily and Linear secrets are
optional. Connecting both services to `main` enables GitHub-triggered
deployments after merges.

The repository configuration does not mutate the existing production Railway
project. Inventory and cutover should happen after Railway authentication.

## Verification

```bash
pnpm install --frozen-lockfile
pnpm check-types
pnpm test
(cd agent && uv run pytest)
node node_modules/railway/dist/iac/bin.js
```

The Slack live harness is documented in [`e2e/README.md`](./e2e/README.md).
Production acceptance is one end-to-end `@kite` mention that returns the
OpenTag persona through the Python agent.

## License

MIT — see [LICENSE](./LICENSE).
