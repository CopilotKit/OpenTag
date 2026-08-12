import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

export interface GitHubDeploymentStackProps extends cdk.StackProps {
  appName: string;
  bootstrapQualifier?: string;
  githubEnvironments: string[];
  githubOidcProviderArn: string;
  githubRepository: string;
}

export class GitHubDeploymentStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: GitHubDeploymentStackProps,
  ) {
    const {
      appName,
      bootstrapQualifier = "hnb659fds",
      githubEnvironments,
      githubOidcProviderArn,
      githubRepository,
      ...stackProps
    } = props;
    super(scope, id, stackProps);

    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      "GitHubOidcProvider",
      githubOidcProviderArn,
    );
    const subjects = githubEnvironments.map(
      (environment) =>
        `repo:${githubRepository}:environment:${environment}`,
    );
    const principal = new iam.WebIdentityPrincipal(
      provider.openIdConnectProviderArn,
      {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        },
        StringLike: {
          "token.actions.githubusercontent.com:sub": subjects,
        },
      },
    );
    const role = new iam.Role(this, "GitHubDeploymentRole", {
      assumedBy: principal,
      description: `GitHub Actions CDK deployment role for ${githubRepository}`,
      maxSessionDuration: cdk.Duration.hours(1),
      roleName: `${appName}-github-deploy`,
    });

    const account = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:iam::${account}:role/cdk-${bootstrapQualifier}-deploy-role-${account}-${region}`,
          `arn:${cdk.Aws.PARTITION}:iam::${account}:role/cdk-${bootstrapQualifier}-file-publishing-role-${account}-${region}`,
          `arn:${cdk.Aws.PARTITION}:iam::${account}:role/cdk-${bootstrapQualifier}-image-publishing-role-${account}-${region}`,
          `arn:${cdk.Aws.PARTITION}:iam::${account}:role/cdk-${bootstrapQualifier}-lookup-role-${account}-${region}`,
        ],
      }),
    );

    cdk.Tags.of(this).add("Application", appName);
    cdk.Tags.of(this).add("ManagedBy", "aws-cdk");

    new cdk.CfnOutput(this, "GitHubDeploymentRoleArn", {
      value: role.roleArn,
    });
  }
}
