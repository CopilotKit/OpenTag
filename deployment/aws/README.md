# Deploy on AWS

By default, OpenTag runs as one private ECS Fargate service with its own cluster:

```text
environment cluster → one service → one task
├── agent container   :8123
└── runtime container :3000 → http://127.0.0.1:8123/

stdout/stderr → CloudWatch Logs → Datadog Forwarder
```

There is no load balancer or public ingress. The runtime connects outbound to
CopilotKit Intelligence. The task runs in private subnets and needs outbound
internet access for Intelligence, OpenAI, GHCR, and any configured MCP service.

Set `sharedCluster=true` only when multiple environments should use one cluster.
That creates `${appName}-shared` for the cluster and VPC integration while each
`${appName}-${environment}` stack retains its own service, task definition, log
groups, secrets access, and Datadog Forwarder. Environment stacks remain
independently deployable.

## Prerequisites

You need:

- AWS CLI v2, Node.js 22+, pnpm, Docker, and AWS CDK v2;
- an AWS SSO profile that can deploy CloudFormation, IAM, ECS, Lambda,
  CloudWatch Logs, and Secrets Manager resources;
- a VPC with private subnets and outbound internet access;
- CopilotKit Intelligence, OpenAI, and Datadog credentials.

Sign in and bootstrap the account/Region once:

```bash
aws configure sso --profile opentag-admin
aws sso login --profile opentag-admin
export AWS_PROFILE=opentag-admin
export AWS_REGION=us-west-2

cd deployment/aws
pnpm install --frozen-lockfile
pnpm exec cdk bootstrap aws://ACCOUNT_ID/us-west-2
```

The first bootstrap/deployment needs permission to create IAM roles, including
the role used by the official Datadog Forwarder.

## Environment variables

AWS configuration is split into two places:

1. Put credentials in one JSON Secrets Manager secret.
2. Pass non-secret settings as CDK context (`-c name=value`).

The public container images do not contain credentials. Outside AWS, the same
variables can be supplied with `docker run --env-file`, Docker Compose,
Kubernetes, or any other container runtime.

### Secrets Manager

Create one JSON secret with these fields:

```json
{
  "INTELLIGENCE_API_KEY": "...",
  "AGENT_AUTH_HEADER": "",
  "OPENAI_API_KEY": "...",
  "TAVILY_API_KEY": "",
  "DAYTONA_API_KEY": "",
  "GITHUB_PERSONAL_ACCESS_TOKEN": "",
  "GITHUB_CODER_TOKEN": "",
  "POSTHOG_PERSONAL_API_KEY": "",
  "LINEAR_API_KEY": "",
  "NOTION_MCP_AUTH_TOKEN": "",
  "COMPOSIO_API_KEY": ""
}
```

Only `INTELLIGENCE_API_KEY` and `OPENAI_API_KEY` are required by the standard
deployment. Every JSON field must exist because ECS resolves each one when the
task starts; use an empty string for an unused integration.

**`AGENT_AUTH_HEADER` is the exception to "empty is fine."** The template above
ships it empty on purpose — that is the correct value when you are not connecting
personal Composio accounts, and it leaves ordinary agent traffic unauthenticated
exactly as before. But `agent/agent_auth.py` strips the value and treats `""` as
unconfigured, and a connect link is refused whenever the secret is unconfigured.
So a deployment that turns on `composioUserToolkits` and leaves this field empty
gets the Connect card and never a link. Put one long random string here, the same
one for both containers — the stack already maps this single field onto both, so
there is nothing to keep in sync by hand.

**Upgrading an existing deployment: nothing to add unless you are turning
Composio on.** `COMPOSIO_API_KEY` is new in this release, and the stack declares
it only when the context that gives it a purpose is set — that is, when either
toolkit list is non-empty. A deployment that does not set those contexts never
asks ECS for the field, so an existing secret still starts.

Add them **when you enable the feature**, in the same change that sets the
context. ECS resolves every declared field at task start, so a secret missing a
field the stack now declares fails with `does not contain the specified JSON
key` and the deployment rolls back.

### Composio context keys

Set these with `-c` at deploy time, or in `cdk.json`:

| Key | Effect |
|---|---|
| `composioToolkits` | Toolkit slugs everyone shares one connection for. Setting either list makes the stack declare `COMPOSIO_API_KEY`. |
| `composioUserToolkits` | Toolkit slugs scoped to whoever sent the message. Setting either list makes the stack declare `COMPOSIO_API_KEY`. Two prerequisites: a **non-empty `AGENT_AUTH_HEADER`** in the JSON secret, without which no connect link is ever minted, and a **Slack-backed Channel** — Teams has no private message, so the link cannot be delivered there. No platform credential is needed either way; the managed adapter delivers privately. |
| `composioApprovals` | `on` (default) or `off`. `destructive` and `writes` are the old spellings and still parse as `on`. |
| `composioWorkspaceUserId` | The Composio user id shared toolkits act as. Set it explicitly: it otherwise defaults to the Channel name, and renaming the Channel would move every shared connection. |

