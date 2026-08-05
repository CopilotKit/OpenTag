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
| `TAP_AGENT_KEY` | No | Enables TAP mode: services are reached through the [TAP](https://tap.human.tech) credential proxy, no service keys in this process (see [docs/tap.md](./docs/tap.md)) |
| `TAP_PROXY_URL` | No | Overrides the TAP proxy URL (defaults to the hosted proxy; set for self-hosted TAP) |
| `TAP_APPROVAL_TIMEOUT` | No | Seconds to wait when TAP holds a call for human approval; defaults to `60` (the held call's outcome stays retrievable after the wait) |
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

Internal sources (PostHog, Linear, Notion) can be connected **one of two
ways** — pick per service before setting variables:

- **Option A — direct keys (default).** Paste each service's key into the
  root `.env` as described per service below. Keys live in the agent process.
- **Option B — [TAP mode](#tap-mode-credential-isolation--any-connected-service).**
  Set a single `TAP_AGENT_KEY` and skip service keys. The agent reaches
  services through the
  [TAP](https://tap.human.tech?utm_source=opentag&utm_medium=github&utm_content=setup)
  credential proxy: no service keys in this process — a prompt-injected agent
  cannot leak a key it never held — plus per-call audit and optional
  per-credential human approval. Also covers services with no MCP integration
  here (GitHub, Sentry, PagerDuty, …). Free tier; the onboarding wizard
  issues the agent key in a few minutes.

The choice is **per service, and the two compose**: with `TAP_AGENT_KEY` set,
any service whose key you still provide below keeps its direct MCP connection,
and TAP covers the rest. Leave a service's key out to route it through TAP —
that is what makes TAP's isolation and approval enforcement apply to it.

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

### TAP mode (credential isolation + any connected service)

Set `TAP_AGENT_KEY` (from a [TAP](https://tap.human.tech) account's agent key)
and restart `pnpm agent`. The agent then reaches any service connected to the
TAP account through the TAP proxy via two generic tools (`tap_discover` +
`tap_call`). It composes per service with the direct integrations above: a
service whose key is still set keeps its direct MCP connection; leave a
service's key out and TAP covers it with no key in this process. Credentials
don't have to be created up front: when the agent needs a service that isn't
connected yet, it posts a prefilled setup link in the conversation. Full
guide: [docs/tap.md](./docs/tap.md).

## Railway

The IaC file declares exactly:

- `agent`: `CopilotKit/OpenTag`, branch `main`, root `agent`, Railpack,
  `/health`, port `8123`.
- `runtime`: `CopilotKit/OpenTag`, branch `main`, repository root,
  `pnpm runtime`, `/api/copilotkit/info`, port `3000`.

`runtime.AGENT_URL` references the agent's Railway private domain and port.
Production Intelligence URLs are literal configuration, the API key is
preserved, and the Channel name is `open-tag`. `OPENAI_API_KEY` is required on
`agent`; Tavily, PostHog, Linear, the paired remote Notion variables, and the
TAP variables (`TAP_AGENT_KEY`, `TAP_PROXY_URL`, `TAP_APPROVAL_TIMEOUT`) are
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
