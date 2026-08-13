# AWS deployment rationale

_Current as of 2026-08-12. The implementation is in
[`../deployment/aws`](../deployment/aws)._

## Why one Fargate task

OpenTag has two processes, but it does not need two AWS services. The selected
topology is one ECS Fargate service with one task containing the `agent` and
`runtime` containers.

Fargate tasks use `awsvpc` networking. Containers in the same task can
communicate over `localhost`, so the runtime uses
`http://127.0.0.1:8123/` for the agent. This removes the need for Service
Connect, Cloud Map, an internal load balancer, a second security group, and a
second independently deployed service
([AWS task networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-networking-awsvpc.html)).

The service has no inbound route. Managed Channel delivery enters CopilotKit
Intelligence, while the runtime opens an outbound websocket to Intelligence.
The task still needs outbound HTTPS access to Intelligence, OpenAI, and any
configured MCP/SaaS providers. Private subnets behind existing NAT gateways are
the simplest fit
([AWS ECS outbound networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/networking-outbound.html)).

The task starts at one copy. Two runtimes declaring the same Channel name can
race to claim deliveries, and the Python graph currently uses an in-memory
checkpointer. ECS deployments are serialized with `minimumHealthyPercent: 0`
and `maximumPercent: 100`, accepting brief deployment downtime.

## Logs without a Datadog container

Both application containers write stdout/stderr through ECS's built-in
`awslogs` driver into separate CloudWatch log groups. The stack deploys the
official Datadog Forwarder CloudFormation template and creates a subscription
filter from each group to its Lambda function.

Datadog documents the Forwarder as the serverless path for forwarding AWS
service logs, including CloudWatch Logs. Its template accepts a Secrets Manager
ARN for the API key and returns the Forwarder Lambda ARN, which lets CDK create
the subscriptions without placing Datadog credentials or software in either
OpenTag image
([Datadog Forwarder](https://docs.datadoghq.com/logs/guide/forwarder/)).

The template is pinned in code rather than following `latest.yaml`, so an
upstream release cannot silently change a deployment. Updating it should be an
explicit, tested dependency change.

This provides application logs, not in-process traces or custom metrics. The
Datadog AWS integration can separately collect account-level AWS and CloudWatch
metrics. Detailed application APM or custom DogStatsD metrics would require
instrumentation or an Agent, which is deliberately outside this simple log-only
deployment
([Datadog AWS integration](https://docs.datadoghq.com/integrations/amazon-web-services/),
[Datadog ECS Fargate](https://docs.datadoghq.com/integrations/aws-fargate/)).

## Images and secrets

CDK can build the two local Dockerfiles as assets for a developer deployment.
For releases, GitHub Actions publishes separate, public, versioned agent and
runtime images to GHCR. Keeping one process per image lets users run the pair
under Docker Compose, ECS, Kubernetes, or another container platform without a process supervisor
([CDK container assets](https://docs.aws.amazon.com/cdk/v2/guide/build-containers.html)).

Both containers in a task share one ECS task execution role, so one JSON
Secrets Manager secret supplies the OpenTag environment fields. ECS resolves
individual JSON keys at task startup; rotating a value requires starting a new
task. The Datadog API key remains in a separate raw-value secret read by the
Forwarder
([ECS Secrets Manager injection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html)).

## Account setup boundary

The first deployment needs:

1. IAM Identity Center/SSO access with enough permission to bootstrap CDK and
   create the Forwarder's IAM and Lambda resources.
2. `cdk bootstrap` once for the chosen account and Region.
3. An existing VPC with private subnets and outbound access, or permission for
   the stack to create a VPC and NAT gateway.
4. An OpenTag JSON secret and a raw Datadog API-key secret.
5. Two ECR repositories only when publishing stable user-facing images; CDK
   assets need no manually created repository.

CDK bootstrap creates deployment and asset-publishing resources, including IAM
roles, S3, ECR, and an SSM version parameter
([AWS CDK bootstrap](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)).

No EKS cluster, ALB, Route 53 record, ACM certificate, Cloud Map namespace, or
public subnet exposure is required for the selected managed-Channel path.
