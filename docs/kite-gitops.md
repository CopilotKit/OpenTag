# Kite GitHub delivery

Kite uses the public AWS CDK module with `appName=kite` and
`sharedCluster=true`. The three environment stacks share the `kite` ECS cluster
but deploy independently.

## Common paths

- Change: PR → CI → merge. No image is published or deployed.
- Release: run **Release** → review and merge its PR → publish `main`,
  `sha-<commit>`, `vX.Y.Z`, and `vX.Y` → update staging's ECS task definition →
  approve prod and community independently.
- Rollback: run **Deploy** → select environment and `vX.Y.Z` →
  deploy the digests recorded in that release.

The release PR uses CopilotKit's DevOps GitHub App (app ID `1108748`). Grant the
App access to OpenTag and make the existing `DEVOPS_BOT_PRIVATE_KEY`
organization secret available to this repository.

## One-time AWS trust

The AWS account owner bootstraps GitHub OIDC and its deployment role outside
this repository. OpenTag's CDK application deliberately does not create or
manage account-level GitHub trust.

The only workflow interface is the resulting role ARN. Store it as
`AWS_ROLE_ARN` in each Kite GitHub Environment. The role trusts this
repository's three `kite-*` environments and can only read task definitions,
register a revision, and update the three Kite ECS services.

## GitHub Environments

Create these environments:

| Environment | Deployment branch policy | Reviewers |
| --- | --- | --- |
| `kite-staging` | `main` | none |
| `kite-prod` | `main` | Admin-team members |
| `kite-community` | `main` | Admin-team members |

Each environment requires these variables:

| Variable | Meaning |
| --- | --- |
| `AWS_ROLE_ARN` | Manually supplied GitHub OIDC deployment-role ARN |
| `AWS_REGION` | Deployment Region, currently `us-west-2` |

The workflow copies the current ECS task definition and changes only the
`agent` and `runtime` image digests. Environment variables, secrets, IAM roles,
CPU, memory, networking, logs, and every other task setting remain unchanged.
Configuration changes are separate, intentional CDK deployments.

Community's application secret must keep GitHub, PostHog, Linear, and Notion
credentials empty. Its only optional research credential is `TAVILY_API_KEY`.

## Repository protection

Protect `main` with one approving review, stale-approval dismissal, code-owner
review, and the required `verify` check. Block direct pushes, force pushes,
deletion, and administrator bypass. Workflow and AWS deployment files are owned
by `@CopilotKit/engineering` in `.github/CODEOWNERS`.

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
