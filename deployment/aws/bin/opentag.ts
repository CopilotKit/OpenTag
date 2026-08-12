#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { GitHubDeploymentStack } from "../lib/github-deployment-stack.js";
import { OpenTagInfrastructureStack } from "../lib/opentag-infrastructure-stack.js";
import { OpenTagStack } from "../lib/opentag-stack.js";

function contextBoolean(app: cdk.App, key: string, fallback: boolean): boolean {
  const value = app.node.tryGetContext(key);
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return String(value).toLowerCase() === "true";
}

const app = new cdk.App();
const appName = app.node.tryGetContext("appName") ?? "opentag";
const environment = app.node.tryGetContext("environment") ?? "production";
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
const environmentAgnostic = contextBoolean(app, "environmentAgnostic", false);
const stackEnvironment = !environmentAgnostic && account && region
  ? { account, region }
  : undefined;
const sharedCluster = contextBoolean(app, "sharedCluster", false);

if (sharedCluster) {
  const infrastructure = new OpenTagInfrastructureStack(
    app,
    `${appName}-shared`,
    {
      appName,
      env: stackEnvironment,
      description: "Shared OpenTag VPC integration and ECS cluster",
    },
  );

  new OpenTagStack(app, `${appName}-${environment}`, {
    cluster: infrastructure.cluster,
    env: stackEnvironment,
    description: "OpenTag runtime and agent on ECS Fargate with Datadog log forwarding",
  });
} else {
  new OpenTagStack(app, `${appName}-${environment}`, {
    env: stackEnvironment,
    description: "OpenTag runtime and agent on ECS Fargate with Datadog log forwarding",
  });
}

const githubRepository = app.node.tryGetContext("githubRepository");
const githubOidcProviderArn = app.node.tryGetContext("githubOidcProviderArn");
if (githubRepository || githubOidcProviderArn) {
  if (
    typeof githubRepository !== "string" ||
    githubRepository.length === 0 ||
    typeof githubOidcProviderArn !== "string" ||
    githubOidcProviderArn.length === 0
  ) {
    throw new Error(
      "githubRepository and githubOidcProviderArn must be set together",
    );
  }
  new GitHubDeploymentStack(app, `${appName}-github`, {
    appName,
    bootstrapQualifier:
      app.node.tryGetContext("bootstrapQualifier") ?? "hnb659fds",
    env: stackEnvironment,
    githubEnvironments: [
      `${appName}-staging`,
      `${appName}-prod`,
      `${appName}-community`,
      `${appName}-infrastructure`,
    ],
    githubOidcProviderArn,
    githubRepository,
    description: "GitHub OIDC role for OpenTag AWS deployments",
  });
}
