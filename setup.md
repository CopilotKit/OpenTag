# OpenTag setup

This guide covers the canonical OpenTag deployment: one Python deep-agent
service and one Node Channel service connected to CopilotKit Intelligence.

Slack and Microsoft Teams are supported for this launch. Discord, Telegram,
and WhatsApp are coming soon.

## Components

| Component | Location | Responsibility |
| --- | --- | --- |
| Channel entrypoint | [`server.ts`](./server.ts) | Environment, readiness, HTTP lifecycle, and shutdown |
| Application composition | [`app/index.ts`](./app/index.ts) | SDK agent factory, managed Slack/Teams Channels, and runtime |
| Channel definition | [`app/channel.tsx`](./app/channel.tsx) | Mentions, commands, components, modals, and interrupts |
| Intelligence runtime | [`app/runtime-host.ts`](./app/runtime-host.ts) | One `CopilotKitIntelligence` and one `CopilotRuntime` |
| Python agent | [`agent/`](./agent) | LangGraph deep agent served over AG-UI |
| Railway topology | [`.railway/railway.ts`](./.railway/railway.ts) | Two services sourced from OpenTag `main` |

The host always uses the Intelligence-owned runtime. It declares an
adapter-free Slack Channel using the configured base name and an adapter-free
Teams Channel named `<base>-teams`. Their credentials and attachments are
configured only in Intelligence.

## Install

Prerequisites:

