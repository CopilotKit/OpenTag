/**
 * `connect_my_app` — posts the connect card and ends the turn.
 *
 * It does not wait for the OAuth round trip. Slack cuts the live update after
 * about a minute (see `userFacingRunError` in app/channel-helpers.ts), and a
 * browser authorization routinely exceeds that.
 */
import { z } from "zod";
import {
  defineChannelTool,
  type ChannelTool,
  type InteractionContext,
} from "@copilotkit/channels";
import { composioClient } from "./client.js";
import { readComposioConfig, type ComposioConfig } from "./config.js";
import { invalidateSession, type Authorization, type ComposioSdk } from "./sessions.js";
import { ConnectAccount, type ConnectRequest } from "../../human-in-the-loop/index.js";

/**
 * How long to keep waiting for the browser flow, in ms.
 *
 * Composio's own default is about a minute, which is shorter than a person
 * spends reading a Google consent screen — a naive wait would therefore reject
 * on almost every real authorization, right when it was meant to help.
 */
const CONNECT_TIMEOUT_MS = 10 * 60 * 1000;

/** Whether one person actually received a private message, and how. */
type PrivateDelivery = { ok: true; usedFallback: boolean } | { ok: false };

/**
 * Send `text` where only `clicker` can read it, and report whether that worked.
 *
 * Three ways it does not: `null` when the surface has no ephemeral path and no
 * DM fallback was possible, `{ ok: false }` from `channels-core` when the
 * adapter implements no `postEphemeral` at all (Teams, today), and a throw when
 * the transport fails. All three mean nobody read it, and the caller has to
 * know — an ignored result is a click that silently does nothing.
 */
async function postPrivately(
  thread: InteractionContext<ConnectRequest>["thread"],
  clicker: InteractionContext<ConnectRequest>["actor"],
  text: string,
): Promise<PrivateDelivery> {
  try {
    const result = await thread.postEphemeral(clicker, text, { fallbackToDM: true });
    if (!result?.ok) return { ok: false };
    return { ok: true, usedFallback: result.usedFallback === true };
  } catch {
    // Swallowed on purpose: a throw here escapes the click handler, the
    // dispatcher rethrows it, and the clicker is left with a dead button and no
    // explanation. The caller reports the failure instead. Nothing about the
    // error is logged — a transport error message can carry the request URL,
    // and this function's whole job is handling links nobody else may see.
    return { ok: false };
  }
}

/**
 * Drop the clicker's cached sessions again the moment the browser flow
 * completes.
 *
 * Deliberately not awaited: the turn has to end now (Slack cuts the live update
 * after about a minute). The invalidation at mint time is the one that runs
 * before this returns; this one exists because that one is too early — the user
 * is told to ask again, and asking again refills the cache with a session that
 * still predates the connection.
 *
 * The `.catch` is not optional. An abandoned authorization rejects on timeout,
 * and Node 22 terminates the process on an unhandled rejection — a user who
 * closes the browser tab would take the bot down with them.
 */
function invalidateOnConnection(authorization: Authorization, userId: string): void {
  try {
    void authorization
      .waitForConnection?.(CONNECT_TIMEOUT_MS)
      .then(() => invalidateSession(userId))
      .catch(() => {});
  } catch {
    // A wait that cannot even start leaves the mint-time invalidation in place,
    // which is exactly where this stood before the chain existed.
  }
}

/**
 * Tell the clicker, and only the clicker, that the connection could not be
 * started — falling back to the thread when there is no private channel, since
 * a click that reports nothing is indistinguishable from a broken button.
 *
 * The provider's own error text is private: it is addressed to one person and
 * can quote the request. The public fallback says less on purpose.
 *
 * `nextStep` is a parameter because the two callers are not the same kind of
 * failure. A provider error may well clear on its own; a deployment with no
 * `COMPOSIO_API_KEY` never will, and telling that clicker to try again in a
 * moment sends them into a loop that cannot end and hides the one fact they
 * could act on — that this is the operator's to fix, not theirs.
 */
async function reportStartFailure(
  thread: InteractionContext<ConnectRequest>["thread"],
  clicker: InteractionContext<ConnectRequest>["actor"],
  toolkit: string,
  failure: string | undefined,
  nextStep = "Try again in a moment.",
): Promise<void> {
  const told = await postPrivately(
    thread,
    clicker,
    failure
      ? `I could not start the ${toolkit} connection — ${failure}. ${nextStep}`
      : `I could not start the ${toolkit} connection. ${nextStep}`,
  );
  if (told.ok) return;
  await thread.post(
    `I could not start the ${toolkit} connection, and I could not message you privately either.`,
  );
}

/**
 * The SDK for this process, re-derived from the environment rather than
 * captured.
 *
 * `composioClient` memoizes, so this is the same instance every other Composio
 * path uses; the point is that the click needs nothing carried over from the
 * turn that posted the card. `null` means the deployment is no longer
 * configured — an operator pulled the key while a card was live.
 *
 * The `""` default user id is never read here: it only fills
 * `config.workspaceUserId`, and connecting always acts as the clicker.
 */
