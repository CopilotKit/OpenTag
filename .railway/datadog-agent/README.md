# Railway log forwarder

This private Datadog Agent service polls Railway's deployment/runtime-log API
and submits Kite's existing `runtime` and `agent` logs through the Agent's
integration-log interface. It does not instrument either application service.

## Enablement and credentials

`.railway/datadog.ts` owns the committed `DD_ENABLED` switch. When it is
`false`, the complete Railway graph contains only the unchanged Kite services.

Each Railway environment must provide these shared variables before enabling:

- `DD_API_KEY`: a dedicated Datadog logs-ingestion key for that environment.
- `RAILWAY_LOGS_TOKEN`: a distinct, environment-scoped Railway project token.

Do not reuse either credential between Community, Staging, and Production.

## Safe rollout

Roll out Community, then Staging, then Production. Before every apply, run
`railway config plan --json` in the selected environment. The only acceptable
changes are creation of `datadog-agent` and `datadog-agent-state`. Abort if the
plan changes variables, deployment settings, or deployments for `runtime` or
`agent`.

After an apply, confirm both Kite services are still running and query Datadog
for fresh `service:kite source:railway` logs with both `component:runtime` and
`component:agent`.

Rollback is the reverse: set `DD_ENABLED = false`, verify the plan deletes only
`datadog-agent` and `datadog-agent-state`, then apply.

## Local verification

```sh
python3 -m unittest discover -s .railway/datadog-agent/tests -v
docker build --load --tag kite-datadog-agent:verification .railway/datadog-agent
```
