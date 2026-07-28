# OpenTag Intelligence v2 Managed-Channels Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate OpenTag from the deprecated `@copilotkit/channels-intelligence` gateway launcher to the published v2 managed-channels runtime so `pnpm channel` connects to the `opentag-dev` Intelligence project and serves the `kite-opentag` channel.

**Architecture:** Bump `@copilotkit/channels*` from `0.1.x` to `0.2.x` repo-wide; rewrite `app/managed.ts` to build a `createChannel({ name: "kite-opentag" })`, hand it to `new CopilotRuntime({ agents:{}, intelligence, identifyUser, channels })`, and mount it with `createCopilotNodeListener` (mounting activates the channel; the runtime derives org/project/channel ids from the Intelligence creds + channel name). The Python `agent/` (brain) is unchanged; the channel forwards turns to it over `AGENT_URL` via `SanitizingHttpAgent`.

**Tech Stack:** TypeScript, tsx, `@copilotkit/channels@^0.2`, `@copilotkit/runtime@^1.63 (/v2, /v2/node)`, `@ag-ui/client`, vitest, pnpm.

## Global Constraints

- Channel name is **`kite-opentag`** (default via `INTELLIGENCE_CHANNEL_NAME`, verbatim — must match the registered Intelligence channel).
- Intelligence env is exactly **`INTELLIGENCE_API_URL`**, **`INTELLIGENCE_GATEWAY_WS_URL`**, **`INTELLIGENCE_API_KEY`**, **`AGENT_URL`** — no `ORG_ID`/`PROJECT_ID`/`CHANNEL_ID`.
- `INTELLIGENCE_API_URL` = `https://dev.intelligence.copilotkit.ai`; `INTELLIGENCE_GATEWAY_WS_URL` = `wss://dev.intelligence.copilotkit.ai/runner`.
- Both run modes must keep working: `pnpm dev`/`pnpm start` (self-hosted) AND `pnpm channel` (managed).
- Secrets (`INTELLIGENCE_API_KEY`, `OPENAI_API_KEY`, Slack tokens) are set by the operator — never hardcode or commit them.
- Keep changes minimal and follow existing file/style conventions; don't restructure unrelated code.

---

### Task 1: Discovery spike — bump deps, enumerate real 0.1→0.2 breakage

**Files:**
- Modify: `package.json` (dependency versions only)
- Produce (scratch, not committed): a breakage list used by Tasks 2–4

**Interfaces:**
- Produces: the authoritative list of (a) whether `createBot` still exists or is renamed `createChannel`; (b) `createChannel`/`CreateChannelOptions` exact signature in `@copilotkit/channels@0.2.x`; (c) `CopilotRuntime` v2 `channels` option + `createCopilotNodeListener` return type (`.channels?.stop()`); (d) the Slack helper import path (`@copilotkit/channels-slack` vs `@copilotkit/channels/slack`) and `SanitizingHttpAgent`/`defaultSlackTools`/`defaultSlackContext` availability; (e) the full `tsc --noEmit` error list across `app/**` and `runtime.ts`.

- [ ] **Step 1: Create the feature branch/worktree** (execution-time; via superpowers:using-git-worktrees). Branch name: `jerel/opentag-intelligence-v2`.

- [ ] **Step 2: Bump the CopilotKit channel deps in `package.json`**

Set these versions (leave `@copilotkit/runtime` — `^1.62.3` already resolves to ≥1.63.2):
```jsonc
"@copilotkit/channels": "^0.2.1",
"@copilotkit/channels-discord": "^0.2.1",
"@copilotkit/channels-intelligence": "^0.2.1",
"@copilotkit/channels-slack": "^0.2.1",
"@copilotkit/channels-telegram": "^0.2.1",
"@copilotkit/channels-ui": "^0.2.1",
"@copilotkit/channels-whatsapp": "^0.2.1"
```
(If any `-discord/-telegram/-whatsapp/-ui` package has no `0.2.x` on npm, run `npm view <pkg> version` and pin the newest available; record it.)

- [ ] **Step 3: Install**

Run: `pnpm install`
Expected: resolves; note any peer-dep warnings.

- [ ] **Step 4: Capture the real API from installed types**

