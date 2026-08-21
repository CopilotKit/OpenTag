/**
 * The Composio feature's single entry point: every tool the agent should see
 * for this deployment, or none at all.
 *
 * Unconfigured means absent, not disabled. Without `COMPOSIO_API_KEY` this
 * returns `[]` before anything is constructed — no SDK client, no session
 * cache, and no tool the model can see but must not call.
 *
 * Called once while the Channel is built, so the SDK client and the startup
 * warnings happen once per process rather than once per turn. Only `resolve`
 * runs per turn, and it is the one thing that depends on who is speaking.
 */
import type { ChannelTool, ChannelToolContext } from "@copilotkit/channels";
import { composioClient } from "./client.js";
import { readComposioConfig } from "./config.js";
import { createConnectTool } from "./connect-tool.js";
import { createRunTool } from "./run-tool.js";
import { resolveScopes, startupWarnings } from "./scopes.js";
import { createSearchTool } from "./search-tool.js";
import { getSession, type CachedSession } from "./sessions.js";

export function composioTools(
  env: NodeJS.ProcessEnv,
  defaultUserId: string,
): ChannelTool[] {
  const config = readComposioConfig(env, defaultUserId);
  if (!config) return [];

  for (const warning of startupWarnings(config, env)) console.warn(warning);

  const sdk = composioClient(config);

  /**
   * The identities this turn may act as. Resolved per turn because the personal
   * scope depends on the actor, and cached per identity by `getSession`, so a
   * warm turn costs nothing.
   */
  const resolve = async (ctx: ChannelToolContext): Promise<CachedSession[]> => {
    const scopes = resolveScopes(config, ctx.actor);

    // `allSettled`, not `all`. A rejected `sessions.create` under `all` loses
    // every other scope with it — one unreachable personal account would take
    // the team's Linear down for that turn — and rejects `resolve` itself, so
    // the turn runs with no Composio tools and no explanation anywhere.
    // `search-tool.ts` already draws this line one layer down.
    const settled = await Promise.allSettled(
      scopes.map((scope) => getSession(sdk, scope.userId, scope.toolkits)),
    );

    const sessions: CachedSession[] = [];
    settled.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") {
        sessions.push(outcome.value);
        return;
      }
      // The scope, so an operator can tell whose account went missing, and the
      // provider's reason, so they can tell why. Neither carries a credential:
      // the api key never leaves `client.ts`, and unlike a connect link a
      // `sessions.create` failure is not itself a bearer capability.
      const scope = scopes[index]!;
      const reason =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      console.warn(
        `[composio] no session for user=${scope.userId} ` +
          `toolkits=${scope.toolkits.join(",")} — running the turn without it: ${reason}`,
      );
    });

    return sessions;
  };

  const tools = [
    createSearchTool(resolve),
    createRunTool(resolve, config.approvals, config.workspaceUserId),
  ];

  // Connecting is a personal act. With no personal toolkits there is nothing a
  // user could connect, and offering the tool would only invite the agent to
  // tell someone to connect a shared account it does not own.
  if (config.userToolkits.length > 0) {
    tools.push(createConnectTool(config));
  }

  return tools;
}
