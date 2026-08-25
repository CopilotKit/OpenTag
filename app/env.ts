export const DEFAULT_INTELLIGENCE_API_URL =
  "https://api.intelligence.copilotkit.ai";
export const DEFAULT_INTELLIGENCE_GATEWAY_WS_URL =
  "wss://realtime.intelligence.copilotkit.ai";
export const DEFAULT_INTELLIGENCE_CHANNEL_NAME = "open-tag";
export const DEFAULT_AGENT_DISPLAY_NAME = "OpenTag";

/**
 * Credentials for talking to Slack directly instead of through Intelligence.
 *
 * Intelligence normally owns the Slack edge and no Slack token belongs in this
 * repository. The one thing it cannot do is post a message only one person can
 * see — its adapter declares `supportsEphemeral: false` — and the Composio
 * connect flow needs exactly that, because a connect link binds whoever opens
 * it to the identity it was minted for.
 *
 * Setting these attaches a direct Slack adapter that does support it. Leaving
 * them unset keeps the managed path, which stays the default.
 */
export interface SlackDirectConfig {
  botToken: string;
  appToken: string;
}

export interface AppEnvironment {
  agentDisplayName: string;
  agentUrl: string;
  agentAuthHeader?: string;
  /** Present only when both Slack tokens are set; otherwise Intelligence delivers. */
  slackDirect?: SlackDirectConfig;
  intelligenceApiKey: string;
  intelligenceApiUrl: string;
  intelligenceGatewayWsUrl: string;
  learningContainerId?: string;
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

/** Both tokens or neither — one alone cannot start a Socket Mode adapter. */
export function readSlackDirect(
  env: NodeJS.ProcessEnv,
): SlackDirectConfig | undefined {
  const botToken = env.SLACK_BOT_TOKEN?.trim();
  const appToken = env.SLACK_APP_TOKEN?.trim();
  if (!botToken && !appToken) return undefined;
  if (!botToken || !appToken) {
    throw new Error(
      "Slack direct delivery needs both SLACK_BOT_TOKEN and SLACK_APP_TOKEN; " +
        `only ${botToken ? "SLACK_BOT_TOKEN" : "SLACK_APP_TOKEN"} is set`,
    );
  }
  return { botToken, appToken };
}

export function readEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AppEnvironment {
  return {
    agentDisplayName:
      env.AGENT_DISPLAY_NAME?.trim() || DEFAULT_AGENT_DISPLAY_NAME,
    agentUrl: required(env, "AGENT_URL"),
    agentAuthHeader: env.AGENT_AUTH_HEADER,
    slackDirect: readSlackDirect(env),
    intelligenceApiKey: required(env, "INTELLIGENCE_API_KEY"),
    intelligenceApiUrl:
      env.INTELLIGENCE_API_URL ?? DEFAULT_INTELLIGENCE_API_URL,
    intelligenceGatewayWsUrl:
      env.INTELLIGENCE_GATEWAY_WS_URL ??
      DEFAULT_INTELLIGENCE_GATEWAY_WS_URL,
    learningContainerId:
      env.INTELLIGENCE_LEARNING_CONTAINER_ID?.trim() || undefined,
    channelName:
      env.INTELLIGENCE_CHANNEL_NAME ?? DEFAULT_INTELLIGENCE_CHANNEL_NAME,
    port: parsePort(env.PORT),
  };
}
