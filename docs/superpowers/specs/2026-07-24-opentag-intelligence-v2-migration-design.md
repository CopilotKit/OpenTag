# OpenTag Intelligence channel → CopilotKit v2 managed-channels migration

**Date:** 2026-07-24
**Status:** Design (approved approach; plan pending)
**Owner:** Jerel

## Problem

OpenTag's Intelligence-Gateway mode (`app/managed.ts`, run via `pnpm channel`) targets the
**old** `@copilotkit/channels-intelligence` launcher: `startChannelsOverRealtimeGateway([bot], { wsUrl, apiKey, scope: { organizationId, projectId, channelId, channelName } })`.

The live Intelligence project **`opentag-dev`** (channel `kite-opentag`, `dev.intelligence.copilotkit.ai`)
documents a **different, newer runtime contract** in its "Connect a runtime" panel:

```ts
import { CopilotRuntime, CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { createChannel } from "@copilotkit/channels";           // dashboard says @copilotkit/channel — typo
import { HttpAgent } from "@ag-ui/client";
const intelligence = new CopilotKitIntelligence({ apiUrl, wsUrl, apiKey });
const runtime = new CopilotRuntime({ agents: {}, intelligence, channels: [ createChannel({ name: "kite-opentag", agent }) ] });
```

- Env collapses to **`INTELLIGENCE_API_URL` + `INTELLIGENCE_GATEWAY_WS_URL` + `INTELLIGENCE_API_KEY`**.
- **No** `ORG_ID` / `PROJECT_ID` / `CHANNEL_ID` — the runtime derives every infra id from the
  Intelligence creds + the channel **`name`**.

So `pnpm channel` as shipped **cannot connect to `opentag-dev`**: it hard-requires org/project/channel
IDs the platform no longer issues, and uses a superseded gateway launcher.

## Findings (research against the CopilotKit monorepo + npm)

- **`createChannel` is the renamed `createBot`.** Same options (`tools`, `context`, `commands`,
  `components`) and handlers (`onMention`, `onModalSubmit`, `onThreadStarted`, HITL via
  `thread.awaitChoice`). OpenTag's `app/` (tools, confirm-write gate, generative-UI components) ports
  **~1:1**.
- **Activation model changed:** no `startChannelsOverRealtimeGateway`, no scope object. You pass
  `channels: [channel]` to `new CopilotRuntime({ intelligence, identifyUser, channels })` and mount it
  with `createCopilotNodeListener({ runtime })`; **creating the listener activates the channel**. There
  is no `.start()`.
- **Published & installable (verified on npm):**
  - `@copilotkit/runtime@1.63.2` — exports `./v2`, `./v2/node` (`CopilotRuntime`, `CopilotKitIntelligence`, `createCopilotNodeListener`).
  - `@copilotkit/channels@0.2.1` / `@copilotkit/channels-core@0.2.1` (`createChannel`); `@copilotkit/channels-intelligence@0.2.1`.
  - `@copilotkit/channel` (singular) does **not** exist — dashboard snippet typo.
- OpenTag currently pins `@copilotkit/channels*@^0.1.1` (and `@copilotkit/runtime@^1.62.3`, which
  already resolves up to 1.63.2). Adopting `createChannel` requires bumping `channels*` **0.1 → 0.2**.

## Decision

Migrate OpenTag to `@copilotkit/channels@^0.2.x` and rewrite `app/managed.ts` to the v2
managed-channels runtime (`CopilotRuntime({ channels }) + createCopilotNodeListener`), keeping the
self-hosted path (`app/index.ts`) and the TS `runtime.ts` agent backend working. The Python `agent/`
(the brain) is unchanged; the channel host points its `HttpAgent`/`SanitizingHttpAgent` at `AGENT_URL`.

## Target design

- **`app/managed.ts`** rewritten to the shape above; `name: "kite-opentag"` (configurable via
  `INTELLIGENCE_CHANNEL_NAME`, default `kite-opentag`); reuse `appTools`/`appContext`/`appCommands` +
  `defaultSlack*`; keep `onMention`/`onModalSubmit`/`onThreadStarted`; add the required `identifyUser`.
- **Env:** drop `INTELLIGENCE_ORG_ID`/`PROJECT_ID`/`CHANNEL_ID`; add `INTELLIGENCE_API_URL`
  (`https://dev.intelligence.copilotkit.ai`); keep `INTELLIGENCE_GATEWAY_WS_URL`
  (`wss://dev.intelligence.copilotkit.ai/runner`) + `INTELLIGENCE_API_KEY` (`cpk-…`, from the project's
  API Keys tab) + `AGENT_URL`.
- **`.railway/railway.ts`** `channel` service env updated to the new var set.

## Scope / affected files

- `package.json` — bump `@copilotkit/channels`, `-slack`, `-discord`, `-telegram`, `-whatsapp`, `-ui`,
  `-intelligence` to `^0.2.x`; confirm `@copilotkit/runtime` ≥1.63.2.
- `app/managed.ts` + `app/managed.test.ts` — rewrite + update.
- `.env.example`, `.railway/railway.ts`, `README.md`, `setup.md` — Intelligence var set.
- **Possibly** `app/index.ts`, `runtime.ts`, and `app/**` tools/HITL/components — only if the 0.1→0.2
  bump changed their APIs (the `createBot`→`createChannel` rename likely touches `app/index.ts`).

## Open questions to resolve during implementation

1. Exact 0.1→0.2 breakage: does `createBot` still exist (self-hosted path), or must `app/index.ts`
   move to `createChannel({ adapters })`?
2. `@copilotkit/channels-slack@0.2.x` API + whether Slack helpers move to a `@copilotkit/channels/slack`
   subpath.
3. Confirm the published `@copilotkit/runtime@1.63.2` `CopilotRuntime` accepts the `channels` option
   (high confidence: `./v2/node` `createCopilotNodeListener` is published).
4. `identifyUser` semantics for a gateway-fronted channel (real Slack user vs stub).
5. HITL confirm-write in 0.2.x (`thread.awaitChoice`).

## Acceptance criteria

- Repo installs, typechecks, and `vitest` passes on `@copilotkit/channels@^0.2.x`.
- Both `pnpm dev` (self-hosted) and `pnpm channel` (managed) compile/start.
- `pnpm channel` connects to `opentag-dev`; the `kite-opentag` channel flips **Waiting for runtime → live**.
- An @mention in the bound Slack workspace gets a reply via the gateway, using the Python `agent/` as the brain, with generative-UI + the confirm-write gate intact.
- `.env.example`, `.railway/railway.ts`, README/setup docs updated to the new var set.

## Non-goals

- Deploying the channel to Railway (separate follow-up; the agent-only Railway deploy is already in flight).
- Changing the Python `agent/` or the self-hosted feature set beyond what the dep bump forces.
