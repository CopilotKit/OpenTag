/**
 * Connect a shared team toolkit — the operator-side half of the Composio
 * integration.
 *
 * Composio scopes every connected account to a `user_id`, and shared-scope
 * calls resolve under `COMPOSIO_WORKSPACE_USER_ID` (defaulting to
 * `INTELLIGENCE_CHANNEL_NAME`). The dashboard's "connect my account" button
 * binds to the dashboard's own user id, which OpenTag never passes, so an
 * account created that way is invisible to the bot forever. This script mints a
 * Connect Link against the workspace identity instead, which is the only way a
 * shared toolkit becomes usable.
 *
 * Personal toolkits are not connected here: those go through the Connect card
 * in a thread, minted per person.
 *
 * Runs standalone — no Slack runtime, no agent, no server.
 *
 *   pnpm composio:connect linear
 */
import "dotenv/config";
import { Composio } from "@composio/core";
import { DEFAULT_INTELLIGENCE_CHANNEL_NAME } from "../app/env.js";
import { readComposioConfig } from "../app/tools/composio/config.js";
import {
  resolveSharedToolkit,
  selectAuthConfig,
  type AuthConfigSummary,
} from "../app/tools/composio/connect-link.js";

/** Every exit from here is a failure with a fix in it. */
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * Walk `authConfigs.list()` to the end.
 *
 * The listing is paginated and a project with many toolkits overflows one page,
 * so stopping at page one would report "no auth config" for a toolkit that has
 * one — the single most misleading thing this script could say.
 */
async function listAuthConfigs(
  composio: Composio,
  toolkit: string,
): Promise<AuthConfigSummary[]> {
  const collected: AuthConfigSummary[] = [];
  let cursor: string | undefined;

  do {
    const page = await composio.authConfigs.list({ toolkit, ...(cursor ? { cursor } : {}) });
    collected.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  return collected;
}

async function main(): Promise<void> {
  // Same reader the runtime uses, so the defaults and validation an operator is
  // debugging are the ones that actually apply at boot.
  const config = readComposioConfig(
    process.env,
    process.env.INTELLIGENCE_CHANNEL_NAME ?? DEFAULT_INTELLIGENCE_CHANNEL_NAME,
  );
  if (!config) {
    fail(
      "Composio is not configured. Set COMPOSIO_API_KEY and at least one of " +
        "COMPOSIO_TOOLKITS / COMPOSIO_USER_TOOLKITS in your .env, then run this again.",
    );
  }

  const toolkit = resolveSharedToolkit(config, process.argv[2]);
  if (!toolkit.ok) fail(toolkit.message);
  const slug = toolkit.value;

  const composio = new Composio({
    apiKey: config.apiKey,
    allowTracking: false,
    disableVersionCheck: true,
  });

  let candidates: AuthConfigSummary[];
  try {
    candidates = await listAuthConfigs(composio, slug);
  } catch (error) {
    // The message may name the endpoint but never the key — the SDK does not
    // echo it, and nothing here adds it.
    fail(
      `Could not list auth configs for "${slug}": ${describe(error)}\n` +
        "Check COMPOSIO_API_KEY is valid for the project you expect.",
    );
  }

  const authConfig = selectAuthConfig(slug, config.authConfigs[slug], candidates);
  if (!authConfig.ok) fail(authConfig.message);

  let redirectUrl: string | undefined;
  try {
    const request = await composio.connectedAccounts.link(config.workspaceUserId, authConfig.value);
    redirectUrl = request.redirectUrl ?? undefined;
  } catch (error) {
    fail(`Could not create a Connect Link for "${slug}": ${describe(error)}`);
  }

  if (!redirectUrl) {
    fail(
      `Composio returned no redirect URL for "${slug}" (auth config ${authConfig.value}). ` +
        `That auth config may not use a browser flow — check it at https://app.composio.dev.`,
    );
  }

  // Printing the link is this script's whole purpose and it goes to the
  // operator's own terminal, but it is a bearer capability: whoever opens it
  // binds *their* account to the shared identity below.
  console.log(
    [
      `Connect ${slug} for the shared workspace identity.`,
      ``,
      `  toolkit:     ${slug}`,
      `  auth config: ${authConfig.value}`,
      `  binds to:    ${config.workspaceUserId}   (COMPOSIO_WORKSPACE_USER_ID)`,
      ``,
      `Open this link yourself, in a browser signed in to the account the whole team`,
      `should act through. Do not forward it — whoever completes it is the account`,
      `every shared ${slug} call will run as.`,
      ``,
      redirectUrl,
      ``,
      `Then restart the runtime and ask the agent for ${slug}.`,
    ].join("\n"),
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  fail(describe(error));
});
