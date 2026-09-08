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
adapter-free Channel using the configured name, with no exceptions: the Slack
and Microsoft Teams adapters, their credentials, and attachments are configured
only in Intelligence, and no platform token is read here.

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
| `COMPOSIO_API_KEY` | No | Master switch for Composio toolkits. Absent means the feature is never constructed |
| `COMPOSIO_TOOLKITS` | No | Toolkit slugs everyone shares one connection for |
| `COMPOSIO_USER_TOOLKITS` | No | Toolkit slugs scoped to whoever sent the message. Each person connects their own account from a Slack thread; a non-empty `AGENT_AUTH_HEADER` is required before a link is minted |
| `COMPOSIO_APPROVALS` | No | `on` (default) or `off`. `destructive` and `writes` are the old spellings and still parse as `on`. An unrecognized value fails startup, but only once Composio is configured — with no API key or no toolkit list the variable is never read |
| `COMPOSIO_WORKSPACE_USER_ID` | No | Composio `user_id` the shared toolkits run as. Defaults to this service's `INTELLIGENCE_CHANNEL_NAME`, and to `open-tag` when that variable is not set on the agent |
| `INTELLIGENCE_CHANNEL_NAME` | No | Also read here, not only by the runtime: it is the default shared-toolkit `user_id` above. The agent's own fallback is `open-tag`, so an overridden Channel name has to be set on **both** services or the shared identity differs between them |
| `COMPOSIO_AUTH_CONFIGS` | No | `toolkit:auth_config_id` pairs, ids case-sensitive. Pins which auth config a toolkit connects against when it has several. Unset, Composio picks one from the project |
| `AGENT_AUTH_HEADER` | No | The runtime's shared secret. Checked when set to a non-empty value, and **required** — non-empty — before a Composio connect link is minted; `""` reads as unconfigured |
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
| `AGENT_AUTH_HEADER` | No | Shared secret between runtime and agent. Sent as `Authorization`; the agent checks it when set to a non-empty value, and **requires** a non-empty one before minting a Composio connect link |
| `PORT` | No | Channel HTTP port; defaults to `3000` |
| `LOG_LEVEL` | No | Defaults to `error`. Channel lifecycle breadcrumbs are emitted at `warn`, so set `warn` or lower to see them |
| `MERMAID_URL` | No | Overrides the Mermaid browser bundle URL used by diagram rendering |

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

There is no app-level `xapp-` token on the managed path, and nothing in OpenTag
reads one. Slack reaches Intelligence over HTTPS at an Intelligence-hosted
Request URL, authenticated by the signing secret Intelligence holds, and
Intelligence reaches your runtime over a websocket your process opens outbound.

`copilotkit channels add --adapter teams --provision` can create the
provider-side Teams app for you. Two Teams gates stay user-owned regardless:
granting tenant admin consent, and uploading the app package through **Apps →
Manage your apps → Upload an app**.

### Leave Socket Mode off

**Socket Mode stays off on the Slack app, permanently.** Managed delivery never
uses it, and a Slack app with Socket Mode enabled installs green and delivers
nothing to the Request URL — which is to say, nothing to Intelligence and
nothing to your runtime. It fails silently and it looks like success.

This is not hypothetical. OpenTag once attached its own Socket Mode adapter so a
Composio connect link could reach one person privately; from 24 August until
that adapter was turned off, Slack delivered events over the socket and stopped
posting them to Intelligence, so the managed path was dead. That adapter and its
two tokens have since been removed from this repository outright — private
delivery is the managed adapter's job with the SDK pair pinned in
[`package.json`](./package.json), and nothing here reads a Slack token any more.

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
declaring them**, which is decided server-side by Intelligence rather than by
anything in this repository. A handler that is never delivered still compiles,
starts, and reports online, so send a real command and submit a real modal
against your own Channel before relying on either.

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
lives in the Python agent, alongside every other capability, and is gated by the
same `confirm_write` card that already guards a Linear or Notion write. There is
one approval mechanism in this product, not two.

Setup is **three steps per app**, not one:

1. Add the toolkit at <https://app.composio.dev>. That creates its auth config.
2. Add its slug to `COMPOSIO_TOOLKITS` or `COMPOSIO_USER_TOOLKITS`. A **shared**
   toolkit also needs connecting once:

   ```bash
   cd agent && uv run python -m composio_tools.connect_cli <toolkit>
   ```

   Open the link it prints, signed in as the account the team should share. That
   needs no running agent, so do it before you restart. Personal toolkits skip
   this — each person connects their own from a thread.
3. Restart the agent, once.

