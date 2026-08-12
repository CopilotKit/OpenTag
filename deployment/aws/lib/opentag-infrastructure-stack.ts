import * as cdk from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import type { Construct } from "constructs";
import { resolveVpc } from "./vpc.js";

export interface OpenTagInfrastructureStackProps extends cdk.StackProps {
  appName: string;
}

export class OpenTagInfrastructureStack extends cdk.Stack {
  readonly cluster: ecs.ICluster;

  constructor(
    scope: Construct,
    id: string,
    props: OpenTagInfrastructureStackProps,
  ) {
    const { appName, ...stackProps } = props;
    super(scope, id, stackProps);

    const vpc = resolveVpc(this);

    this.cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: appName,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      vpc,
    });

    cdk.Tags.of(this).add("Application", appName);
    cdk.Tags.of(this).add("ManagedBy", "aws-cdk");

    new cdk.CfnOutput(this, "ClusterName", {
      value: this.cluster.clusterName,
    });
  }
}
