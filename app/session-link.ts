/**
 * "Open session" footer support — the Slack-side half of remote sessions.
 *
 * A managed reply carries a link to the same conversation in the Intelligence
 * console, plus the model badge for the turn that produced it.
 *
 * On the managed Intelligence path the canonical thread id arrives as the
 * turn's `conversationKey` — the delivery adapter sets
 * `conversationKey: delivery.canonicalThreadId` from the prepared delivery.
 * Local adapters instead put a provider-shaped key there (Slack's
 * `${teamId}:${channel}:${threadTs}`), which is not a thread id and must never
 * become a link, so the key is accepted only when it has canonical shape.
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

/**
 * Canonical Intelligence thread ids are UUIDs. A provider conversation key
 * (`${teamId}:${channel}:${threadTs}`) is not one, so requiring the shape keeps
 * a local-adapter key from being rendered as a console link.
 */
const CANONICAL_THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The canonical thread id carried by a managed turn's conversation key, or
 * undefined when this conversation is not managed.
 */
export function canonicalThreadIdFrom(
  conversationKey: string | undefined,
): string | undefined {
  const key = conversationKey?.trim();
  return key && CANONICAL_THREAD_ID.test(key) ? key : undefined;
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
 * no config, or a conversation with no canonical thread behind it.
 */
export function sessionFooter(options: {
  config?: SessionLinkConfig;
  conversationKey?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const { config } = options;
  const threadId = canonicalThreadIdFrom(options.conversationKey);
  if (!config || !threadId) return undefined;

  const url = buildSessionUrl(config, threadId);
  return `<${url}|Open session> · ${agentModelBadge(options.env)}`;
}
