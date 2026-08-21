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
| AWS topology | [`deployment/aws/`](./deployment/aws) | One private Fargate task, images, secrets, and Datadog log forwarding |

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

Node 22 is a floor, not a preference. `package.json` declares
`engines: { node: ">=22" }` because `@composio/core` pulls `openai@7`, which
requires it. On Node 20 you are stopped at install rather than at runtime, which
is the point.

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

### Shared identity

| Variable             | Required | Purpose                                                                                 |
| -------------------- | -------- | --------------------------------------------------------------------------------------- |
| `AGENT_DISPLAY_NAME` | No       | User-facing identity used by the agent persona and capability UI; defaults to `OpenTag` |

Set the same value on both services when they do not share an environment. For
example, `AGENT_DISPLAY_NAME=Kite` makes the agent introduce itself and render
its capability showcase as Kite without renaming the OpenTag project, services,
or Channel slug.

### Agent

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Model access |
| `OPENAI_MODEL` | No | Defaults to `gpt-5.5` |
| `OPENAI_REASONING_EFFORT` | No | Defaults to `low` |
| `OPENAI_VERBOSITY` | No | Defaults to `low` |
| `TAVILY_API_KEY` | No | Enables live web research |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | No | Enables read-only GitHub repository, code, PR, Actions-run, and job-log search. It remains the legacy coding fallback |
| `GITHUB_MCP_URL` | No | Overrides the hosted GitHub MCP URL; OpenTag still sends read-only headers |
| `DAYTONA_API_KEY` | No | Enables the coding subagent (Daytona sandbox) |
| `DAYTONA_SNAPSHOT` | No | Optional Daytona snapshot id. If unset, the first command probes the box. `git` and `pnpm` install only when needed. The default snapshot already has Node. `pnpm` is enabled with Corepack in `$HOME/.local/bin` |
| `DAYTONA_TTL_MINUTES` | No | Daytona box TTL in minutes. Defaults to `60` |
| `GITHUB_CODER_TOKEN` | No | Preferred PAT coding credential. Mutually exclusive with complete GitHub App credentials |
| `GITHUB_APP_ID` | No | GitHub App ID; all three App variables are required together |
| `GITHUB_APP_INSTALLATION_ID` | No | Single supported GitHub App installation ID |
| `GITHUB_APP_PRIVATE_KEY_BASE64` | No | Base64-encoded GitHub App private-key PEM |
| `POSTHOG_PERSONAL_API_KEY` | No | Enables the hosted PostHog MCP in read-only CLI mode |
| `POSTHOG_MCP_URL` | No | Overrides the hosted PostHog MCP URL |
| `LINEAR_API_KEY` | No | Enables the hosted Linear MCP |
| `LINEAR_MCP_URL` | No | Overrides the hosted Linear MCP URL |
| `NOTION_MCP_AUTH_TOKEN` | No | Bearer token for a remote Notion MCP; requires `NOTION_MCP_URL` |
| `NOTION_MCP_URL` | No | Remote Notion MCP endpoint; requires `NOTION_MCP_AUTH_TOKEN` |
| `CORS_ALLOW_ORIGINS` | No | Comma-separated allowed origins; defaults to `*` |
| `SERVER_HOST` | No | Local bind host; defaults to `0.0.0.0` |
| `SERVER_PORT` | No | Local/container port; defaults to `8123` |
| `AGENT_RELOAD` | No | Local development reload; disabled by default |

To check a live Daytona box (create, `echo`, `git`, then delete):

```bash
uv run --directory agent python scripts/probe_daytona.py
```

