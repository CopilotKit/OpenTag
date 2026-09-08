import assert from "node:assert/strict";
import { test } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import { OpenTagInfrastructureStack } from "../lib/opentag-infrastructure-stack.js";
import { OpenTagStack } from "../lib/opentag-stack.js";

interface ContainerDefinition {
  Environment?: { Name: string; Value: string }[];
  Name: string;
  Secrets?: { Name: string; ValueFrom: unknown }[];
}

/** The one task definition's container called `name`. */
function containerDefinition(
  template: Template,
  name: string,
): ContainerDefinition {
  const taskDefinitions = Object.values(
    template.findResources("AWS::ECS::TaskDefinition"),
  ) as { Properties: { ContainerDefinitions: ContainerDefinition[] } }[];
  assert.equal(taskDefinitions.length, 1);
  const container = taskDefinitions[0]?.Properties.ContainerDefinitions.find(
    (candidate) => candidate.Name === name,
  );
  assert.ok(container, `no ${name} container in the task definition`);
  return container;
}

/** What a container's secret for `key` must resolve to: the shared secret's field, by reference. */
function secretsManagerField(key: string): unknown {
  return {
    "Fn::Join": ["", [{ Ref: "OpenTagSecretArn" }, `:${key}::`]],
  };
}

/** A container's secrets keyed by name, so the comparison ignores declaration order. */
function secretsByName(
  template: Template,
  name: string,
): Record<string, unknown> {
  return Object.fromEntries(
    (containerDefinition(template, name).Secrets ?? []).map(
      ({ Name, ValueFrom }) => [Name, ValueFrom],
    ),
  );
}

function expectedSecrets(keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, secretsManagerField(key)]));
}

/**
 * A container's environment as name to value, so a comparison reads both.
 *
 * The names-only version this replaces passed with the CORS default flipped to
 * a single origin, with `PLAYWRIGHT_BROWSERS_PATH` pointed at a directory the
 * image does not have, and with the runtime `PORT` moved off the port its own
 * health check probes. Every one of those is a container that boots into a
 * different deployment than the one the file describes.
 */
function environmentValues(
  template: Template,
  name: string,
): Record<string, string> {
  return Object.fromEntries(
    (containerDefinition(template, name).Environment ?? []).map(
      ({ Name, Value }) => [Name, Value],
    ),
  );
}

function stackWithContext(
  context: Record<string, string | boolean> = {},
  shared = false,
): OpenTagStack {
  const app = new cdk.App({
    context: {
      appName: "opentag",
      channelName: "open-tag",
      environment: "test",
      ...context,
    },
  });
  if (!shared) return new OpenTagStack(app, "test-stack");

  const infrastructure = new cdk.Stack(app, "test-infrastructure");
  const vpc = new ec2.Vpc(infrastructure, "Vpc", {
    maxAzs: 2,
    natGateways: 1,
  });
  const cluster = new ecs.Cluster(infrastructure, "Cluster", { vpc });
  return new OpenTagStack(app, "test-stack", { cluster });
}

test("creates one shared cluster independently of environment services", () => {
  const app = new cdk.App({ context: { appName: "kite" } });
  const stack = new OpenTagInfrastructureStack(app, "kite-shared", {
    appName: "kite",
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs("AWS::ECS::Cluster", 1);
  template.hasResourceProperties("AWS::ECS::Cluster", {
    ClusterName: "kite",
  });
});

test("keeps the standalone cluster as the public default", () => {
  const template = Template.fromStack(stackWithContext());

  template.resourceCountIs("AWS::ECS::Cluster", 1);
  template.hasResourceProperties("AWS::ECS::Cluster", {
    ClusterName: "opentag-test",
  });
});

test("accepts a shared cluster without creating another cluster", () => {
  const template = Template.fromStack(stackWithContext({}, true));

  template.resourceCountIs("AWS::ECS::Cluster", 0);
  template.resourceCountIs("AWS::ECS::Service", 1);
});

test("creates one private rolling environment service containing both containers", () => {
  const template = Template.fromStack(stackWithContext());

  template.resourceCountIs("AWS::ECS::Service", 1);
  template.resourceCountIs("AWS::ECS::TaskDefinition", 1);
  template.hasResourceProperties("AWS::ECS::Service", {
    DeploymentConfiguration: Match.objectLike({
      MaximumPercent: 200,
      MinimumHealthyPercent: 100,
    }),
    DesiredCount: 1,
    EnableExecuteCommand: true,
    NetworkConfiguration: {
      AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "DISABLED" }),
    },
  });
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Environment: Match.arrayWith([
          { Name: "AGENT_DISPLAY_NAME", Value: "OpenTag" },
          { Name: "OPENAI_MODEL", Value: "gpt-5.5" },
          { Name: "OPENAI_REASONING_EFFORT", Value: "low" },
          { Name: "OPENAI_VERBOSITY", Value: "low" },
        ]),
        Name: "agent",
      }),
      Match.objectLike({
        DependsOn: [{ Condition: "HEALTHY", ContainerName: "agent" }],
        Environment: Match.arrayWith([
          { Name: "AGENT_DISPLAY_NAME", Value: "OpenTag" },
          {
            Name: "AGENT_URL",
            Value: "http://127.0.0.1:8123/",
          },
        ]),
        Name: "runtime",
      }),
    ]),
    Cpu: "2048",
    Memory: "4096",
  });
});