**The slug is the tricky part.** It is Composio's own, lowercase and unspaced:
Google Calendar is `googlecalendar`, not `google-calendar` or `gcal`. Take it
from the toolkit's page URL at <https://app.composio.dev> (`/toolkit/gmail`), or
from the Toolkits list in their docs. A typo is **silent** — OpenTag does not
validate slugs against Composio at startup, so a misspelled toolkit is simply one
that never appears: the agent has no tools for it and `search_my_tools` never
mentions it. If an app you configured seems absent, check the spelling first.

`COMPOSIO_API_KEY` is the master switch. Without it nothing is constructed — no
client, no session, no tool the model can see but must not call. A key with both
toolkit lists empty is equally inert.

#### Shared team accounts versus personal ones

`COMPOSIO_TOOLKITS` runs every Slack user through **one** connection, under the
Composio `user_id` in `COMPOSIO_WORKSPACE_USER_ID` — defaulting to the agent's
own `INTELLIGENCE_CHANNEL_NAME`, and to `open-tag` when that is unset there.
That is right for the team's Linear or Jira. The connect script below reads the
same two variables from wherever you run it, so an id that differs between your
shell and the deployment connects an account no turn will look up.

`COMPOSIO_USER_TOOLKITS` scopes to whoever spoke, keyed by their verified
platform actor **and** the platform it came from — a provider id is unique only
within its provider, so `U1` on Slack and `U1` on Teams are different people. You
ask about "my calendar" and get yours; your colleague gets theirs. A turn with no
resolvable actor gets no personal tools at all and never falls back to the shared
identity.

Both lists may be set at once, and one turn can use both. A toolkit named in both
resolves to the personal scope only.

How an account gets connected differs by list, and this is where the surprises
are:

- **Personal.** The agent calls `connect_app`, which posts a public **Connect**
  card carrying no link. On Slack, whoever clicks receives a one-time link
  privately, minted for them; somebody else clicking the same card connects
  their own account. A pre-minted link posted in a channel would be an
  account-takeover hazard, because whoever completes the flow binds their
  account to the id the link was minted for.
- **Shared.** Nobody in Slack can connect it, and neither can the dashboard — a
  connection made there binds to the dashboard's own user id, which this
  deployment never passes. It is a test button. The connect script above is the
  only correct path.

**Personal toolkits work, and Slack is the surface they work on.** The agent
learns who spoke from `forwardedProps.channelActor`, which the pinned
`@copilotkit/channels` forwards on every run of a turn. A clean install of this
repository resolves the speaker with nothing configured for it.

Delivery is the other half, and it is where the surfaces differ. A connect link
has to reach one person alone. On Slack it does: the Connect card is public in
the thread, the link is minted when somebody clicks and goes to that person
privately, and the whole flow is proven end to end against a live workspace.
Teams has no ephemeral message, so a Teams-backed Channel posts the card and
then tells the clicker the link could not be sent privately — it is discarded
rather than posted where the thread can read it.

The pin in [`package.json`](./package.json) says what should be installed. This
says what is:

```bash
grep -rl channelActor node_modules/.pnpm
```

Output names the packages that carry the field. Silence means the installed
Channels predates it and every turn will read as anonymous — reinstall, and if
it is still silent, check the pin.

**Upgrading an older installation.** Older SDKs did not forward the speaker,
so `COMPOSIO_USER_TOOLKITS` could be configured and silent — `search_my_tools`
listed no personal tool and no Connect card was ever posted. Install the SDK
pair pinned in [`package.json`](./package.json) to enable forwarding; no
environment variable enables it. Two things then have to be true before a link
is minted: the Slack-backed Channel above, and a non-empty
`AGENT_AUTH_HEADER` on both services, described below.

That forwarded value is the only thing the agent will treat as an identity, and
four rules follow from it. They fail closed — each one costs access to a
personal toolkit and none of them grants it:

- A `channelActor` in a request's own `state` is discarded. The AG-UI adapter
  merges caller state *over* forwarded properties, so without this the body
  would decide whose account a turn runs in.
- A turn that forwards nobody is anonymous, and clears whoever spoke last. The
  graph is checkpointed per thread, so an inherited actor would let a second
  person in a Slack thread act as the first.
- Only `slack` and `teams` are recognised surfaces. Adding one means adding it
  to `KNOWN_PLATFORMS` in `agent/composio_tools/state.py`; until then its turns
  read as anonymous rather than sharing a namespace with everybody else's.
- Only `kind: "human"` gets a personal identity. A `bot`, `app` or `system`
  actor — a workflow posting on somebody's behalf — reaches the shared toolkits
  and no personal one, and cannot be minted a connect link. The Channels SDK
  documents `kind` as the provider's own metadata rather than an authorization
  claim, which is exactly why it is read as a filter and never as a grant: it
  can only take a personal toolkit away, never hand one over.

