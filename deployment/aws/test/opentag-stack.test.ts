import assert from "node:assert/strict";
import { test } from "node:test";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { OpenTagStack } from "../lib/opentag-stack.js";

function stackWithContext(
  context: Record<string, string | boolean> = {},
): OpenTagStack {
  const app = new cdk.App({
    context: {
      appName: "opentag",
      channelName: "open-tag",
      environment: "test",
      ...context,
    },
  });
  return new OpenTagStack(app, "test-stack");
}

test("creates one private singleton service containing both containers", () => {
  const template = Template.fromStack(stackWithContext());

  template.resourceCountIs("AWS::ECS::Service", 1);
  template.resourceCountIs("AWS::ECS::TaskDefinition", 1);
  template.hasResourceProperties("AWS::ECS::Service", {
    DeploymentConfiguration: Match.objectLike({
      MaximumPercent: 100,
      MinimumHealthyPercent: 0,
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

test("allows supported non-secret environment overrides through context", () => {
  const template = Template.fromStack(
    stackWithContext({
      intelligenceApiUrl: "https://intelligence.example.test",
      agentDisplayName: "Kite",
      logLevel: "debug",
      mermaidUrl: "https://cdn.example.test/mermaid.js",
      openAiModel: "gpt-test",
      openAiReasoningEffort: "high",
      openAiVerbosity: "medium",
    }),
  );

  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Environment: Match.arrayWith([
          { Name: "AGENT_DISPLAY_NAME", Value: "Kite" },
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
  assert.match(json, /INTELLIGENCE_API_KEY/);
  assert.doesNotMatch(json, /:GITHUB_MCP_URL::/);
  assert.doesNotMatch(json, /:LINEAR_MCP_URL::/);
  assert.doesNotMatch(json, /:NOTION_MCP_URL::/);
  assert.doesNotMatch(json, /:POSTHOG_MCP_URL::/);
  assert.doesNotMatch(json, /sk-[A-Za-z0-9]/);
  assert.doesNotMatch(json, /cpk-[A-Za-z0-9]/);
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
