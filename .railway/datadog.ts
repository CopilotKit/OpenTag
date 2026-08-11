import {
  github,
  service,
  type RailwayContext,
  type ServiceNode,
  type VariableValue,
} from "railway/iac";

// WARNING: Changing this to false makes Railway plan deletion of the
// Datadog Agent and Kite's DD_* variables in every environment subsequently applied.
export const DD_ENABLED = true;

const DATADOG_ENVIRONMENTS = {
  staging: "staging",
  community: "community",
  production: "prod",
} as const;

export type DatadogEnvironment =
  (typeof DATADOG_ENVIRONMENTS)[keyof typeof DATADOG_ENVIRONMENTS];

type EnvironmentFragment = Record<string, string | VariableValue>;

export interface DatadogTopology {
  resources: ServiceNode[];
  runtimeEnv: EnvironmentFragment;
  agentEnv: EnvironmentFragment;
}

export interface DatadogTopologyOptions {
  enabled?: boolean;
  repository: string;
  branch: string;
}

export function datadogEnvironmentFor(
  railwayEnvironment: string | undefined,
): DatadogEnvironment {
  // The standalone evaluator has no target environment. Staging keeps its
  // output deterministic; real plan/apply commands always supply the target.
  if (!railwayEnvironment) return "staging";

  const environment =
    DATADOG_ENVIRONMENTS[
      railwayEnvironment as keyof typeof DATADOG_ENVIRONMENTS
    ];
  if (!environment) {
    throw new Error(
      `Datadog is not configured for Railway environment "${railwayEnvironment}"`,
    );
  }
  return environment;
}

function applicationEnvironment(
  privateDomain: VariableValue,
  environment: DatadogEnvironment,
  component: "runtime" | "agent",
  syslogPort: 514 | 515,
): EnvironmentFragment {
  return {
    DD_TELEMETRY_ENABLED: "true",
    DD_AGENT_HOST: privateDomain,
    DD_AGENT_STATSD_PORT: "8125",
    DD_AGENT_SYSLOG_PORT: String(syslogPort),
    DD_ENV: environment,
    DD_SERVICE: "kite",
    DD_COMPONENT: component,
    DD_PLATFORM: "railway",
    DD_VERSION: "${{RAILWAY_DEPLOYMENT_ID}}",
  };
}

export function createDatadogTopology(
  context: RailwayContext,
  options: DatadogTopologyOptions,
): DatadogTopology {
  if (options.enabled === false) {
    return { resources: [], runtimeEnv: {}, agentEnv: {} };
  }

  const environment = datadogEnvironmentFor(
    context.environmentName ?? context.environment,
  );
  const datadogAgent = service("datadog-agent", {
    source: github(options.repository, {
      branch: options.branch,
      rootDirectory: ".railway/datadog-agent",
    }),
    build: { builder: "DOCKERFILE" },
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    env: {
      DD_API_KEY: context.shared.DD_API_KEY,
      DD_SITE: "datadoghq.com",
      DD_HOSTNAME: `kite-${environment}-datadog-agent`,
      DD_ENV: environment,
      DD_TAGS: "platform:railway",
      DD_LOGS_ENABLED: "true",
      DD_APM_ENABLED: "false",
      DD_DOGSTATSD_NON_LOCAL_TRAFFIC: "true",
      DD_BIND_HOST: "::",
    },
  });

  return {
    resources: [datadogAgent],
    runtimeEnv: applicationEnvironment(
      datadogAgent.env.RAILWAY_PRIVATE_DOMAIN,
      environment,
      "runtime",
      514,
    ),
    agentEnv: applicationEnvironment(
      datadogAgent.env.RAILWAY_PRIVATE_DOMAIN,
      environment,
      "agent",
      515,
    ),
  };
}
