# Exclusive Connected-App Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a deployer choose Composio or Arcade for connected-app tools by configuring exactly one provider API key, while preserving existing Composio behavior.

**Architecture:** The Python agent selects one provider and registers that provider's tools. Arcade is added alongside the existing Composio implementation, reusing the existing trusted-identity helpers and approval gate in place; the Channel continues to own click identity and private delivery. Extract common code only when both implementations demonstrate a concrete need.

**Tech Stack:** Existing Python Deep Agents/LangGraph agent, FastAPI, TypeScript CopilotKit Channels, and the Arcade Python SDK (`arcadepy`).

---

## Status and scope

Feature specification and staged implementation plan, authored 2026-09-14 and revised 2026-09-15. This records the agreed behavior and implementation boundaries, rather than supplying unverified SDK code. Validate SDK contracts before implementing dependent calls. Investigate production browser verification early, but do not make its completion a prerequisite for independent selection, adapter, or regression-test work.

The deliverable is a working Arcade integration, including personal linking for ordinary colleagues, while preserving Composio. An interface with no working Arcade implementation is an intermediate milestone, not completion.

Agreed: both providers are supported by the codebase, but only one is active in a deployment. API-key presence selects the provider. No automatic provider fallback or combined catalog.

Proposed implementation details below include configuration names, module boundaries, and a manual retry after account connection. They are design choices for this feature, not claims about existing behavior.

Baseline inspected: local HEAD `be27c426131a86e8ce198d1d00c8e72d06a60991`, branch `feat/composio-in-agent`, and merged PR #68, whose final head is `27c5b2ecd22127a86e421da700e70f7a8949aee7`. These are different revisions. Recheck the target branch before implementation; do not treat this checkout as current main.

## Product contract

Treat absent, empty, and whitespace-only API keys as unset. Select before constructing clients or parsing provider-specific settings.

| Composio key | Arcade key | Result |
| --- | --- | --- |
| Set | Unset | Select Composio |
| Unset | Set | Select Arcade |
| Unset | Unset | No connected-app provider |
| Set | Set | Fail startup: `Configure only one of COMPOSIO_API_KEY or ARCADE_API_KEY.` |

Both keys is an error even if one provider has no configured apps. Adding an Arcade key to a Composio deployment therefore fails startup rather than silently switching providers. No separate provider-selector setting is introduced. Never choose by initialization order or connectivity. Never include credential values in errors.

No provider leaves existing direct integrations, web search, coder, and other agent capabilities governed by their current configuration. Exclusivity applies only to Composio versus Arcade.

Preserve Composio's environment variables, personal/shared routing, connection identities, approval modes and legacy aliases, and operator connection command. Preserve its current key-with-no-apps behavior: warning plus no registered connected-app tools. This qualifies the earlier conversational shorthand that every incomplete setup would fail startup; compatibility takes precedence for this existing case.

For the new Arcade configuration, require at least one allowed app when a key is supplied. Invalid selected-provider configuration fails startup with a useful message. Ignore inactive-provider settings other than the key-selection conflict. Provider outages produce an unavailable result, never selection of another provider.

The agent continues to expose `search_my_tools` and `run_my_tool`. Users ask for actions without choosing a provider in conversation. Show provider names where useful in setup, connection consent, and diagnostics.

## Configuration

Keep all `COMPOSIO_*` settings unchanged. Proposed Arcade settings:

| Setting | Meaning |
| --- | --- |
| `ARCADE_API_KEY` | Selects Arcade; held only by the agent |
| `ARCADE_TOOLKITS` | Allowed apps acting through an operator-connected shared identity |
| `ARCADE_USER_TOOLKITS` | Allowed apps acting through each speaker's own identity |
| `ARCADE_WORKSPACE_USER_ID` | Shared identity; defaults to the Channel name, then `open-tag` |
| `ARCADE_IDENTITY_NAMESPACE` | Required for personal apps; stable deployment namespace within an Arcade project |
| `ARCADE_APPROVALS` | `on` by default, or `off`; no legacy aliases needed |

An app listed in both scopes is personal only. Missing identity must never fall back to the shared account. Warn when personal-data apps are configured as shared, following the existing Composio convention.

Arcade's catalog identifiers must be resolved against its actual definitions. Do not reuse Composio's uppercase-underscore slug parsing or assume app names coincide. Operator input may be normalized for lookup, but execution uses the canonical identifier returned by Arcade.

