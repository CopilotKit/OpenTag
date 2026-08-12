#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { OpenTagStack } from "../lib/opentag-stack.js";

const app = new cdk.App();
const appName = app.node.tryGetContext("appName") ?? "opentag";
const environment = app.node.tryGetContext("environment") ?? "production";
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;

new OpenTagStack(app, `${appName}-${environment}`, {
  env: account && region ? { account, region } : undefined,
  description: "OpenTag runtime and agent on ECS Fargate with Datadog log forwarding",
});
