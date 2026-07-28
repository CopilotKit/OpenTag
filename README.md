# OpenTag

OpenTag is an open-source research and triage agent for Slack and Microsoft
Teams. It runs on CopilotKit Channels, connects to CopilotKit Intelligence, and
uses a Python LangGraph deep agent over AG-UI.

The launch supports:

- Slack through Intelligence, including the existing production `@kite` app.
- Microsoft Teams through Intelligence.

Discord, Telegram, and WhatsApp are coming soon.

## Architecture

```text
Slack / Microsoft Teams
          │
          ▼
CopilotKit Intelligence
          │ realtime
          ▼
runtime (Node + CopilotRuntime with embedded Channels)
          │ AG-UI
          ▼
agent (Python + LangGraph deepagents)
          ├── OpenAI
          ├── Tavily (optional)
          ├── Linear MCP (optional)
          └── Notion MCP (optional local sidecar)
```

There is one canonical runtime host: [`server.ts`](./server.ts).
[`app/index.ts`](./app/index.ts) composes one `CopilotKitIntelligence`, one
`CopilotRuntime`, and two adapter-free managed Channels: the configured base
name for Slack and `<base>-teams` for Microsoft Teams. Intelligence owns all
platform credentials and attachments.

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

2. Configure both services from the shared root environment.

   ```bash
   cp .env.example .env
   ```

   Set:

   ```dotenv
   OPENAI_API_KEY=sk-...
   AGENT_URL=http://localhost:8123/
   INTELLIGENCE_API_KEY=cpk-...
   ```

   Tavily, Linear, and Notion are optional. Both Node and Python load this root
   `.env`; Railway supplies the same values as service variables.

   `INTELLIGENCE_API_URL` and `INTELLIGENCE_GATEWAY_WS_URL` default to the
   production Intelligence endpoints. `INTELLIGENCE_CHANNEL_NAME` defaults to
   `opentag`.

3. In Intelligence, create two managed Channels: `opentag` for Slack and
   `opentag-teams` for Microsoft Teams. If you change the base name, use that
   name and `<base>-teams`.

4. Run both services.

   ```bash
   pnpm agent
   pnpm runtime
   ```

The runtime waits for its Intelligence connection to become ready before its
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

### Intelligence

Use the normal Intelligence flow for both launch platforms:

1. Create one OpenTag project.
2. Create the base Channel for Slack and `<base>-teams` for Microsoft Teams.
3. Issue a runtime API key.
4. Configure each platform attachment on its matching Channel.
5. Run one `pnpm runtime` process with the base Channel name and key.

No organization, project, Channel ID, or runtime-instance ID environment
variables—or Slack/Teams credentials—are required by the runtime.

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
- Notion is optional for local development: put its token and shared
  `NOTION_MCP_AUTH_TOKEN` in the root `.env` and run `pnpm notion-mcp`.

Every Linear and Notion mutation is intercepted in code before the MCP request
runs. The interceptor emits `confirm_write` and proceeds only after approval;
reads and rendering do not pause.

## Railway

[`.railway/railway.ts`](./.railway/railway.ts) defines exactly two services,
all sourced from `CopilotKit/OpenTag` on `main`:

| Service | Root | Start | Health |
| --- | --- | --- | --- |
| `agent` | `agent` | `uvicorn main:app --host "" --port ${PORT:-8123}` | `/health` |
| `runtime` | repository root | `pnpm runtime` | `/api/copilotkit/info` |

The runtime reaches the agent over Railway private networking and embeds both
managed Channels. Railway sets `INTELLIGENCE_CHANNEL_NAME=kite`, so the runtime
declares `kite` for Slack and `kite-teams` for Teams. It preserves the runtime
API key. OpenAI is required on `agent`; Tavily and Linear secrets are optional.
Connecting both services to `main` enables GitHub-triggered deployments after
merges.

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
