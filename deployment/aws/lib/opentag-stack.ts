import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as destinations from "aws-cdk-lib/aws-logs-destinations";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { resolveVpc } from "./vpc.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, "../../..");

const DATADOG_FORWARDER_TEMPLATE_URL =
  "https://datadog-cloudformation-template.s3.amazonaws.com/aws/forwarder/5.4.11.yaml";

const AGENT_SECRET_KEYS = [
  "OPENAI_API_KEY",
  "TAVILY_API_KEY",
  "DAYTONA_API_KEY",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "GITHUB_CODER_TOKEN",
  "POSTHOG_PERSONAL_API_KEY",
  "LINEAR_API_KEY",
  "NOTION_MCP_AUTH_TOKEN",
] as const;

const RUNTIME_SECRET_KEYS = [
  "INTELLIGENCE_API_KEY",
  "AGENT_AUTH_HEADER",
] as const;

function contextString(
  scope: Construct,
  key: string,
  fallback: string,
): string {
  const value = scope.node.tryGetContext(key);
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function contextBoolean(
  scope: Construct,
  key: string,
  fallback: boolean,
): boolean {
  const value = scope.node.tryGetContext(key);
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
}

function contextNumber(
  scope: Construct,
  key: string,
  fallback: number,
): number {
  const value = Number(scope.node.tryGetContext(key) ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`CDK context ${key} must be a positive integer`);
  }
  return value;
}

function secretFields(
  secret: secretsmanager.ISecret,
  keys: readonly string[],
): Record<string, ecs.Secret> {
  return Object.fromEntries(
    keys.map((key) => [key, ecs.Secret.fromSecretsManager(secret, key)]),
  );
}

function optionalEnvironment(
  name: string,
  value: string,
): Record<string, string> {
  return value.length > 0 ? { [name]: value } : {};
}

export interface OpenTagStackProps extends cdk.StackProps {
  cluster?: ecs.ICluster;
}

export class OpenTagStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OpenTagStackProps = {}) {
    const { cluster, ...stackProps } = props;
    super(scope, id, stackProps);

    const appName = contextString(this, "appName", "opentag");
    const environmentName = contextString(
      this,
      "environment",
      "production",
    );
    const serviceName = contextString(
      this,
      "serviceName",
      `${appName}-${environmentName}`,
    );
    const channelName = contextString(this, "channelName", "open-tag");
    const agentDisplayName = contextString(
      this,
      "agentDisplayName",
      "OpenTag",
    );
    const intelligenceApiUrl = contextString(
      this,
      "intelligenceApiUrl",
      "https://api.intelligence.copilotkit.ai",
    );
    const intelligenceGatewayWsUrl = contextString(
      this,
      "intelligenceGatewayWsUrl",
      "wss://realtime.intelligence.copilotkit.ai",
    );
    const logLevel = contextString(this, "logLevel", "warn");
    const mermaidUrl = contextString(this, "mermaidUrl", "");
    const openAiModel = contextString(this, "openAiModel", "gpt-5.5");
    const openAiReasoningEffort = contextString(
      this,
      "openAiReasoningEffort",
      "low",
    );
    const openAiVerbosity = contextString(
      this,
      "openAiVerbosity",
      "low",
    );
    const daytonaSnapshot = contextString(this, "daytonaSnapshot", "");
    const daytonaTtlMinutes = contextNumber(
      this,
      "daytonaTtlMinutes",
      60,
    );
    const githubAppId = contextString(this, "githubAppId", "");
    const githubAppInstallationId = contextString(
      this,
      "githubAppInstallationId",
      "",
    );
    const githubAppPrivateKeySecretArn = contextString(
      this,
      "githubAppPrivateKeySecretArn",
      "",
    );
    const enableDatadog = contextBoolean(this, "enableDatadog", true);
    const datadogSite = contextString(
      this,
      "datadogSite",
      "datadoghq.com",
    );
    const logRetentionDays = contextNumber(this, "logRetentionDays", 30);
    const secretsKmsKeyArn = this.node.tryGetContext("secretsKmsKeyArn");
    const secretsKmsKey =
      typeof secretsKmsKeyArn === "string" && secretsKmsKeyArn.length > 0
        ? kms.Key.fromKeyArn(this, "SecretsKmsKey", secretsKmsKeyArn)
        : undefined;

    if (
      !Object.values(logs.RetentionDays).includes(
        logRetentionDays as logs.RetentionDays,
      )
    ) {
      throw new Error(
        `CDK context logRetentionDays=${logRetentionDays} is not supported by CloudWatch Logs`,
      );
    }

    const applicationSecretArn = new cdk.CfnParameter(
      this,
      "OpenTagSecretArn",
      {
        noEcho: true,
        type: "String",
        description:
          "Complete ARN of the JSON Secrets Manager secret documented in deployment/aws/README.md",
      },
    );
    const datadogSecretArn = enableDatadog
      ? new cdk.CfnParameter(this, "DatadogApiKeySecretArn", {
          noEcho: true,
          type: "String",
          description:
            "Complete ARN of a Secrets Manager secret whose entire value is the Datadog API key",
        })
      : undefined;

