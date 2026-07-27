export const DEFAULT_INTELLIGENCE_API_URL =
  "https://api.intelligence.copilotkit.ai";
export const DEFAULT_INTELLIGENCE_GATEWAY_WS_URL =
  "wss://realtime.intelligence.copilotkit.ai";
export const DEFAULT_INTELLIGENCE_CHANNEL_NAME = "opentag";

export interface AppEnvironment {
  agentUrl: string;
  agentAuthHeader?: string;
  intelligenceApiKey: string;
  intelligenceApiUrl: string;
  intelligenceGatewayWsUrl: string;
  channelName: string;
  port: number;
  slackBotToken?: string;
  slackAppToken?: string;
  teamsClientId?: string;
  teamsClientSecret?: string;
  teamsTenantId?: string;
  teamsPort: number;
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
    slackBotToken: env.SLACK_BOT_TOKEN,
    slackAppToken: env.SLACK_APP_TOKEN,
    teamsClientId: env.TEAMS_CLIENT_ID,
    teamsClientSecret: env.TEAMS_CLIENT_SECRET,
    teamsTenantId: env.TEAMS_TENANT_ID,
    teamsPort: parsePort(env.TEAMS_PORT, 3978, "TEAMS_PORT"),
  };
}