/** The fields the documented secret has carried since the first release. */
const ESTABLISHED_AGENT_SECRETS = [
  "OPENAI_API_KEY",
  // Presented by the runtime; checked by the agent. Both containers read the
  // same field of the same secret or the runtime cannot reach the agent at
  // all. Already documented as a required field before this container read it,
  // so an existing secret carries it.
  "AGENT_AUTH_HEADER",
  "TAVILY_API_KEY",
  "DAYTONA_API_KEY",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "GITHUB_CODER_TOKEN",
  "POSTHOG_PERSONAL_API_KEY",
  "LINEAR_API_KEY",
  "NOTION_MCP_AUTH_TOKEN",
];

const ESTABLISHED_RUNTIME_SECRETS = [
  "INTELLIGENCE_API_KEY",
  // The other half of the pair above.
  "AGENT_AUTH_HEADER",
];

test("injects each container's secrets from the shared secret, and no others", () => {
  // Asserted as the whole set rather than one membership check at a time. The
  // suite already had a `assert.match(json, /OPENAI_API_KEY/)` style check, and
  // it passes just as happily with the entire Composio, shared-secret and Slack
  // wiring deleted — which is how that wiring shipped with no coverage at all.
  const template = Template.fromStack(stackWithContext());

  assert.deepEqual(
    secretsByName(template, "agent"),
    expectedSecrets(ESTABLISHED_AGENT_SECRETS),
  );
  assert.deepEqual(
    secretsByName(template, "runtime"),
    expectedSecrets(ESTABLISHED_RUNTIME_SECRETS),
  );
});

test("asks an upgrading deployment for no secret field it does not already have", () => {
  // ECS resolves every declared secret field when the task starts and fails the
  // task when one is missing — so a field added here unconditionally is not a
  // deploy-time error an operator can read, it is an existing deployment that
  // stops starting tasks after the upgrade. Nothing this release introduced may
  // appear until the context that gives it a purpose is set.
  //
  // The empty context is asserted above, as a complete set. What is asserted
  // here is every *other* way an upgrade can arrive without a connected
  // account: a Composio setting configured while the toolkit lists are still
  // empty. Each one of these is a context key the stack reads, and reading one
  // of them as "Composio is configured" adds `COMPOSIO_API_KEY` to a secret
  // that does not carry it yet — an upgrade whose tasks stop starting, with the
  // default-context assertion above still green.
  const settingsThatDoNotConfigureComposio: Record<string, string>[] = [
    { composioApprovals: "on" },
    { composioWorkspaceUserId: "acme" },
    // No context key reads this one yet (see `deployment/aws/README.md`), so
    // today it is inert. It is listed because the moment it is wired, the
    // question of whether it turns the integration on is exactly this test's.
    { composioAuthConfigs: "linear:ac_ExAmPle1" },
    { composioToolkits: "" },
    { composioUserToolkits: "" },
    {
      composioApprovals: "on",
      composioWorkspaceUserId: "acme",
      composioAuthConfigs: "linear:ac_ExAmPle1",
    },
  ];

  for (const context of settingsThatDoNotConfigureComposio) {
    const template = Template.fromStack(stackWithContext(context));
    const label = JSON.stringify(context);

    assert.deepEqual(
      secretsByName(template, "agent"),
      expectedSecrets(ESTABLISHED_AGENT_SECRETS),
      `agent secrets with ${label}`,
    );
    assert.deepEqual(
      secretsByName(template, "runtime"),
      expectedSecrets(ESTABLISHED_RUNTIME_SECRETS),
      `runtime secrets with ${label}`,
    );
  }
});

