# Migrating production `@kite` to OpenTag

This is a CopilotKit-internal runbook for cutting the existing production
`@kite` Slack app over to OpenTag on managed Intelligence Channels. It is not
part of getting OpenTag running — for that, use the
[README quick start](../README.md#quick-start), which creates a fresh Slack app
from a CLI-generated manifest and never touches `@kite`.

## Constraint

**Do not create, reinstall, or replace the production Slack app.** It owns the
bot user, the workspace installation, and the `@kite` handle. Losing any of the
three is user-visible and not cheaply reversible.

That constraint is in tension with one fact about the managed path, and the
tension is the whole difficulty of this cutover: Slack must POST events to an
Intelligence-hosted Request URL, and `@kite` was built for Socket Mode. Socket
Mode and a Request URL are mutually exclusive delivery modes. So the app's event
delivery has to change even though the app itself must not be recreated.

Two consequences follow, and both need confirming against the live app before
anyone touches it:

- Slack applies manifest scope changes only on **Reinstall to Workspace**. If the
  cutover needs no scope change, no reinstall is needed. If it does, reinstalling
  is unavoidable and its blast radius on the existing installation must be
  understood first.
- The **signing secret is reissued on reinstall**. Any reinstall invalidates the
  secret stored in Intelligence, so treat a post-reinstall auth failure as a
  stale stored secret before suspecting a missing scope.

## Credentials

The managed Slack adapter takes exactly two values:

| Field | Where |
| --- | --- |
| `channelToken` | **Bot User OAuth Token** (`xoxb-`), from **OAuth & Permissions** |
| `signingSecret` | **Signing Secret**, from **Basic Information → App Credentials** |

There is no app-level `xapp-` token anywhere on this path. If you are looking for
a field to paste one into, you are on the Socket Mode path, which is the thing
being migrated away from. Earlier revisions of this runbook asked for `xapp-`;
that was wrong.

Never put either value in source control or in chat.

## Sequence

Drive the Slack-side changes from the CLI's emitted next actions rather than from
remembered steps. Run `channels add` against the existing app's Channel and read
`nextAction.instructions`, `nextAction.caveats`, `nextAction.requiredEnvVars`,
and `nextAction.resumeCommand`:

```bash
npx --yes copilotkit@latest channels add --name open-tag --display-name "OpenTag" --adapter slack --json
```

Then:

1. **Stop the old Kite Socket Mode runtime**, so there is exactly one consumer.
   Managed delivery is claim-based: two runtimes on the same Channel name in the
   same project race per delivery and the loser silently receives nothing. The
   tell is a Slack reply nobody's terminal knows anything about.
2. **Reconfigure the existing app's event delivery** per the CLI's emitted
   instructions — Socket Mode off, the Intelligence Request URL set, and
   interactivity enabled so human-in-the-loop buttons fire.
3. **Attach the existing `xoxb-` token and signing secret** in Intelligence,
   entered directly into the Slack attachment.
4. **Start the OpenTag `runtime` service** with `INTELLIGENCE_CHANNEL_NAME` set
   to the Channel name in `.copilotkit/channels.json`.
5. **Verify.** See below.

## Acceptance

Production acceptance is one end-to-end `@kite` mention that returns the OpenTag
persona through the Python agent. Add the two trigger checks that catch the
regressions this repo has actually shipped — an unmentioned follow-up in that
subscribed thread should reply, and an unmentioned message in a fresh
conversation should stay silent.

Run diagnostics before concluding anything:

```bash
npx --yes copilotkit@latest channels status --json
```

```bash
LOG_LEVEL=debug pnpm runtime
```

The runtime logger defaults to `error` while every Channel lifecycle breadcrumb
is emitted at `warn`. The line `channel "<name>" requires setup` is the single
highest-value diagnostic here, and at the default level it is written and
discarded.

### Signals that are not health

Several things look like success and are not:

- **`ready()` resolving.** It resolves on `setup_required` too, which is a valid
  degraded state, not a failure. Only `controls.status()` distinguishes them.
- **`/api/copilotkit/info` returning 200.** It reports license and runtime state
  and says nothing about Slack.
- **The dashboard's Agent run column reading `—`**, Overview showing
  `AGENT: Not declared`, and an `…:activation` pseudo-thread. None of those
  indicate a failed turn; the activation thread only means the runtime activated.

The tab that proves a real round trip is **Usage**: `Completed turns` plus a
non-zero `Outbound`.

## Rollback

If the cutover fails, stop the new Channel **before** restoring the prior Railway
deployment, so the old Socket Mode consumer does not come back up alongside a
live managed Channel.

## Railway

The repository configuration does not mutate the existing production Railway
project. The live migration reuses the existing Kite `runtime` service, adds the
`agent` service, connects both to `CopilotKit/OpenTag` on `main`, and enables
GitHub autodeploys. Inventory and cutover happen after Railway authentication.

See [`setup.md`](../setup.md#railway) for the service and variable contract.
