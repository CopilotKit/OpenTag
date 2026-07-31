/**
 * "Open session" footer support — the Slack-side half of remote sessions.
 *
 * A managed reply carries a link to the same conversation in the Intelligence
 * console, plus the model badge for the turn that produced it.
 *
 * Thread identity is NOT resolvable from the SDK today: an `IncomingTurn`
 * carries `deliveryId` and `turnId` but no canonical thread id, the
 * delivery transcript response is `{ messages, truncation }`, and
 * `GET /api/projects/:projectId/channels/:channelId/threads` is console-authed
 * rather than runtime-authed. Until the platform surfaces `canonicalThreadId`
 * on the delivery context, `sessionFooter` returns undefined and no footer is
 * posted — the link is omitted rather than guessed.
 */

/** Console location of a canonical Intelligence thread. */
export interface SessionLinkConfig {
  /** Console origin, e.g. `https://intelligence.copilotkit.ai`. */
  consoleUrl: string;
  orgSlug: string;
  projectSlug: string;
  /**
   * Path segment holding the conversation view. The console ships
   * `/threads/:threadId` today; a dedicated `/sessions/:threadId` view can be
   * selected without a code change once it exists.
   */
  pathSegment: string;
}

/**
 * Agent tuning defaults, mirrored from `agent/agent.py` so the badge reports
 * what the agent actually resolved. `session-link.test.ts` asserts these stay
 * in sync with the Python source — a divergence would make the badge lie.
 */
export const AGENT_MODEL_DEFAULT = "gpt-5.5";
export const AGENT_REASONING_DEFAULT = "low";

const DEFAULT_PATH_SEGMENT = "threads";

/** Reject anything that would land the user somewhere unintended. */
function parseConsoleUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid INTELLIGENCE_CONSOLE_URL: "${raw}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `Invalid INTELLIGENCE_CONSOLE_URL scheme: "${url.protocol}"`,
    );
  }
  if (raw.includes("${")) {
    throw new Error(
      `Unresolved template in INTELLIGENCE_CONSOLE_URL: "${raw}"`,
    );
  }
  return url.origin;
}

/** A slug reaches the URL path verbatim, so keep it to safe characters. */
function parseSlug(raw: string, name: string): string {
  const slug = raw.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
    throw new Error(`Invalid ${name}: "${raw}"`);
  }
  return slug;
}

/**
 * Read footer configuration. Returns undefined when the console location is not
 * fully configured, which disables the footer — a partial config is a
 * misconfiguration, not a reason to emit a broken link.
 */
export function readSessionLinkConfig(
  env: NodeJS.ProcessEnv = process.env,
): SessionLinkConfig | undefined {
  const consoleUrl = env.INTELLIGENCE_CONSOLE_URL;
  const orgSlug = env.INTELLIGENCE_ORG_SLUG;
  const projectSlug = env.INTELLIGENCE_PROJECT_SLUG;
  if (!consoleUrl || !orgSlug || !projectSlug) return undefined;
  if (env.SESSION_FOOTER === "off") return undefined;

  return {
    consoleUrl: parseConsoleUrl(consoleUrl),
    orgSlug: parseSlug(orgSlug, "INTELLIGENCE_ORG_SLUG"),
    projectSlug: parseSlug(projectSlug, "INTELLIGENCE_PROJECT_SLUG"),
    pathSegment: parseSlug(
      env.INTELLIGENCE_SESSION_PATH ?? DEFAULT_PATH_SEGMENT,
      "INTELLIGENCE_SESSION_PATH",
    ),
  };
}

/** Model badge for the turn, e.g. `gpt-5.5[low]`. */
export function agentModelBadge(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const model = env.OPENAI_MODEL?.trim() || AGENT_MODEL_DEFAULT;
  const reasoning =
    env.OPENAI_REASONING_EFFORT?.trim().toLowerCase() ||
    AGENT_REASONING_DEFAULT;
  return `${model}[${reasoning}]`;
}

/** Console URL for one canonical thread. */
export function buildSessionUrl(
  config: SessionLinkConfig,
  threadId: string,
): string {
  const id = threadId.trim();
  if (!id) throw new Error("buildSessionUrl requires a threadId");
  return `${config.consoleUrl}/o/${config.orgSlug}/${config.projectSlug}/${config.pathSegment}/${encodeURIComponent(id)}`;
}

/**
 * Footer text for a completed turn, or undefined when it should be omitted —
 * no config, or no canonical thread id to point at.
 */
export function sessionFooter(options: {
  config?: SessionLinkConfig;
  canonicalThreadId?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const { config, canonicalThreadId } = options;
  if (!config || !canonicalThreadId?.trim()) return undefined;

  const url = buildSessionUrl(config, canonicalThreadId);
  return `<${url}|Open session> · ${agentModelBadge(options.env)}`;
}