Personal Arcade IDs are deterministic encodings of `(namespace, platform, actor_id)`, with unambiguous escaping or length encoding. Preserve the existing Composio identity format. Changing the namespace means a new set of Arcade connections and must be documented as such.

Provider keys stay on the agent service. `AGENT_AUTH_HEADER` stays on both services and remains mandatory for capability-minting routes. Additional browser-verifier configuration is specified only after Stage 1 establishes the supported route and identity proof; do not invent a callback URL that the deployed topology cannot serve.

## Minimal integration boundary

Start with one selector function and explicit registration branches in the existing composition points. Both implementations satisfy these behavioral contracts; a common base class, shared tool implementation, or multi-module neutral package is not required:

| Operation | Required contract |
| --- | --- |
| Describe capabilities | Configured app names and personal/shared scope; never claim authorization from configuration alone |
| Discover | Allowed canonical actions, descriptions, input schemas, scope, and connection requirements |
| Inspect action | Resolve canonical definition and effect; reject an action outside the configured allowlist |
| Execute | Explicit server-resolved identity, canonical action and validated arguments; normalized success/failure |
| Start connection | Verified clicker and validated connection target; private URL, already-authorized result, or safe error |

Keep SDK response parsing, Composio sessions, Arcade authorization scopes, and provider errors inside their provider packages. Arcade may expose its own tools with the same `search_my_tools` and `run_my_tool` names because only one pair is registered. Leave Composio's existing tool builder intact. Avoid a generic plugin registry or a new provider framework.

Only the selected provider's tools and prompt additions are registered. In particular, replace the Composio-specific absence statement in `agent/prompts/tools.py`: an Arcade deployment must not be told it has no connected apps.

Reuse trusted actor handling directly from `agent/composio_tools/state.py`. Do not move or rename it as part of adding Arcade; its package name is not a reason to disturb the identity boundary. Preserve the persisted `channel_actor` key, anonymous-turn clearing, rejection of caller-supplied identity, and delayed approval behavior through the real AG-UI adapter. Reuse `require_write_confirmation` and existing effect constants in place as well.

After both implementations work, extract a helper only if a concrete shared behavior otherwise needs two maintained implementations. Keep such changes independently reviewable and covered by existing behavior tests. No identity-module relocation is planned for this feature.

## Discovery, execution, and approval

Discovery searches only configured apps and respects pagination. A bounded local index of allowed Arcade definitions is acceptable for the first version; semantic search parity with Composio is not required. Return exact argument schemas for discovered actions.

Execution independently enforces configured ownership and schema validity. A model-supplied action identifier is not authorization. Neither tool exposes a user ID, provider selector, or account selector as a model-controlled argument.

Arcade authorization is action/scope-specific. Check authorization for the requested action; a prior successful read does not establish access to send or delete. Do not initiate account-binding flows during ordinary discovery or expose their URLs in tool results.

Map explicit Arcade read-only metadata to `read`, explicit destructive metadata to `destructive`, and a non-read explicitly declared non-destructive to `write`. Missing, malformed, contradictory, or unresolvable metadata defaults to `destructive`; destructive wins over a contradictory read-only claim. Do not infer safety from an action name or idempotency.

When approvals are on, gate every non-read through the existing `require_write_confirmation`. Preserve personal approver checks on both confirm and decline. Account consent does not count as write approval. Recheck required account access at execution without executing as a side effect of that check.

Normalize authorization-needed, declined, expired/revoked authorization, provider unavailable, definitive execution failure, and unknown execution outcome separately. Never automatically retry a write after an ambiguous transport failure. Redact provider exceptions before returning or logging them; never expose authorization URLs or tokens.

## Connection experience

1. Search or execution reports that a validated action needs account access. It returns a safe connection target, never a URL.
2. `connect_app` posts a public button naming the app. The target may contain a canonical action so Arcade can request the right scopes; the agent validates it again on click.
3. On click, the Channel supplies the actual clicker's identity to an authenticated agent route. It never trusts an actor ID embedded in card props.
4. The agent initiates Arcade authorization for that clicker and action. The Channel delivers the URL through the existing private delivery path. If private delivery fails, it discards the URL and reports the failure without exposing it.
5. Browser verification binds the flow to the same person. Investigate the approach in Stage 1 and demonstrate the production binding in Stage 4.
6. The user returns and asks OpenTag to continue. The next call checks real authorization status and, for a write, asks for write approval. No automatic background execution after OAuth in the first version.

