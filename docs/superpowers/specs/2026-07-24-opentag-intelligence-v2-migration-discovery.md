# OpenTag `@copilotkit/channels` 0.1.x → 0.2.x Migration Discovery Spike

> **Point-in-time record.** This is what the Task 1 spike found *before* any code
> was written. It is kept for the verified SDK signatures below, not as a
> description of what shipped — the implementation deliberately diverged twice:
>
> - **`@copilotkit/runtime` was raised to `^1.63.2`**, not left at `^1.62.3` as
>   the version table below records. 1.62.3 has no v2 `channels` support and no
>   `createCopilotNodeListener`, so the floor had to move.
> - **`@copilotkit/channels-intelligence` was dropped as a direct dependency.**
>   It stays available transitively via `channels` + `runtime`; the v2
>   managed-channels path never imports it.
>
> The design doc and plan alongside this file describe what was actually built.

Task 1 discovery only — no application code (`app/**`, `runtime.ts`) was modified.
Every signature quoted below was read directly from installed `.d.ts` files
under `node_modules/@copilotkit/*` (or, for one clearly-marked case in section
(c), from standalone `npm pack` tarballs pulled to the scratchpad for
comparison — never installed into this repo). Nothing here is guessed.

## Versions

| Package | Old range | New range | Resolved |
|---|---|---|---|
| `@copilotkit/channels` | `^0.1.1` | `^0.2.1` | `0.2.1` |
| `@copilotkit/channels-discord` | `^0.0.3` | `^0.2.1` | `0.2.1` |
| `@copilotkit/channels-intelligence` | `^0.1.1` | `^0.2.1` | `0.2.1` |
| `@copilotkit/channels-slack` | `^0.1.2` | `^0.2.1` | `0.2.1` |
| `@copilotkit/channels-telegram` | `^0.0.4` | `^0.2.1` | `0.2.1` |
| `@copilotkit/channels-ui` | `^0.1.1` | `^0.2.1` | `0.2.1` |
| `@copilotkit/channels-whatsapp` | `^0.0.2` | `^0.2.1` | `0.2.1` |
| `@copilotkit/runtime` | `^1.62.3` (left unchanged per spec) | `^1.62.3` | **`1.62.3`** |

`npm view <pkg> versions --json` (run before editing `package.json`) showed
every one of the seven `-discord/-telegram/-whatsapp/-ui`/etc. packages already
had a `0.2.1` published, so **no fallback pin was needed** — all seven are
exactly `^0.2.1`, matching the micro-spec's default instruction.

`pnpm install` completed cleanly (`Done in 9.7s`, exit 0). Pre-existing,
unrelated peer-dependency warnings (not caused by this bump):
```
├─┬ @notionhq/notion-mcp-server 2.4.1
│ └─┬ @modelcontextprotocol/sdk 1.29.0
│   ├── ✕ unmet peer zod@"^3.25 || ^4.0": found 3.24.1 in @notionhq/notion-mcp-server
│   └─┬ zod-to-json-schema 3.25.2
│     └── ✕ unmet peer zod@"^3.25.28 || ^4": found 3.24.1 in @notionhq/notion-mcp-server
└─┬ @tanstack/ai-openai 0.15.10
  ├── ✕ unmet peer zod@^4.0.0: found 3.25.76
  ├── ✕ unmet peer @tanstack/ai@^0.39.0: found 0.32.0
  └─┬ @tanstack/openai-base 0.9.6
    └── ✕ unmet peer @tanstack/ai@^0.39.0: found 0.32.0
```
(Also: "Ignored build scripts: `@scarf/scarf@1.4.0`, `esbuild@0.28.1`" — the
pre-existing `pnpm approve-builds` gate, unrelated.)

**Important:** `@copilotkit/runtime`'s `package.json` range (`^1.62.3`) was left
untouched per spec, and `pnpm-lock.yaml` already had `1.62.3` pinned from
before this spike. Since the range didn't change, plain `pnpm install` had no
reason to move that lock entry forward — it resolved to the exact
pre-existing **`1.62.3`**, not the newer `1.63.2` the migration plan assumed.
This turns out to matter a great deal — see section (c).

Secondary observation: `@copilotkit/channels-ui@0.2.1` depends on
`@copilotkit/shared@^1.63.1` (resolves `1.63.2`), while
`@copilotkit/runtime@1.62.3`'s own tree resolves `@copilotkit/shared@1.62.3` —
two versions of `@copilotkit/shared` coexist in the pnpm store
(`node_modules/.pnpm/@copilotkit+shared@1.62.3_...` and `@1.63.2_...`). This did
not produce a `check-types` error in this run, but is worth knowing about,
especially if `runtime` gets bumped per point (c) below.

---

## (a) `createBot` vs `createChannel`

