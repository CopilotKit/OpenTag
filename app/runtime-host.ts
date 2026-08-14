import type { Channel } from "@copilotkit/channels";
import {
  CopilotKitIntelligence,
  CopilotRuntime,
} from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";
import type { AppEnvironment } from "./env.js";

export const OPENTAG_SERVICE_USER = {
  id: "opentag-service",
  name: "OpenTag Channel Service",
} as const;

type ChannelEngine = NonNullable<
  Parameters<typeof createCopilotNodeListener>[0]["__channelEngine"]
>;

export function createOpenTagRuntime(options: {
  environment: AppEnvironment;
  channels: Channel[];
  /** @internal Test seam supplied by Runtime 1.66; production uses the gateway. */
  __channelEngine?: ChannelEngine;
}) {
  const intelligence = new CopilotKitIntelligence({
    apiUrl: options.environment.intelligenceApiUrl,
    wsUrl: options.environment.intelligenceGatewayWsUrl,
    apiKey: options.environment.intelligenceApiKey,
  });

  const runtime = new CopilotRuntime({
    agents: {},
    intelligence,
    identifyUser: () => OPENTAG_SERVICE_USER,
    channels: options.channels,
    ...(options.environment.learningContainerId
      ? {
          ɵlearning: {
            containerId: options.environment.learningContainerId,
          },
        }
      : {}),
  });

  const listener = createCopilotNodeListener({
    runtime,
    basePath: "/api/copilotkit",
    ...(options.__channelEngine
      ? { __channelEngine: options.__channelEngine }
      : {}),
  });

  return { intelligence, listener, runtime };
}
