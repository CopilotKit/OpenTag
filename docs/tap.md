# TAP mode — credential isolation and open-ended integrations

TAP mode routes the agent's external service calls through the
[TAP](https://tap.human.tech) credential proxy. The agent references each
credential by **name**; TAP injects the real secret server-side, pins it to the
service's own API host, applies the team's approval policy, and forwards the
request. This process holds **no service API key**.

It is **opt-in and off by default** — without `TAP_AGENT_KEY`, OpenTag uses its
direct MCP integrations exactly as documented in [setup.md](../setup.md).

## Why turn it on

- **Open-ended integrations.** Instead of one MCP connection per service, the
  agent gets two generic tools: `tap_discover` (lists the credentials it may
  use, each with its approval policy and usage examples) and `tap_call` (one
  universal authenticated call). Anything connected to the TAP account —
  GitHub, Sentry, PagerDuty, Datadog, Stripe, Gmail/Google Calendar via
  TAP-mediated OAuth — is usable the moment an admin adds it. No code change,
  no redeploy.
- **Nothing to leak.** `env | grep -i linear` comes back empty. A
  prompt-injected agent cannot exfiltrate a key it never held, and TAP refuses
  to send a credential anywhere but its own pinned host, before injection.
- **Auditability.** Every forwarded call gets an audit record and a receipt id
  on the TAP side, answering "what has the bot been doing in our systems?"
- **A policy dial, not a toll.** Low-stakes credentials (Linear, Notion) run
  with zero added friction. For higher-stakes credentials the team can require
  a human approval — or a passkey — per call, from the TAP dashboard, with no
  change here.

## Setup

TAP mode needs a TAP account — the free tier covers trying this out, and the
onboarding wizard issues the agent key in a few minutes.

1. Create a team at
   [tap.human.tech](https://tap.human.tech?utm_source=opentag&utm_medium=github&utm_content=docs)
   and copy an agent key from the onboarding wizard (or Dashboard → Agents).
2. In the root `.env`:

   ```
   TAP_AGENT_KEY=tap_...
   # TAP_PROXY_URL only if self-hosting TAP; defaults to the hosted proxy
   ```

3. Restart `pnpm agent`. Startup logs show `TAP mode: enabled`. TAP composes
   per service with the direct integrations: any service key still set
   (`LINEAR_API_KEY`, `NOTION_MCP_AUTH_TOKEN`, `POSTHOG_PERSONAL_API_KEY`)
   keeps that service's direct MCP connection — remove a key to route that
   service through TAP, which is what makes the isolation and approval
   enforcement apply to it. The boot log states which services are direct and
   that the rest go through `tap_call`.

Credentials can be connected in the TAP dashboard up front, **or lazily**: ask
the bot for something first — if the service isn't connected, the bot replies
with a prefilled creation link; open it, paste the service's API key (the
secret goes into the TAP dashboard, never into chat), and tell the bot to try
again.

For the stock integrations, connect:

| Credential name | Host pin           | Notes |
| --------------- | ------------------ | ----- |
| `linear`        | `api.linear.app`   | Linear personal API key; the agent speaks GraphQL to `/graphql` |
| `notion`        | `api.notion.com`   | Notion internal-integration token |
| `posthog`       | `us.posthog.com` (or your region) | PostHog personal API key. Note: direct mode is server-enforced read-only; TAP mode exposes the full REST API behind the write gate — consider a require-approval TAP policy for it |

## How writes are handled

Two independent layers, mirroring stock behavior:

1. **In-channel confirmation (always).** A mutating `tap_call` emits the same
   `confirm_write` interrupt as the MCP write interceptor — the user approves
   in the conversation before the request is sent. Reads (including Linear
   GraphQL queries and Notion search/database queries, which are HTTP POSTs)
   do not pause. Ambiguous calls are treated as writes.
2. **TAP policy (per credential, optional).** The team can additionally
   require a human approval in the TAP dashboard for any credential. When TAP
   holds a call, the bot relays the approval link and waits (up to
   `TAP_APPROVAL_TIMEOUT`, default 300s; `0` means report the held call
   immediately instead of waiting). If the approval lands later, the bot can
   fetch the outcome with its `tap_check_approval` tool. Approvals denied on
   the TAP side fail closed.

Layer 1 is conversation UX, not enforcement — a confused or manipulated model
could mislabel a call. Layer 2 is enforced server-side by TAP regardless of
what the model does, which is why higher-stakes credentials should carry a
TAP require-approval policy rather than relying on method-based auto-approval
alone.

## Notes

- TAP has a free tier that covers trying this out.
- The agent composes raw API calls from `tap_discover`'s usage examples. A
  malformed call returns a corrective error and costs nothing; if a specific
  service proves chronically awkward, a dedicated tool for it is a reasonable
  one-off addition.
- Self-hosted TAP works by setting `TAP_PROXY_URL`.