Support link expired, access denied, already authorized, additional scopes required, and missing provider configuration with distinct useful messages. A successful click does not mean the account is connected.

Shared accounts use an operator CLI analogous to the existing Composio command. A personal Connect button must not bind a shared account. First-version personal linking is Slack-only, matching the existing supported experience.

### Switching providers and old interactions

Changing providers requires restart and new account connections. No credential migration or automatic revocation of old-provider accounts is attempted.

Bind new connection cards and pending tool approvals to the provider that created them. Reject stale interactions if it differs from the selected provider. Legacy Composio cards without a marker remain usable only in Composio mode; in Arcade mode they instruct the user to request a fresh action.

Provider binding must reach the graph's execution boundary, not merely the displayed card. An old checkpoint must never resume against the newly selected provider. Cover checkpoint replay and resume through the real adapter. Do not add a provider argument that lets the model choose an inactive provider.

## Production authorization prerequisite

Arcade documents its default verifier as requiring an Arcade project-member login. Its production guidance calls for custom OAuth app credentials and a custom verifier so end users need not join the Arcade project.

The runtime-to-agent shared secret authenticates a service call; it is not a browser login. OpenTag's forwarded Slack actor alone is not browser proof. Investigate a supported verifier using authenticated browser identity linked to the Slack actor, or an Arcade-supported equivalent, in Stage 1; demonstrate its binding in Stage 4. A browser query parameter or possession of the public Connect card is insufficient.

Until demonstrated, classify personal linking as development-only. This does not prevent implementing the adapter, exercising developer accounts, or validating shared-account behavior. Do not claim general personal-account production readiness based on a maintainer successfully logging into Arcade. Completing this prerequisite is required for the full feature, not an optional follow-up. If external setup prevents it, report that specific incomplete capability while continuing independent work.

## Proposed file map

Paths are repository-relative. Add focused files as implementation requires them; the map does not mandate an abstraction layer or a file for each operation.

| Files | Responsibility |
| --- | --- |
| New `agent/connected_app_provider.py` | Pure API-key selection; no SDK construction or identity logic |
| Existing `agent/composio_tools/` | Keep existing runtime, session and tool builders; reuse identity helpers in place; only targeted provider-binding changes |
| New `agent/arcade_tools/` | Arcade configuration, SDK client, search/run tool builder, action authorization and operator setup; split catalog/effect helpers only when useful |
| `agent/agent.py`, `agent/agui.py`, `agent/main.py` | Register selected tools, preserve actor/resume semantics, expose authenticated connection dispatch |
| `agent/write_confirmation.py`, `agent/prompts/tools.py`, `agent/prompts/__init__.py` | Reuse approval helper; add provider binding and selected-provider capability text without moving effect definitions |
| `app/tools/connect-app.tsx`, `app/tools/connect-click.tsx`, `app/human-in-the-loop/connect-account.tsx` | Provider-bound connection targets, click identity, private delivery and stale-card response |
| New `app/tools/connected-app-connect.ts`; existing `app/tools/composio-connect.ts` | Neutral client contract; retain compatibility where old callers require it |
| `app/channel.tsx` and approval renderer | Preserve personal approver checks; reject mismatched provider-bound approval |
| `agent/agent_auth.py` | Preserve secret protection; narrowly integrate verifier route authentication only if Stage 1 requires a public browser route |
| New verifier module and route selected in Stage 1 | Browser identity verification; placement depends on the demonstrated deployment path |
| `agent/pyproject.toml`, `agent/uv.lock`, deployment/build files | SDK dependency, package inclusion, and configuration wiring |
| `.env.example`, `README.md`, `setup.md`, `AGENTS.md` | Selection rules, setup, supported surfaces, switching and Arcade code locations |

Retain `/composio/connect` and add `/arcade/connect`; each route refuses requests when its provider is inactive. Keep the current Composio client and add only the connection dispatch needed for provider-bound cards. A new generic HTTP endpoint is not required. Agent and runtime must agree on the response contract for connection targets and selected-provider mismatch. Provider information sent to the Channel is non-secret and cannot override agent-side selection.

## Staged implementation

