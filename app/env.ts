export const DEFAULT_INTELLIGENCE_API_URL =
  "https://api.intelligence.copilotkit.ai";
export const DEFAULT_INTELLIGENCE_GATEWAY_WS_URL =
  "wss://realtime.intelligence.copilotkit.ai";
export const DEFAULT_INTELLIGENCE_CHANNEL_NAME = "open-tag";
export const DEFAULT_AGENT_DISPLAY_NAME = "OpenTag";

export interface AppEnvironment {
  agentDisplayName: string;
  agentUrl: string;
  agentAuthHeader?: string;
  intelligenceApiKey: string;
  intelligenceApiUrl: string;
  intelligenceGatewayWsUrl: string;
  learningContainerId?: string;
  channelName: string;
  port: number;
}

/** Trimmed, and blank counts as missing — a deploy UI's "unset" is an empty string. */
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
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
    agentDisplayName:
      env.AGENT_DISPLAY_NAME?.trim() || DEFAULT_AGENT_DISPLAY_NAME,
    agentUrl: required(env, "AGENT_URL"),
    // Trimmed like every neighbour, and blank means unset. This one value goes
    // out as an HTTP header: a trailing newline is not a legal header value and
    // makes `fetch` reject every request to the agent, and a whitespace-only
    // value reads as "a secret is configured" everywhere it is checked while
    // authorizing nothing.
    agentAuthHeader: env.AGENT_AUTH_HEADER?.trim() || undefined,
    intelligenceApiKey: required(env, "INTELLIGENCE_API_KEY"),
    // `||` rather than `??`: a variable declared and left empty is how a deploy
    // platform's UI represents "not set", and `??` let that empty string defeat
    // the default and become an empty URL.
    intelligenceApiUrl:
      env.INTELLIGENCE_API_URL?.trim() || DEFAULT_INTELLIGENCE_API_URL,
    intelligenceGatewayWsUrl:
      env.INTELLIGENCE_GATEWAY_WS_URL?.trim() ||
      DEFAULT_INTELLIGENCE_GATEWAY_WS_URL,
    learningContainerId:
      env.INTELLIGENCE_LEARNING_CONTAINER_ID?.trim() || undefined,
    channelName:
      env.INTELLIGENCE_CHANNEL_NAME?.trim() || DEFAULT_INTELLIGENCE_CHANNEL_NAME,
    // `?.trim() || undefined` like every neighbour, and for the same reason:
    // this module's rule is that a blank value counts as unset, because a
    // deploy platform's UI represents "not set" as a declared empty string.
    // `PORT` alone did not follow it — `parsePort("")` throws, so a `PORT` row
    // left empty in a deploy UI aborted boot rather than falling back to the
    // default every other variable here falls back to.
    port: parsePort(env.PORT?.trim() || undefined),
  };
}
