# OpenTag

OpenTag is an open-source on-call triage assistant for Slack and Microsoft
Teams, with research available on demand. It runs on CopilotKit Channels,
connects to CopilotKit Intelligence, and uses a Python LangGraph agent over
AG-UI.

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
          ├── GitHub MCP (optional, read-only)
          ├── PostHog MCP (optional, read-only)
          ├── Linear MCP (optional)
          └── Notion MCP (optional remote server)
```

There is one canonical runtime host: [`server.ts`](./server.ts).
[`app/index.ts`](./app/index.ts) composes one `CopilotKitIntelligence`, one
`CopilotRuntime`, and one adapter-free managed Channel. Intelligence owns its
Slack and Microsoft Teams adapters, credentials, and attachments.

The launch pins the requested canaries:

- `@copilotkit/channels@0.2.2-canary.rc-1`
- `@copilotkit/runtime@1.63.3-canary.rc-1`

## Quick start

Prerequisites: Node.js 22+, pnpm, Python 3.12, and
[`uv`](https://docs.astral.sh/uv/).

1. Install the Node dependencies.

   ```bash
   pnpm install
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

   Tavily, GitHub, PostHog, Linear, and Notion are optional. Both Node and
   Python load this root `.env`; Railway supplies the same values as service
   variables.

   `INTELLIGENCE_API_URL` and `INTELLIGENCE_GATEWAY_WS_URL` default to the
   production Intelligence endpoints. `INTELLIGENCE_CHANNEL_NAME` defaults to
   `open-tag`.

   The Intelligence API key selects a project, and the Channel name selects a
   Channel inside that project. Use a non-production project and API key
   locally; Railway keeps its existing production key and `open-tag` Channel.

3. In the project selected by your local Intelligence API key, create one
   managed Channel named `open-tag` and configure its Slack and Microsoft
   Teams adapters.

4. Run the complete local stack.

   ```bash
   pnpm dev
   ```

   The `predev` hook syncs the locked Python environment and installs
   Playwright's Chromium browser. `pnpm dev` then runs the Python agent with
   reload enabled and the Node runtime in watch mode.

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
2. Create one Channel named `open-tag`.
3. Issue a runtime API key.
4. Configure the Slack and Microsoft Teams adapters on that Channel.
5. Run one `pnpm runtime` process with that Channel name and key.

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
  triages requests and renders UI from model knowledge.
- `GITHUB_PERSONAL_ACCESS_TOKEN` enables read-only repository, code, issue, and
  pull-request search through GitHub's hosted MCP. `GITHUB_MCP_URL` can override
  the endpoint; OpenTag still sends GitHub's read-only configuration header.
- `POSTHOG_PERSONAL_API_KEY` enables PostHog analytics through its hosted MCP.
  Create the key with PostHog's **MCP Server** preset. The default connection is
  token-efficient and read-only; `POSTHOG_MCP_URL` can override the endpoint.
- `LINEAR_API_KEY` enables the hosted Linear MCP.
- Notion is optional and remote-only. Set both `NOTION_MCP_URL` and
  `NOTION_MCP_AUTH_TOKEN`; setting only one disables the integration.

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

The runtime reaches the agent over Railway private networking and embeds the
managed `open-tag` Channel. Railway sets
`INTELLIGENCE_CHANNEL_NAME=open-tag`; Intelligence owns both platform
adapters. The runtime API key is preserved. OpenAI is required on `agent`;
Tavily, GitHub search, PostHog, Linear, and remote Notion settings are optional.
Connecting both services to `main` enables GitHub-triggered deployments after
merges.

The repository configuration does not mutate the existing production Railway
project. Inventory and cutover should happen after Railway authentication.

## Verification

```bash
pnpm install --frozen-lockfile
pnpm setup:dev
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
