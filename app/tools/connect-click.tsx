/**
 * What happens when somebody presses "Connect".
 *
 * Kept out of the card so it can be tested without rendering one, and out of
 * `composio-connect.ts` so that module stays a pure client with no knowledge of
 * threads or delivery.
 *
 * Nothing awaits this handler, so nothing here may throw: a rejection escaping
 * it is an unhandled one, and all the person sees is a button that did nothing.
 * Every step below either delivers something or logs why it could not.
 */
import type { InteractionContext, Renderable } from "@copilotkit/channels";
import { reportRecoverableError } from "../channel-helpers.js";
import { readEnvironment } from "../env.js";
import {
  ConnectFailed,
  ConnectLink,
  type ConnectRequest,
} from "../human-in-the-loop/connect-account.js";
import {
  normalizeToolkit,
  requestConnectLink,
  safeRefusalMessage,
} from "./composio-connect.js";

type Interaction = InteractionContext<ConnectRequest>;

/**
 * Deliver privately, and say so publicly when that was not possible.
 *
 * `Thread.postEphemeral` reports a non-delivery two ways, and neither is an
 * exception: `null` when the surface has no native ephemeral message and was
 * told not to DM, and `{ ok: false }` when the adapter offers no private
 * message at all. Both results were discarded here, so on the default
 * deployment — the managed Intelligence adapter, which declares
 * `supportsEphemeral: false` at the time — the minted link went nowhere, the thread stayed
 * silent, and nothing was logged. The button did nothing, twice over.
 *
 * So: ask for the DM fallback, because a DM is scoped to the clicker exactly as
 * an ephemeral message is — the hazard a connect link carries is a *second
 * reader*, and a DM has none. Then check what came back. When nothing was
 * delivered the thread gets a sentence saying so, never the link: whoever
 * completes a connect flow binds their account to the id it was minted for, so
 * a link a second person can read is an account takeover.
 *
 * The managed adapter implements `postEphemeral` as of
 * `@copilotkit/channels@0.9.2`, and the flow is confirmed working end to end
 * against a live Slack workspace: the clicker gets a link nobody else can
 * read. Teams has no ephemeral surface, so there the link is discarded and the
 * clicker is told — which is the whole point of checking the result.
 */
export async function handleConnectClick(
  toolkit: string,
  interaction: Interaction,
  deps: {
    environment?: ReturnType<typeof readEnvironment>;
    readEnvironment?: typeof readEnvironment;
    request?: typeof requestConnectLink;
  } = {},
): Promise<void> {
  try {
    await runConnectClick(toolkit, interaction, deps);
  } catch (error) {
    // The last resort. Everything below is already guarded, so reaching here
    // means something threw that was not expected to — and the person is still
    // looking at a button that appears to have done nothing.
    reportRecoverableError(error, {
      operation: "connect_click",
      recovery: "posted_the_notice_in_the_thread",
    });
    await postToThread(
      interaction,
      <ConnectFailed message="Something went wrong starting that connection. Try again, and tell whoever runs this deployment if it keeps happening." />,
    );
  }
}