Beyond a Slack-backed Channel, personal toolkits need one thing configured:

- **`AGENT_AUTH_HEADER`, non-empty, on both services.** The runtime asks the
  agent to mint each link, and the agent refuses to mint one without this secret.
  A link is a bearer capability; there is no configuration in which handing one
  to an unauthenticated caller is right. Empty is not configured: `configured_secret`
  in [`agent/agent_auth.py`](./agent/agent_auth.py) strips the value and treats
  `""` as absent, so a deployment that ships the variable set to an empty string
  refuses every mint. Ordinary agent traffic is checked only when the variable
  holds a value, so an existing deployment is unaffected until it opts in.

Delivery itself needs no configuration here, and no platform token — this app
holds no Slack credential to deliver with. The managed adapter puts the link in
front of the clicker alone. Where a surface offers no private message the Connect
button discards the minted link rather than posting it in the thread, says so to
the person who clicked, and logs what an operator should check. See
[`app/tools/connect-click.tsx`](./app/tools/connect-click.tsx).

#### Approvals

`COMPOSIO_APPROVALS` is `on` (the default) or `off`. A gated call posts the same
card as a Linear or Notion write and pauses the graph, so the answer can arrive
twenty minutes later and the model still sees the result.

A tool's effect comes from Composio's own behaviour tags, looked up per slug.
`readOnlyHint` is the only thing that takes a call out of the gate. Everything
else is gated, including a slug that cannot be classified — which covers both a
lookup that failed and a tool the lookup found carrying no behaviour tag. Only
the lookup's own answer is remembered, never the fail-safe one, so a tool is not
permanently mislabelled by one bad lookup.

**`destructive` and `writes` were separate modes and are now one.** They gated an
identical set and always would have. The tags can say exactly two things —
`readOnlyHint` and `destructiveHint` — so there is no way to express "a write
that is definitely not destructive", and `idempotentHint` cannot stand in for
one, because DELETE is idempotent. Since an unclassified tool is gated as
destructive rather than guessed at, every call is either a read or destructive,
and choosing between the two modes was choosing between two spellings of one
behaviour. Both still parse as `on`, so an existing deployment does not fail at
boot on upgrade; there is nothing to change unless you want the new name.

A call that runs in one person's own account names that person as its approver,
and only they can answer the card — approving it spends their access and nobody
else's. Somebody else pressing it is told so, privately where the surface allows
one and in the thread where it does not, and the card stays up for its owner.
Both buttons share one durable decision, so only one click can resume the
agent, including after a runtime restart. Each answer also names its original
graph interrupt; a delayed click cannot approve a newer pending action.

Upgrade the runtime and agent together for this approval protocol. Cards
created before the upgrade cannot be resumed safely and require a fresh
request. If the agent cannot provide an interrupt ID, the runtime refuses the
approval and asks the operator to update the agent.

Sessions are created with connection management off. The connect flow above is
the only way an account is linked, because it is the only one that binds the
connection to an actor the platform verified.

## Railway

The IaC file declares exactly:

- `agent`: `CopilotKit/OpenTag`, branch `main`, root `agent`, Railpack,
  `/health`, port `8123`.
- `runtime`: `CopilotKit/OpenTag`, branch `main`, repository root,
  `pnpm runtime`, `/api/copilotkit/info`, port `3000`.

`runtime.AGENT_URL` references the agent's Railway private domain and port.
Production Intelligence URLs are literal configuration, the API key is
preserved, and the Channel name is the literal `open-tag` on **both** services —
the agent's copy is what shared Composio toolkits default their `user_id` to.
`AGENT_DISPLAY_NAME` is preserved independently on both services and must match
when overridden. `OPENAI_API_KEY` is required on `agent`; Tavily, Daytona/coder,
GitHub, PostHog, Linear, and the paired remote Notion variables are optional
preserved settings.

The variables this change added are preserved too, and which service carries
them is the whole design:

- On `agent`: `COMPOSIO_API_KEY`, `COMPOSIO_TOOLKITS`, `COMPOSIO_USER_TOOLKITS`,
  `COMPOSIO_APPROVALS`, `COMPOSIO_WORKSPACE_USER_ID`, `COMPOSIO_AUTH_CONFIGS`.
  The toolkits live in the agent, so the Composio credential never reaches the
  runtime.
- On `runtime`: nothing. Delivery is the managed adapter's job, so the runtime
  carries no platform credential.
- On both: `AGENT_AUTH_HEADER`. It is a shared secret, so the two values have to
  match; they are preserved independently and Railway will not reconcile them
  for you.

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