**`createBot` no longer exists anywhere in the installed 0.2.1 packages, with
no back-compat alias.** An exhaustive grep for `createBot`, `BotTool`,
`BotCommand`, `defineBotTool`, `defineBotCommand`, `BotNode`, and any `Bot`
type/interface/class across every installed `@copilotkit/channels*` package's
`.d.ts` output returned **zero matches**.

It is renamed to `createChannel`, defined in `@copilotkit/channels-core` and
re-exported through the app-facing `@copilotkit/channels` package (the same
specifier the app already imports from):

`node_modules/@copilotkit/channels/dist/index.d.ts`:
```ts
export * from "@copilotkit/channels-core";
```

`@copilotkit/channels-core/dist/create-channel.d.ts` (source of truth; the
physical path under this repo is
`node_modules/.pnpm/@copilotkit+channels-core@0.2.1_.../node_modules/@copilotkit/channels-core/dist/create-channel.d.ts`):
```ts
export declare function createChannel<TStateSchema extends StandardSchemaV1 | undefined = undefined>(
  opts: CreateChannelOptions<TStateSchema>
): Channel<ThreadStateOf<TStateSchema>>;
```

So `import { createChannel } from "@copilotkit/channels"` is the correct 0.2.x
form — only the symbol name changes, not the import path. `Bot` (the type) is
likewise renamed to `Channel`, same file.

---

## (b) `createChannel` / `CreateChannelOptions` exact signature

Full options interface, `@copilotkit/channels-core/dist/create-channel.d.ts`:
```ts
export interface CreateChannelOptions<TStateSchema extends StandardSchemaV1 | undefined = undefined> {
  /** Project-unique Intelligence Channel name. Required for Intelligence Channel
   * Bots ...; optional for local/custom adapters. Validated by the Channel
   * runtime (`startChannels`), not here. */
  name?: string;
  /** Adapters supplied at construction. Optional — can also be attached before
   * `start()` via `Channel.addAdapter`. */
  adapters?: PlatformAdapter[];
  /** The managed delivery provider this Channel targets when activated via
   * CopilotKit Intelligence. Defaults to "slack" when unset. Ignored for
   * direct-adapter Channels. */
  provider?: ManagedChannelProvider; // "slack" | "teams"
  agent?: AbstractAgent | ((threadId: string) => AbstractAgent);
  /** @deprecated Pass `store.adapter` instead. */
  actionStore?: ActionStore;
  tools?: ChannelTool[];
  context?: ContextEntry[];
  /** Named JSX components used in interactive messages, for durable re-render
   * across a restart. */
  components?: ChannelComponent[];
  /** Slash commands. Forwarded to adapters that support them; ignored elsewhere. */
  commands?: ChannelCommand[];
  /** Persistence, per-thread state schema, transcripts, and lock/dedup tuning. */
  store?: StoreConfig<TStateSchema>;
}

export declare function createChannel<TStateSchema extends StandardSchemaV1 | undefined = undefined>(
  opts: CreateChannelOptions<TStateSchema>
): Channel<ThreadStateOf<TStateSchema>>;
```

Notes for the next wave:
- `name`, `adapters`, `agent`, `tools`, `context`, `commands` keep the same
  field names as the 0.1.x `createBot` call sites already use in
  `app/index.ts`/`app/managed.ts` — only the *element types* changed
  (`BotTool`→`ChannelTool`, `BotCommand`→`ChannelCommand`; see (e)).
- Two **new** fields not present in 0.1.x: `provider?: "slack" | "teams"`
  (managed-delivery provider selection, defaults `"slack"`) and
  `components?: ChannelComponent[]` (durable JSX component registration).
- Returned `Channel<TState>` interface (same file) exposes: `onMention`,
  `onMessage`, `onThreadStarted`, `onInteraction`, `onInterrupt`, `onCommand`
  (2 overloads), `onReaction` (2 overloads), `onModalSubmit`, `onModalClose`,
  `tool()`, `addAdapter()`, `start(): Promise<void>`, `stop(): Promise<void>`,
  plus a **new** `transcripts: Transcripts` property not in 0.1.x's `Bot`.

---

## (c) `CopilotRuntime` v2 / `channels` option / `identifyUser` / `createCopilotNodeListener`

**Headline finding: at the runtime version actually installed
(`@copilotkit/runtime@1.62.3`), none of the "managed channels" API the
migration plan assumes exists.** A full-text, case-insensitive grep for
`channels` across every `.d.ts` file in
`node_modules/@copilotkit/runtime/dist/` (including all of `dist/v2/**`)
returned **zero matches**.

