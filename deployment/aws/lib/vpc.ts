import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";

export function resolveVpc(scope: Construct): ec2.IVpc {
  const configuredVpcId = scope.node.tryGetContext("vpcId");
  if (configuredVpcId) {
    return ec2.Vpc.fromLookup(scope, "Vpc", {
      vpcId: String(configuredVpcId),
    });
  }

  return new ec2.Vpc(scope, "Vpc", {
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
}