async function runConnectClick(
  toolkit: string,
  interaction: Interaction,
  deps: {
    environment?: ReturnType<typeof readEnvironment>;
    readEnvironment?: typeof readEnvironment;
    request?: typeof requestConnectLink;
  },
): Promise<void> {
  const request = deps.request ?? requestConnectLink;

  // The value travels on the card, and the card was posted from a name the
  // model chose. A click after a restart re-derives that card from its stored
  // props, so this is the last place the value is checked before it is rendered
  // again.
  const slug = normalizeToolkit(toolkit);
  if (slug === null) {
    reportRecoverableError(
      "[opentag] a connect click carried something that is not an app name; nothing was minted",
      {
        operation: "connect_click_toolkit",
        recovery: "posted_the_notice_in_the_thread",
      },
    );
    await postToThread(
      interaction,
      <ConnectFailed message="That is not an app I can connect, so I did not start a connection." />,
    );
    return;
  }

  const actor = interaction.actor;
  if (!actor?.id) {
    // Without a verified clicker there is nobody to mint for. Minting anyway
    // would bind an account to whatever id we guessed. The notice goes to the
    // thread rather than to a made-up id: `postEphemeral("unknown", …)`
    // addresses a user that does not exist, so nobody ever saw it.
    reportRecoverableError(
      "[opentag] a connect click arrived with no identifiable actor; nothing was minted",
      {
        operation: "connect_click_actor",
        recovery: "posted_the_notice_in_the_thread",
      },
    );
    await postToThread(
      interaction,
      <ConnectFailed message="I could not tell who clicked, so I did not start a connection." />,
    );
    return;
  }

  let environment: ReturnType<typeof readEnvironment>;
  try {
    environment = deps.environment ?? (deps.readEnvironment ?? readEnvironment)();
  } catch (error) {
    // `readEnvironment()` throws on a deployment missing `AGENT_URL`, and it
    // runs per click — inside a handler nothing awaits.
    reportRecoverableError(error, {
      operation: "connect_click_environment",
      recovery: "told_the_clicker_on_whichever_surface_could_carry_it",
    });
    await deliver(
      interaction,
      actor,
      <ConnectFailed message="This deployment is not configured to connect accounts. Ask whoever runs it." />,
    );
    return;
  }

  const result = await request({
    agentUrl: environment.agentUrl,
    agentAuthHeader: environment.agentAuthHeader,
    actorId: actor.id,
    actorKind: actor.kind,
    platform: interaction.platform,
    toolkit: slug,
  });

  if (!result.ok) {
    // A refusal carries no capability, so the thread is a safe second home for
    // it — and silence is not one.
    //
    // The sentence itself, though, was written by another service and is about
    // to be rendered as mrkdwn, where `<url|label>` is a live hyperlink. The
    // model-chosen toolkit slug was given this treatment earlier in this PR and
    // this path was missed: the agent's own 400 quotes the toolkit it was
    // handed, so a value the model chose reaches here by a second route. Same
    // rule, same place — nothing from outside this repository is rendered
    // unexamined.
    const safe = safeRefusalMessage(result.message);
    if (safe === null) {
      reportRecoverableError(
        "[opentag] the agent's connect refusal was not a renderable sentence " +
          "and was replaced; it is logged here rather than shown: " +
          result.message,
        {
          operation: "connect_click_refusal",
          recovery: "showed_this_app's_own_sentence_instead",
        },
      );
    }
    await deliver(
      interaction,
      actor,
      <ConnectFailed
        message={safe ?? `Could not start the ${slug} connection.`}
      />,
    );
    return;
  }

  const delivered = await deliverPrivately(
    interaction,
    actor,
    <ConnectLink toolkit={slug} url={result.url} />,
  );
  if (delivered) return;

  // Says what actually broke, in the one place only an operator reads. Private
  // delivery is the managed adapter's job and it has one: an ephemeral message
  // where the surface supports it, a DM where it does not. Reaching this line
  // means that adapter refused or the surface has no private message at all, so
  // the answer is on the Intelligence side — not a token this app could hold.
  reportRecoverableError(
    `[opentag] a minted ${slug} connect link could not be delivered privately ` +
      "and was discarded rather than posted publicly. Check that this " +
      "deployment's Intelligence Channel is connected and that its Slack app " +
      "can message this person directly.",
    {
      operation: "connect_click_delivery",
      recovery: "discarded_the_link_and_said_so_in_the_thread",
    },
  );
  await postToThread(
    interaction,
    <ConnectFailed
      message={
        `I could not send you the ${slug} link privately, so I did not send it ` +
        `at all — a connect link binds whoever opens it, so it must not be ` +
        `posted where anyone else can read it. Ask whoever runs this ` +
        `deployment to let me message you directly.`
      }
    />
  );
}

/** Privately if the surface can, in the thread if it cannot. Never silent. */
async function deliver(
  interaction: Interaction,
  actor: NonNullable<Interaction["actor"]>,
  ui: Renderable,
): Promise<void> {
  if (await deliverPrivately(interaction, actor, ui)) return;
  await postToThread(interaction, ui);
}

/**
 * True only when the surface actually put this in front of that one person.
 *
 * `null` means the surface delivered nothing; `{ ok: false }` means it declined
 * and said why. Neither is an exception, which is how both came to be dropped.
 */
async function deliverPrivately(
  interaction: Interaction,
  actor: NonNullable<Interaction["actor"]>,
  ui: Renderable,
): Promise<boolean> {
  try {
    const result = await interaction.thread.postEphemeral(actor, ui, {
      fallbackToDM: true,
    });
    if (result?.ok) return true;
    reportRecoverableError(
      "[opentag] the surface delivered no private connect message: " +
        (result?.error ?? "no ephemeral message and no DM on this surface"),
      {
        operation: "connect_click_private_delivery",
        recovery: "falling_back_to_the_thread",
      },
    );
  } catch (error) {
    reportRecoverableError(error, {
      operation: "connect_click_private_delivery",
      recovery: "falling_back_to_the_thread",
    });
  }
  return false;
}

/** The public half. Only ever a sentence — never a link. */
async function postToThread(
  interaction: Interaction,
  ui: Renderable,
): Promise<void> {
  try {
    await interaction.thread.post(ui);
  } catch (error) {
    reportRecoverableError(error, {
      operation: "connect_click_thread_notice",
      recovery: "none_the_clicker_was_not_told",
    });
  }
}
