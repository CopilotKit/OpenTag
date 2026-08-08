# OpenTag reference

The five-minute path to a working OpenTag is in the
[README quick start](./README.md#quick-start). This file is the reference behind
it: components, the full environment contract, Channel commands, optional
sources, Railway, and tests.

The canonical deployment is one Python agent service and one Node
CopilotRuntime service with Channels embedded. Slack and Microsoft Teams are
supported; Discord, Telegram, and WhatsApp are coming soon.

## Components

| Component | Location | Responsibility |
| --- | --- | --- |
| Runtime entrypoint | [`server.ts`](./server.ts) | Environment, Channels readiness, HTTP lifecycle, and shutdown |
| Application composition | [`app/index.ts`](./app/index.ts) | SDK agent factory, managed Channel, and runtime |
| Channel definition | [`app/channel.tsx`](./app/channel.tsx) | Mentions, commands, components, modals, and interrupts |
| Intelligence runtime | [`app/runtime-host.ts`](./app/runtime-host.ts) | One `CopilotKitIntelligence` and one `CopilotRuntime` |
| Environment contract | [`app/env.ts`](./app/env.ts) | Required variables and in-code defaults |
| Python agent | [`agent/`](./agent) | LangGraph deep agent served over AG-UI |
| Railway topology | [`.railway/railway.ts`](./.railway/railway.ts) | Two services sourced from OpenTag `main` |

The host always uses the Intelligence-owned runtime. It declares one
adapter-free Channel using the configured name. The Slack and Microsoft Teams
adapters, their credentials, and attachments are configured only in
Intelligence — never here.

## Install

Prerequisites:

- Node.js 22+
- pnpm
- Python 3.12
- [`uv`](https://docs.astral.sh/uv/)
- A CopilotKit Intelligence project, Channel, and runtime API key (free plan
  available) — or an alternative
  [Channels SDK](https://docs.copilotkit.ai/channels) channel runner
- An OpenAI API key for the Python agent

```bash
pnpm install --frozen-lockfile
cd agent
uv sync
cd ..
```

`@copilotkit/channels` and `@copilotkit/runtime` are intentionally pinned.
[`package.json`](./package.json) is the single source of truth for both
versions; this file does not restate them, because a hand-copied pin drifts on
the next bump.

## Environment contract

```bash
cp .env.example .env
```

One root `.env` configures both services. The Python agent loads it explicitly
for local development; Railway supplies the same values as service variables
without a checked-in file.

### Agent

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Model access |
| `OPENAI_MODEL` | No | Defaults to `gpt-5.5` |
| `OPENAI_REASONING_EFFORT` | No | Defaults to `low` |
| `OPENAI_VERBOSITY` | No | Defaults to `low` |
| `TAVILY_API_KEY` | No | Enables live web research |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | No | Enables read-only GitHub repository, code, issue, and PR search |
| `GITHUB_MCP_URL` | No | Overrides the hosted GitHub MCP URL; OpenTag still sends read-only headers |
| `POSTHOG_PERSONAL_API_KEY` | No | Enables the hosted PostHog MCP in read-only CLI mode |
| `POSTHOG_MCP_URL` | No | Overrides the hosted PostHog MCP URL |
| `LINEAR_API_KEY` | No | Enables the hosted Linear MCP |
| `LINEAR_MCP_URL` | No | Overrides the hosted Linear MCP URL |
| `NOTION_MCP_AUTH_TOKEN` | No | Bearer token for a remote Notion MCP; requires `NOTION_MCP_URL` |
| `NOTION_MCP_URL` | No | Remote Notion MCP endpoint; requires `NOTION_MCP_AUTH_TOKEN` |
| `SERVER_HOST` | No | Local bind host; defaults to `0.0.0.0` |
| `SERVER_PORT` / `PORT` | No | Local port; defaults to `8123` |

Only `OPENAI_API_KEY` is required. Without Tavily or internal-source
credentials the agent still chats, triages, and renders supported UI
components; planning and virtual files remain available for explicitly
substantial work.

Run it alone:

```bash
pnpm agent
```

The AG-UI endpoint is `http://localhost:8123/`; `/health` reports the
`opentag-agent` service.

### Runtime

| Variable | Required | Purpose |
| --- | --- | --- |
| `AGENT_URL` | Yes | Python AG-UI endpoint, locally `http://localhost:8123/` |
| `INTELLIGENCE_API_KEY` | Yes | Runtime authentication; also selects the project |
| `INTELLIGENCE_CHANNEL_NAME` | No | Defaults to `open-tag`; must match the Channel name exactly |
| `INTELLIGENCE_API_URL` | No | Defaults to `https://api.intelligence.copilotkit.ai` |
| `INTELLIGENCE_GATEWAY_WS_URL` | No | Defaults to `wss://realtime.intelligence.copilotkit.ai` |
| `AGENT_AUTH_HEADER` | No | Authorization header forwarded to the agent |
| `PORT` | No | Channel HTTP port; defaults to `3000` |
| `LOG_LEVEL` | No | Defaults to `error`; use `debug` to see Channel lifecycle breadcrumbs |

The API key selects a project; the Channel name selects a Channel inside it.
Legacy organization, project, Channel ID, and runtime-instance ID variables are
not used. Slack and Teams credentials do not belong here — Intelligence owns
them.

Both Intelligence URLs are defaulted in [`app/env.ts`](./app/env.ts) rather than
in `.env`. That is deliberate, and it is why `copilotkit channels status`
reports them as unset. A genuinely missing `INTELLIGENCE_GATEWAY_WS_URL` does
not error: the realtime plane is a different host from the API plane and is not
derived from it, so `channels.ready()` simply hangs until it times out.

Start the runtime:

```bash
pnpm runtime
```

`pnpm start` and `pnpm runtime` run the same canonical entrypoint; `pnpm dev`
adds watch mode for both services. Startup waits for
`listener.channels.ready()` before opening HTTP. SIGINT and SIGTERM stop
Channels, HTTP, and the rendering browser exactly once, even if shutdown is
requested more than once.

Note that `ready()` resolving is not proof of health. It also resolves on
`setup_required`, which is a valid degraded state rather than a failure. Only
`controls.status()` → `{ overall, channels }` distinguishes them, and
`/api/copilotkit/info` returning 200 reports license and runtime state while
saying nothing at all about Slack.

## Channel reference

The Channel is created and reconciled with the public CopilotKit CLI. These
commands configure **managed Intelligence Channels**; they do not configure the
open-source `@copilotkit/channels` adapter packages, which are a separate
product sharing the words "channels" and "Slack".

| Command | Purpose |
| --- | --- |
| `copilotkit project select` | Select or create the hosted Intelligence project |
| `copilotkit channels add [name]` | Declare a Channel, reconcile it, and report the next step |
| `copilotkit channels status` | Compare your configuration, your code, and the server |
| `copilotkit channels list` | List Channels and their attachment state |
| `copilotkit channels rotate <name>` | Replace stored provider credentials |
| `copilotkit channels providers` | List providers and the credentials each asks for |
| `copilotkit channels setup` | Install the `channels-setup` skill and hand the flow to your coding agent |
| `copilotkit skills onboard --channels` | The same prompt, but `--agent` narrows which agents it installs to |

No flag accepts a credential value. Credentials are read from `.env`, from a
named variable via `--credential-env <field>=<VAR>`, or from a JSON document on
stdin via `--credentials-stdin` for CI and secret managers. `--json` implies
non-interactive: it never prompts and never opens a browser.

`channels add` writes `.copilotkit/channels.json`. Keep that file tracked; keep
`.env` and `.copilotkit/artifacts/` ignored.

The `channels-setup` skill installed by `channels setup` is a pointer, not a copy
of the steps: it fetches its workflow from
<https://copilotkit.ai/channels-guide.md> at run time so it cannot go stale
against the CLI. That workflow assumes a project starting from nothing, so it
includes phases for building the agent and writing the Channel runtime — OpenTag
has both already. Its Slack handoff never asks anyone to paste a secret into chat.

### Credentials each provider asks for

| Provider | Fields |
| --- | --- |
| `slack` | `channelToken` — Bot User OAuth Token (`xoxb-`), from **OAuth & Permissions**; `signingSecret`, from **Basic Information → App Credentials** |
| `teams` | `clientId` and `tenantId`, from the Entra app registration **Overview**; `clientSecret` — the secret **Value**, not the Secret ID |

There is no app-level `xapp-` token on the managed path. Slack reaches
Intelligence over HTTPS at an Intelligence-hosted Request URL, authenticated by
the signing secret Intelligence holds, and Intelligence reaches your runtime
over a websocket your process opens outbound. Nothing here uses Socket Mode, and
a Slack app configured for Socket Mode installs green and delivers nothing.

`copilotkit channels add --adapter teams --provision` can create the
provider-side Teams app for you. Two Teams gates stay user-owned regardless:
granting tenant admin consent, and uploading the app package through **Apps →
Manage your apps → Upload an app**.

### Channel names claim deliveries

Managed delivery is claim-based. Two runtimes declaring the same Channel name in
the same project race per delivery, and the loser silently receives nothing —
the tell is a Slack reply your terminal knows nothing about. Give a local or
forked runtime its own project, key, and Channel name rather than reusing
`open-tag`.

The name is a slug: lowercase, digits, single hyphens. It must match
`INTELLIGENCE_CHANNEL_NAME` character for character.

## Tools, commands, and UI

OpenTag registers:

- `/agent <text>` to run a mention-free prompt.
- `/triage [note]` to summarize and propose Linear issues.
- `/preview <title>` to preview an issue privately where supported.
- `/file-issue` to open a form where supported, with a conversational fallback.

The Channel also forwards sender context, Slack-specific tools on Slack turns,
file content, and rich issue/page/table/native-Slack-chart/diagram/status/
incident/link components.

Trigger routing is not symmetric. A mentioned turn goes to `onMention` if
registered and falls back to `onMessage` otherwise; an unmentioned turn reaches
`onMessage` only. `onMention` subscribes the thread, which is what lets
unmentioned follow-ups in that thread run the agent. Always verify with a
channel mention first.

Mentions, messages, and button and select clicks are the proven managed-path
triggers — interactivity is enabled deliberately, which is what makes
human-in-the-loop fire. **Slash commands and modals are registered in code but
their managed-path delivery depends on the Channel's generated Slack manifest
declaring them.** As of the last verification against `@copilotkit/channels`
0.7.0 the generated manifest declared no `slash_commands` and `view_submission`
was not handled, so those handlers compiled, started, reported online, and never
fired. Send a real command and submit a real modal before relying on either.

Before a Linear or Notion mutation reaches MCP, a Python interceptor emits
`confirm_write`. The Channel posts an approval card, and the button resumes the
graph with the user's decision. The MCP handler runs only after approval. Reads
and UI rendering are never gated.

## Optional sources

### Tavily

Set `TAVILY_API_KEY` to enable live web research. The `web_search` tool is not
registered when the key is absent.

### GitHub

Set `GITHUB_PERSONAL_ACCESS_TOKEN` to enable GitHub search. Use a fine-grained
personal access token limited to the repositories and read permissions the agent
needs. OpenTag connects to GitHub's hosted MCP with only the repository, issue,
and pull-request toolsets and requests read-only mode. Set `GITHUB_MCP_URL` only
to override the hosted endpoint, then restart `pnpm agent` so it rediscovers the
tools.

### PostHog

Create a PostHog personal API key using the **MCP Server** preset, then set
`POSTHOG_PERSONAL_API_KEY`. OpenTag connects to `https://mcp.posthog.com/mcp` in
token-efficient CLI mode with server-enforced read-only access. Set
`POSTHOG_MCP_URL` only to override the complete endpoint, including its
`mode=cli&readonly=true` safety parameters. Restart `pnpm agent` after changing
either variable.

### Linear

Set `LINEAR_API_KEY`. OpenTag connects to the hosted Linear MCP by default.
Railway preserves this optional secret on the `agent` service.

### Notion

Notion is optional and remote-only, not a separate Railway service. Set both
`NOTION_MCP_URL` and `NOTION_MCP_AUTH_TOKEN`, then restart `pnpm agent` so it
discovers the tools. If either value is absent OpenTag skips Notion without
blocking startup.

## Railway

The IaC file declares exactly:

- `agent`: `CopilotKit/OpenTag`, branch `main`, root `agent`, Railpack,
  `/health`, port `8123`.
- `runtime`: `CopilotKit/OpenTag`, branch `main`, repository root,
  `pnpm runtime`, `/api/copilotkit/info`, port `3000`.

`runtime.AGENT_URL` references the agent's Railway private domain and port.
Production Intelligence URLs are literal configuration, the API key is
preserved, and the Channel name is `open-tag`. `OPENAI_API_KEY` is required on
`agent`; Tavily, GitHub, PostHog, Linear, and the paired remote Notion variables
are optional preserved settings.

Evaluate the configuration locally without applying it:

```bash
node node_modules/railway/dist/iac/bin.js
```

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
There is no launch-blocking Teams E2E harness.

## Coming soon

Discord, Telegram, and WhatsApp are intentionally not configured. Their adapters
and setup instructions will be added once launch support is ready.