`COMPOSIO_AUTH_CONFIGS` has no context key yet, so an AWS deployment cannot pin
which auth config a shared toolkit connects against. Railway can.

Create a second Secrets Manager secret for Datadog. Its entire plaintext value
must be the raw Datadog API key, not JSON.

For optional GitHub App coding, create a separate Secrets Manager secret whose
entire plaintext value is the base64-encoded private-key PEM. Pass its complete
ARN as `githubAppPrivateKeySecretArn`; do not add the private key to the JSON
application secret. Existing PAT-only deployments require no change.

Changing the OpenTag secret requires a new ECS task. Never put secret values in
CDK context, command history, or source control.

### Non-secret application settings

These CDK context values become container environment variables:

| CDK context | Container variable | Default |
| --- | --- | --- |
| `agentDisplayName` | `AGENT_DISPLAY_NAME` on both containers | `OpenTag` |
| `channelName` | `INTELLIGENCE_CHANNEL_NAME` on both containers | `open-tag` |
| `intelligenceApiUrl` | `INTELLIGENCE_API_URL` | CopilotKit hosted API |
| `intelligenceGatewayWsUrl` | `INTELLIGENCE_GATEWAY_WS_URL` | CopilotKit hosted realtime gateway |
| `logLevel` | `LOG_LEVEL` | `warn` |
| `mermaidUrl` | `MERMAID_URL` | Built-in jsDelivr URL |
| `openAiModel` | `OPENAI_MODEL` | `gpt-5.5` |
| `openAiReasoningEffort` | `OPENAI_REASONING_EFFORT` | `low` |
| `openAiVerbosity` | `OPENAI_VERBOSITY` | `low` |
| `corsAllowOrigins` | `CORS_ALLOW_ORIGINS` | `*` |
| `daytonaSnapshot` | `DAYTONA_SNAPSHOT` | Unset |
| `daytonaTtlMinutes` | `DAYTONA_TTL_MINUTES` | `60` |
| `githubAppId` | `GITHUB_APP_ID` | Unset |
| `githubAppInstallationId` | `GITHUB_APP_INSTALLATION_ID` | Unset |
| `githubMcpUrl` | `GITHUB_MCP_URL` | Hosted read-only GitHub MCP |
| `posthogMcpUrl` | `POSTHOG_MCP_URL` | Hosted read-only PostHog MCP |
| `linearMcpUrl` | `LINEAR_MCP_URL` | Hosted Linear MCP |
| `notionMcpUrl` | `NOTION_MCP_URL` | Unset |
| `composioToolkits` | `COMPOSIO_TOOLKITS` | Unset |
| `composioUserToolkits` | `COMPOSIO_USER_TOOLKITS` | Unset |
| `composioApprovals` | `COMPOSIO_APPROVALS` | Unset, so the agent's own default `on` applies |
| `composioWorkspaceUserId` | `COMPOSIO_WORKSPACE_USER_ID` | Unset |

`githubAppPrivateKeySecretArn` optionally maps a separate raw Secrets Manager
secret to `GITHUB_APP_PRIVATE_KEY_BASE64` on the agent container.

