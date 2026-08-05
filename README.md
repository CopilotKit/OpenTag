# OpenTag

OpenTag is an open-source on-call triage assistant for Slack and Microsoft
Teams, with research available on demand. It runs on CopilotKit Channels,
connects to CopilotKit Intelligence, and uses a Python LangGraph agent over
AG-UI.

Slack and Microsoft Teams are supported today. Discord, Telegram, and WhatsApp
are coming soon.

## Quick start

Prerequisites: Node.js 22+, pnpm, Python 3.12,
[`uv`](https://docs.astral.sh/uv/), a CopilotKit account, an OpenAI API key,
and a Slack workspace you can install an app into.

### 1. Install dependencies

```bash
pnpm install
```

### 2. Create the managed Channel

Do this **before** touching Slack. The Channel is what generates a Slack app
manifest already pointed at the right Request URL, so creating the Slack app
first means creating the wrong one.

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

Follow the emitted `nextAction` rather than remembered Slack steps. Three
details in that flow cost the most time when skipped:

- After creating the app from the link, open **OAuth & Permissions** and choose
  **Reinstall to Workspace**. Slack applies the manifest's real scopes only on
  reinstall.
- Take the **Bot User OAuth Token** (`xoxb-`) from **OAuth & Permissions**, not
  the token shown in the app-creation modal, and the **Signing Secret** from
  **Basic Information → App Credentials**. Those two values are all the Slack
  adapter wants — there is no app-level `xapp-` token anywhere on this path.
- The signing secret is reissued on reinstall. If auth fails right after a
  reinstall, suspect a stale stored secret before a missing scope.

`--name` is a slug and must match `INTELLIGENCE_CHANNEL_NAME` character for
character. If you are running a fork against your own project, pick your own
name — see [Channel names claim deliveries](#channel-names-claim-deliveries).

For Microsoft Teams, use `--adapter teams`. Two Teams steps stay yours because
nothing can work around them: granting tenant admin consent, and uploading the
app package through **Apps → Manage your apps → Upload an app**.

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

## Architecture

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

## Docs

- [`setup.md`](./setup.md) — full reference: components, environment contract,
  commands, optional sources, Railway.
- [`docs/migration-kite.md`](./docs/migration-kite.md) — CopilotKit-internal
  cutover of the existing production `@kite` app.
- [`e2e/README.md`](./e2e/README.md) — Slack live harness.

## License

MIT — see [LICENSE](./LICENSE).
