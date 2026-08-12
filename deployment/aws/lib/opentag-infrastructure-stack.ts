import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import type { Construct } from "constructs";

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

    const configuredVpcId = this.node.tryGetContext("vpcId");
    const vpc = configuredVpcId
      ? ec2.Vpc.fromLookup(this, "Vpc", { vpcId: String(configuredVpcId) })
      : new ec2.Vpc(this, "Vpc", {
          maxAzs: 2,
          natGateways: 1,
          subnetConfiguration: [
            {
              cidrMask: 24,
              name: "public",
              subnetType: ec2.SubnetType.PUBLIC,
            },
            {
              cidrMask: 24,
              name: "application",
              subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
          ],
        });

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
