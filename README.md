# OpenTag — a get-started Slack bot, built on CopilotKit

OpenTag is the **open, get-started on-ramp** for building Slack bots with
[CopilotKit](https://github.com/CopilotKit/CopilotKit). It's a thread-tagging
assistant: @mention it (or run `/tag`) in a Slack thread and it reads the
conversation, proposes a label (`bug` / `question` / `feature` / `docs` /
`urgent`), and — after you click **Apply** — posts the tag as a rich card.

Clone it, add two Slack tokens and an OpenAI key, and you have a running bot in a
couple of minutes. It's the minimal sibling of **Kite.dev** — the viral on-call
triage bot — stripped to the smallest thing that still teaches the whole shape of
a CopilotKit bot. (More on that [below](#where-this-leads).)

It's built on:

- **[`@copilotkit/bot`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot)** — the platform-agnostic bot engine.
- **[`@copilotkit/bot-slack`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-slack)** — the Slack adapter (Socket Mode; bundles `@slack/bolt`, no public URL needed).
- **[`@copilotkit/bot-ui`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-ui)** — a cross-platform JSX vocabulary for rich messages.
- **[`@copilotkit/runtime`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/runtime)** — the AG-UI agent backend (`BuiltInAgent` = an LLM; no Python, no LangGraph).

## What it teaches

In ~250 lines of `app/`, OpenTag shows the whole shape of a CopilotKit bot:

| Concept                                                          | Where                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| `createBot({ adapters, agent, tools, context, commands })`      | `app/index.ts`                                          |
| The core turn loop — `bot.onMention` → `thread.runAgent()`      | `app/index.ts`                                          |
| A `BotTool` that grounds the agent in the real conversation     | `app/tools/read-thread.ts`                              |
| A generative-UI **render-tool** + JSX component                 | `app/tools/tag-card.tsx`, `app/components/tag-card.tsx` |
| A blocking **human-in-the-loop** gate (`thread.awaitChoice`)    | `app/human-in-the-loop/confirm-tag.tsx`                 |
| A slash command (`/tag`)                                        | `app/commands/index.ts`                                 |
| The agent backend — one `BuiltInAgent` (LLM, no MCP) over AG-UI | `runtime.ts`                                            |

## Quickstart

```bash
git clone https://github.com/CopilotKit/OpenTag.git
cd OpenTag
npm install
cp .env.example .env       # fill in SLACK_* + OPENAI_API_KEY (see below)

# then, in two terminals:
npm run runtime            # terminal 1 — the agent backend on :8200
npm run dev                # terminal 2 — the bot
```

You need an `OPENAI_API_KEY` and your Slack app's two tokens (next section).
Prefer `pnpm` or `yarn`? Both work — swap `npm` for your package manager.

## 1. Create the Slack app

- Go to <https://api.slack.com/apps?new_app=1> → **From a manifest** → paste
  [`slack-app-manifest.yaml`](./slack-app-manifest.yaml).
- _OAuth & Permissions_ → **Install to Workspace** → copy the `xoxb-` **Bot User
  OAuth Token** → `SLACK_BOT_TOKEN`.
- _Basic Information → App-Level Tokens_ → **Generate Token and Scopes** with the
  `connections:write` scope → copy the `xapp-` token → `SLACK_APP_TOKEN`.

The manifest declares the `/tag` command, the assistant pane, and **Socket Mode**
— so the bot connects outbound and needs no public URL.

## 2. Try it

@mention the bot in a channel thread, DM it, or run `/tag`:

> @OpenTag tag this thread

OpenTag reads the thread, proposes a label with a one-line rationale, and shows
an **Apply / Cancel** card. Click **Apply** and it posts the applied tag.

## How it works

```
Slack ──@mention──▶ bot (app/) ──AG-UI──▶ runtime (runtime.ts)
                                            └─ BuiltInAgent (LLM)
```

- **`app/`** — the bot: `createBot` + the Slack adapter, the `read_thread` /
  `tag_card` tools, the `confirm_tag` HITL gate, and the `/tag` command. **This
  is the directory you copy to start your own bot.**
- **`runtime.ts`** — the agent backend: a single CopilotKit `BuiltInAgent` (an
  LLM) served over AG-UI. No Python, no LangGraph, no external services.

The system prompt (`runtime.ts`) steers a strict order: **read → confirm →
apply.**

1. `read_thread` — fetches the conversation via `thread.getMessages()` so the
   agent tags what was actually said.
2. `confirm_tag` — posts an Apply/Cancel card and **blocks** on
   `thread.awaitChoice(...)`, returning `{ confirmed }`. Applying a tag is a
   write, so the agent may never skip this.
3. `tag_card` — only after approval, renders the `<TagCard>` component to show
   the applied tag.

### The human-in-the-loop gate

```tsx
// app/human-in-the-loop/confirm-tag.tsx
async handler({ label, rationale }, { thread }) {
  const choice = await thread.awaitChoice<{ confirmed?: boolean }>(
    <ConfirmTag label={label} rationale={rationale} />,
  );
  return choice?.confirmed
    ? "The user APPROVED — apply the tag now by calling tag_card."
    : "The user DECLINED — do not apply the tag; acknowledge briefly and stop.";
}
```

## Where this leads

OpenTag is the *minimal* starter. The same `@copilotkit/bot` engine powers
**Kite.dev** — the on-call triage bot from the viral
[OpenTag post](https://x.com/ataiiam/status/2070269772126937456) — which runs the
full kitchen sink:

- **Multi-platform** — Slack **+ Discord + Telegram + WhatsApp** from one process
  (one `createBot`, an array of adapters).
- **Linear + Notion over MCP** — query issues, file bugs, find runbooks, write
  postmortems — each write behind the same kind of HITL gate.
- **Generative UI** — issue cards, charts (Chart.js → PNG), diagrams (Mermaid),
  and tables, rendered natively per platform.
- **Modals & ephemerals** — `/file-issue` opens a structured form; `/preview`
  shows a private draft.

The reference implementation lives in CopilotKit's monorepo:
**[`examples/slack`](https://github.com/CopilotKit/CopilotKit/tree/main/examples/slack)**.
OpenTag is "here's how you start"; Kite.dev is "here's everything it can do."

## Make it yours

- **Apply tags for real.** Today the "apply" is visual — the seam is the
  `tag_card` tool handler in `app/tools/tag-card.tsx` (and the approval branch in
  `confirm-tag.tsx`). Call your own system there: a GitHub Issues label, a Linear
  update, a row in your DB.
- **Change the taxonomy.** Edit the label list in the `runtime.ts` system prompt
  and the colors in `app/components/tag-card.tsx`.
- **Add a platform.** Drop another adapter into the secret-gated block in
  `app/index.ts` — e.g.
  [`@copilotkit/bot-discord`](https://github.com/CopilotKit/CopilotKit/tree/main/packages/bot-discord).
  Everything in `app/` is platform-agnostic and shared verbatim.
- **Durable buttons.** Pass a `@copilotkit/bot-store-redis` store to `createBot`
  so an Apply/Cancel click still resolves after a restart.

## Tests

```bash
npm test                   # unit tests: read_thread, tag_card, confirm_tag
npm run check-types        # tsc --noEmit
```

## Roadmap

`npx copilotkit create --framework opentag` — scaffold this starter in one
command. (Coming soon; for now, clone this repo.)

## License

MIT — see [LICENSE](./LICENSE).
