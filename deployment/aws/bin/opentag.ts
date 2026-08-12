#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
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
const stackEnvironment = account && region
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