    const applicationSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "OpenTagSecret",
      applicationSecretArn.valueAsString,
    );
    const githubAppPrivateKeySecret = githubAppPrivateKeySecretArn
      ? secretsmanager.Secret.fromSecretCompleteArn(
          this,
          "GitHubAppPrivateKeySecret",
          githubAppPrivateKeySecretArn,
        )
      : undefined;

    const serviceCluster = cluster ?? this.createStandaloneCluster(
      appName,
      environmentName,
    );

    const resolvedRetention = logRetentionDays as logs.RetentionDays;
    const agentLogGroup = new logs.LogGroup(this, "AgentLogGroup", {
      logGroupName: `/ecs/${appName}/${environmentName}/agent`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: resolvedRetention,
    });
    const runtimeLogGroup = new logs.LogGroup(this, "RuntimeLogGroup", {
      logGroupName: `/ecs/${appName}/${environmentName}/runtime`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: resolvedRetention,
    });

    const task = new ecs.FargateTaskDefinition(this, "Task", {
      cpu: 2048,
      memoryLimitMiB: 4096,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const agentContainer = task.addContainer("AgentContainer", {
      containerName: "agent",
      cpu: 1024,
      environment: {
        AGENT_DISPLAY_NAME: agentDisplayName,
        CORS_ALLOW_ORIGINS: contextString(
          this,
          "corsAllowOrigins",
          "*",
        ),
        ...optionalEnvironment("DAYTONA_SNAPSHOT", daytonaSnapshot),
        DAYTONA_TTL_MINUTES: String(daytonaTtlMinutes),
        ...optionalEnvironment("GITHUB_APP_ID", githubAppId),
        ...optionalEnvironment(
          "GITHUB_APP_INSTALLATION_ID",
          githubAppInstallationId,
        ),
        GITHUB_MCP_URL: contextString(
          this,
          "githubMcpUrl",
          "https://api.githubcopilot.com/mcp/readonly",
        ),
        LINEAR_MCP_URL: contextString(
          this,
          "linearMcpUrl",
          "https://mcp.linear.app/mcp",
        ),
        ...optionalEnvironment(
          "NOTION_MCP_URL",
          contextString(this, "notionMcpUrl", ""),
        ),
        ...optionalEnvironment(
          "PARALLEL_MCP_URL",
          contextString(this, "parallelMcpUrl", ""),
        ),
        OPENAI_MODEL: openAiModel,
        OPENAI_REASONING_EFFORT: openAiReasoningEffort,
        OPENAI_VERBOSITY: openAiVerbosity,
        POSTHOG_MCP_URL: contextString(
          this,
          "posthogMcpUrl",
          "https://mcp.posthog.com/mcp?mode=cli&readonly=true",
        ),
        SERVER_HOST: "0.0.0.0",
        SERVER_PORT: "8123",
      },
      healthCheck: {
        command: [
          "CMD-SHELL",
          "python -c \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8123/health', timeout=3)\" || exit 1",
        ],
        interval: cdk.Duration.seconds(30),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
      },
      image: this.containerImage(
        "agentImage",
        "agentEcrRepositoryArn",
        "deployment/docker/agent.Dockerfile",
      ),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: agentLogGroup,
        streamPrefix: "agent",
      }),
      memoryReservationMiB: 1792,
      secrets: {
        ...secretFields(applicationSecret, AGENT_SECRET_KEYS),
        ...(githubAppPrivateKeySecret
          ? {
              GITHUB_APP_PRIVATE_KEY_BASE64:
                ecs.Secret.fromSecretsManager(githubAppPrivateKeySecret),
            }
          : {}),
      },
    });
    agentContainer.addPortMappings({
      appProtocol: ecs.AppProtocol.http,
      containerPort: 8123,
      name: "agent",
    });

    const runtimeContainer = task.addContainer("RuntimeContainer", {
      containerName: "runtime",
      cpu: 1024,
      environment: {
        AGENT_DISPLAY_NAME: agentDisplayName,
        AGENT_URL: "http://127.0.0.1:8123/",
        INTELLIGENCE_API_URL: intelligenceApiUrl,
        INTELLIGENCE_CHANNEL_NAME: channelName,
        INTELLIGENCE_GATEWAY_WS_URL: intelligenceGatewayWsUrl,
        LOG_LEVEL: logLevel,
        ...optionalEnvironment("MERMAID_URL", mermaidUrl),
        PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
        PORT: "3000",
      },
      healthCheck: {
        command: [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:3000/api/copilotkit/info').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\" || exit 1",
        ],
        interval: cdk.Duration.seconds(30),
        retries: 3,
        startPeriod: cdk.Duration.seconds(45),
        timeout: cdk.Duration.seconds(5),
      },
      image: this.containerImage(
        "runtimeImage",
        "runtimeEcrRepositoryArn",
        "deployment/docker/runtime.Dockerfile",
      ),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: runtimeLogGroup,
        streamPrefix: "runtime",
      }),
      memoryReservationMiB: 1792,
      secrets: secretFields(applicationSecret, RUNTIME_SECRET_KEYS),
    });
    runtimeContainer.addPortMappings({
      appProtocol: ecs.AppProtocol.http,
      containerPort: 3000,
      name: "runtime",
    });
    runtimeContainer.addContainerDependencies({
      condition: ecs.ContainerDependencyCondition.HEALTHY,
      container: agentContainer,
    });

    const executionRole = task.obtainExecutionRole();
    applicationSecret.grantRead(executionRole);
    githubAppPrivateKeySecret?.grantRead(executionRole);
    if (secretsKmsKey) {
      secretsKmsKey.grantDecrypt(executionRole);
    }

    const securityGroup = new ec2.SecurityGroup(this, "ServiceSecurityGroup", {
      allowAllOutbound: true,
      description: "OpenTag outbound traffic only",
      vpc: serviceCluster.vpc,
    });
    const service = new ecs.FargateService(this, "Service", {
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      cluster: serviceCluster,
      desiredCount: 1,
      enableECSManagedTags: true,
      enableExecuteCommand: true,
      maxHealthyPercent: 200,
      minHealthyPercent: 100,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      securityGroups: [securityGroup],
      serviceName,
      taskDefinition: task,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    if (enableDatadog && datadogSecretArn) {
      this.addDatadogForwarder(
        datadogSecretArn.valueAsString,
        datadogSite,
        appName,
        environmentName,
        [agentLogGroup, runtimeLogGroup],
      );
    }

    cdk.Tags.of(this).add("Application", appName);
    cdk.Tags.of(this).add("Environment", environmentName);
    cdk.Tags.of(this).add("ManagedBy", "aws-cdk");

    new cdk.CfnOutput(this, "ClusterName", {
      value: serviceCluster.clusterName,
    });
    new cdk.CfnOutput(this, "ServiceName", { value: service.serviceName });
    new cdk.CfnOutput(this, "RuntimeToAgentUrl", {
      value: "http://127.0.0.1:8123/",
    });
    new cdk.CfnOutput(this, "RuntimeLogGroupName", {
      value: runtimeLogGroup.logGroupName,
    });
    new cdk.CfnOutput(this, "AgentLogGroupName", {
      value: agentLogGroup.logGroupName,
    });
  }

  private createStandaloneCluster(
    appName: string,
    environmentName: string,
  ): ecs.ICluster {
    const vpc = resolveVpc(this);

    return new ecs.Cluster(this, "Cluster", {
      clusterName: `${appName}-${environmentName}`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      vpc,
    });
  }

  private addDatadogForwarder(
    apiKeySecretArn: string,
    site: string,
    appName: string,
    environmentName: string,
    logGroups: logs.ILogGroup[],
  ): void {
    const forwarderStack = new cdk.CfnStack(this, "DatadogForwarder", {
      parameters: {
        DdApiKeySecretArn: apiKeySecretArn,
        DdSite: site,
        DdTags: `service:${appName},application:${appName},env:${environmentName}`,
        FunctionName: `${appName}-${environmentName}-datadog-forwarder`,
      },
      templateUrl: DATADOG_FORWARDER_TEMPLATE_URL,
    });
    const forwarder = lambda.Function.fromFunctionAttributes(
      this,
      "DatadogForwarderFunction",
      {
        functionArn: forwarderStack
          .getAtt("Outputs.DatadogForwarderArn")
          .toString(),
        sameEnvironment: true,
      },
    );

    logGroups.forEach((logGroup, index) => {
      const subscription = new logs.SubscriptionFilter(
        this,
        `DatadogLogSubscription${index + 1}`,
        {
          destination: new destinations.LambdaDestination(forwarder),
          filterPattern: logs.FilterPattern.allEvents(),
          logGroup,
        },
      );
      subscription.node.addDependency(forwarderStack);
    });

    new cdk.CfnOutput(this, "DatadogForwarderArn", {
      value: forwarder.functionArn,
    });
  }

  private containerImage(
    contextKey: "agentImage" | "runtimeImage",
    repositoryArnContextKey:
      | "agentEcrRepositoryArn"
      | "runtimeEcrRepositoryArn",
    dockerfile: string,
  ): ecs.ContainerImage {
    const registryImage = this.node.tryGetContext(contextKey);
    const repositoryArn = this.node.tryGetContext(repositoryArnContextKey);
    if (registryImage && repositoryArn) {
      throw new Error(
        `Set only one of ${contextKey} and ${repositoryArnContextKey}`,
      );
    }
    if (typeof repositoryArn === "string" && repositoryArn.length > 0) {
      const repository = ecr.Repository.fromRepositoryArn(
        this,
        `${contextKey}Repository`,
        repositoryArn,
      );
      return ecs.ContainerImage.fromEcrRepository(
        repository,
        contextString(this, "imageTag", "latest"),
      );
    }
    if (typeof registryImage === "string" && registryImage.length > 0) {
      return ecs.ContainerImage.fromRegistry(registryImage);
    }
    return ecs.ContainerImage.fromAsset(repositoryRoot, {
      file: dockerfile,
      platform: ecrAssets.Platform.LINUX_AMD64,
    });
  }
}
