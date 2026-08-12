<div align="center">

# OpenTag

**An open-source, self-hosted on-call triage assistant for Slack and Microsoft Teams — clone it, customize it, ship your own.**

[**See it work**](#see-it-work) · [**Quick start**](#quick-start) · [**Make it yours**](#make-it-yours) · [**Channels SDK**](https://github.com/CopilotKit/channels-sdk)

[![Built with Channels SDK](https://img.shields.io/badge/built%20with-Channels%20SDK-6430AB)](https://github.com/CopilotKit/channels-sdk)
[![Managed by CopilotKit Intelligence](https://img.shields.io/badge/managed%20by-CopilotKit%20Intelligence-1e293b)](https://docs.copilotkit.ai/channels)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

</div>

https://github.com/user-attachments/assets/46fb9854-7540-4756-a33f-fe97810f80d4

<div align="center">

A spreadsheet goes in. A native Slack chart, a Linear issue behind an approval
gate, and a cited research brief come back — in the thread, where the work
already is.

</div>

## The Channels SDK starter application

[Channels SDK](https://github.com/CopilotKit/channels-sdk) brings any AG-UI agent
into Slack and Microsoft Teams. Its README shows you the pieces. **OpenTag is
those pieces assembled into something you would actually deploy** — and it is
built to be taken, not just read.

| Clone it | Customize it | Ship it |
| --- | --- | --- |
| A working triage bot in one quick start: managed Channel, Node runtime, Python LangGraph agent, and native Slack UI. | The agent, the persona, the tools, and the UI are each one file or one directory. Point it at your own agent without touching the Channel lifecycle. | Two Railway services, pinned SDK versions, graceful shutdown, and a live Slack harness — production shape, not demo shape. |

Slack and Microsoft Teams are supported today. Discord, Telegram, and WhatsApp
are coming soon.

## See it work

Every frame below is this repository running in a real Slack workspace.

| Native UI from a file | Approval before a write | Research with sources |
| --- | --- | --- |
| <img src="./assets/demo-chart.png" alt="A CSV is uploaded and OpenTag replies with a native Slack line chart of impressions, engagements, and likes, plus a written takeaway"> | <img src="./assets/demo-approval.png" alt="OpenTag asks to save a project, the user approves, and OpenTag reports the Linear project it created"> | <img src="./assets/demo-research.png" alt="OpenTag returns a table of AI industry themes with a key takeaway and a list of cited sources"> |
| A `.csv` becomes a Slack chart and an insight, not a wall of numbers. | Linear and Notion writes pause for a human. The button resumes the LangGraph run. | Live web research comes back as a table with the links it used. |

## Quick start

Prerequisites: Node.js 22+, pnpm, Python 3.12,
[`uv`](https://docs.astral.sh/uv/), a CopilotKit account, an OpenAI API key,
and a Slack workspace you can install an app into.

OpenTag's channel can run two ways:

1. **Managed channel runner** — a CopilotKit Intelligence Channel runs the
   connection and takes care of the durable-data concerns: delivery, state,
   and concurrency. Free plan available; this quick start uses it.
2. **Your own channel runner** — build and operate one on the open-source
   Channels SDK. See the
   [Channels SDK docs](https://docs.copilotkit.ai/channels) for how to do
   that.

### 1. Install dependencies

```bash
pnpm install
```

### 2. Create the managed Channel

Do this **before** touching Slack. The Channel is what generates a Slack app
manifest already pointed at the right Request URL, so creating the Slack app
first means creating the wrong one.

Two ways to do it. Both end in the same place.

#### Let your coding agent drive it

```bash
npx --yes copilotkit@latest channels setup
```

That installs a `channels-setup` skill and copies a one-line prompt to your
clipboard (`--no-clipboard` prints it instead). Paste it into your agent:

> Use the `channels-setup` skill to set up a Channel for this project.

The skill is deliberately a pointer rather than a copy of the steps: it fetches
its workflow from <https://copilotkit.ai/channels-guide.md> at run time, so it
cannot go stale against the CLI. It covers the whole path — selecting the
project, creating and reconciling the Channel, walking you through the Slack
console handoff, and proving a real mention gets a reply. It hands every secret
back to you; it never asks you to paste one into chat.

It writes `.agents/skills/channels-setup` and a `skills-lock.json`, both already
gitignored here. Note that it installs to every coding agent it detects with no
way to narrow the list. To install for one agent only, use the equivalent
command, which takes the same prompt:

```bash
npx --yes copilotkit@latest skills onboard --channels --agent claude-code
```

The skill will also carry you through the rest of this quick start. One thing to
watch: its workflow is written for a project starting from nothing, so it has
phases for building the agent and writing the Channel runtime. **OpenTag already
has both** — [`agent/`](./agent) and [`server.ts`](./server.ts). Point your agent
at the existing code to verify and run, not to rewrite.

#### Or run it yourself

```bash
npx --yes copilotkit@latest project select
```

```bash
npx --yes copilotkit@latest channels add --name open-tag --display-name "OpenTag" --adapter slack --json
```

`channels add` declares the Channel in `.copilotkit/channels.json`, creates it
on the server, and returns a JSON envelope with one of three states:

- `completed` — the adapter is attached. Continue to step 3.
- `blocked` — a normal pause waiting on you in the Slack console. Read
  `nextAction`: it carries the prefilled manifest link, the exact environment
  variable names to set, and the `resumeCommand` to run afterward. This exits 0.
- `failed` — stop and read the error code. Do not continue.

`--name` is a slug and must match `INTELLIGENCE_CHANNEL_NAME` character for
character. If you are running a fork against your own project, pick your own
name — see [Channel names claim deliveries](#channel-names-claim-deliveries).

For Microsoft Teams, use `--adapter teams`. Two Teams steps stay yours because
nothing can work around them: granting tenant admin consent, and uploading the
app package through **Apps → Manage your apps → Upload an app**.

#### Three Slack details that cost the most time

These apply on either path. Follow the CLI's emitted `nextAction` rather than
remembered Slack steps, and watch for:

- After creating the app from the link, open **OAuth & Permissions** and choose
  **Reinstall to Workspace**. Slack applies the manifest's real scopes only on
  reinstall.
- Take the **Bot User OAuth Token** (`xoxb-`) from **OAuth & Permissions**, not
  the token shown in the app-creation modal, and the **Signing Secret** from
  **Basic Information → App Credentials**. Those two values are all the Slack
  adapter wants — there is no app-level `xapp-` token anywhere on this path.
- The signing secret is reissued on reinstall. If auth fails right after a
  reinstall, suspect a stale stored secret before a missing scope.

### 3. Configure the environment

```bash
cp .env.example .env
```

Set:

```dotenv
OPENAI_API_KEY=sk-...
AGENT_URL=http://localhost:8123/
INTELLIGENCE_API_KEY=cpk-...
INTELLIGENCE_CHANNEL_NAME=open-tag
```

Both the Node runtime and the Python agent load this one root `.env`; Railway
supplies the same values as service variables. Tavily, GitHub, PostHog, Linear,
and Notion are optional — see [Optional research
sources](#optional-research-sources).

`INTELLIGENCE_API_URL` and `INTELLIGENCE_GATEWAY_WS_URL` already default to the
production Intelligence endpoints in
[`app/env.ts`](./app/env.ts), so leaving them unset is correct.

### 4. Run the stack

```bash
pnpm dev
```

The `predev` hook syncs the locked Python environment and installs Playwright's
Chromium. `pnpm dev` then runs the Python agent with reload enabled and the Node
runtime in watch mode. The runtime waits for its Intelligence connection to
become ready before its HTTP listener accepts traffic.

### 5. Invite the bot

```text
/invite @OpenTag
```

Installed in the workspace is not the same as present in a conversation. Slack
emits no `app_mention` at all for a channel the app is not a member of, so
without this OpenTag looks broken while behaving correctly.

## Prove it works

A Channel that installs cleanly and answers nothing is the most expensive
failure available here, because it looks finished. Three checks separate the
two. Send them from a real human account:

1. **Mention it.** `@OpenTag what changed in the last deploy?` — expect a
   useful, model-backed reply.
2. **Follow up without mentioning it,** in that same thread — expect a reply.
   A mention subscribes the thread; unmentioned messages run the agent only in
   already-subscribed threads.
3. **Send an unmentioned message in a fresh conversation** — expect
   **silence**. A reply here means the trigger rules are wrong.

If any of those fail, in this order:

```bash
npx --yes copilotkit@latest channels status --json
```

It reports declaration, source, server, adapter, environment, and lifecycle
diagnostics. Resolve every one. Two of its warnings are expected for OpenTag
and are not faults: it flags `INTELLIGENCE_API_URL` and
`INTELLIGENCE_GATEWAY_WS_URL` as unset because
[`app/env.ts`](./app/env.ts) defaults them in code rather than in `.env`.

```bash
LOG_LEVEL=debug pnpm runtime
```

The runtime logger defaults to `error`, while every Channel lifecycle
breadcrumb is emitted at `warn` — including `channel "<name>" requires setup`,
the single highest-value diagnostic here. At the default level it is written and
discarded.

Note that the runtime does not hot-reload Channel wiring. After editing a
handler, the agent, or the Channel, restart the process and confirm `online`
again before retesting. A stale process answering with the old behavior is
indistinguishable from a change that did not work.

### Channel names claim deliveries

Managed delivery is claim-based: two runtimes declaring the same Channel name in
the same Intelligence project race per delivery, and the loser silently receives
nothing. The tell is a Slack reply your terminal knows nothing about.

`INTELLIGENCE_CHANNEL_NAME` defaults to `open-tag`, which is the name the
production deployment uses. Give a local or forked runtime its own Intelligence
project, its own API key, and its own Channel name.

## Make it yours

OpenTag is meant to be forked. Each thing you would want to change is one file
or one directory, and none of them require touching the Channel lifecycle.

| To change… | Edit | Notes |
| --- | --- | --- |
| The persona and behavior | [`agent/prompts/`](./agent/prompts) | `system.py` holds the base system prompt |
| The agent itself | [`agent/agent.py`](./agent/agent.py) | A LangGraph deep agent; model and reasoning effort come from the environment |
| **The agent framework** | `AGENT_URL` | Point it at *any* AG-UI-compatible agent. The runtime speaks AG-UI over HTTP and does not care what is on the other end |
| Which tools the agent has | [`agent/tools.py`](./agent/tools.py), [`agent/internal_sources.py`](./agent/internal_sources.py) | Sources register only when their credentials are present |
| What gets rendered in chat | [`app/components/`](./app/components), [`app/tools/`](./app/tools) | Issue cards, tables, charts, diagrams |
| Mentions, commands, triggers | [`app/channel.tsx`](./app/channel.tsx) | The whole Channel surface in one file |
| Which writes need approval | [`agent/write_confirmation.py`](./agent/write_confirmation.py) | The interceptor that emits `confirm_write` |
| The deployment topology | [`.railway/railway.ts`](./.railway/railway.ts) | Two services, declared as code |

If you are customizing with a coding agent, read [`AGENTS.md`](./AGENTS.md)
first — it names the API authority for Channels code and points at the setup
workflow instead of letting an agent improvise one.

## What OpenTag includes

- Mentions and app-owned commands.
- Sender-aware context and Slack tools scoped to Slack turns.
- Rich issue, page, status, incident, link, table, native Slack chart, and
  diagram output.
- File-aware prompts.
- A LangGraph interrupt and resumable confirmation card before Linear or Notion
  writes.
- Graceful, idempotent shutdown for Channels, HTTP, and the rendering browser.
- Nullable parent-message ID normalization through `SanitizingHttpAgent`.

The Python agent is the only supported backend. Its identity and behavior live
in [`agent/agent.py`](./agent/agent.py); the Channel UI and behavior live under
[`app/`](./app/).

## How it works

```text
Slack / Microsoft Teams
          │ HTTPS to an Intelligence-hosted Request URL
          ▼
CopilotKit Intelligence
          │ outbound websocket from your runtime
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

| You run | CopilotKit Intelligence manages |
| --- | --- |
| The Python agent, its model credentials, and its tools | Slack and Microsoft Teams platform credentials |
| The long-running Node Channels runtime | Platform ingress and credentialed delivery |
| Deployment, state, and logs | Runtime registration, health, and reconnects |

Neither leg is Socket Mode, and neither needs a tunnel or a public URL of your
own. Slack reaches Intelligence over HTTPS, authenticated by the signing secret
Intelligence holds. Intelligence reaches your runtime over a websocket your
process opens outbound, authenticated by `INTELLIGENCE_API_KEY`.

There is one canonical runtime host: [`server.ts`](./server.ts).
[`app/index.ts`](./app/index.ts) composes one `CopilotKitIntelligence`, one
`CopilotRuntime`, and one adapter-free managed Channel. Intelligence owns the
Slack and Microsoft Teams adapters, their credentials, and attachments — no
platform credential belongs in this repository's environment.

`@copilotkit/channels` and `@copilotkit/runtime` are pinned for reproducible
deploys. [`package.json`](./package.json) is the source of truth for both
versions.

One naming collision is worth internalizing: the CopilotKit CLI's `channels`
commands configure **managed Intelligence Channels**. They do not configure the
open-source `@copilotkit/channels` adapter packages, which are a separate
product that shares the words "channels" and "Slack". OpenTag uses the package
to define its Channel and Intelligence to deliver to it.

## Optional research sources

Every one of these is optional. Without them OpenTag still chats, triages
requests, and renders UI from model knowledge.

| Variable | Enables |
| --- | --- |
| `TAVILY_API_KEY` | Live web research |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | Read-only repository, code, issue, and PR search |
| `POSTHOG_PERSONAL_API_KEY` | PostHog analytics, read-only (use the **MCP Server** key preset) |
| `LINEAR_API_KEY` | Hosted Linear MCP |
| `NOTION_MCP_URL` + `NOTION_MCP_AUTH_TOKEN` | Remote Notion MCP; setting only one disables it |

Every Linear and Notion mutation is intercepted in code before the MCP request
runs. The interceptor emits `confirm_write` and proceeds only after approval;
reads and rendering do not pause.

[`setup.md`](./setup.md) documents each source, its overrides, and the full
environment contract.

## Deploying

[`.railway/railway.ts`](./.railway/railway.ts) defines exactly two services,
both sourced from `CopilotKit/OpenTag` on `main`:

| Service | Root | Start | Health |
| --- | --- | --- | --- |
| `agent` | `agent` | `uvicorn main:app --host "" --port ${PORT:-8123}` | `/health` |
| `runtime` | repository root | `pnpm runtime` | `/api/copilotkit/info` |

The runtime reaches the agent over Railway private networking and embeds the
managed Channel. Connecting both services to `main` enables GitHub-triggered
deployments after merges. See [`setup.md`](./setup.md#railway) for the variable
contract.

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

## Developer resources

| I want to… | Start here |
| --- | --- |
| Get OpenTag answering in Slack | [Quick start](#quick-start) |
| Fork it and change the agent | [Make it yours](#make-it-yours) |
| Read the full environment contract | [`setup.md`](./setup.md) |
| Customize it with a coding agent | [`AGENTS.md`](./AGENTS.md) |
| Understand the SDK underneath | [Channels SDK](https://github.com/CopilotKit/channels-sdk) |
| Build a Channel from scratch | [Channels documentation](https://docs.copilotkit.ai/channels) |
| Try Channels with no setup at all | [Try Channels](https://www.copilotkit.ai/try-channels) |
| Connect an agent in another framework | [AG-UI integrations](https://docs.ag-ui.com/introduction) |
| Cut production `@kite` over to OpenTag | [`docs/migration-kite.md`](./docs/migration-kite.md) |

## About

OpenTag is built and maintained by [CopilotKit](https://www.copilotkit.ai) —
the team behind the [Channels SDK](https://github.com/CopilotKit/channels-sdk)
and the [AG-UI protocol](https://github.com/ag-ui-protocol/ag-ui).

It is a **starter project for the Channels SDK**. The SDK's own README shows
each piece on its own; OpenTag is those pieces assembled into an application
worth deploying, published so you can start from a working system instead of a
blank directory. Nothing here is meant to stay the way we wrote it — fork it,
swap the agent, the persona, the tools, and the UI, and ship it under your own
name. We keep it aligned with the SDK so a fork stays upgradeable.

Two adjacent things, so the boundary stays clear:

- The **[Channels SDK](https://github.com/CopilotKit/channels-sdk)**
  (`@copilotkit/channels`) is the open-source library that gives an
  AG-UI-compatible agent a native place to work in Slack and Microsoft Teams.
  OpenTag is one application built on it.
- **[CopilotKit Intelligence](https://docs.copilotkit.ai/channels)** is the
  managed service that runs the platform connection and the durable-data
  concerns behind it. This quick start uses it, and it is optional — you can
  operate your own channel runner instead.

Questions, forks worth showing off, and bug reports are all welcome:

- [Discord](https://discord.gg/6dffbvGU3D) — ask a question or show what you
  built
- [@copilotkit on X](https://x.com/copilotkit) — releases and what's shipping
- [docs.copilotkit.ai](https://docs.copilotkit.ai) — CopilotKit and Channels
  documentation
- [OpenTag issues](https://github.com/CopilotKit/OpenTag/issues) for this
  repository, [channels-sdk issues](https://github.com/CopilotKit/channels-sdk/issues)
  for the SDK underneath it

## License

[MIT](./LICENSE) © CopilotKit
