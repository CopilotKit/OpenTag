# Agent instructions

OpenTag is meant to be cloned and customized, often with a coding agent driving.
This file tells that agent where the authority lives, so it grounds work in the
current API instead of in recalled patterns.

## Skills to install before you start

This repository vendors no skills. It installs them, because the CopilotKit CLI
delivers them from one home and a vendored copy silently falls behind.

| Task | Skill | Install |
| --- | --- | --- |
| Changing Channel code — `createChannel`, handlers, commands, JSX message UI, modals, human-in-the-loop, runtime wiring | `copilotkit-channels` | `npx copilotkit@latest skills install --skill copilotkit-channels` |
| Getting Slack to answer for the first time, or diagnosing a Channel stuck at `setup_required` or a mention with no reply | `setup-slack-channel` | `npx copilotkit@latest skills install --skill setup-slack-channel` |
| The whole setup path, including Microsoft Teams | `channels-setup` | `npx copilotkit@latest channels setup` |
| Runtime internals — `CopilotRuntime`, agent runners, tools | `runtime` | `npx copilotkit@latest skills install --skill runtime` |

`setup-slack-channel` is written **for this repository**. Its phases assume
OpenTag's conventions — `app/channel.tsx`, `app/env.ts`,
`INTELLIGENCE_CHANNEL_NAME`, a local agent on port 8123 — so prefer it here over
a generic setup sequence.

Always relay these with `@latest`. A bare `copilotkit` resolves to whatever is on
PATH or already in the npx cache, and an older CLI fails with
`Unknown option '--skill'`.

Do not commit what `skills install` writes. `.agents/`, `.claude/skills`,
`agent/skills`, and `skills-lock.json` are gitignored deliberately: those paths
are install targets, so committing them means the next install overwrites tracked
files.

## Repository map

| Area | Path | What it owns |
| --- | --- | --- |
| Runtime entrypoint | `server.ts` | Environment, Channels readiness, HTTP lifecycle, shutdown |
| Composition | `app/index.ts` | Agent factory, managed Channel, runtime |
| Channel surface | `app/channel.tsx` | Mentions, commands, components, modals, interrupts |
| Environment contract | `app/env.ts` | Required variables and in-code defaults |
| Rendered UI | `app/components/`, `app/tools/` | Issue cards, tables, charts, diagrams |
| Sandbox jobs | `app/sandbox/` | Daytona jobs; Channel tools stay in `app/tools/` |
| Agent | `agent/agent.py` | LangGraph deep agent served over AG-UI |
| Persona | `agent/prompts/` | `system.py` is the base system prompt |
| Approval gate | `agent/write_confirmation.py` | Emits `confirm_write` before Linear or Notion writes |
| Deployment | `.railway/railway.ts` | Two services, declared as code |

Reference docs: [`README.md`](./README.md) for the quick start,
[`setup.md`](./setup.md) for the full environment contract, and
[`docs/migration-kite.md`](./docs/migration-kite.md) for the internal `@kite`
cutover.

## Verify before claiming done

```bash
pnpm check-types
pnpm test
(cd agent && uv run pytest)
node node_modules/railway/dist/iac/bin.js
```

Run the last one from the repository root, not from `agent/`. Report the commands
you actually ran; do not claim a check that did not run.

## Gotchas that cost the most time

- **The runtime does not hot-reload Channel wiring.** After editing a handler,
  the agent, or the Channel, restart the process and prove `online` again. A stale
  process answering with the old behavior is indistinguishable from a change that
  did not work, and it will send you debugging code that is already correct.
- **`ready()` resolving is not health.** It also resolves on `setup_required`,
  a valid degraded state. Only `controls.status()` distinguishes them, and
  `/api/copilotkit/info` returning 200 says nothing about Slack.
- **`LOG_LEVEL` defaults to `error` while every Channel lifecycle breadcrumb is
  emitted at `warn`.** Run `LOG_LEVEL=debug pnpm runtime`. The line
  `channel "<name>" requires setup` is the highest-value diagnostic here and is
  discarded at the default level.
- **Channel names claim deliveries.** Two runtimes declaring the same name in one
  Intelligence project race per delivery and the loser is silently starved. Give a
  local runtime its own project, key, and Channel name — never reuse `open-tag`.
- **Slash commands and modals are registered but unverified on the managed
  path.** Delivery depends on the generated Slack manifest declaring
  `slash_commands`; as of the 0.7.0 verification it declared none. Do not describe
  them as working without sending a real command.
- **Trigger routing is not symmetric.** A mentioned turn goes to `onMention` if
  registered and falls back to `onMessage`; an unmentioned turn reaches
  `onMessage` only. `onMention` subscribes the thread. Always verify with a
  channel mention first, and remember that workspace-installed is not the same as
  invited to a conversation.

## Conventions

- **Pinned SDK versions live in `package.json` and nowhere else.** Do not restate
  `@copilotkit/channels` or `@copilotkit/runtime` versions in prose or in a test
  assertion. Three copies of `0.7.0` drifted at once when the deps were bumped,
  and one of them broke the build. `app/cleanup.test.ts` asserts the pin *shape*
  for this reason.
- **No Slack or Teams credential belongs in this repository.** Intelligence owns
  the adapters. One root `.env` configures both services; the Python agent loads
  it explicitly for local development.
- **`@copilotkit/channels` and `@copilotkit/runtime` upgrade together.** They ship
  as a tested pair.
- Commit messages follow the conventional prefixes already in the log (`feat:`,
  `fix:`, `docs:`, `chore:`), scoped where it helps.