Run and read (do not guess):
```bash
sed -n '1,60p' node_modules/@copilotkit/channels-core/dist/index.d.ts | grep -nE 'createChannel|CreateChannelOptions|createBot' 
ls node_modules/@copilotkit/runtime/dist/v2/ && grep -rnE 'channels\??:|createCopilotNodeListener|class CopilotRuntime' node_modules/@copilotkit/runtime/dist/v2/*.d.ts | head
grep -rnE 'SanitizingHttpAgent|defaultSlackTools|defaultSlackContext' node_modules/@copilotkit/channels-slack/dist/*.d.ts 2>/dev/null || ls node_modules/@copilotkit/channels/dist/slack* 2>/dev/null
```
Record the exact `createChannel` options type, whether `createBot` still exists, the `CopilotRuntime` `channels` option, `createCopilotNodeListener` signature/return, and the Slack helper import path.

- [ ] **Step 5: Enumerate breakage**

Run: `pnpm check-types` (i.e. `tsc --noEmit -p tsconfig.json`)
Expected: a list of errors in `app/index.ts`, `runtime.ts`, `app/**`. **Save the full error list** — it drives Tasks 2–3. Do NOT fix yet.

- [ ] **Step 6: Commit the dep bump**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): bump @copilotkit/channels* to ^0.2.1 (v2 managed-channels)"
```

---

### Task 2: Restore self-hosted path + shared `app/` to compile on 0.2.x

**Files:**
- Modify (per Task 1 breakage list): `app/index.ts`, `runtime.ts`, and any `app/**` files that fail typecheck (likely `app/tools/*`, `app/human-in-the-loop/*`, `app/components/*` if `createBot`→`createChannel` or tool-def types changed).
- Test: existing `app/**/__tests__/*` + `runtime`-adjacent tests.

**Interfaces:**
- Consumes: Task 1's breakage list + exact signatures.
- Produces: a repo that typechecks and whose existing vitest suite passes on 0.2.x, with `app/index.ts` still starting the self-hosted bot.

- [ ] **Step 1: Apply the mechanical rename/signature fixes** from Task 1 (e.g. if `createBot` is gone, switch `app/index.ts` to the 0.2.x self-hosted constructor — `createChannel({ adapters })` or the documented equivalent — using the exact signature captured in Task 1). Show the concrete edit for each failing file as you go; keep behavior identical.

- [ ] **Step 2: Run typecheck**

Run: `pnpm check-types`
Expected: PASS (0 errors).

- [ ] **Step 3: Run the existing test suite**

Run: `pnpm test`
Expected: PASS (fix any test that references renamed symbols to use the new names — do not weaken assertions).

- [ ] **Step 4: Smoke the self-hosted entry compiles/starts** (no tokens needed to fail fast on import errors)

Run: `node --check <(npx tsc --noEmit) ` is not valid; instead: `pnpm start` and confirm it fails only on missing Slack tokens (not on import/type errors), then Ctrl-C.
Expected: process reaches "missing SLACK_* / no adapters" rather than a module/type crash.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: compile self-hosted path + app/ on @copilotkit/channels@0.2.x"
```

---

### Task 3: Rewrite `app/managed.ts` to the v2 managed-channels runtime

**Files:**
- Modify: `app/managed.ts`
- Test: `app/managed.test.ts`

**Interfaces:**
- Consumes: Task 1 signatures (`createChannel`, `CopilotRuntime` v2 `channels`, `createCopilotNodeListener`), and OpenTag's existing `appTools`/`appContext`/`appCommands`, `senderContext`, `fileIssueSubmit`/`FILE_ISSUE_CALLBACK`, `closeBrowser`, `SanitizingHttpAgent`/`defaultSlackTools`/`defaultSlackContext`.
- Produces: `createKiteChannel(opts)` (pure, testable, returns the `Channel`) + a `main()` that builds the runtime and mounts the node listener.

- [ ] **Step 1: Update `app/managed.test.ts`** to assert the pure builder shape (mirrors the existing test's intent): a `createKiteChannel({ agentUrl, channelName })` returns a channel whose `name === "kite-opentag"` by default, and `parseProjectId` is removed (no longer used). Write the failing test first (import will fail).

```ts
import { describe, it, expect } from "vitest";
import { createKiteChannel } from "./managed.js";
describe("createKiteChannel", () => {
  it("defaults the channel name to kite-opentag", () => {
    const ch = createKiteChannel({ agentUrl: "http://localhost:8123/" });
    expect(ch.name).toBe("kite-opentag");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- app/managed.test.ts`
Expected: FAIL (`createKiteChannel` not exported).

- [ ] **Step 3: Rewrite `app/managed.ts`** to this shape (adjust import paths/signatures to Task 1's captured reality):

```ts
import "dotenv/config";
import { createServer } from "node:http";
import { createChannel } from "@copilotkit/channels";
import type { Channel } from "@copilotkit/channels";
import { SanitizingHttpAgent, defaultSlackTools, defaultSlackContext } from "@copilotkit/channels-slack";
import { CopilotRuntime, CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";
import { appTools } from "./tools/index.js";
import { appContext } from "./context/app-context.js";
import { appCommands } from "./commands/index.js";
import { senderContext } from "./sender-context.js";
import { fileIssueSubmit, FILE_ISSUE_CALLBACK } from "./modals/file-issue.js";
import { closeBrowser } from "./render/browser.js";

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
  return v;
};

export interface CreateKiteChannelOptions {
  agentUrl: string;
  agentAuthHeader?: string;
  channelName?: string;
}

export function createKiteChannel(opts: CreateKiteChannelOptions): Channel {
  const channelName = opts.channelName ?? "kite-opentag";
  const headers = opts.agentAuthHeader ? { Authorization: opts.agentAuthHeader } : undefined;
  const channel = createChannel({
    name: channelName,
    agent: (threadId: string) => {
      const a = new SanitizingHttpAgent({ url: opts.agentUrl, headers });
      a.threadId = threadId;
      return a;
    },
    tools: [...appTools, ...defaultSlackTools],
    context: [...appContext, ...defaultSlackContext],
    commands: appCommands,
  });
  channel.onMention(async ({ thread, message }) => {
    try {
      await thread.runAgent({
        prompt: message.contentParts?.length ? message.contentParts : message.text,
        context: senderContext(message.user, thread.platform),
      });
    } catch (err) {
      console.error("[channel] agent run failed", err);
      await thread.post("Sorry — I hit an error handling that. Please try again.")
        .catch((e: unknown) => console.error("[channel] failed to post agent error", e));
    }
  });
  channel.onModalSubmit(FILE_ISSUE_CALLBACK, fileIssueSubmit);
  channel.onThreadStarted(async ({ thread, user }) => {
    if (!user?.name) return;
    try {
      await thread.setSuggestedPrompts([
        { title: `Triage ${user.name}'s issues`, message: "Triage my open issues" },
        { title: "What shipped this week?", message: "Summarize what shipped this week" },
      ]);
    } catch (err) { console.error("[channel] onThreadStarted failed", err); }
  });
  return channel;
}

async function main() {
  const channel = createKiteChannel({
    agentUrl: required("AGENT_URL"),
    agentAuthHeader: process.env.AGENT_AUTH_HEADER,
    channelName: process.env.INTELLIGENCE_CHANNEL_NAME,
  });
  const intelligence = new CopilotKitIntelligence({
    apiUrl: required("INTELLIGENCE_API_URL"),
    wsUrl: required("INTELLIGENCE_GATEWAY_WS_URL"),
    apiKey: required("INTELLIGENCE_API_KEY"),
  });
  const runtime = new CopilotRuntime({
    agents: {},
    intelligence,
    identifyUser: () => ({ id: "opentag-runtime", name: "OpenTag" }), // refine per Task 1 identifyUser type
    channels: [channel],
  });
  const rawPort = process.env["PORT"];
  const port = rawPort && rawPort.trim() !== "" ? Number(rawPort) : 8300;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid PORT: "${rawPort}"`); process.exit(1);
  }
  const listener = createCopilotNodeListener({ runtime, basePath: "/api/copilotkit" });
  const server = createServer(listener).listen(port, () => {
    console.log(`[channel] KiteBot channel "${channel.name}" mounted on :${port} → gateway`);
  });
  const shutdown = async (signal: string) => {
    console.log(`\n[channel] received ${signal}, stopping…`);
    let code = 0;
    try { await listener.channels?.stop(); } catch (e) { console.error("[channel] stop failed", e); code = 1; }
    server.close();
    await closeBrowser().catch((e: unknown) => console.error("[channel] browser cleanup failed", e));
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

process.on("unhandledRejection", (r) => console.error("[channel] unhandledRejection:", r));
if (process.argv[1] && process.argv[1].endsWith("managed.ts")) {
  main().catch((e: unknown) => { console.error("[channel] fatal:", e); process.exit(1); });
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm test -- app/managed.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the whole repo**

Run: `pnpm check-types`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/managed.ts app/managed.test.ts
git commit -m "feat(channel): rewrite managed.ts to v2 managed-channels runtime"
```

---

### Task 4: Update env template, Railway IaC, and docs

**Files:**
- Modify: `.env.example`, `.railway/railway.ts`, `README.md`, `setup.md`

**Interfaces:**
- Consumes: the Global Constraints var set.
- Produces: operator-facing config matching the new runtime.

- [ ] **Step 1: `.env.example`** — in the Intelligence block, remove `INTELLIGENCE_ORG_ID`, `INTELLIGENCE_PROJECT_ID`, `INTELLIGENCE_CHANNEL_ID`, `INTELLIGENCE_RUNTIME_INSTANCE_ID`; add `INTELLIGENCE_API_URL=https://dev.intelligence.copilotkit.ai`; keep `INTELLIGENCE_GATEWAY_WS_URL=wss://dev.intelligence.copilotkit.ai/runner`, `INTELLIGENCE_API_KEY=cpk-...`; set `INTELLIGENCE_CHANNEL_NAME=kite-opentag`.

- [ ] **Step 2: `.railway/railway.ts`** — in the `channel` service `env`, replace the five `INTELLIGENCE_*` `preserve()` scope vars with `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, `INTELLIGENCE_API_KEY` (`preserve()` for the key; the two URLs may be literals), keep `AGENT_URL` → agent service. Update the file's header comment to describe the v2 model.

- [ ] **Step 3: `setup.md` + `README.md`** — update the "Intelligence channel mode" section: new var table, `@copilotkit/runtime/v2` + `createChannel` model, remove org/project/channel-id references, note `createCopilotNodeListener` mounting activates the channel.

- [ ] **Step 4: Typecheck the IaC**

Run: `pnpm check-types` (and, if available, `railway`'s IaC eval — otherwise skip).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .env.example .railway/railway.ts README.md setup.md
git commit -m "docs+config: v2 Intelligence env (API_URL/WS_URL/API_KEY, kite-opentag)"
```

---

### Task 5: Live verification against `opentag-dev`

**Files:** none (runtime verification)

**Interfaces:**
- Consumes: a running Python `agent/` (`pnpm agent`, `:8123`) and operator-supplied `INTELLIGENCE_API_KEY`.

- [ ] **Step 1: Operator sets secrets** in `.env`: `INTELLIGENCE_API_KEY` (from opentag-dev → API Keys), `INTELLIGENCE_API_URL`, `INTELLIGENCE_GATEWAY_WS_URL`, `AGENT_URL=http://localhost:8123/`. (Agent runs `OPENAI_API_KEY` already.) The implementer does NOT enter these — prompt the operator.

- [ ] **Step 2: Start the brain**

Run: `pnpm agent` (terminal 1) → `curl localhost:8123/health` → `{"status":"ok",...}`.

- [ ] **Step 3: Start the channel host**

Run: `pnpm channel` (terminal 2)
Expected: logs "channel kite-opentag mounted … → gateway"; the `opentag-dev` dashboard `kite-opentag` channel flips **Waiting for runtime → live** (RUNTIME "Last seen" updates).

- [ ] **Step 4: End-to-end**

@mention the bot in the channel's bound Slack workspace; expect a reply routed via the gateway → agent, with a generative-UI card and the confirm-write gate on a write action.

- [ ] **Step 5: Finalize** — push branch, open PR referencing this plan and the design doc; DO NOT deploy the channel to Railway in this PR (separate follow-up).

## Self-Review notes

- Spec coverage: dep bump (T1–2), managed.ts rewrite (T3), env/Railway/docs (T4), live check (T5) — all acceptance criteria mapped.
- Discovery dependency is isolated to T1; T2's exact edits are intentionally driven by T1's typecheck output (a migration cannot know every break a priori) — the plan names the files and the known-likely rename, and requires showing each concrete edit at execution.
- Open items from the design doc (createBot existence, slack import path, identifyUser type, HITL API) are resolved concretely in Task 1 before dependent code is written.