function sdkFromEnv(): ComposioSdk | null {
  const config = readComposioConfig(process.env, "");
  return config ? composioClient(config) : null;
}

/**
 * The Connect click.
 *
 * Lifted out of the JSX for the same reason `handleToolRunDecision` is: this,
 * not the tool handler, is where the security decision lives, and a closure
 * inside a card is unreachable from a test.
 *
 * Everything here is derived from `interaction` and the environment — the
 * clicker's id, the clicker's thread, and the process-wide SDK. Nothing is
 * captured from the turn that posted the card: not the SDK, and above all not
 * whoever triggered it, because a link minted for the triggerer and handed to a
 * clicker is exactly the account-takeover this whole flow exists to prevent.
 * That is also what lets the card be re-rendered from stored props and clicked
 * long after a restart.
 */
export async function handleConnectClick(
  toolkit: string,
  interaction: InteractionContext<ConnectRequest>,
): Promise<void> {
  const clicker = interaction.actor;
  // An unattributable click cannot be bound to anyone, and guessing would bind
  // this account to the wrong person. Nothing is posted: there is no one to
  // post it to privately, and the thread is not an option.
  if (!clicker?.id) return;

  const thread = interaction.thread;
  const sdk = sdkFromEnv();
  if (!sdk) {
    await reportStartFailure(
      thread,
      clicker,
      toolkit,
      "connected apps are not configured on this deployment (no COMPOSIO_API_KEY)",
      "Retrying will not help. Ask whoever runs this deployment to set it.",
    );
    return;
  }

  let authorization: Authorization | undefined;
  let failure: string | undefined;
  try {
    const session = await sdk.sessions.create(clicker.id, {
      toolkits: [toolkit],
      // Mandatory. A default session hands the holder remote bash and a Python
      // sandbox, which nobody asked for by clicking "Connect Gmail".
      workbench: { enable: false },
    });
    authorization = await session.authorize(toolkit);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  // One line per click. The id and the outcome, and deliberately not the link:
  // a redirect URL is a bearer capability, so a log line carrying one is a
  // credential at rest.
  console.log(
    `[composio] connect ${toolkit} ` +
      `${authorization?.redirectUrl ? "link issued" : "failed"} user=${clicker.id}`,
  );

  if (!authorization?.redirectUrl) {
    await reportStartFailure(thread, clicker, toolkit, failure);
    return;
  }

  // Ephemeral, never `post`. The link binds whoever completes it, so the one
  // person who may see it is the one it was minted for.
  const delivered = await postPrivately(
    thread,
    clicker,
    `Authorize ${toolkit} here: ${authorization.redirectUrl}`,
  );

  if (!delivered.ok) {
    // No private channel, so there is nowhere the link may go. Posting it here
    // would let anyone else in the thread open it and bind their own account to
    // the clicker's id, which is the one outcome this flow exists to prevent.
    await thread.post(
      `I could not send you a private message on ${interaction.platform}, and a connect ` +
        `link must not be posted where someone else could open it — so I cannot share it ` +
        `here. Ask whoever runs this deployment to enable private messages for me.`,
    );
    return;
  }

  if (delivered.usedFallback) {
    await thread.post("📬 I sent you the link as a direct message (only you can open it).");
  }

  // Dropped now rather than on completion, because nothing here waits for the
  // round trip. A cached session predating the connect would keep reporting the
  // toolkit as unconnected until its TTL expired.
  invalidateSession(clicker.id);
  // ...and dropped again when the flow actually completes, since the line above
  // runs while the user still has the consent screen open.
  invalidateOnConnection(authorization, clicker.id);
}

/**
 * No SDK parameter: the card carries no handler to capture one, and the click
 * re-derives it from the environment. Only `config` is needed, and only to
 * decide which toolkits a person is allowed to connect.
 */
export function createConnectTool(config: ComposioConfig): ChannelTool {
  return defineChannelTool({
    name: "connect_my_app",
    description:
      "Ask the user to connect one of their accounts. Use when search_my_tools reports " +
      "a toolkit needs connecting.",
    parameters: z.object({
      toolkit: z.string().describe("Toolkit slug, e.g. gmail"),
    }),
    async handler({ toolkit }, ctx) {
      const slug = toolkit.trim().toLowerCase();

      // Personal toolkits only. A workspace toolkit would connect under the
      // clicker's own id while every workspace-scope call resolves under
      // `workspaceUserId`, so the account would be created and never used —
      // the user authorizes, comes back, and nothing works.
      if (config.workspaceToolkits.includes(slug) && !config.userToolkits.includes(slug)) {
        return (
          `"${slug}" is a shared team app. Whoever runs this deployment connects it once ` +
          `by running \`pnpm composio:connect ${slug}\` on the server; individual users ` +
          "do not connect it here."
        );
      }
      if (!config.userToolkits.includes(slug)) {
        return `"${slug}" is not configured on this deployment.`;
      }
      if (!ctx.actor?.id) {
        return "I can't tell who you are on this platform, so I can't connect an account for you.";
      }

      await ctx.thread.post(<ConnectAccount toolkit={slug} />);

      return `Posted a Connect ${slug} card. Stop here — the user connects, then asks again.`;
    },
  });
}