### Stage 1: Validate SDK contracts and investigate browser verification

- [ ] Read/install current repository-required skills before implementation: `npx copilotkit@latest skills install --skill copilotkit-channels` for Channel changes; install `runtime` if modifying SDK runtime internals. Do not commit installed skills.
- [ ] Recheck Git state and the implementation base; preserve unrelated work.
- [ ] Verify a supported `arcadepy` release against the project's Python version and dependency resolver. Record the tested SDK/API response shapes, including errors and effect metadata.
- [ ] Using an isolated developer project and test account, prove allowed-tool listing, schema retrieval, non-mutating auth checks, connection initiation, authorization completion, and a read. Keep credentials out of fixtures.
- [ ] Investigate the production verifier path: identify required OAuth credentials, a supported way to authenticate browser identity, and a publicly reachable route in the deployment topology. Record what is proven and what still needs external setup.
- [ ] Write the adapter recipe from the SDK evidence. Write the verifier recipe when its identity-binding approach is established; implement and prove it in Stage 4. External verifier setup must not block independent work in Stages 2 and 3.

Exit: SDK contracts are grounded enough to implement the adapter, and the production-verification dependency is explicit. A successful maintainer-only OAuth flow is not evidence that colleague onboarding works.

### Stage 2: Select one provider and preserve Composio

- [ ] Add `agent/tests/test_connected_app_selection.py` covering all four key combinations, whitespace, both-key conflict before SDK construction, and inactive-provider settings.
- [ ] Run those tests before implementation and confirm the expected failing assertions.
- [ ] Add the selector in `agent/connected_app_provider.py` and branch at existing agent/HTTP composition points. Preserve Composio's no-apps warning behavior and verify no inactive SDK client is instantiated.
- [ ] Reuse actor/effect helpers at their existing import paths. Leave identity normalization, graph state keys, session construction and connection IDs unchanged.
- [ ] Run existing Composio, AG-UI identity, approval-resume, configuration and health suites. Confirm direct tools still register with neither provider selected.

Exit: provider selection is tested and Composio behavior is preserved. Until Stage 3 is wired, an Arcade selection must report that implementation is unavailable rather than silently behaving as no provider. Do not ship this intermediate state as the completed feature.

### Stage 3: Implement the Arcade adapter

- [ ] Add `agent/tests/test_arcade_config.py`, `test_arcade_catalog.py`, `test_arcade_tools.py`, and `test_arcade_effects.py` with sanitized SDK-shaped fixtures captured in Stage 1.
- [ ] Cover pagination, unknown action, invalid arguments, disabled app, missing actor, overlapping scope lists, metadata fallback, revoked access, rate limiting and unknown write outcome. Verify failures before adding the corresponding behavior.
- [ ] Implement the Stage 1 adapter recipe and Arcade's own search/run tool builder. Enforce allowlists at execution and register this pair only when Arcade is selected. Do not rewrite Composio's tool builder to fit Arcade.
- [ ] Route all gated calls through the existing approval helper. Verify decline makes zero execute calls; approval executes once as the original actor.
- [ ] Generate prompt content for Composio, Arcade and neither. Assert Arcade-only never gets the Composio absence statement.

Exit: Arcade discovery and execution work with configured test accounts, under existing identity and approval rules. Production personal linking can still be incomplete and must be described that way.

### Stage 4: Connect and resume safely

- [ ] Add `agent/tests/test_arcade_connect.py`, `test_arcade_approval_resume.py`, and `test_connected_app_provider_switch.py` plus the corresponding TypeScript connection-client and click tests.
- [ ] Cover missing/mismatched shared secret, clicker different from requester, non-human actor, unknown connection target, additional scopes and failed private delivery.
- [ ] Add the Arcade connection route and minimal dispatch for provider-bound cards. Preserve the existing Composio route and old Composio cards. Both routes reject an inactive provider.
- [ ] Implement and test the supported browser flow investigated in Stage 1. Demonstrate two distinct Slack identities, mismatch rejection and expired-flow handling. Confirm raw query-string identity cannot satisfy it; exclude URLs and sensitive state from logs and model-visible messages.
- [ ] Exercise two speakers and delayed approval through `OpenTagAGUIAgent`, including anonymous follow-up, regenerate, and provider switch with a pending interaction. UI-only unit tests are insufficient.
- [ ] Implement the Arcade operator connect command and verify it loads the root environment using existing conventions.

