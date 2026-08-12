# Kite GitHub delivery

Kite uses the public AWS CDK module with `appName=kite` and
`sharedCluster=true`. The three environment stacks share the `kite` ECS cluster
but deploy independently.

## Delivery model

- Every reviewed merge to `main` publishes `main` and `sha-<commit>` for both
  images, then deploys the exact `main` digests to staging.
- **Release / create PR** creates an editable version and release-notes PR.
- Merging `release/publish/vX.Y.Z` tags those same manifests, deploys staging,
  creates the GitHub Release and `container-images.json`, then opens independent
  prod and community approvals.
- **Deploy / released version** redeploys or rolls back any environment from a
  release manifest.
- **Deploy / shared infrastructure** is the only routine workflow that updates
  `kite-shared`.

The release PR uses CopilotKit's DevOps GitHub App (app ID `1108748`). Grant the
App access to OpenTag and make the existing `DEVOPS_BOT_PRIVATE_KEY`
organization secret available to this repository.

## One-time AWS trust

The AWS account must already contain GitHub's OIDC provider and a bootstrapped
CDK environment. Deploy the GitHub role once with an administrator SSO session:

```bash
cd deployment/aws
pnpm install --frozen-lockfile
pnpm exec cdk deploy kite-github --exclusively \
  -c appName=kite \
  -c environment=staging \
  -c sharedCluster=true \
  -c vpcId=vpc-... \
  -c agentImage=ghcr.io/copilotkit/opentag-agent:main \
  -c runtimeImage=ghcr.io/copilotkit/opentag-runtime:main \
  -c githubRepository=CopilotKit/OpenTag \
  -c githubOidcProviderArn=arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com
```

The output `GitHubDeploymentRoleArn` becomes `AWS_ROLE_ARN` in every GitHub
Environment. The role trusts only `kite-staging`, `kite-prod`,
`kite-community`, and `kite-infrastructure`, and can assume only the current
account and Region's CDK bootstrap roles.

## GitHub Environments

Create these environments:

| Environment | Deployment branch policy | Reviewers |
| --- | --- | --- |
| `kite-staging` | `main` | none |
| `kite-prod` | `main` | Admin-team members |
| `kite-community` | `main` | Admin-team members |
| `kite-infrastructure` | `main` | Admin-team members |

Each environment requires these variables:

| Variable | Meaning |
| --- | --- |
| `AWS_ROLE_ARN` | Output of `kite-github` |
| `AWS_REGION` | Deployment Region, currently `us-west-2` |
| `VPC_ID` | VPC containing private subnets with egress |
| `OPENTAG_SECRET_ARN` | Complete environment application-secret ARN |
| `DATADOG_API_KEY_SECRET_ARN` | Complete raw Datadog key-secret ARN |
| `INTELLIGENCE_CHANNEL_NAME` | Unique managed Channel name |
| `INTELLIGENCE_API_URL` | Environment Intelligence API |
| `INTELLIGENCE_GATEWAY_WS_URL` | Environment Intelligence gateway |
| `DATADOG_SITE` | Datadog site, normally `datadoghq.com` |
| `LOG_LEVEL` | Runtime log level, normally `warn` |

`kite-infrastructure` only needs `AWS_ROLE_ARN`, `AWS_REGION`, and `VPC_ID`.
Secret values stay in AWS Secrets Manager; GitHub stores only their ARNs.

Community's application secret must keep GitHub, PostHog, Linear, and Notion
credentials empty. Its only optional research credential is `TAVILY_API_KEY`.

## Repository protection

Protect `main` with one approving review, stale-approval dismissal, code-owner
review, and the required `verify` check. Block direct pushes, force pushes,
deletion, and administrator bypass. Workflow and AWS deployment files are owned
by `@CopilotKit/admin` in `.github/CODEOWNERS`.

GitHub currently requires environment reviewers to be configured as individual
users for this repository; the environments use the six current Admin-team
members, with one approval required and self-approval disabled. Keep this list
in sync when team membership changes. In each protected environment's settings,
also disable **Allow administrators to bypass configured protection rules**;
GitHub does not expose that environment setting through its repository API.

## Observability

Logs remain `stdout/stderr -> CloudWatch Logs -> Datadog Forwarder`, tagged
`service:kite`, `application:kite`, and `env:<environment>`. ECS Container
Insights supplies AWS infrastructure metrics. No Datadog Agent or application
tracer is installed, so this configuration does not provide Datadog APM traces.
