/**
 * Composio configuration. Absent `COMPOSIO_API_KEY` returns null and the feature
 * is never constructed — absent, not disabled, so the agent has no tool it can
 * see but must not call.
 */

export type ApprovalMode = "off" | "destructive" | "writes";

const APPROVAL_MODES: ApprovalMode[] = ["off", "destructive", "writes"];

export interface ComposioConfig {
  apiKey: string;
  workspaceToolkits: string[];
  userToolkits: string[];
  approvals: ApprovalMode;
  workspaceUserId: string;
  /**
   * Rarely needed, and read only by `scripts/composio-connect.ts` — no runtime
   * path consumes it. `session.authorize()` takes no auth config id and
   * resolves one from the project itself, so a personal toolkit with several
   * cannot be pinned; this pins the choice when the operator connects a shared
   * toolkit.
   */
  authConfigs: Record<string, string>;
}

function slugList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Empty or whitespace-only means unset, matching `readEnvironment`'s
 * `?.trim() ||` idiom — `COMPOSIO_APPROVALS=` is routine in `.env` files and
 * compose passthrough, and must not take the runtime down at boot.
 */
function approvalMode(raw: string | undefined): ApprovalMode {
  const value = raw?.trim().toLowerCase() || "destructive";
  if (!APPROVAL_MODES.includes(value as ApprovalMode)) {
    throw new Error(
      `Invalid COMPOSIO_APPROVALS: "${raw}" — expected one of ${APPROVAL_MODES.join(", ")}`,
    );
  }
  return value as ApprovalMode;
}

/**
 * Parses `toolkit:auth_config_id` pairs. Toolkit keys are lowercased to match
 * the toolkit lists, but ids are preserved verbatim — real auth config ids are
 * mixed case (`ac_ExAmPle1-aB`), so lowercasing them would not resolve. Splits
 * on the first colon only, so an id containing one is not truncated.
 */
function authConfigMap(raw: string | undefined): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const entry of (raw ?? "").split(",")) {
    const separator = entry.indexOf(":");
    if (separator === -1) continue;
    const toolkit = entry.slice(0, separator).trim().toLowerCase();
    const id = entry.slice(separator + 1).trim();
    if (toolkit && id) pairs[toolkit] = id;
  }
  return pairs;
}

export function readComposioConfig(
  env: NodeJS.ProcessEnv,
  defaultUserId: string,
): ComposioConfig | null {
  const apiKey = env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) return null;

  const workspaceToolkits = slugList(env.COMPOSIO_TOOLKITS);
  const userToolkits = slugList(env.COMPOSIO_USER_TOOLKITS);
  if (workspaceToolkits.length === 0 && userToolkits.length === 0) return null;

  return {
    apiKey,
    workspaceToolkits,
    userToolkits,
    approvals: approvalMode(env.COMPOSIO_APPROVALS),
    workspaceUserId: env.COMPOSIO_WORKSPACE_USER_ID?.trim() || defaultUserId,
    authConfigs: authConfigMap(env.COMPOSIO_AUTH_CONFIGS),
  };
}
