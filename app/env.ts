export const DEFAULT_INTELLIGENCE_API_URL =
  "https://api.intelligence.copilotkit.ai";
export const DEFAULT_INTELLIGENCE_GATEWAY_WS_URL =
  "wss://realtime.intelligence.copilotkit.ai";
export const DEFAULT_INTELLIGENCE_CHANNEL_NAME = "open-tag";

export type LogComponent = "runtime" | "agent";

export type LogExporterEnvironment =
  | { exporter: "none" }
  | { exporter: "invalid"; detail: string }
  | {
      exporter: "syslog";
      host: string;
      port: number;
      component: LogComponent;
    };

export interface AppEnvironment {
  agentUrl: string;
  agentAuthHeader?: string;
  intelligenceApiKey: string;
  intelligenceApiUrl: string;
  intelligenceGatewayWsUrl: string;
  channelName: string;
  port: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function parsePort(
  raw: string | undefined,
  defaultPort = 3000,
  name = "PORT",
): number {
  if (raw === undefined) return defaultPort;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid ${name}: "${raw}"`);
  }
  return port;
}

export function readLogExporterEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): LogExporterEnvironment {
  const exporter = env.OPENTAG_LOG_EXPORTER ?? "none";
  if (exporter === "none") return { exporter };
  if (exporter !== "syslog") {
    return {
      exporter: "invalid",
      detail: `invalid OPENTAG_LOG_EXPORTER "${exporter}"`,
    };
  }

  const host = env.OPENTAG_LOG_EXPORTER_HOST?.trim();
  const rawPort = env.OPENTAG_LOG_EXPORTER_PORT;
  const port = Number(rawPort);
  const component = env.OPENTAG_LOG_COMPONENT;
  if (
    !host ||
    !rawPort ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    (component !== "runtime" && component !== "agent")
  ) {
    return {
      exporter: "invalid",
      detail:
        "syslog requires a host, a valid port, and component runtime|agent",
    };
  }

  return { exporter, host, port, component };
}

export function readEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AppEnvironment {
  return {
    agentUrl: required(env, "AGENT_URL"),
    agentAuthHeader: env.AGENT_AUTH_HEADER,
    intelligenceApiKey: required(env, "INTELLIGENCE_API_KEY"),
    intelligenceApiUrl:
      env.INTELLIGENCE_API_URL ?? DEFAULT_INTELLIGENCE_API_URL,
    intelligenceGatewayWsUrl:
      env.INTELLIGENCE_GATEWAY_WS_URL ??
      DEFAULT_INTELLIGENCE_GATEWAY_WS_URL,
    channelName:
      env.INTELLIGENCE_CHANNEL_NAME ?? DEFAULT_INTELLIGENCE_CHANNEL_NAME,
    port: parsePort(env.PORT),
  };
}