Confirmed directly in the constructor-options source,
`node_modules/@copilotkit/runtime/dist/v2/runtime/core/runtime.d.mts`:
```ts
interface CopilotSseRuntimeOptions extends BaseCopilotRuntimeOptions {
  runner?: AgentRunner;
  intelligence?: undefined;
  generateThreadNames?: undefined;
}
interface CopilotIntelligenceRuntimeOptions extends BaseCopilotRuntimeOptions {
  intelligence: CopilotKitIntelligence;
  identifyUser: IdentifyUserCallback;
  generateThreadNames?: boolean;
  maxReconnectMs?: number;
  maxRejoinMs?: number;
  lockTtlSeconds?: number;
  lockKeyPrefix?: string;
  lockHeartbeatIntervalSeconds?: number;
}
type CopilotRuntimeOptions = CopilotSseRuntimeOptions | CopilotIntelligenceRuntimeOptions;
```
No `channels` field on either variant. `identifyUser`'s type IS present and
matches the plan's assumption exactly:
```ts
interface CopilotRuntimeUser { id: string; name: string; }
type IdentifyUserCallback = (request: Request) => MaybePromise<CopilotRuntimeUser>;
```
Also note: `agents` is **required and non-empty** —
`BaseCopilotRuntimeOptions.agents: AgentsConfig` where
`AgentsConfig = MaybePromise<NonEmptyRecord<Record<string, AbstractAgent>>> | AgentsFactory`.
The migration plan's example `new CopilotRuntime({ agents: {}, ... })` (an
empty object literal) will not satisfy `NonEmptyRecord` — that's its own
typecheck failure, independent of the channels question.

And `node_modules/@copilotkit/runtime/dist/v2/runtime/endpoints/node.d.mts`:
```ts
declare function createCopilotNodeListener(options: CopilotRuntimeHandlerOptions): NodeFetchHandler;
```
where `CopilotRuntimeHandlerOptions`
(`.../runtime/core/fetch-handler.d.mts`) has no `channels`-related field, and
`NodeFetchHandler` (`.../endpoints/node-fetch-handler.d.mts`) is a **bare
function type**:
```ts
type NodeFetchHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
```
**So `.channels?.stop()` does not exist on the installed
`createCopilotNodeListener`'s return value — the return isn't an object with
properties at all, just a plain callable.**

### Where the assumed API actually lives

