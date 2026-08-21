/**
 * Which Composio identities a turn acts as, and the misconfigurations worth
 * saying out loud at startup.
 */
import type { ComposioConfig } from "./config.js";

export interface ResolvedScope {
  userId: string;
  toolkits: string[];
}

/** Apps whose data is one person's, not a team's. */
const PERSONAL_TOOLKITS = new Set(["gmail", "googlecalendar", "outlook", "googledrive"]);

/** Composio toolkit slug -> the env var enabling the same app over MCP. */
const MCP_EQUIVALENTS: Record<string, string> = {
  linear: "LINEAR_API_KEY",
  notion: "NOTION_MCP_AUTH_TOKEN",
  posthog: "POSTHOG_PERSONAL_API_KEY",
  github: "GITHUB_PERSONAL_ACCESS_TOKEN",
};

/**
 * Every applicable scope, not the first match.
 *
 * A toolkit named in both lists resolves to the personal scope only: routing by
 * slug is ambiguous when a slug lives in two sessions, and picking whichever
 * loaded first would attribute an issue to a person or to a shared account
 * depending on restart order.
 *
 * That de-duplication is unconditional — it does not depend on the personal
 * scope actually resolving. Naming a toolkit in `userToolkits` is the operator
 * saying it must run as the person, so an unidentified turn gets no access to
 * it rather than falling through to the shared account.
 */
export function resolveScopes(
  config: ComposioConfig,
  actor: { id?: string } | undefined,
): ResolvedScope[] {
  const scopes: ResolvedScope[] = [];

  /**
   * The single place a personal identity is admitted. Blank is not an identity:
   * `{ id: "" }` and `{}` are as unverified as no actor at all, and matching
   * `readEnvironment`'s `?.trim() ||` idiom keeps a whitespace-only id out too.
   */
  const actorId = actor?.id?.trim() || undefined;

  const workspaceToolkits = config.workspaceToolkits.filter(
    (slug) => !config.userToolkits.includes(slug),
  );

  if (workspaceToolkits.length > 0) {
    scopes.push({ userId: config.workspaceUserId, toolkits: workspaceToolkits });
  }
  if (actorId !== undefined && config.userToolkits.length > 0) {
    scopes.push({ userId: actorId, toolkits: config.userToolkits });
  }
  return scopes;
}

export function startupWarnings(config: ComposioConfig, env: NodeJS.ProcessEnv): string[] {
  const warnings: string[] = [];

  for (const slug of new Set(config.workspaceToolkits)) {
    if (config.userToolkits.includes(slug)) {
      warnings.push(
        `[composio] "${slug}" is in both COMPOSIO_TOOLKITS and COMPOSIO_USER_TOOLKITS. ` +
          "Using each person's own account; the shared one is ignored for this app.",
      );
      continue;
    }
    if (PERSONAL_TOOLKITS.has(slug)) {
      warnings.push(
        `[composio] "${slug}" is in COMPOSIO_TOOLKITS (shared). Every Slack user will act ` +
          "through ONE account. If you meant each person to use their own, move it to " +
          "COMPOSIO_USER_TOOLKITS.",
      );
    }
  }

  for (const slug of new Set([...config.workspaceToolkits, ...config.userToolkits])) {
    const mcpVar = MCP_EQUIVALENTS[slug];
    if (!mcpVar || !env[mcpVar]?.trim()) continue;
    warnings.push(
      `[composio] "${slug}" is configured twice: via Composio and via ${mcpVar}. ` +
        "The agent will see two sets of tools for it and may pick either, so whether " +
        "an action asks for approval will vary. Remove one to make this predictable.",
    );
  }

  return warnings;
}
