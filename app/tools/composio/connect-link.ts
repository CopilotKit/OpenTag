/**
 * The decisions behind `scripts/composio-connect.ts`, kept out of the script so
 * they can be tested without a network.
 *
 * Shared toolkits have no in-Slack connect path — `connect_my_app` refuses them
 * on purpose, because a connection made by a clicker binds to the clicker's own
 * Composio `user_id` while every shared call resolves under
 * `workspaceUserId`. The operator script is the only correct path, and these
 * two functions are the whole of what it has to get right before it touches the
 * API.
 */
import type { ComposioConfig } from "./config.js";

/**
 * Structural subset of an `authConfigs.list()` item. Declared here rather than
 * imported so a test can build one, matching how `sessions.ts` treats the SDK.
 */
export interface AuthConfigSummary {
  id: string;
  toolkit?: { slug?: string };
  isComposioManaged?: boolean;
}

/** Either a decision, or the exact sentence the operator should read. */
export type Decision<T> = { ok: true; value: T } | { ok: false; message: string };

export const DASHBOARD_URL = "https://app.composio.dev";

/**
 * Is this a slug the script may mint a shared link for?
 *
 * A personal toolkit is refused rather than quietly handled: minting a
 * workspace-identity link for `gmail` when `gmail` is in
 * `COMPOSIO_USER_TOOLKITS` would connect one mailbox that every personal-scope
 * call then ignores, which is the same broken end state this script exists to
 * prevent.
 */
export function resolveSharedToolkit(
  config: Pick<ComposioConfig, "workspaceToolkits" | "userToolkits">,
  requested: string | undefined,
): Decision<string> {
  const slug = requested?.trim().toLowerCase();
  if (!slug) {
    return {
      ok: false,
      message:
        "Usage: pnpm composio:connect <toolkit>\n" +
        `Shared toolkits on this deployment: ${describeList(config.workspaceToolkits)}`,
    };
  }

  if (config.workspaceToolkits.includes(slug)) return { ok: true, value: slug };

  if (config.userToolkits.includes(slug)) {
    return {
      ok: false,
      message:
        `"${slug}" is a personal toolkit (COMPOSIO_USER_TOOLKITS). Each person connects ` +
        "their own from inside a thread — ask the agent for it and click the Connect " +
        "card. This script only connects shared toolkits.",
    };
  }

  return {
    ok: false,
    message:
      `"${slug}" is not in COMPOSIO_TOOLKITS. Add it there (and at ${DASHBOARD_URL}) ` +
      `and restart the runtime first.\n` +
      `Shared toolkits on this deployment: ${describeList(config.workspaceToolkits)}`,
  };
}

function describeList(slugs: string[]): string {
  return slugs.length > 0 ? slugs.join(", ") : "(none configured)";
}

/**
 * Which auth config the Connect Link should be minted against.
 *
 * A pin wins outright and is never cross-checked against the listing: pinning
 * is how an operator overrides a bad guess, so second-guessing it would defeat
 * the point. Otherwise exactly one candidate is required — with several, the
 * script asks for a pin instead of picking, because the wrong auth config
 * produces a connection that looks fine and grants the wrong scopes.
 */
export function selectAuthConfig(
  toolkit: string,
  pinned: string | undefined,
  candidates: AuthConfigSummary[],
): Decision<string> {
  const pin = pinned?.trim();
  if (pin) return { ok: true, value: pin };

  const matches = candidates.filter(
    (candidate) => candidate.toolkit?.slug?.trim().toLowerCase() === toolkit,
  );

  if (matches.length === 0) {
    return {
      ok: false,
      message:
        `No auth config exists for "${toolkit}". Add the toolkit at ${DASHBOARD_URL} — ` +
        "that is what creates its auth config — then run this again.",
    };
  }

  const only = matches[0];
  if (matches.length === 1 && only) return { ok: true, value: only.id };

  const listed = matches
    .map((match) => `  ${match.id}${match.isComposioManaged ? " (Composio-managed)" : ""}`)
    .join("\n");
  return {
    ok: false,
    message:
      `"${toolkit}" has ${matches.length} auth configs and none is pinned, so I will not ` +
      `guess which one to connect:\n${listed}\n` +
      `Pin one with COMPOSIO_AUTH_CONFIGS=${toolkit}:<id> and run this again.`,
  };
}