test("adds the Composio key to the agent once a toolkit is configured", () => {
  // The agent treats a key with no toolkits as unconfigured, so the toolkit
  // lists are what decides whether the key has anything to do. Both lists,
  // separately: either one on its own turns the integration on.
  const contexts: Record<string, string>[] = [
    { composioToolkits: "linear" },
    { composioUserToolkits: "gmail" },
  ];
  for (const context of contexts) {
    const template = Template.fromStack(stackWithContext(context));

    assert.deepEqual(
      secretsByName(template, "agent"),
      expectedSecrets([...ESTABLISHED_AGENT_SECRETS, "COMPOSIO_API_KEY"]),
      `agent secrets with ${JSON.stringify(context)}`,
    );
  }
});

test("puts no Slack token on the runtime, personal toolkits or not", () => {
  // The runtime once held the Slack pair so a personal connect link could reach
  // one named person, which the managed adapter could not do. It can now, and
  // holding the pair was actively harmful: a second Slack ingress answered
  // every message twice, and it needed Socket Mode, which stops Slack
  // delivering events to Intelligence at all. Both contexts are asserted as
  // complete secret sets, so re-adding either token fails here.
  // Annotated, because inferring a union of three differently-shaped object
  // literals is not a `Record<string, string>` and `pnpm build` (`tsc
  // --noEmit`) has been failing on this line. `pnpm test` strips types rather
  // than checking them, so the suite stayed green over a package that does not
  // compile.
  const contexts: Record<string, string>[] = [
    { composioToolkits: "linear" },
    { composioUserToolkits: "gmail" },
    { composioToolkits: "linear", composioUserToolkits: "gmail" },
  ];
  for (const context of contexts) {
    const template = Template.fromStack(stackWithContext(context));
    assert.deepEqual(
      secretsByName(template, "runtime"),
      expectedSecrets(ESTABLISHED_RUNTIME_SECRETS),
      `runtime secrets with ${JSON.stringify(context)}`,
    );
  }
});

test("never puts a Composio setting or credential on the internet-facing runtime", () => {
  // The runtime is the service the platform reaches. The Composio key mints
  // sessions against every connected account in the project, and nothing in the
  // runtime reads it.
  //
  // Environment as well as secrets, which is what the neighbouring assertions
  // cannot see: they compare secret sets, so a Composio setting added to the
  // runtime's plaintext environment — the toolkit lists, the shared identity,
  // the auth-config pins — passes all of them. Every Composio context key the
  // stack reads is set here, so anything that forwards one to the runtime under
  // any name fails.
  const template = Template.fromStack(
    stackWithContext({
      composioToolkits: "linear,jira",
      composioUserToolkits: "gmail",
      composioApprovals: "on",
      composioWorkspaceUserId: "acme",
      composioAuthConfigs: "linear:ac_ExAmPle1",
    }),
  );

  assert.deepEqual(
    Object.keys(secretsByName(template, "runtime")).filter((key) =>
      key.startsWith("COMPOSIO_"),
    ),
    [],
  );
  assert.deepEqual(
    Object.keys(environmentValues(template, "runtime")).filter((key) =>
      key.startsWith("COMPOSIO_"),
    ),
    [],
  );
  // Not under another name either: no runtime value carries the toolkit list or
  // the identity shared toolkits act as. A key-prefix filter cannot see a
  // Composio value forwarded as, say, `CHANNEL_OWNER`.
  const runtimeValues = Object.values(environmentValues(template, "runtime"));
  assert.deepEqual(
    runtimeValues.filter(
      (value) => value === "acme" || value.includes("linear,jira"),
    ),
    [],
  );

  // And the agent, which is the service that reads them, still has them — so
  // this test passing does not mean the wiring was removed from both.
  //
  // `COMPOSIO_AUTH_CONFIGS` is absent on purpose: it has no context key on this
  // stack, which `deployment/aws/README.md` says out loud. Listed as a complete
  // set so that closing that gap has to come here and say so, rather than
  // arriving as an unread key.
  assert.deepEqual(
    Object.keys(environmentValues(template, "agent"))
      .filter((key) => key.startsWith("COMPOSIO_"))
      .sort(),
    [
      "COMPOSIO_APPROVALS",
      "COMPOSIO_TOOLKITS",
      "COMPOSIO_USER_TOOLKITS",
      "COMPOSIO_WORKSPACE_USER_ID",
    ],
  );
});