Exit: ordinary colleagues can connect their own accounts without joining the Arcade project, and stale provider interactions cannot execute. This is the production personal-linking gate.

### Stage 5: Package, document and verify

- [ ] Review actual duplication after both paths work. Extract only a small helper whose shared behavior is demonstrated; skip extraction if it offers no concrete benefit. Leave trusted-identity code in place.
- [ ] Include new packages in the built Python distribution; verify imports from the built artifact, not just the source directory.
- [ ] Wire Arcade settings into the agent's Railway environment. Document Stage 1's verifier route deployment and its authentication separately from the internal connect route.
- [ ] Update setup examples for Composio-only, Arcade-only and neither; document the both-key error, new account connections after switching, and operator versus personal setup.
- [ ] Run the repository checks below and record actual results. Fix regressions introduced by the feature; identify unrelated failures explicitly.
- [ ] Restart changed processes, then prove Channel `online` through `controls.status()` on an isolated Channel/project. Health HTTP 200 and `ready()` alone are insufficient.
- [ ] Complete the live acceptance scenarios below. Do not merge, publish, deploy to production, or send test messages to other people as an implied part of this document-writing request.

## Acceptance matrix

| Scenario | Required result |
| --- | --- |
| Existing Composio deployment | Same accounts, tools, approvals and operator setup; no new required variables |
| Arcade-only | Only Arcade connected-app tools registered; correct prompt and configured apps |
| Both keys | Clear startup error before either client is constructed |
| Neither key | Other agent capabilities work; no connected-app tools or misleading claims |
| Selected provider unavailable | Actionable failure; no cross-provider fallback |
| Person A and person B in one thread | Each reads/acts as themselves; anonymous turn inherits neither identity |
| B clicks A's public Connect button | Any newly minted connection is B's; A's account remains unchanged |
| Browser verifier mismatch | Flow rejected without binding an account |
| Read authorized, send not authorized | Additional account authorization required; no send occurs |
| Write approved/declined | Correct person decides; declined executes zero times, approved executes once |
| Late approval | Original action, provider and account preserved through actual graph resume |
| Provider changed with old card/checkpoint | Explicit stale-interaction response; zero execution against replacement provider |
| Private delivery unavailable | No URL in thread, model output, or logs |
| Shared app requested personally | No private click can change the shared account |
| Ambiguous write timeout | Outcome reported as unknown; no automatic replay |

Live acceptance uses a private test conversation and dedicated accounts. Sending or modifying data requires explicit test authorization. Automated tests must not load real provider credentials or contact production services.

## Verification commands

From the repository root:

```bash
pnpm check-types
pnpm test
(cd agent && uv run pytest)
node node_modules/railway/dist/iac/bin.js
```

Packaging check from `agent/`: `uv build`, followed by installation/import checks of the resulting artifact in an isolated environment. The implementer must report exact commands and outcomes. These checks have not been run for this specification-only change.

## Explicit exclusions

Simultaneously active providers; combined catalogs; automatic fallback; account/token migration; a new approval system; a new agent framework; automatic execution upon OAuth completion; Teams personal-linking expansion; a marketplace or generic integration-management UI.

## Sources

- [OpenTag PR #68](https://github.com/CopilotKit/OpenTag/pull/68): agent-owned capabilities, identity and connection/approval boundaries.
- [Arcade authorization](https://docs.arcade.dev/en/build/tool-calling/custom-apps/auth-tool-calling): per-user authorize/execute contract.
- [Arcade production verification](https://docs.arcade.dev/en/build/user-facing-agents/secure-auth-production): project-member default verifier, custom verifier and OAuth app requirements.
- [Arcade tool definitions](https://docs.arcade.dev/en/build/tool-calling/custom-apps/get-tool-definitions): tool retrieval and pagination.
- [Arcade tool metadata](https://docs.arcade.dev/en/build/create-tools/tool-basics/add-tool-metadata): read-only and destructive flags.
- [Arcade LangChain integration](https://docs.arcade.dev/en/get-started/agent-frameworks/langchain/use-arcade-with-langchain-py): Python SDK and interrupt integration.

Documentation was reviewed during the preceding assessment in this conversation. Revalidate SDK details during Stage 1; no live Arcade behavior has been verified yet.