Only `OPENAI_API_KEY` is required. Coding stays off until `DAYTONA_API_KEY` and
a PAT or complete GitHub App configuration are set. If both explicit methods are
configured, or the App configuration is incomplete, coding stays off and startup
logs the configuration problem. `GITHUB_ALLOWED_REPOS` is no longer enforced;
if it remains configured, startup warns that GitHub permissions define access.
GitHub MCP stays read-only even when coding is on.
Implementation jobs require a scoped brief with files, the exact change, and a
test command; repair and merge jobs may inspect the checkout and CI logs to
identify those details. Slack does not say "open the PR" unless the user named
a PR. If Slack cuts the live update, the job may still be running. Without
Tavily or internal-source
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
| `INTELLIGENCE_LEARNING_CONTAINER_ID` | No | Assigns OpenTag Threads to this existing Learning Container |
| `INTELLIGENCE_API_URL` | No | Defaults to `https://api.intelligence.copilotkit.ai` |
| `INTELLIGENCE_GATEWAY_WS_URL` | No | Defaults to `wss://realtime.intelligence.copilotkit.ai` |
| `AGENT_AUTH_HEADER` | No | Authorization header forwarded to the agent |
| `PORT` | No | Channel HTTP port; defaults to `3000` |
| `LOG_LEVEL` | No | Defaults to `error`; use `debug` to see Channel lifecycle breadcrumbs |
| `MERMAID_URL` | No | Overrides the Mermaid browser bundle URL used by diagram rendering |
| `COMPOSIO_API_KEY` | No | Master switch for Composio toolkits. Absent means the feature is never constructed |
| `COMPOSIO_TOOLKITS` | No | Toolkit slugs everyone shares one connection for |
| `COMPOSIO_USER_TOOLKITS` | No | Toolkit slugs scoped to whoever sent the message |
| `COMPOSIO_APPROVALS` | No | `off`, `destructive` (default), or `writes`. An unrecognized value fails startup |
| `COMPOSIO_WORKSPACE_USER_ID` | No | Composio `user_id` the shared toolkits run as; defaults to `INTELLIGENCE_CHANNEL_NAME` |
| `COMPOSIO_AUTH_CONFIGS` | No | **Read only by `pnpm composio:connect`, never by the runtime.** `toolkit:auth_config_id` pairs, ids case-sensitive; pins which auth config a *shared* toolkit connects against when it has several |

The API key selects a project; the Channel name selects a Channel inside it.
When `INTELLIGENCE_LEARNING_CONTAINER_ID` is set, it must name an existing
Learning Container in that same project. Omitting it preserves the default
behavior and leaves OpenTag Threads unassigned to Learning.
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

When an agent run fails, Slack gets a short reason (live update cut after
about a minute, dropped connection, coder recursion, or the error text).
If the user named a GitHub PR, that URL is in the message. Slack does not
get a stack trace.

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

