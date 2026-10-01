import type { RequestListener } from "node:http";
import type { Channel } from "@copilotkit/channels";
import {
  CopilotKitIntelligence,
  CopilotRuntime,
} from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";
import {
  createArcadeAgentClient,
  handleArcadeBrowserRequest,
} from "./arcade-browser-routes.js";
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

  const copilotListener = createCopilotNodeListener({
    runtime,
    basePath: "/api/copilotkit",
    ...(options.__channelEngine
      ? { __channelEngine: options.__channelEngine }
      : {}),
  });

  const arcadeClient = createArcadeAgentClient({
    agentUrl: options.environment.agentUrl,
    agentAuthHeader: options.environment.agentAuthHeader,
  });

  /**
   * The Arcade connect pages sit in front of the Copilot listener.
   *
   * Wrapped rather than mounted as a second server: this process serves one
   * listener, and two pages do not justify another. They are the only part of
   * this deployment the public internet needs to reach, and they live here
   * rather than on the agent so that the process holding the provider keys
   * keeps no public entry point — see `arcade-browser-routes.ts`.
   *
   * Everything this does not recognise falls through untouched.
   */
  const wrapped: RequestListener = (request, response) => {
    void handleArcadeBrowserRequest(request, response, arcadeClient).then(
      (handled) => {
        if (!handled) copilotListener(request, response);
      },
      (error) => {
        // A throw here would take the process down on a request anybody can
        // make. The page says nothing; the log says what happened.
        console.error("[opentag] the connect page failed:", error);
        if (!response.headersSent) {
          response.statusCode = 500;
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
        }
        response.end("This connection could not be completed just now.");
      },
    );
  };

  // The Copilot listener carries the Channel control on itself, and the server
  // waits on it to know the Channel is online. Wrapping a function drops its
  // properties, so it is carried across deliberately: without this the process
  // starts, serves, and never activates — which looks like a dead Channel
  // rather than like a missing property.
  const listener = Object.assign(wrapped, copilotListener) as typeof copilotListener;

  return { intelligence, listener, runtime };
}