test("leaves optional settings out of the container until context supplies them", () => {
  // The whole map, name and value. Two separate failures are in scope here: an
  // `optionalEnvironment` that stops being optional (`COMPOSIO_APPROVALS=""`
  // reaching the agent is not the same as it being absent, and every
  // `arrayWith` assertion in this file is blind to a key that should not
  // exist), and a default quietly changing under a name that still looks
  // right.
  const template = Template.fromStack(stackWithContext());

  assert.deepEqual(environmentValues(template, "agent"), {
    AGENT_DISPLAY_NAME: "OpenTag",
    // Wide open by default because the agent sits on a private subnet with no
    // ingress; narrowing it is the operator's call, not a silent edit here.
    CORS_ALLOW_ORIGINS: "*",
    DAYTONA_TTL_MINUTES: "60",
    GITHUB_MCP_URL: "https://api.githubcopilot.com/mcp/readonly",
    // The agent derives the default Composio workspace user id from this, so
    // an agent that never receives it runs the team's shared connections under
    // the literal `open-tag` whatever the channel is really called.
    INTELLIGENCE_CHANNEL_NAME: "open-tag",
    LINEAR_MCP_URL: "https://mcp.linear.app/mcp",
    OPENAI_MODEL: "gpt-5.5",
    OPENAI_REASONING_EFFORT: "low",
    OPENAI_VERBOSITY: "low",
    POSTHOG_MCP_URL: "https://mcp.posthog.com/mcp?mode=cli&readonly=true",
    SERVER_HOST: "0.0.0.0",
    // The port the agent's own health check probes, and the port the runtime
    // is told to reach it on.
    SERVER_PORT: "8123",
  });
  assert.deepEqual(environmentValues(template, "runtime"), {
    AGENT_DISPLAY_NAME: "OpenTag",
    AGENT_URL: "http://127.0.0.1:8123/",
    INTELLIGENCE_API_URL: "https://api.intelligence.copilotkit.ai",
    INTELLIGENCE_CHANNEL_NAME: "open-tag",
    INTELLIGENCE_GATEWAY_WS_URL: "wss://realtime.intelligence.copilotkit.ai",
    LOG_LEVEL: "warn",
    // Where the runtime image installs Chromium. Point it elsewhere and the
    // browser is missing at run time, not at build time.
    PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
    // The port the runtime's own health check probes.
    PORT: "3000",
  });
});

test("carries the configured channel name to both containers", () => {
  const template = Template.fromStack(stackWithContext({ channelName: "kite" }));

  assert.equal(
    environmentValues(template, "agent").INTELLIGENCE_CHANNEL_NAME,
    "kite",
  );
  assert.equal(
    environmentValues(template, "runtime").INTELLIGENCE_CHANNEL_NAME,
    "kite",
  );
});

test("allows supported non-secret environment overrides through context", () => {
  const template = Template.fromStack(
    stackWithContext({
      intelligenceApiUrl: "https://intelligence.example.test",
      agentDisplayName: "Kite",
      logLevel: "debug",
      mermaidUrl: "https://cdn.example.test/mermaid.js",
      daytonaSnapshot: "snap-test",
      daytonaTtlMinutes: "45",
      githubAppId: "12345",
      githubAppInstallationId: "67890",
      openAiModel: "gpt-test",
      openAiReasoningEffort: "high",
      openAiVerbosity: "medium",
      composioToolkits: "linear,jira",
      composioUserToolkits: "gmail",
      composioApprovals: "writes",
      composioWorkspaceUserId: "acme",
    }),
  );

  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Environment: Match.arrayWith([
          { Name: "AGENT_DISPLAY_NAME", Value: "Kite" },
          { Name: "DAYTONA_SNAPSHOT", Value: "snap-test" },
          { Name: "DAYTONA_TTL_MINUTES", Value: "45" },
          { Name: "GITHUB_APP_ID", Value: "12345" },
          { Name: "GITHUB_APP_INSTALLATION_ID", Value: "67890" },
          // Composio is read by the agent container, which is where the
          // toolkits live. Listed in the order the stack builds them, because
          // `arrayWith` matches in sequence and CDK preserves insertion order.
          { Name: "COMPOSIO_TOOLKITS", Value: "linear,jira" },
          { Name: "COMPOSIO_USER_TOOLKITS", Value: "gmail" },
          { Name: "COMPOSIO_APPROVALS", Value: "writes" },
          { Name: "COMPOSIO_WORKSPACE_USER_ID", Value: "acme" },
          { Name: "OPENAI_MODEL", Value: "gpt-test" },
          { Name: "OPENAI_REASONING_EFFORT", Value: "high" },
          { Name: "OPENAI_VERBOSITY", Value: "medium" },
        ]),
        Name: "agent",
      }),
      Match.objectLike({
        Environment: Match.arrayWith([
          { Name: "AGENT_DISPLAY_NAME", Value: "Kite" },
          {
            Name: "INTELLIGENCE_API_URL",
            Value: "https://intelligence.example.test",
          },
          { Name: "LOG_LEVEL", Value: "debug" },
          {
            Name: "MERMAID_URL",
            Value: "https://cdn.example.test/mermaid.js",
          },
        ]),
        Name: "runtime",
      }),
    ]),
  });
});

