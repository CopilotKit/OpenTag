import {
  github,
  service,
  volume,
  type RailwayContext,
  type ResourceNode,
  type VariableValue,
} from "railway/iac";

// WARNING: Applying with this set to false deletes only the Datadog Agent and
// its cursor volume. Kite's runtime and agent services are never modified.
export const DD_ENABLED = true;

const DATADOG_ENVIRONMENTS = {
  staging: "staging",
  community: "community",
  production: "prod",
} as const;

export type DatadogEnvironment =
  (typeof DATADOG_ENVIRONMENTS)[keyof typeof DATADOG_ENVIRONMENTS];

export interface DatadogTopology {
  resources: ResourceNode[];
}

export interface DatadogTopologyOptions {
  enabled?: boolean;
  repository: string;
  branch: string;
  targets: {
    runtimeServiceId: string | VariableValue;
    agentServiceId: string | VariableValue;
  };
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

export function createDatadogTopology(
  context: RailwayContext,
  options: DatadogTopologyOptions,
): DatadogTopology {
  if (options.enabled === false) return { resources: [] };

  const environment = datadogEnvironmentFor(
    context.environmentName ?? context.environment,
  );
  const cursorVolume = volume("datadog-agent-state", { sizeMB: 100 });
  const datadogAgent = service("datadog-agent", {
    source: github(options.repository, {
      branch: options.branch,
      rootDirectory: ".railway/datadog-agent",
    }),
    build: { builder: "DOCKERFILE" },
    deploy: {
      numReplicas: 1,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 5,
    },
    volumeMounts: {
      "/opt/datadog-agent/run": cursorVolume,
    },
    env: {
      DD_API_KEY: context.shared.DD_API_KEY,
      RAILWAY_LOGS_TOKEN: context.shared.RAILWAY_LOGS_TOKEN,
      RAILWAY_RUNTIME_SERVICE_ID: options.targets.runtimeServiceId,
      RAILWAY_AGENT_SERVICE_ID: options.targets.agentServiceId,
      DD_SITE: "datadoghq.com",
      DD_HOSTNAME: `kite-${environment}-railway-logs`,
      DD_ENV: environment,
      DD_SERVICE: "kite",
      DD_TAGS: `service:kite env:${environment} platform:railway`,
      DD_LOGS_ENABLED: "true",
      DD_LOGS_CONFIG_FORCE_USE_HTTP: "true",
      DD_LOGS_CONFIG_USE_COMPRESSION: "true",
      DD_APM_ENABLED: "false",
      DD_ENABLE_PAYLOADS_EVENTS: "false",
      DD_ENABLE_PAYLOADS_SERIES: "false",
      DD_ENABLE_PAYLOADS_SERVICE_CHECKS: "false",
      DD_ENABLE_PAYLOADS_SKETCHES: "false",
      DD_PROCESS_AGENT_ENABLED: "false",
      DD_PROCESS_CONFIG_CONTAINER_COLLECTION_ENABLED: "false",
      DD_PROCESS_CONFIG_PROCESS_COLLECTION_ENABLED: "false",
      DD_REMOTE_CONFIGURATION_ENABLED: "false",
    },
  });

  return { resources: [datadogAgent, cursorVolume] };
}
