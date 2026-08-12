# Deploy on AWS

OpenTag runs as one private ECS Fargate service:

```text
one task
├── agent container   :8123
└── runtime container :3000 → http://127.0.0.1:8123/

stdout/stderr → CloudWatch Logs → Datadog Forwarder
```

There is no load balancer or public ingress. The runtime connects outbound to
CopilotKit Intelligence. The task runs in private subnets and needs outbound
internet access for Intelligence, OpenAI, GHCR, and any configured MCP service.

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
  "GITHUB_PERSONAL_ACCESS_TOKEN": "",
  "POSTHOG_PERSONAL_API_KEY": "",
  "LINEAR_API_KEY": "",
  "NOTION_MCP_AUTH_TOKEN": ""
}
```

Only `INTELLIGENCE_API_KEY` and `OPENAI_API_KEY` are required by the standard
deployment. Every JSON field must exist because ECS resolves each one when the
task starts; use an empty string for an unused integration.

Create a second Secrets Manager secret for Datadog. Its entire plaintext value
must be the raw Datadog API key, not JSON.

Changing the OpenTag secret requires a new ECS task. Never put secret values in
CDK context, command history, or source control.

### Non-secret application settings

These CDK context values become container environment variables:

| CDK context | Container variable | Default |
| --- | --- | --- |
| `agentDisplayName` | `AGENT_DISPLAY_NAME` on both containers | `OpenTag` |
| `channelName` | `INTELLIGENCE_CHANNEL_NAME` | `open-tag` |
| `intelligenceApiUrl` | `INTELLIGENCE_API_URL` | CopilotKit hosted API |
| `intelligenceGatewayWsUrl` | `INTELLIGENCE_GATEWAY_WS_URL` | CopilotKit hosted realtime gateway |
| `logLevel` | `LOG_LEVEL` | `warn` |
| `mermaidUrl` | `MERMAID_URL` | Built-in jsDelivr URL |
| `openAiModel` | `OPENAI_MODEL` | `gpt-5.5` |
| `openAiReasoningEffort` | `OPENAI_REASONING_EFFORT` | `low` |
| `openAiVerbosity` | `OPENAI_VERBOSITY` | `low` |
| `corsAllowOrigins` | `CORS_ALLOW_ORIGINS` | `*` |
| `githubMcpUrl` | `GITHUB_MCP_URL` | Hosted read-only GitHub MCP |
| `posthogMcpUrl` | `POSTHOG_MCP_URL` | Hosted read-only PostHog MCP |
| `linearMcpUrl` | `LINEAR_MCP_URL` | Hosted Linear MCP |
| `notionMcpUrl` | `NOTION_MCP_URL` | Unset |

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
pnpm synth -c vpcId=vpc-...
pnpm diff -c vpcId=vpc-...
```

Deploy a versioned public GHCR release:

```bash
pnpm deploy \
  -c vpcId=vpc-... \
  -c agentImage=ghcr.io/copilotkit/opentag-agent:v0.2.0 \
  -c runtimeImage=ghcr.io/copilotkit/opentag-runtime:v0.2.0 \
  --parameters opentag-production:OpenTagSecretArn=COMPLETE_OPENTAG_SECRET_ARN \
  --parameters opentag-production:DatadogApiKeySecretArn=COMPLETE_DATADOG_SECRET_ARN
```

Useful deployment settings:

| Context | Default | Purpose |
| --- | --- | --- |
| `appName` | `opentag` | Resource-name prefix |
| `environment` | `production` | Environment and Datadog tag |
| `enableDatadog` | `true` | Forward logs to Datadog |
| `datadogSite` | `datadoghq.com` | Datadog intake site |
| `logRetentionDays` | `30` | CloudWatch retention |
| `vpcId` | unset | Reuse a VPC instead of creating one |
| `agentImage` | unset | Full agent image URI |
| `runtimeImage` | unset | Full runtime image URI |
| `secretsKmsKeyArn` | unset | Customer-managed key for the OpenTag secret |

Without `agentImage` and `runtimeImage`, CDK builds local Docker assets. Without
`vpcId`, it creates a VPC and NAT gateway.

To deploy before Datadog credentials are available:

```bash
pnpm deploy \
  -c vpcId=vpc-... \
  -c enableDatadog=false \
  --parameters opentag-production:OpenTagSecretArn=COMPLETE_OPENTAG_SECRET_ARN
```

## Public images

GitHub Actions publishes:

- `ghcr.io/copilotkit/opentag-agent`
- `ghcr.io/copilotkit/opentag-runtime`

The workflow runs on `main`, `v*` tags, and manual dispatch. Version tags also
produce immutable `sha-...` tags. New GHCR packages start private; after the
first publication, an organization owner must change both packages to public.
No registry credentials are needed after that.

Test the same images locally:

```bash
cp .env.example .env
docker compose -f deployment/docker-compose.yml up --build
```

## Verify

```bash
aws ecs describe-services \
  --cluster opentag-production \
  --services opentag-production
aws logs tail /ecs/opentag/production/agent --follow
aws logs tail /ecs/opentag/production/runtime --follow
```

In Datadog Logs, search for `application:opentag env:production`. The log-group
name distinguishes the agent from the runtime.

The runtime health endpoint does not prove that the managed Channel is online.
Check runtime logs for `setup_required`, then test a real Channel mention.

The service deliberately runs one task. Multiple runtimes using the same
Channel name can race to claim deliveries, and the agent currently keeps graph
checkpoints in memory. Deployments therefore accept brief downtime while
replacing that single task.
