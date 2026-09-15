# Stage 1 findings: the Arcade SDK boundary

Recorded 2026-09-15 against `arcadepy` 1.10.0, the latest release the index
offers. Established by reading the installed package and by read-only calls
against a live Arcade project — 3000 tool definitions listed, no write call
made. The one part still unproven is browser verification, at the end.

## The dependency itself

`arcadepy` 1.10.0 declares `requires-python >=3.8`, and this agent pins
`>=3.12` and runs 3.13.2, so the floor is satisfied. Its dependencies are
`anyio`, `distro`, `httpx`, `pydantic`, `sniffio` and `typing-extensions` —
every one already resolved in this tree, and none with a ceiling that conflicts
with an existing floor. Adding it costs one new transitive package, `distro`.

## What the client exposes

`tools.list`, `tools.get`, `tools.authorize`, `tools.execute`, plus
`auth.authorize`, `auth.status` and `auth.wait_for_completion`. That is the
whole surface the plan's five operations need.

`tools.authorize` takes `tool_name`, `user_id` and an optional `next_uri`, and
returns an `AuthorizationResponse` carrying `id`, `url`, `scopes`, `user_id` and
a `status` of `not_started` / `pending` / `completed` / `failed`.

Two things follow, both of which the plan assumed and both of which hold:

* **Authorization is per action, not per app.** `tool_name` is the unit, and the
  response names the `scopes` that authorization covers. The plan's requirement
  that a prior read must not establish send access is expressible directly.
* **The connect target can stay a target.** `authorize` mints the URL, so the
  agent can hold an action identifier and mint on click, exactly as the Composio
  path already does.

`auth.status` accepts a `wait` of at most 59 seconds, so polling for completion
is bounded per call rather than open-ended.

## Effect metadata: present, and richer than Composio's

Established against a live project by listing 3000 tool definitions and reading
the raw JSON.

The generated SDK types are a red herring. `ToolDefinition` declares no
`metadata` field, and reading the package alone suggests effect information is
unavailable. It is not: the API returns `metadata.behavior` and `arcadepy`'s
base model sets `extra="allow"`, so the field survives parsing and is reachable
even though no type declares it. A first pass that stopped at the type
definitions concluded the opposite, and was wrong.

What comes back, on tools that publish it:

```json
"metadata": {
  "classification": {"service_domains": ["email"]},
  "behavior": {
    "operations": ["update"],
    "read_only": false,
    "destructive": true,
    "idempotent": true,
    "open_world": true
  }
}
```

**The plan's three-band mapping works as written, and the middle band is real.**
Across 346 classified tools: no tool claims `read_only` and `destructive`
together, so the contradiction case the plan defends against did not occur once.
More usefully, non-reads that explicitly declare themselves non-destructive are
common — Github alone publishes 26 reads, 16 writes and 1 destructive. That is
the `write` band the Composio path could not express at all, because MCP
behaviour tags say only "read" or "destructive". On Arcade, "this changes
something but will not destroy anything" is a statement a tool can actually
make, so the approval card can stop painting ordinary writes the same as
deletions.

### Coverage splits on one clean line

Overall coverage is 11.5%, and that number is misleading. The split is entirely
between two families of toolkit:

| Family | Example | Metadata |
| --- | --- | --- |
| Curated toolkits | `Github`, `Asana`, `Attio`, `Figma`, `Clickup`, `Confluence`, `Daytona` | **100%**, every tool |
| Generated API wrappers | `GithubApi`, `AsanaApi`, `DatadogApi`, `AirtableApi` | **0%**, every tool |

Every curated toolkit sampled classified all of its tools. Every `*Api` toolkit
classified none of them. The low headline percentage is arithmetic: the wrapper
families are enormous (`GithubApi` 780 tools, `DatadogApi` 588,
`FreshserviceApi` 214) and drown out the curated ones.

### What that means for the gate

The plan's fallback — unresolvable metadata is treated as destructive — is
correct and needs no change. Its consequence is now predictable rather than
surprising: a deployment that names `Github` gets a working three-band gate, and
a deployment that names `GithubApi` gets an approval card on every single call,
including reads.

So this is a configuration concern, not a classification one. **Arcade config
validation should warn at startup when a configured toolkit publishes no
behaviour metadata**, naming the curated toolkit to use instead where one exists
under the same name minus the `Api` suffix. That warning belongs with the other
startup warnings in Stage 3, and it is cheap: the answer is already in the
listing the adapter has to fetch anyway.

## Production browser verification

Unchanged from what the plan already records, and not yet investigated against a
live project: Arcade's default verifier expects the person completing the OAuth
flow to be a member of the Arcade project, which ordinary colleagues in a Slack
workspace are not. Production use needs custom OAuth credentials and a custom
verifier on a publicly reachable route. This remains the Stage 4 gate.

## What this changes about the plan

Nothing structural. The effect-mapping paragraph stands as written and turns out
to be better supported on Arcade than on Composio, because the `write` band is
expressible here.

Two additions for Stage 3, both small:

1. **Warn on a toolkit that publishes no behaviour metadata**, at configuration
   time, naming the curated equivalent where one exists. Without it, a deployer
   who names a `*Api` toolkit gets an approval card on every read and no
   explanation.
2. **Read `metadata.behavior` off the undeclared field rather than a typed
   attribute**, and pin that with a contract test against a recorded payload. It
   is reachable because the SDK's base model allows extra fields, which is a
   property of the SDK's configuration rather than a documented guarantee — if a
   future release tightens it, the classification silently falls back to
   destructive-for-everything and nothing else goes red.
