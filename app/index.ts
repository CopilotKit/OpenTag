import { SanitizingHttpAgent } from "@copilotkit/channels/slack";
import { createOpenTagChannel } from "./channel.js";
import { readEnvironment, type AppEnvironment } from "./env.js";
import { createOpenTagRuntime } from "./runtime-host.js";

/**
 * One SDK agent per conversation, because Channels agents are stateful.
 *
 * Exported so the `Authorization` header can be asserted. It is the runtime's
 * half of the shared secret — the agent refuses traffic that arrives without it
 * — and once the agent is inside a Channel nothing in this process can see what
 * was put on the wire, so dropping the header here is otherwise invisible.
 */
export function createAgentFactory(environment: AppEnvironment) {
  // Truthiness alone decided this: `""` dropped the header with no sign, and
  // `" "` — or a value pasted with a trailing newline — went out as if it were
  // a secret. Both read as "configured" to whoever set them, and the agent
  // answers 401 to both. `readEnvironment` already normalizes blank to
  // undefined, so reaching this throw means a caller built an `AppEnvironment`
  // by hand with a value that cannot work.
  const secret = environment.agentAuthHeader?.trim();
  if (environment.agentAuthHeader !== undefined && !secret) {
    throw new Error(
      "AGENT_AUTH_HEADER is set but blank. Unset it to talk to an " +
        "unauthenticated agent, or set it to the secret the agent checks.",
    );
  }

  return (threadId: string) => {
    const instance = new SanitizingHttpAgent({
      url: environment.agentUrl,
      headers: secret ? { Authorization: secret } : undefined,
    });
    instance.threadId = threadId;
    return instance;
  };
}

export function createOpenTagApplication(
  environment: AppEnvironment = readEnvironment(),
) {
  const agent = createAgentFactory(environment);

  // A one-sided shared secret is invisible from either end: an agent that
  // requires one answers 401 to every request, and once the agent is inside a
  // Channel nothing in this process sees the response. This line at boot is the
  // only place the operator can notice which half is missing.
  if (!environment.agentAuthHeader) {
    console.warn(
      "[opentag] no AGENT_AUTH_HEADER is set, so agent requests go out " +
        "unauthenticated. If the agent has one set, every request will be " +
        "rejected with 401.",
    );
  }

  // Intelligence owns the Slack and Teams adapters for this logical Channel.
  const channels = [
    createOpenTagChannel(
      environment.channelName,
      agent,
      environment.agentDisplayName,
    ),
  ];
  const runtimeHost = createOpenTagRuntime({ environment, channels });

  return { channels, environment, ...runtimeHost };
}