Composio calls are gated separately and differently — a second card, its own
`COMPOSIO_APPROVALS` dial, and no graph to resume. See [Composio](#composio).

## Optional sources

### Tavily

Set `TAVILY_API_KEY` to enable live web research. The `web_search` tool is not
registered when the key is absent.

### GitHub

Set `GITHUB_PERSONAL_ACCESS_TOKEN` to enable GitHub search. Use a fine-grained
personal access token limited to the repositories and read permissions the agent
needs. OpenTag connects to GitHub's hosted MCP with an explicit allowlist of
read-only repository, pull-request, Actions-run, and job-log tools. Every loaded
tool must advertise `readOnlyHint`; triggers, reruns, cancels, deletes, and other
writes are excluded. Set `GITHUB_MCP_URL` only
to override the hosted endpoint, then restart `pnpm agent` so it rediscovers the
tools.

For coding, prefer a fine-grained `GITHUB_CODER_TOKEN`; classic PATs continue to
work. Alternatively, set all three GitHub App variables. A search PAT may coexist
with App coding. The required repository permissions are **Contents: read/write**,
**Pull requests: read/write**, and **Metadata: read-only**. Add **Actions: read**
for CI inspection and **Workflows: write** only when the agent must modify workflow
files. Installation-selected repositories are the App authorization boundary.
OpenTag does not request or configure branch-protection bypass.

Credentials stay on the OpenTag host. Daytona receives the current token only on
clone, pull, and push API calls; the sandbox receives no GitHub environment
variable, credential helper, authenticated remote, App JWT, or private key. The
coder commits locally, then one `confirm_write` covers its push and draft-PR
create/update. If the push succeeds and the PR write fails, retrying performs only
the PR write.

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

### Composio

Composio adds a toolkit — Gmail, Linear, Jira, Google Calendar, Salesforce —
without a new MCP block, a `preserve()` line, or a matching test assertion. It
lives in the Node runtime, not the Python agent, because a verified user
identity exists only there: `ChannelToolContext` carries a resolved actor, and
`Thread.runAgent()` has no way to hand a structured user id to the agent.

Setup is **two steps per app**, not one:

1. Add the toolkit at <https://app.composio.dev>. That creates its auth config.
2. Add its slug to `COMPOSIO_TOOLKITS` or `COMPOSIO_USER_TOOLKITS`. For a
   **shared** toolkit, also run `pnpm composio:connect <slug>` once and open the
   link it prints — that needs no running runtime, so do it before you restart.
   Nobody in Slack can do it for you, and the dashboard cannot either; see
   [Shared team accounts versus personal
   ones](#shared-team-accounts-versus-personal-ones). Personal toolkits skip it
   — each user connects their own from a thread.
3. Restart the runtime, once.

**The slug is the tricky part.** It is Composio's own, lowercase and unspaced:
Google Calendar is `googlecalendar`, not `google-calendar` or `gcal`. Take it
from the toolkit's page URL at <https://app.composio.dev> (`/toolkit/gmail`), or
from the Toolkits list in their docs. A typo is **silent** — OpenTag does not
validate slugs against Composio at startup, so a misspelled toolkit is simply a
configured toolkit that never appears: the agent has no tools for it and
`search_my_tools` never mentions it. If an app you configured seems absent,
check the spelling before anything else.

Adding Salesforce six months later is those same steps — no code, no test
change, no edit to `.railway/railway.ts` or the CDK stack. It is not zero-touch:
step 1 is a person in a dashboard and step 3 is a restart.

`COMPOSIO_API_KEY` is the master switch. Without it nothing is constructed — no
SDK client, no session, no tool the model can see but must not call. A key with
both toolkit lists empty is equally inert.

Composio is deliberately local-first. Its variables are not declared in
[`.railway/railway.ts`](./.railway/railway.ts) or in
[`deployment/aws/`](./deployment/aws), so a value set by hand on the Railway
`runtime` service is not carried across an IaC apply. Add a `preserve()` line
before you rely on it in a deployment.

#### Shared team accounts versus personal ones

`COMPOSIO_TOOLKITS` runs every Slack user through **one** connection, under the
Composio `user_id` in `COMPOSIO_WORKSPACE_USER_ID` (defaulting to
`INTELLIGENCE_CHANNEL_NAME`). That is right for the team's Linear or Jira.

`COMPOSIO_USER_TOOLKITS` scopes to the person speaking, keyed by their verified
platform actor id. You ask about "my calendar" and get yours; your colleague
gets theirs. A turn with no resolvable actor gets no personal tools at all and
never falls back to the shared identity.

Both lists may be set at once, and one turn can use both.

How an account actually gets connected differs by list, and this is where the
surprises are:

- **Personal.** The agent posts a public **Connect** card carrying no link.
  Whoever clicks it receives a one-time link privately, minted for them; someone
  else clicking the same card connects their own account. A pre-minted link
  posted in a channel would let whoever opens it bind their own mailbox to
  another person's identity, so the link never appears in the thread. Where
  there is no private channel — the Teams adapter implements no ephemeral post —
  OpenTag says it cannot deliver the link rather than posting it publicly.
- **Shared.** There is no in-Slack path, by design. `connect_my_app` refuses a
  shared toolkit, because the account would be created under the clicker's own
  id while every shared call resolves under `COMPOSIO_WORKSPACE_USER_ID` — the
  user would authorize, come back, and find nothing works. The operator
  connects it once, from a terminal:

  ```bash
  pnpm composio:connect linear
  ```

  It reads your local `.env`, mints a Composio Connect Link bound to the
  resulting `COMPOSIO_WORKSPACE_USER_ID`, and prints it. Open that link
  yourself, in a browser signed in to the account the whole team should act
  through. The link is a bearer capability: whoever completes it *is* the
  account every shared call runs as, so do not forward it.

  **The identity must match the deployed one.** `COMPOSIO_WORKSPACE_USER_ID`
  defaults to `INTELLIGENCE_CHANNEL_NAME`, and Composio variables are set by
  hand on the Railway `runtime` service (above) — so a local `.env` with a
  different Channel name binds the connection to a `user_id` production never
  looks up. Nothing errors: you authorize successfully, deploy, and the bot
  still says the toolkit needs connecting. Set `COMPOSIO_WORKSPACE_USER_ID`
  explicitly to the same value in both places, and confirm the `binds to:` line
  the script prints is the one production uses.

  The script needs no running runtime — no `pnpm dev`, no agent — and never
  guesses which auth config to use. A slug that is not in `COMPOSIO_TOOLKITS`, a
  toolkit with no auth config yet, and a toolkit with several auth configs and
  no pin each exit non-zero naming the fix. In the last case, pin one with
  `COMPOSIO_AUTH_CONFIGS=linear:ac_...` and run it again; a pin is taken as
  given and is not checked against the project, so a wrong id fails at Composio
  rather than here.

**"Connect my account" in the Composio dashboard is a test button.** It binds
the connection to the dashboard's own user id, which OpenTag never passes, so
the bot cannot see it and nobody on your team needs to touch it. Use
`pnpm composio:connect` instead — a shared toolkit is connected only when a
connected account exists under the exact value of `COMPOSIO_WORKSPACE_USER_ID`,
and that script is the only thing that creates one.

Per-user isolation was verified against the live API, not assumed: with two
active connected accounts in a project, sessions created for four other ids all
reported every toolkit unconnected. Connections do not leak across identities.

#### Approvals

`COMPOSIO_APPROVALS` decides what stops for a human:

| Mode | Behavior |
| --- | --- |
| `off` | Never asks. |
| `destructive` | **Default.** Asks only before tools Composio tags `destructiveHint`. |
| `writes` | Asks before anything not tagged `readOnlyHint` — how the Linear and Notion MCP integrations already behave. |

Measured coverage: gmail exposes 63 tools of which 9 are destructive, linear 47
of which 3, googlecalendar 49 of which 8. So `destructive` gates deletes and
their neighbours and leaves everything else silent. A slug OpenTag cannot
classify — past the 300-tool listing cap, or invented by the model — is treated
as destructive, so it is gated in every mode but `off`.

A gated call runs in **two turns**, and that is worth understanding before you
set `writes`. The managed Intelligence adapter reports
`supportsBlockingChoice: false`, so nothing can block waiting for a click; the
tool posts a card and returns "stop here", and the Approve button executes and
rewrites the card in place. The consequence: **the model never sees the result
of a gated call** and cannot summarize or chain off it. Fine for a delete, where
"Done." on the card is the entire answer. On `writes`, every write becomes a
conversational dead end.

**An approval card shows the arguments, in the channel.** Not the tool name —
the values. Every non-empty argument becomes a labelled row: recipients, the
subject, the body, up to 300 characters per row and 12 rows before the rest is
counted and elided. So gating "email that supplier from my Gmail" posts the
draft where everyone in the thread can read it, and the same is true of a
calendar invite's guest list or an issue's description.

That is deliberate and it is not going to change: an approver who cannot see
what they are approving is a rubber stamp, and the card is the only place the
arguments are ever shown. But it is worth weighing before you put personal
toolkits behind approvals, because the person whose mailbox it is may not expect
the thread to see the draft. The dial is `COMPOSIO_APPROVALS`, and it is
all-or-nothing: on the `destructive` default only deletes are carded, so a sent
mail posts nothing; on `writes` every write is carded, arguments and all. There
is no per-toolkit or per-channel setting. Arguments are never written to logs
and never travel in the Slack button payload — the card is the only place they
appear.

Each gated call posts its own card; a batch is not one card. A personal-scope
call may be approved only by the person it was composed for — otherwise Bob
approving Alice's delete would run against Bob's account — while a shared-scope
call may be approved by anyone in the thread. Pending calls live in memory, so a
card clicked after a restart answers `This approval expired — the bot restarted.
Ask again.` instead of executing or hanging.

#### The three startup warnings

OpenTag prints these once at boot and keeps running:

- A personal-shaped app (`gmail`, `googlecalendar`, `outlook`, `googledrive`) in
  `COMPOSIO_TOOLKITS`. Every Slack user will act through one mailbox.
  Occasionally correct — a shared `support@` — usually a mistake.
- The same slug in both lists. The personal account wins and the shared entry is
  dropped for that toolkit; on a turn with no resolvable actor, neither scope
  offers it.
- A toolkit also configured over MCP — `LINEAR_API_KEY`,
  `NOTION_MCP_AUTH_TOKEN`, `POSTHOG_PERSONAL_API_KEY`, or
  `GITHUB_PERSONAL_ACCESS_TOKEN`. The agent then sees two complete tool sets for
  that app with different approval behavior and may pick either, so whether an
  action asks for approval varies per turn. Remove one.

#### What Google shows your users

Consent screens say **Composio**, not OpenTag. The Connect card says so up
front, because the alternative is a user deciding the bot is phishing them.

Composio-managed auth is the default and the right choice. Self-branding is
**worse** until Google verification is finished: without it users get "Google
hasn't verified this app → Advanced → (unsafe)", which is a scarier screen than
a correctly named third party. Verification for restricted Gmail scopes is a
security assessment, not a form.

Two consequences of managed auth:

- All of one person's Composio connections share **one** Google OAuth grant.
  Scopes accumulate across toolkits and the consent screen shows the union —
  observed live as "Composio already has access to 12 capabilities". Revoking
  Composio in Google account settings disconnects **every** app at once.
- Managed auth requests Composio's default scopes. You do not pick them.

A Google Workspace that allowlists third-party apps can block the flow before it
ever reaches OpenTag. That is an admin action in Google, not in Composio, and
the symptom is a user who never gets past the consent screen.

#### Restarts, caching, and logs

OpenTag stores no credentials. Composio holds connected accounts server-side
keyed by `user_id`, so **a restart asks nobody to reconnect** — it empties an
in-process cache and nothing else. A cold session costs roughly a second
(session creation plus the tool listing); afterwards it is free. A cached
session carries a 10-minute TTL, and connecting an account drops that person's
entry outright — session, tool listing, and classification together — so the
next turn sees the new connection instead of waiting out the TTL.

Every Composio call logs one line: slug, effect, the resolved `user_id`, and
Composio's own `logId` for correlating against their dashboard. Never the
arguments — that is where the mail bodies are. `execute()` does not throw on
tool failure, so a failed write returns its error verbatim rather than reading
as a success.

Composio's remote sandbox — the tools slugged `COMPOSIO_REMOTE_BASH_TOOL` and
`COMPOSIO_REMOTE_WORKBENCH`, remote shell and Python; not environment variables
— is disabled on every
session without exception. A default session hands both out with no opt-in, and
OpenTag already has a sandbox in `agent/coding/` behind its own credentials.

[`docs/composio-tools-design.md`](./docs/composio-tools-design.md) records the
design and the API findings verified against the live service.

## Railway

The IaC file declares exactly:

- `agent`: `CopilotKit/OpenTag`, branch `main`, root `agent`, Railpack,
  `/health`, port `8123`.
- `runtime`: `CopilotKit/OpenTag`, branch `main`, repository root,
  `pnpm runtime`, `/api/copilotkit/info`, port `3000`.

`runtime.AGENT_URL` references the agent's Railway private domain and port.
Production Intelligence URLs are literal configuration, the API key is
preserved, and the Channel name is `open-tag`. `AGENT_DISPLAY_NAME` is preserved
independently on both services and must match when overridden. `OPENAI_API_KEY`
is required on `agent`; Tavily, Daytona/coder, GitHub, PostHog, Linear, and the
paired remote Notion variables are optional preserved settings. The `COMPOSIO_*`
variables are deliberately absent — see [Composio](#composio).

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