Set `composioWorkspaceUserId` explicitly whenever you use `composioToolkits`.
Left unset, shared toolkits use `channelName`, which the stack forwards to the
agent as `INTELLIGENCE_CHANNEL_NAME`. The connect script an operator runs locally
reads the same variables from their local environment, so it must use the same
identity. If the two disagree, the link connects an account no deployed turn
ever looks up. Set `COMPOSIO_WORKSPACE_USER_ID` locally to the deployed
`composioWorkspaceUserId` to keep them aligned. See
[`../../setup.md`](../../setup.md#composio).

The AWS task fixes `AGENT_URL` to `http://127.0.0.1:8123/`, the runtime port to
`3000`, and the agent port to `8123` because both containers share one task.
Users running the images elsewhere can set `AGENT_URL`, `PORT`, `SERVER_HOST`,
and `SERVER_PORT` themselves. The image health checks follow the configured
ports.

The complete local environment contract remains in
[`../../setup.md`](../../setup.md#environment-contract).

## Deploy

Build and test the CDK project:

```bash
cd deployment/aws
pnpm build
pnpm test
pnpm exec cdk synth opentag-production -c vpcId=vpc-...
pnpm exec cdk diff opentag-production -c vpcId=vpc-...
```

Deploy a versioned public GHCR release:

```bash
pnpm exec cdk deploy opentag-production \
  -c vpcId=vpc-... \
  -c agentImage=ghcr.io/copilotkit/opentag-agent:v0.4.1 \
  -c runtimeImage=ghcr.io/copilotkit/opentag-runtime:v0.4.1 \
  --parameters opentag-production:OpenTagSecretArn=COMPLETE_OPENTAG_SECRET_ARN \
  --parameters opentag-production:DatadogApiKeySecretArn=COMPLETE_DATADOG_SECRET_ARN
```

Useful deployment settings:

| Context | Default | Purpose |
| --- | --- | --- |
| `appName` | `opentag` | Resource-name prefix |
| `environment` | `production` | Environment and Datadog tag |
| `serviceName` | `${appName}-${environment}` | ECS service name |
| `sharedCluster` | `false` | Put environment stacks on `${appName}-shared` |
| `enableDatadog` | `true` | Forward logs to Datadog |
| `datadogSite` | `datadoghq.com` | Datadog intake site |
| `logRetentionDays` | `30` | CloudWatch retention |
| `vpcId` | unset | Reuse a VPC instead of creating one |
| `agentImage` | unset | Full agent image URI |
| `runtimeImage` | unset | Full runtime image URI |
| `secretsKmsKeyArn` | unset | Customer-managed key for the OpenTag secret |

Without `agentImage` and `runtimeImage`, CDK builds local Docker assets. Without
`vpcId`, the standalone stack creates a VPC and NAT gateway.

For multiple environments, include `-c sharedCluster=true` on every command.
Deploying an environment also deploys its `${appName}-shared` dependency unless
`--exclusively` is used. Delete all environment stacks before deleting the
shared stack.

### Move an existing environment to a shared cluster

An ECS service cannot move between clusters in place. Also, two live runtimes
using the same Channel name race for deliveries. Use a one-time replacement:

1. Deploy `${appName}-shared` with `sharedCluster=true`.
2. Scale the old service to zero and verify its task has stopped.
3. Deploy the environment with `sharedCluster=true` and a new `serviceName`,
   such as `${appName}-${environment}-shared`.
4. Verify the Channel is online before removing any retained old resources.

The temporary service-name change lets CloudFormation create the replacement on
the shared cluster before deleting the old cluster. Do not run both services at
the same time.

To deploy before Datadog credentials are available:

```bash
pnpm exec cdk deploy opentag-production \
  -c vpcId=vpc-... \
  -c enableDatadog=false \
  --parameters opentag-production:OpenTagSecretArn=COMPLETE_OPENTAG_SECRET_ARN
```

## Public images

CopilotKit's maintainer-only release automation publishes:

- `ghcr.io/copilotkit/opentag-agent`
- `ghcr.io/copilotkit/opentag-runtime`

Merging a generated release PR publishes mutable `main`, immutable
`sha-<commit>`, `vX.Y.Z`, and `vX.Y` tags for the same manifests. Ordinary
merges do not publish images. New GHCR packages start private; after the first
publication, an organization owner must change both packages to public. No
registry credentials are needed after that.

Test the same images locally. The compose file resolves its build context and
its `env_file` relative to `deployment/`, so the `.env` it wants is the one at
the repository root — these paths are written from `deployment/aws`, where the
Deploy section above left you:

```bash
cp ../../.env.example ../../.env
docker compose -f ../docker-compose.yml up --build
```

## Verify

```bash
aws ecs describe-services \
  --cluster opentag-production \
  --services opentag-production
aws logs tail /ecs/opentag/production/agent --follow
aws logs tail /ecs/opentag/production/runtime --follow
```

In Datadog Logs, search for `application:opentag env:production`. The standard
`service:opentag` tag is also attached. The log-group name distinguishes the
agent from the runtime, and the application and service tags follow `appName`.

The runtime health endpoint does not prove that the managed Channel is online.
Check runtime logs for `setup_required`, then test a real Channel mention.

The service maintains one task during normal operation. During deployments, ECS
briefly starts a second task and waits for it to become healthy before stopping
the old task. This avoids intentionally taking OpenTag offline during replacement.
Multiple runtimes using the same Channel name can race to claim deliveries, so
the overlap is limited to the rollout. Agent graph checkpoints remain in memory,
so verify a real Channel mention after deployment.

CloudWatch Container Insights supplies cluster, service, task, CPU, memory,
network, and storage metrics. The Forwarder supplies logs to Datadog. This stack
does not install tracer libraries or a Datadog Agent sidecar, so Datadog APM
request traces are not available.
