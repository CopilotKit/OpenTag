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

The forwarder also emits one logs-only health heartbeat after every successful
poll and a sanitized error log when Railway collection fails. No Datadog
service-check payloads are enabled. Use these Log Explorer queries:

- Healthy heartbeat: `service:kite source:railway component:forwarder @forwarder.health:ok`
- Forwarder errors: `service:kite source:railway component:forwarder @forwarder.health:error`

For reliable no-data detection, create one log monitor per Railway environment,
scope the healthy-heartbeat query with `env:community`, `env:staging`, or
`env:prod`, and alert when the count is below `1` over the last five minutes.
Use a separate log monitor for any forwarder-error count above `0`. Datadog's
[log-monitor documentation](https://docs.datadoghq.com/monitors/types/log/)
explains the no-data behavior. This repository does not create those monitors.

## Railway API request budget

The check runs once per 60 seconds. In steady state, each environment makes two
runtime-log requests per run (120 requests/hour) and one batched deployment
discovery request every four minutes (15 requests/hour), for approximately 135
requests/hour per environment or 405 requests/hour across all three. That is
1.35% per environment and 4.05% aggregate of Railway's published 10,000
requests/hour Pro limit.
Deployment rollover and adaptively splitting a capped log window can temporarily
add requests. HTTP 429 responses suspend polling for Railway's bounded
`Retry-After` interval plus up to five seconds of jitter.

See Railway's current [Public API rate
limits](https://docs.railway.com/integrations/api#rate-limits) before changing the
poll interval or deployment-cache lifetime.

Rollback is the reverse: set `DD_ENABLED = false`, verify the plan deletes only
`datadog-agent` and `datadog-agent-state`, then apply.

## Local verification

```sh
python3 -m unittest discover -s .railway/datadog-agent/tests -v
docker build --load --tag kite-datadog-agent:verification .railway/datadog-agent
```
