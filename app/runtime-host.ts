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

export function createOpenTagRuntime(options: {
  environment: AppEnvironment;
  channels: Channel[];
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
  });

  const listener = createCopilotNodeListener({
    runtime,
    basePath: "/api/copilotkit",
  });

  return { intelligence, listener, runtime };
}
