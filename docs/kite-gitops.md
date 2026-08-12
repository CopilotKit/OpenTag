# Kite GitHub delivery

Kite uses the public AWS CDK module with `appName=kite` and
`sharedCluster=true`. The three environment stacks share the `kite` ECS cluster
but deploy independently.

## Common paths

- Change: PR → verify → merge → publish `main` and `sha-<commit>` → deploy the
  exact digests to staging.
- Release: **Release / create PR** → review and merge → publish `vX.Y.Z` and
  `vX.Y` → create the GitHub Release → approve prod and community independently.
- Rollback: **Deploy / released version** → select environment and `vX.Y.Z` →
  deploy the digests recorded in that release.
- Infrastructure: **Deploy / shared infrastructure** → approval → update only
  `kite-shared`.

The release PR uses CopilotKit's DevOps GitHub App (app ID `1108748`). Grant the
App access to OpenTag and make the existing `DEVOPS_BOT_PRIVATE_KEY`
organization secret available to this repository.

## One-time AWS trust

The AWS account owner bootstraps GitHub OIDC and its deployment role outside
this repository. OpenTag's CDK application deliberately does not create or
manage account-level GitHub trust.

The only workflow interface is the resulting role ARN. Store it as
`AWS_ROLE_ARN` in each Kite GitHub Environment. The role must trust this
repository's four `kite-*` environments and be able to use the account and
Region's CDK bootstrap roles.

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
| `AWS_ROLE_ARN` | Manually supplied GitHub OIDC deployment-role ARN |
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
