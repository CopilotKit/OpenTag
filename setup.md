# OpenTag setup

This guide covers the canonical OpenTag deployment: one Python agent service
and one Node CopilotRuntime service with Channels embedded.

Slack and Microsoft Teams are supported for this launch. Discord, Telegram,
and WhatsApp are coming soon.

## Components

| Component | Location | Responsibility |
| --- | --- | --- |
| Runtime entrypoint | [`server.ts`](./server.ts) | Environment, Channels readiness, HTTP lifecycle, and shutdown |
| Application composition | [`app/index.ts`](./app/index.ts) | SDK agent factory, managed Channel, and runtime |
| Channel definition | [`app/channel.tsx`](./app/channel.tsx) | Mentions, commands, components, modals, and interrupts |
| Intelligence runtime | [`app/runtime-host.ts`](./app/runtime-host.ts) | One `CopilotKitIntelligence` and one `CopilotRuntime` |
| Python agent | [`agent/`](./agent) | LangGraph deep agent served over AG-UI |
| Railway topology | [`.railway/railway.ts`](./.railway/railway.ts) | Two services sourced from OpenTag `main` |

The host always uses the Intelligence-owned runtime. It declares one
adapter-free Channel using the configured name. Its Slack and Microsoft Teams
adapters, credentials, and attachments are configured only in Intelligence.

## Install

Prerequisites:

- Node.js 22+
- pnpm
- Python 3.12
- [`uv`](https://docs.astral.sh/uv/)
- A CopilotKit Intelligence project, Channel, and runtime API key
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
| `OPENAI_REASONING_EFFORT` | No | Defaults to `low` |
| `OPENAI_VERBOSITY` | No | Defaults to `low` |
| `TAVILY_API_KEY` | No | Enables live web research |
| `POSTHOG_PERSONAL_API_KEY` | No | Enables the hosted PostHog MCP in read-only CLI mode |
| `POSTHOG_MCP_URL` | No | Overrides the hosted PostHog MCP URL |
| `LINEAR_API_KEY` | No | Enables the hosted Linear MCP |
| `LINEAR_MCP_URL` | No | Overrides the hosted Linear MCP URL |
| `NOTION_MCP_AUTH_TOKEN` | No | Bearer token for a remote Notion MCP; requires `NOTION_MCP_URL` |
| `NOTION_MCP_URL` | No | Remote Notion MCP endpoint; requires `NOTION_MCP_AUTH_TOKEN` |
| `SERVER_HOST` | No | Local bind host; defaults to `0.0.0.0` |
| `SERVER_PORT` / `PORT` | No | Local port; defaults to `8123` |

Only `OPENAI_API_KEY` is required. Without Tavily or internal-source
credentials, the agent still chats, triages, and renders supported UI
components. Planning and virtual files remain available for explicitly
substantial work. The Python agent explicitly loads this root `.env` for local
development; Railway service variables work normally without a checked-in
environment file.

Run it:

```bash
pnpm agent
```

The AG-UI endpoint is `http://localhost:8123/`; `/health` reports the
`opentag-agent` service.

## Configure Intelligence

In [CopilotKit Intelligence](https://intelligence.copilotkit.ai):

1. Create or select the OpenTag project.
2. Create one Channel named `open-tag`.
3. Issue a runtime API key.
4. Configure the Slack and Microsoft Teams adapters on that Channel.

| Variable | Required | Purpose |
| --- | --- | --- |
| `AGENT_URL` | Yes | Python AG-UI endpoint, locally `http://localhost:8123/` |
| `INTELLIGENCE_API_KEY` | Yes | Runtime authentication |
| `INTELLIGENCE_API_URL` | No | Defaults to `https://api.intelligence.copilotkit.ai` |
| `INTELLIGENCE_GATEWAY_WS_URL` | No | Defaults to `wss://realtime.intelligence.copilotkit.ai` |
| `INTELLIGENCE_CHANNEL_NAME` | No | Defaults to `open-tag`; Railway uses `open-tag` |
| `AGENT_AUTH_HEADER` | No | Authorization header forwarded to the agent |
| `PORT` | No | Channel HTTP port; defaults to `3000` |

Legacy organization, project, Channel ID, and runtime-instance ID variables are
not used. Slack and Teams credentials also do not belong in this environment;
Intelligence owns them.

Start the runtime:

```bash
pnpm runtime
```

Use `pnpm dev` for watch mode. `pnpm start` and `pnpm runtime` both run the
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
3. Start the OpenTag `runtime` service with
   `INTELLIGENCE_CHANNEL_NAME=open-tag`.
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

Managed Microsoft Teams is supported. Configure the Teams adapter on the same
`open-tag` Channel in Intelligence. The same Node process and runtime host both
platforms; there is no direct adapter or Railway platform credential.

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
`web_search` tool is not registered when the key is absent.

### PostHog

Create a PostHog personal API key using the **MCP Server** preset, then set
`POSTHOG_PERSONAL_API_KEY` in the root `.env`. OpenTag connects to
`https://mcp.posthog.com/mcp` in token-efficient CLI mode with server-enforced
read-only access. Set `POSTHOG_MCP_URL` only to override the complete endpoint,
including its `mode=cli&readonly=true` safety parameters. Restart `pnpm agent`
after changing either variable.

### Linear

Set `LINEAR_API_KEY` in the root `.env`. OpenTag connects to the hosted Linear
MCP by default. Railway preserves this optional secret on the `agent` service.

### Notion

Notion is optional and is not a separate Railway service. Configure an existing
remote MCP endpoint by setting both `NOTION_MCP_URL` and
`NOTION_MCP_AUTH_TOKEN`, then restart `pnpm agent` so it discovers the tools.
If either value is absent, OpenTag skips Notion without blocking startup.

## Railway

The IaC file declares exactly:

- `agent`: `CopilotKit/OpenTag`, branch `main`, root `agent`, Railpack,
  `/health`, port `8123`.
- `runtime`: `CopilotKit/OpenTag`, branch `main`, repository root,
  `pnpm runtime`, `/api/copilotkit/info`, port `3000`.

`runtime.AGENT_URL` references the agent's Railway private domain and port.
Production Intelligence URLs are literal configuration, the API key is
preserved, and the Channel name is `open-tag`. `OPENAI_API_KEY` is required on
`agent`; Tavily, PostHog, Linear, and the paired remote Notion variables are
optional preserved settings.

Evaluate the configuration locally without applying it:

```bash
node node_modules/railway/dist/iac/bin.js
```

The live Railway migration reuses the existing Kite `runtime` service, adds the
`agent`, connects both to OpenTag, and enables GitHub autodeploys.

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
