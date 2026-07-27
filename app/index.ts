import { SanitizingHttpAgent } from "@copilotkit/channels/slack";
import { createOpenTagChannel } from "./channel.js";
import { readEnvironment, type AppEnvironment } from "./env.js";
import { createOpenTagRuntime } from "./runtime-host.js";

export function createOpenTagApplication(
  environment: AppEnvironment = readEnvironment(),
) {
  // Channels agents are stateful, so each conversation gets its own SDK agent.
  const agent = (threadId: string) => {
    const instance = new SanitizingHttpAgent({
      url: environment.agentUrl,
      headers: environment.agentAuthHeader
        ? { Authorization: environment.agentAuthHeader }
        : undefined,
    });
    instance.threadId = threadId;
    return instance;
  };

  // Managed providers are declared per Channel. Intelligence owns the Slack and
  // Teams credentials and routes each provider to its matching declaration.
  const channels = [
    createOpenTagChannel(environment.channelName, "slack", agent),
    createOpenTagChannel(`${environment.channelName}-teams`, "teams", agent),
  ];
  const runtimeHost = createOpenTagRuntime({ environment, channels });

  return { channels, environment, ...runtimeHost };
}