- Node.js 22+
- pnpm
- Python 3.12
- [`uv`](https://docs.astral.sh/uv/)
- A CopilotKit Intelligence project, Channels, and runtime API key
- An OpenAI API key for the Python agent

Install both dependency sets:

```bash
pnpm install --frozen-lockfile
cd agent
uv sync
cd ..
```

The Channels and Runtime packages are intentionally pinned to canaries:

```text
@copilotkit/channels  0.2.2-canary.rc-1
@copilotkit/runtime   1.63.3-canary.rc-1
```

## Configure the environment

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Model access |
| `OPENAI_MODEL` | No | Defaults to `gpt-5.5` |
| `TAVILY_API_KEY` | No | Enables live web research |
| `LINEAR_API_KEY` | No | Enables the hosted Linear MCP |
| `LINEAR_MCP_URL` | No | Overrides the hosted Linear MCP URL |
| `NOTION_MCP_AUTH_TOKEN` | No | Authenticates to a local Notion MCP sidecar |
| `NOTION_MCP_URL` | No | Defaults to `http://127.0.0.1:3001/mcp` |
| `SERVER_HOST` | No | Local bind host; defaults to `0.0.0.0` |
| `SERVER_PORT` / `PORT` | No | Local port; defaults to `8123` |

Only `OPENAI_API_KEY` is required. Without Tavily or internal-source
credentials, the agent still chats, plans, writes virtual files, and renders
supported UI components. The Python agent explicitly loads this root `.env`
for local development; Railway service variables work normally without a
checked-in environment file.

Run it:

```bash
pnpm agent
```

The AG-UI endpoint is `http://localhost:8123/`; `/health` reports the
`opentag-research-agent` service.

## Configure Intelligence

In [CopilotKit Intelligence](https://intelligence.copilotkit.ai):

1. Create or select the OpenTag project.
2. Create two Channels. For a normal installation use `opentag` with provider
   Slack and `opentag-teams` with provider Microsoft Teams. For production use
   `kite` and `kite-teams`.
3. Issue a runtime API key.
4. Configure each platform attachment on its matching Channel.

| Variable | Required | Purpose |
| --- | --- | --- |
| `AGENT_URL` | Yes | Python AG-UI endpoint, locally `http://localhost:8123/` |
| `INTELLIGENCE_API_KEY` | Yes | Runtime authentication |
| `INTELLIGENCE_API_URL` | No | Defaults to `https://api.intelligence.copilotkit.ai` |
| `INTELLIGENCE_GATEWAY_WS_URL` | No | Defaults to `wss://realtime.intelligence.copilotkit.ai` |
| `INTELLIGENCE_CHANNEL_NAME` | No | Defaults to `opentag`; Railway sets `kite` |
| `AGENT_AUTH_HEADER` | No | Authorization header forwarded to the agent |
| `PORT` | No | Channel HTTP port; defaults to `3000` |

Legacy organization, project, Channel ID, and runtime-instance ID variables are
not used. Slack and Teams credentials also do not belong in this environment;
Intelligence owns them.

Start the Channel:

```bash
pnpm channel
```

Use `pnpm dev` for watch mode. `pnpm start` and `pnpm channel` both run the
same canonical entrypoint. Startup waits for `listener.channels.ready()` before
opening HTTP. SIGINT and SIGTERM stop Channels, HTTP, and the rendering browser
once, even if shutdown is requested more than once.

## Slack

### Existing production `@kite`

Do not create, reinstall, or replace the current production Slack app. The
existing app owns the bot user, workspace installation, and `@kite` handle.

For cutover:

1. Stop the old Kite Socket Mode runtime so there is only one consumer.
2. Enter the existing `xapp` and `xoxb` tokens directly into the Slack
   attachment in Intelligence. Do not put them in source control or chat.
3. Start the OpenTag `channel` service with
   `INTELLIGENCE_CHANNEL_NAME=kite`.
4. Send one `@kite` mention and verify the reply uses the OpenTag persona and
   Python deep agent.

If the cutover fails, stop the new Channel before restoring the prior Railway
deployment.

### New Slack installations

The JSON and YAML Slack manifests in this repository describe OpenTag for
future installations. Create a new Slack app from either manifest, install it
to the workspace, and attach its app-level and bot tokens in Intelligence.

Those manifests are not a production migration step for `@kite`.

## Microsoft Teams

Managed Microsoft Teams is supported. Configure the Teams attachment on the
`<base>-teams` Channel in Intelligence. The same Node process and runtime host
both platform Channels; there is no direct adapter or Railway platform
credential.

## Tools, commands, and UI

OpenTag registers:

- `/agent <text>` to run a mention-free prompt.
- `/triage [note]` to summarize and propose Linear issues.
- `/preview <title>` to preview an issue privately where supported.
- `/file-issue` to open a form where supported, with a conversational fallback.

The Channel also forwards sender context, Slack-specific tools on Slack turns,
file content, and rich issue/page/table/chart/diagram/status/incident/link
components.

Before a Linear or Notion mutation reaches MCP, a Python interceptor emits
`confirm_write`. The Channel posts an approval card, and the button resumes the
graph with the user's decision. The MCP handler runs only after approval.
Reads and UI rendering are never gated.

## Optional sources

### Tavily

Set `TAVILY_API_KEY` in the root `.env` to enable live web research. The
`research` tool is not registered when the key is absent.

### Linear

Set `LINEAR_API_KEY` in the root `.env`. OpenTag connects to the hosted Linear
MCP by default. Railway preserves this optional secret on the `agent` service.

### Notion for local development

The Railway launch has no Notion sidecar. For local development:

1. Put `NOTION_TOKEN` and a strong `NOTION_MCP_AUTH_TOKEN` in the root `.env`.
2. Run `pnpm notion-mcp`.
3. Restart `pnpm agent` so it discovers the Notion tools.

Notion is optional and is not a deployment blocker.

## Railway

The IaC file declares exactly:

- `agent`: `CopilotKit/OpenTag`, branch `main`, root `agent`, Nixpacks,
  `/health`, port `8123`.
- `channel`: `CopilotKit/OpenTag`, branch `main`, repository root,
  `pnpm channel`, port `3000`.

`channel.AGENT_URL` references the agent's Railway private domain and port.
Production Intelligence URLs are literal configuration, the API key is
preserved, and the base Channel name is `kite` (with `kite-teams` derived by
the application). `OPENAI_API_KEY` is required on `agent`; Tavily and Linear
are optional preserved secrets.

Evaluate the configuration locally without applying it:

```bash
node node_modules/railway/dist/iac/bin.js
```

The live Railway migration still requires authenticated access: inventory the
existing project, reuse its current Kite service as `channel`, add `agent`,
connect both sources to OpenTag `main`, and enable GitHub autodeploys.

## Coming soon

Discord, Telegram, and WhatsApp are intentionally not configured for this
launch. Their adapters and setup instructions will be added after launch
support is ready.

## Tests

```bash
pnpm install --frozen-lockfile
pnpm check-types
pnpm test
cd agent && uv run pytest
```

The Slack API live harness is separate from unit tests:

```bash
pnpm e2e
```

See [`e2e/README.md`](./e2e/README.md) for its required workspace credentials.
There is no launch-blocking Teams E2E harness; production acceptance is the
single `@kite` round trip described above.