`npm view @copilotkit/runtime versions` shows the `^1.62.3` range spans
`1.62.3` → `1.63.2` (highest 1.x) before `2.0.0-next.1`. To find out whether
the plan's assumed shape exists anywhere in that range, I pulled the `1.63.2`
and `2.0.0-next.1` tarballs standalone into the scratchpad via `npm pack`
(extracted only — **never installed into this repo's `node_modules`**) and
grepped their type declarations:

- **`@copilotkit/runtime@1.63.2` has it, matching the plan's premise exactly.**
  `runtime.d.mts` (1.63.2) adds `channels?: Channel[]` to
  `CopilotIntelligenceRuntimeOptions` (`Channel` from
  `@copilotkit/channels-core`), plus a `CopilotRuntimeConstructor` overload
  that brands the result `RuntimeWithDeclaredChannels` when constructed with a
  non-empty `channels` tuple. `channel-manager.d.mts` (1.63.2, new file — does
  not exist at 1.62.3) defines:
  ```ts
  interface ChannelsControl {
    ready(opts?: { timeoutMs?: number }): Promise<void>;
    status(): { overall: ChannelStatus; channels: Record<string, ChannelStatus> };
    stop(): Promise<void>;
  }
  ```
  and `node.d.mts` (1.63.2):
  ```ts
  type NodeCopilotListener = NodeFetchHandler & { channels?: ChannelsControl };
  declare function createCopilotNodeListener(options: CopilotRuntimeHandlerOptions): NodeCopilotListener;
  ```
  i.e. **`listener.channels?.stop()` is valid at 1.63.2**, exactly as the plan's
  Task 3 example assumes. `fetch-handler.d.mts` (1.63.2) also adds: an overload
  where a runtime built with a non-empty `channels` array yields a handler
  whose `.channels` is **non-optional** (`CopilotRuntimeFetchHandlerWithChannels`),
  and a new `activateChannels?: boolean` option (default `true`) on
  `CopilotRuntimeHandlerOptions` controlling whether the control surface is
  built at all.
- `2.0.0-next.1` was also checked for completeness: its `dist/v2` is a single
  flat `index.d.ts` (no `runtime/core/**` split like 1.62.3/1.63.2 have), and a
  full-text grep for "channels" across its **entire** `dist/` tree returned
  zero matches. It appears to be an unrelated, earlier-stage prerelease line,
  not a superset of 1.63.2's channels work — irrelevant to this migration.

**Conclusion:** the plan's Task 3 code is only valid from
`@copilotkit/runtime@1.63.2` onward. Since `^1.62.3` already covers `1.63.2`,
no `package.json` change is needed — but the **lockfile** must actually move
(e.g. `pnpm update @copilotkit/runtime`, or any action that forces
re-resolution within the existing range); a bare `pnpm install` will not do
this on its own when the declared range hasn't changed. **This is the single
most important handoff item for whoever executes Task 2/3**: bump the lockfile
resolution to ≥1.63.2 *before* attempting the `channels`/
`createCopilotNodeListener(...).channels` rewrite, or none of it will
typecheck — `channels` and `.channels` simply don't exist at the version
currently sitting in `pnpm-lock.yaml`.

---

## (d) Slack helper import path + `SanitizingHttpAgent`/`defaultSlackTools`/`defaultSlackContext`

Both import paths resolve to the same code — `@copilotkit/channels/slack` is a
pure re-export of the standalone `@copilotkit/channels-slack` package:

`node_modules/@copilotkit/channels/dist/slack.d.ts`:
```ts
export * from "@copilotkit/channels-slack";
```

The app currently imports directly from `@copilotkit/channels-slack` (a real
`package.json` dependency) — **that remains correct and unchanged in 0.2.1.**

All three symbols exist, unchanged in name, per
`node_modules/@copilotkit/channels-slack/dist/index.d.ts`:
```ts
export { slackTaggingContext, slackFormattingContext, slackConversationModelContext, defaultSlackContext } from "./built-in-context.js";
export { SanitizingHttpAgent } from "./sanitizing-http-agent.js";
export { lookupSlackUserTool, defaultSlackTools } from "./built-in-tools.js";
export { slack, SlackAdapter } from "./adapter.js";
```

Exact signatures:
- `dist/sanitizing-http-agent.d.ts`:
  ```ts
  export declare class SanitizingHttpAgent extends HttpAgent {
    run(input: RunAgentInput): Observable<BaseEvent>;
  }
  ```
- `dist/built-in-tools.d.ts`:
  ```ts
  export declare const defaultSlackTools: ReadonlyArray<ChannelTool>;
  ```
  (element type renamed along with `BotTool`→`ChannelTool`; the constant name
  and its being a `ReadonlyArray` are unchanged.)
- `dist/built-in-context.d.ts`:
  ```ts
  export type SlackContextEntry = ContextEntry; // alias of @copilotkit/channels-core's ContextEntry
  export declare const defaultSlackContext: ReadonlyArray<SlackContextEntry>;
  ```

No signature or import-path changes needed for
`app/index.ts`/`app/managed.ts`'s existing
`import { SanitizingHttpAgent, defaultSlackTools, defaultSlackContext } from "@copilotkit/channels-slack"`.

---

## (e) Renamed / removed symbols

### From `@copilotkit/channels` (i.e. `@copilotkit/channels-core`)

| Old (0.1.x) | Status | New name / exact source |
|---|---|---|
| `defineBotTool` | **renamed** | `defineChannelTool` — `channels-core/dist/tools.d.ts`: `export declare function defineChannelTool<Schema extends ObjectSchema>(tool: ChannelTool<Schema>): ChannelTool<Schema>;` |
| `BotTool` | **renamed** | `ChannelTool` — `channels-core/dist/tools.d.ts`: `export type ChannelTool<Schema extends ObjectSchema = ObjectSchema> = { name: string; description: string; parameters: Schema; handler(args: InferSchemaOutput<Schema>, ctx: ChannelToolContext): Promise<unknown> \| unknown; };` |
| `defineBotCommand` | **renamed** | `defineChannelCommand` — `channels-core/dist/commands.d.ts`: `export declare function defineChannelCommand<Schema extends ObjectSchema>(command: ChannelCommand<Schema>): ChannelCommand<Schema>;` |
| `BotCommand` | **renamed** | `ChannelCommand` — `channels-core/dist/commands.d.ts`: `export interface ChannelCommand<Schema extends ObjectSchema = ObjectSchema> { name: string; description?: string; options?: Schema; handler(ctx: CommandContext<InferSchemaOutput<Schema>>): void \| Promise<void>; }` |
| `ContextEntry` | **unchanged** | `channels-core/dist/tools.d.ts`: `export interface ContextEntry { description: string; value: string; }` |
| `ModalSubmitHandler` | **unchanged** | `channels-core/dist/create-channel.d.ts`: `export type ModalSubmitHandler = (evt: ModalSubmitEvent) => ModalSubmitResult \| void \| Promise<ModalSubmitResult \| void>;` |
| `PlatformAdapter` | **unchanged** | `channels-core/dist/platform-adapter.d.ts`: large interface — `platform`, `capabilities`, `ackDeadlineMs`, `start`, `stop`, `render`, `post`, `update`, `stream`, `delete`, `createRunRenderer`, `decodeInteraction`, `lookupUser`, `conversationStore`, plus many optional capability hooks (`getMessages?`, `postFile?`, `registerCommands?`, `setSuggestedPrompts?`, `setThreadTitle?`, `addReaction?`/`removeReaction?`, `postEphemeral?`, `renderModal?`/`openModal?`). |
| `Bot` | **renamed** | `Channel` — `channels-core/dist/create-channel.d.ts`: `export interface Channel<TState = unknown> { readonly name?: string; readonly adapters: readonly PlatformAdapter[]; onMention(...); onMessage(...); onThreadStarted(...); onInteraction(...); onInterrupt(...); onCommand(...); onReaction(...); onModalSubmit(...); onModalClose(...); tool(...); addAdapter(...); start(): Promise<void>; stop(): Promise<void>; transcripts: Transcripts; }` (factory: `createChannel`, see (a)/(b)). |

Confirmed by an exhaustive grep (zero hits) for `createBot`, `BotTool`,
`BotCommand`, `defineBotTool`, `defineBotCommand`, `BotNode`, and any `Bot`
type/interface/class across **every** installed channel package's `.d.ts`
output — there is no deprecated/back-compat alias for any of these; every call
site must switch to the new name.

### From `@copilotkit/channels-ui`

| Old (0.1.x) | Status | New name / exact source |
|---|---|---|
| `BotNode` | **renamed** | `ChannelNode` — `channels-ui/dist/ir.d.ts`: `export interface ChannelNode { type: string \| ComponentFn \| symbol; props: Record<string, unknown>; key?: string \| number; }` |
| `ModalView` | unchanged | `channels-ui/dist/modal.d.ts`: `export type ModalView = ChannelNode & { type: "modal"; };` |
| `Modal` | unchanged | `channels-ui/dist/modal.d.ts`: `export declare const Modal: (props: ModalProps) => ModalView;` |
| `TextInput` | unchanged | `channels-ui/dist/modal.d.ts`: `export declare const TextInput: (props: TextInputProps) => ChannelNode;` |
| `ModalSelect` | unchanged | `channels-ui/dist/modal.d.ts`: `export declare const ModalSelect: (props: ModalSelectProps) => ChannelNode;` |
| `ModalSelectOption` | unchanged | `channels-ui/dist/modal.d.ts`: `export declare const ModalSelectOption: (props: ModalSelectOptionProps) => ChannelNode;` |
| `RadioButtons` | unchanged | `channels-ui/dist/modal.d.ts`: `export declare const RadioButtons: (props: RadioButtonsProps) => ChannelNode;` |
| `Message` | unchanged | `channels-ui/dist/components.d.ts`: `export declare const Message: (props: MessageProps) => ChannelNode;` |
| `Header` | unchanged | `channels-ui/dist/components.d.ts`: `export declare const Header: (props: HeaderProps) => ChannelNode;` |
| `Section` | unchanged | `channels-ui/dist/components.d.ts`: `export declare const Section: (props: SectionProps) => ChannelNode;` |
| `Context` | unchanged | `channels-ui/dist/components.d.ts`: `export declare const Context: (props: ContextProps) => ChannelNode;` |
| `Actions` | unchanged | `channels-ui/dist/components.d.ts`: `export declare const Actions: (props: ActionsProps) => ChannelNode;` |
| `Button` | unchanged | `channels-ui/dist/components.d.ts`: `export declare function Button<TValue = unknown>(props: ButtonProps<TValue>): ChannelNode;` |
| `InteractionContext` | unchanged | `channels-ui/dist/types.d.ts`: `export interface InteractionContext<TValue = unknown> { thread: Thread; message: IncomingMessage; action: { id: string; value?: TValue }; values: Record<string, unknown>; user: PlatformUser; platform: string; openModal?(view: ModalView): Promise<{ ok: boolean; error?: string }>; }` |
| `PlatformUser` | unchanged | `channels-ui/dist/types.d.ts`: `export interface PlatformUser { id: string; name?: string; handle?: string; email?: string; }` |
| `AgentContentPart` | unchanged | `channels-ui/dist/types.d.ts`: discriminated union — `{ type: "text"; text: string } \| { type: "image"\|"audio"\|"video"\|"document"; source: MediaDataSource }` |
| `Thread` | unchanged (interface) | `channels-ui/dist/types.d.ts` — full interface below. |

`Thread.awaitChoice(...)` — **exists**, identically on both the public
interface and the concrete implementing class:
```ts
// channels-ui/dist/types.d.ts — the Thread interface
awaitChoice<T = unknown>(ui: Renderable): Promise<T>;

// channels-core/dist/thread.d.ts — concrete `class Thread implements ThreadInterface`
awaitChoice<T = unknown>(ui: Renderable): Promise<T>;
```
(The concrete class adds `runAgent(input?: { context?; tools?; prompt?; transcript? })`
and a `resume(value)` method not on the bare `channels-ui` interface, plus a
`supportsBlockingChoice?: boolean` capability flag mirrored from the adapter.)

**Only `BotNode` was renamed** (`BotNode`→`ChannelNode`); every other
`channels-ui` symbol in the requested list kept its exact old name. This lines
up with the `check-types` output below — every `channels-ui`-sourced failure is
specifically `Module '"@copilotkit/channels-ui"' has no exported member
'BotNode'`, and nothing else from that package ever fails.

---

## (f) Full `pnpm check-types` output, grouped by file

Command: `pnpm check-types` (`tsc --noEmit -p tsconfig.json`). **Exit code 2.
74 errors across 19 files**: 22× `TS2305` (no exported member — the direct
rename breaks), 40× `TS7031` (implicit-any destructured binding element), 11×
`TS7006` (implicit-any parameter), 1× `TS2347` (untyped generic call). The 51
implicit-any errors (`TS7031`+`TS7006`) are **cascades**: once
`createBot`/`Bot`/`BotTool`/`BotCommand`/`defineBotTool`/`defineBotCommand`
fail to import, TS can no longer infer the (now effectively `any`-typed)
generic helper's callback parameters, which trips `strict`
(`noImplicitAny`). Nothing below was fixed — this is the recorded breakage
list only, per spec.

### `app/index.ts` — 7 errors (2 root-cause + 5 cascade)
```
app/index.ts(20,10): error TS2305: Module '"@copilotkit/channels"' has no exported member 'createBot'.
app/index.ts(21,32): error TS2305: Module '"@copilotkit/channels"' has no exported member 'BotTool'.
app/index.ts(190,13): error TS7006: Parameter 'threadId' implicitly has an 'any' type.
app/index.ts(222,26): error TS7031: Binding element 'thread' implicitly has an 'any' type.
app/index.ts(222,34): error TS7031: Binding element 'message' implicitly has an 'any' type.
app/index.ts(247,32): error TS7031: Binding element 'thread' implicitly has an 'any' type.
app/index.ts(247,40): error TS7031: Binding element 'user' implicitly has an 'any' type.
```

### `app/managed.ts` — 6 errors (2 root-cause + 4 cascade)
```
app/managed.ts(19,10): error TS2305: Module '"@copilotkit/channels"' has no exported member 'createBot'.
app/managed.ts(20,15): error TS2305: Module '"@copilotkit/channels"' has no exported member 'Bot'.
app/managed.ts(121,26): error TS7031: Binding element 'thread' implicitly has an 'any' type.
app/managed.ts(121,34): error TS7031: Binding element 'message' implicitly has an 'any' type.
app/managed.ts(139,32): error TS7031: Binding element 'thread' implicitly has an 'any' type.
app/managed.ts(139,40): error TS7031: Binding element 'user' implicitly has an 'any' type.
```

### `app/commands/index.ts` — 16 errors (2 root-cause + 14 cascade)
```
app/commands/index.ts(14,10): error TS2305: Module '"@copilotkit/channels"' has no exported member 'defineBotCommand'.
app/commands/index.ts(15,15): error TS2305: Module '"@copilotkit/channels"' has no exported member 'BotCommand'.
app/commands/index.ts(53,21): error TS7031: Binding element 'thread' implicitly has an 'any' type.
app/commands/index.ts(53,29): error TS7031: Binding element 'text' implicitly has an 'any' type.
app/commands/index.ts(53,35): error TS7031: Binding element 'user' implicitly has an 'any' type.
app/commands/index.ts(71,21): error TS7031: Binding element 'thread' implicitly has an 'any' type.
app/commands/index.ts(71,29): error TS7031: Binding element 'text' implicitly has an 'any' type.
app/commands/index.ts(71,35): error TS7031: Binding element 'user' implicitly has an 'any' type.
app/commands/index.ts(91,21): error TS7031: Binding element 'thread' implicitly has an 'any' type.
app/commands/index.ts(91,29): error TS7031: Binding element 'text' implicitly has an 'any' type.
app/commands/index.ts(91,35): error TS7031: Binding element 'user' implicitly has an 'any' type.
app/commands/index.ts(91,41): error TS7031: Binding element 'platform' implicitly has an 'any' type.
app/commands/index.ts(136,21): error TS7031: Binding element 'thread' implicitly has an 'any' type.
app/commands/index.ts(136,29): error TS7031: Binding element 'openModal' implicitly has an 'any' type.
app/commands/index.ts(136,40): error TS7031: Binding element 'platform' implicitly has an 'any' type.
app/commands/index.ts(136,50): error TS7031: Binding element 'user' implicitly has an 'any' type.
```

### `app/commands/__tests__/commands.test.ts` — 1 error
```
app/commands/__tests__/commands.test.ts(3,15): error TS2305: Module '"@copilotkit/channels-ui"' has no exported member 'BotNode'.
```

### `app/components/issue-card.tsx` — 1 error
```
app/components/issue-card.tsx(23,15): error TS2305: Module '"@copilotkit/channels-ui"' has no exported member 'BotNode'.
```

### `app/components/issue-list.tsx` — 1 error
```
app/components/issue-list.tsx(20,15): error TS2305: Module '"@copilotkit/channels-ui"' has no exported member 'BotNode'.
```

### `app/components/page-list.tsx` — 1 error
```
app/components/page-list.tsx(20,15): error TS2305: Module '"@copilotkit/channels-ui"' has no exported member 'BotNode'.
```

### `app/human-in-the-loop/confirm-write-tool.tsx` — 5 errors (1 root-cause + 4 cascade)
```
app/human-in-the-loop/confirm-write-tool.tsx(13,10): error TS2305: Module '"@copilotkit/channels"' has no exported member 'defineBotTool'.
app/human-in-the-loop/confirm-write-tool.tsx(38,19): error TS7031: Binding element 'action' implicitly has an 'any' type.
app/human-in-the-loop/confirm-write-tool.tsx(38,27): error TS7031: Binding element 'detail' implicitly has an 'any' type.
app/human-in-the-loop/confirm-write-tool.tsx(38,39): error TS7031: Binding element 'thread' implicitly has an 'any' type.
app/human-in-the-loop/confirm-write-tool.tsx(39,26): error TS2347: Untyped function calls may not accept type arguments.
```

### `app/human-in-the-loop/__tests__/confirm-write-tool.test.tsx` — 1 error
```
app/human-in-the-loop/__tests__/confirm-write-tool.test.tsx(2,27): error TS2305: Module '"@copilotkit/channels-ui"' has no exported member 'BotNode'.
```

### `app/human-in-the-loop/__tests__/confirm-write.test.tsx` — 1 error
```
app/human-in-the-loop/__tests__/confirm-write.test.tsx(4,8): error TS2305: Module '"@copilotkit/channels-ui"' has no exported member 'BotNode'.
```

### `app/modals/__tests__/file-issue.test.tsx` — 1 error
```
app/modals/__tests__/file-issue.test.tsx(9,15): error TS2305: Module '"@copilotkit/channels-ui"' has no exported member 'BotNode'.
```

### `app/tools/__tests__/showcase-tools.test.tsx` — 1 error
```
app/tools/__tests__/showcase-tools.test.tsx(12,3): error TS2305: Module '"@copilotkit/channels-ui"' has no exported member 'BotNode'.
```

### `app/tools/index.ts` — 1 error
```
app/tools/index.ts(22,15): error TS2305: Module '"@copilotkit/channels"' has no exported member 'BotTool'.
```

### `app/tools/read-thread.ts` — 4 errors (1 root-cause + 3 cascade)
```
app/tools/read-thread.ts(14,10): error TS2305: Module '"@copilotkit/channels"' has no exported member 'defineBotTool'.
app/tools/read-thread.ts(24,17): error TS7006: Parameter '_args' implicitly has an 'any' type.
app/tools/read-thread.ts(24,26): error TS7031: Binding element 'thread' implicitly has an 'any' type.
app/tools/read-thread.ts(28,31): error TS7006: Parameter 'm' implicitly has an 'any' type.
```

### `app/tools/render-chart.tsx` — 4 errors (1 root-cause + 3 cascade)
```
app/tools/render-chart.tsx(11,10): error TS2305: Module '"@copilotkit/channels"' has no exported member 'defineBotTool'.
app/tools/render-chart.tsx(74,19): error TS7031: Binding element 'title' implicitly has an 'any' type.
app/tools/render-chart.tsx(74,26): error TS7031: Binding element 'chartSpec' implicitly has an 'any' type.
app/tools/render-chart.tsx(74,39): error TS7006: Parameter 'ctx' implicitly has an 'any' type.
```

### `app/tools/render-diagram.tsx` — 4 errors (1 root-cause + 3 cascade)
```
app/tools/render-diagram.tsx(11,10): error TS2305: Module '"@copilotkit/channels"' has no exported member 'defineBotTool'.
app/tools/render-diagram.tsx(44,19): error TS7031: Binding element 'title' implicitly has an 'any' type.
app/tools/render-diagram.tsx(44,26): error TS7031: Binding element 'mermaid' implicitly has an 'any' type.
app/tools/render-diagram.tsx(44,37): error TS7006: Parameter 'ctx' implicitly has an 'any' type.
```

### `app/tools/render-table.tsx` — 5 errors (1 root-cause + 4 cascade)
```
app/tools/render-table.tsx(23,10): error TS2305: Module '"@copilotkit/channels"' has no exported member 'defineBotTool'.
app/tools/render-table.tsx(132,19): error TS7031: Binding element 'title' implicitly has an 'any' type.
app/tools/render-table.tsx(132,26): error TS7031: Binding element 'columns' implicitly has an 'any' type.
app/tools/render-table.tsx(132,35): error TS7031: Binding element 'rows' implicitly has an 'any' type.
app/tools/render-table.tsx(132,45): error TS7031: Binding element 'thread' implicitly has an 'any' type.
```

### `app/tools/render-tools.tsx` — 7 errors (1 root-cause + 6 cascade)
```
app/tools/render-tools.tsx(8,10): error TS2305: Module '"@copilotkit/channels"' has no exported member 'defineBotTool'.
app/tools/render-tools.tsx(26,17): error TS7006: Parameter 'props' implicitly has an 'any' type.
app/tools/render-tools.tsx(26,26): error TS7031: Binding element 'thread' implicitly has an 'any' type.
app/tools/render-tools.tsx(41,17): error TS7006: Parameter 'props' implicitly has an 'any' type.
app/tools/render-tools.tsx(41,26): error TS7031: Binding element 'thread' implicitly has an 'any' type.
app/tools/render-tools.tsx(55,17): error TS7006: Parameter 'props' implicitly has an 'any' type.
app/tools/render-tools.tsx(55,26): error TS7031: Binding element 'thread' implicitly has an 'any' type.
```

### `app/tools/showcase-tools.tsx` — 7 errors (1 root-cause + 6 cascade)
```
app/tools/showcase-tools.tsx(25,10): error TS2305: Module '"@copilotkit/channels"' has no exported member 'defineBotTool'.
app/tools/showcase-tools.tsx(100,17): error TS7006: Parameter 'props' implicitly has an 'any' type.
app/tools/showcase-tools.tsx(100,26): error TS7031: Binding element 'thread' implicitly has an 'any' type.
app/tools/showcase-tools.tsx(143,17): error TS7006: Parameter 'props' implicitly has an 'any' type.
app/tools/showcase-tools.tsx(143,26): error TS7031: Binding element 'thread' implicitly has an 'any' type.
app/tools/showcase-tools.tsx(186,17): error TS7006: Parameter 'props' implicitly has an 'any' type.
app/tools/showcase-tools.tsx(186,26): error TS7031: Binding element 'thread' implicitly has an 'any' type.
```

(19 files, 74 errors total — matches `grep -c "error TS"` exactly.)

---

## Summary for Task 2/3 implementers

1. Rename, repo-wide: `createBot`→`createChannel`, `Bot`→`Channel`,
   `BotTool`→`ChannelTool`, `BotCommand`→`ChannelCommand`,
   `defineBotTool`→`defineChannelTool`, `defineBotCommand`→`defineChannelCommand`,
   `BotNode`→`ChannelNode`. Every other symbol touched by this codebase
   (`ContextEntry`, `ModalSubmitHandler`, `PlatformAdapter`, `Thread` incl.
   `awaitChoice`, and every named `channels-ui` component/type besides
   `BotNode`) keeps its exact old name and import path — fixing the 22
   `TS2305` root causes above should make most of the 51 cascade errors
   disappear on their own (correct type inference returns once the generic
   helpers resolve).
2. `@copilotkit/channels-slack`'s `SanitizingHttpAgent`/`defaultSlackTools`/
   `defaultSlackContext`/`slack` need zero changes — same names, same
   signatures, same import path.
3. **Blocking for Task 3 specifically:** the `CopilotRuntime`/
   `createCopilotNodeListener` "managed channels" surface (`channels` option,
   `.channels?.stop()`) does not exist at the currently-locked
   `@copilotkit/runtime@1.62.3` — it first appears at `1.63.2`. `^1.62.3`
   already permits `1.63.2`, but the lockfile needs an explicit
   `pnpm update @copilotkit/runtime` (or equivalent forced re-resolution) to
   actually move there; a bare `pnpm install` will not, since the declared
   range in `package.json` didn't change. Also: `agents: {}` (empty) fails the
   `NonEmptyRecord` constraint on `CopilotRuntimeOptions.agents` — the plan's
   example construction needs a non-empty `agents` record.
4. `startChannelsOverRealtimeGateway(channels: Channel[], config)` — what the
   current `app/managed.ts` calls today — **still exists unchanged** in
   `@copilotkit/channels-intelligence@0.2.1` (just retyped `Bot[]`→`Channel[]`),
   alongside a new lower-level `startChannels(opts: StartChannelsOptions)`. A
   much smaller migration (rename-only, keep the realtime-gateway launcher) is
   technically possible as a fallback if the `CopilotRuntime`/
   `createCopilotNodeListener` v2 rewrite in Task 3 proves too disruptive or
   the runtime bump is undesirable.
5. `@copilotkit/channels-ui@0.2.1` pulls `@copilotkit/shared@1.63.2` while
   `@copilotkit/runtime@1.62.3`'s tree pulls `@copilotkit/shared@1.62.3` — two
   coexisting versions in the pnpm store today. Not currently causing a
   `check-types` failure, but worth eliminating if `runtime` gets bumped to
   1.63.2 anyway per point 3 (it would naturally converge).