test("forwards both awslogs groups through the official Datadog Forwarder", () => {
  const template = Template.fromStack(stackWithContext());

  template.resourceCountIs("AWS::CloudFormation::Stack", 1);
  template.resourceCountIs("AWS::Logs::SubscriptionFilter", 2);
  template.resourceCountIs("AWS::Lambda::Permission", 2);
  template.hasResourceProperties("AWS::CloudFormation::Stack", {
    Parameters: Match.objectLike({
      DdApiKeySecretArn: { Ref: "DatadogApiKeySecretArn" },
      DdSite: "datadoghq.com",
      DdTags: "service:opentag,application:opentag,env:test",
      FunctionName: "opentag-test-datadog-forwarder",
    }),
    TemplateURL:
      "https://datadog-cloudformation-template.s3.amazonaws.com/aws/forwarder/5.4.11.yaml",
  });
  template.allResourcesProperties("AWS::Logs::SubscriptionFilter", {
    FilterPattern: "",
  });
  assert.doesNotMatch(
    JSON.stringify(template.toJSON()),
    /datadog-agent|ECS_FARGATE|DD_API_KEY/,
  );
});

test("injects application secrets without plaintext values", () => {
  const template = Template.fromStack(stackWithContext());
  const json = JSON.stringify(template.toJSON());

  assert.match(json, /OpenTagSecretArn/);
  assert.match(json, /DatadogApiKeySecretArn/);
  assert.match(json, /OPENAI_API_KEY/);
  assert.match(json, /DAYTONA_API_KEY/);
  assert.match(json, /GITHUB_CODER_TOKEN/);
  assert.match(json, /INTELLIGENCE_API_KEY/);
  assert.doesNotMatch(json, /:GITHUB_MCP_URL::/);
  assert.doesNotMatch(json, /:LINEAR_MCP_URL::/);
  assert.doesNotMatch(json, /:NOTION_MCP_URL::/);
  assert.doesNotMatch(json, /:POSTHOG_MCP_URL::/);
  assert.doesNotMatch(json, /sk-[A-Za-z0-9]/);
  assert.doesNotMatch(json, /cpk-[A-Za-z0-9]/);
});

test("optionally injects a separate GitHub App private-key secret", () => {
  const secretArn =
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:github-app-key-AbCdEf";
  const template = Template.fromStack(
    stackWithContext({
      githubAppId: "12345",
      githubAppInstallationId: "67890",
      githubAppPrivateKeySecretArn: secretArn,
    }),
  );
  const json = JSON.stringify(template.toJSON());

  assert.match(json, /GITHUB_APP_PRIVATE_KEY_BASE64/);
  assert.match(json, /github-app-key-AbCdEf/);
  assert.doesNotMatch(json, /BEGIN PRIVATE KEY/);
});

test("can disable Datadog before account credentials are available", () => {
  const template = Template.fromStack(
    stackWithContext({ enableDatadog: false }),
  );
  const json = JSON.stringify(template.toJSON());

  template.resourceCountIs("AWS::ECS::TaskDefinition", 1);
  template.resourceCountIs("AWS::Logs::SubscriptionFilter", 0);
  template.resourceCountIs("AWS::CloudFormation::Stack", 0);
  assert.doesNotMatch(json, /DatadogApiKeySecretArn|datadog-forwarder/);
});

test("can grant the execution role access to a customer-managed secrets key", () => {
  const keyArn = "arn:aws:kms:us-east-1:123456789012:key/example";
  const template = Template.fromStack(
    stackWithContext({ secretsKmsKeyArn: keyArn }),
  );

  template.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: "kms:Decrypt",
          Effect: "Allow",
          Resource: keyArn,
        }),
      ]),
    },
  });
});

test("grants pull access when using existing private ECR repositories", () => {
  const agentRepositoryArn =
    "arn:aws:ecr:us-east-1:123456789012:repository/opentag-agent";
  const runtimeRepositoryArn =
    "arn:aws:ecr:us-east-1:123456789012:repository/opentag-runtime";
  const template = Template.fromStack(
    stackWithContext({
      agentEcrRepositoryArn: agentRepositoryArn,
      imageTag: "v1.2.3",
      runtimeEcrRepositoryArn: runtimeRepositoryArn,
    }),
  );
  const json = JSON.stringify(template.toJSON());

  assert.match(json, /opentag-agent/);
  assert.match(json, /opentag-runtime/);
  assert.match(json, /ecr:BatchGetImage/);
  assert.match(json, /v1\.2\.3/);
});
