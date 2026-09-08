/**
 * The connect prompt. Public in the thread, and deliberately carrying no URL.
 *
 * A connect link binds whoever completes it to the Composio user id it was
 * minted for, so a link posted in a channel is an account-takeover hazard. The
 * link is minted on click, for the clicker, and delivered to that person alone.
 */
import {
  Actions,
  Button,
  Context,
  Header,
  Message,
  Section,
} from "@copilotkit/channels";
import type { InteractionContext, Renderable } from "@copilotkit/channels";
import { reportRecoverableError } from "../channel-helpers.js";
import { normalizeToolkit } from "../tools/composio-connect.js";

/** What the button carries. The toolkit only — never an id, never a link. */
export type ConnectRequest = { toolkit: string };

/**
 * Mint and deliver the link for whoever clicked.
 *
 * Defined here rather than passed in as a prop, and that is the difference
 * between a working button and a dead one. A click after a restart is served by
 * re-rendering this card from its stored props; a function handed in as a prop
 * does not survive that, so the button comes back with no handler, the Channel
 * swallows the resulting error, and the person clicks and nothing happens — with
 * nothing anywhere to explain it. This flow keeps no in-process state (the link
 * is minted fresh, for the clicker), so a re-derived card works exactly as well
 * as the original.
 *
 * The import is dynamic to keep the module graph acyclic: `connect-click.js`
 * imports the cards below, so importing it back statically would close a cycle.
 * Nothing else in this app imports that module statically either, so this is a
 * real first load, inside a click handler, and not the cache hit an earlier
 * comment here claimed. That is precisely why the `catch` matters: a module
 * that fails to load — a syntax error shipped in a build, a transitive import
 * that throws on evaluation — surfaces here and nowhere else.
 */
async function connect(
  interaction: InteractionContext<ConnectRequest>,
  toolkit: string,
) {
  try {
    const { handleConnectClick } = await import("../tools/connect-click.js");
    await handleConnectClick(toolkit, interaction);
  } catch (error) {
    // The one outcome this card is shaped to avoid. `handleConnectClick`
    // reports the failures it can name — a request that came back refused, a
    // clicker it could not identify — by telling that person. Everything it
    // cannot name, an incomplete deployment among them, threw straight out of
    // the click, and a swallowed throw here is a button that does nothing and
    // says nothing, minutes after the person was told to press it.
    //
    // The recovery is recorded after the telling, not before it: the two calls
    // below report non-delivery by *returning*, so the old fixed
    // `told_the_clicker_privately` was written into the log on the exact runs
    // where nobody was told.
    const recovery = await tellTheClicker(interaction, toolkit);
    reportRecoverableError(error, {
      operation: "connect_account_click",
      recovery,
    });
  }
}

/**
 * Say it privately if the surface can, in the thread if it cannot.
 *
 * Returns what actually happened, in the words the log uses.
 *
 * `postEphemeral` reports a non-delivery two ways and neither is an exception:
 * `null` when the surface has no native ephemeral message and was told not to
 * DM, and `{ ok: false }` when the adapter offers no private message at all.
 * The managed Intelligence adapter — the default deployment — is the second, so
 * discarding the result meant this notice reliably went nowhere.
 *
 * The same shape as `connect-click.tsx`'s own delivery, deliberately not shared
 * with it: this runs precisely when that module could not be loaded.
 */
async function tellTheClicker(
  interaction: InteractionContext<ConnectRequest>,
  toolkit: string,
): Promise<string> {
  // Rendered into a card, so it gets the treatment every value that reaches a
  // rendered surface from outside this repository gets. The slug is checked at
  // both entry points already; a card re-derived from stored props is a third
  // route in, and this is the one place on it that renders the value.
  const slug = normalizeToolkit(toolkit);
  const notice: Renderable = (
    <ConnectFailed
      message={
        slug === null
          ? "I could not start that connection. Please try again."
          : `I could not start the ${slug} connection. Please try again.`
      }
    />
  );

  // Only ever to a verified clicker. `postEphemeral("unknown", …)` addresses a
  // user id that does not exist, so the notice was delivered to nobody at all.
  if (interaction.actor) {
    try {
      const result = await interaction.thread.postEphemeral(
        interaction.actor,
        notice,
        // The DM fallback, matching the link path: a DM is scoped to the
        // clicker exactly as an ephemeral message is, and the default adapter
        // has no ephemeral message to offer.
        { fallbackToDM: true },
      );
      if (result?.ok) return "told_the_clicker_privately";
    } catch (tellError) {
      reportRecoverableError(tellError, {
        operation: "connect_account_click_notice",
        recovery: "falling_back_to_the_thread",
      });
    }
  }

  // The notice carries no link and no capability, so the thread is a safe
  // second home for it — and silence is not one.
  try {
    await interaction.thread.post(notice);
    return "posted_the_notice_in_the_thread";
  } catch (postError) {
    reportRecoverableError(postError, {
      operation: "connect_account_click_notice",
      recovery: "none_the_clicker_was_not_told",
    });
    return "none_the_clicker_was_not_told";
  }
}

export function ConnectAccount({ toolkit }: { toolkit: string }) {
  const label = toolkit.charAt(0).toUpperCase() + toolkit.slice(1);
  return (
    <Message accent="#010507">
      <Header>{`🔗 Connect ${label}`}</Header>
      <Section>
        {`I need access to your ${label} account to do that. The link is private to whoever clicks.`}
      </Section>
      <Actions>
        <Button
          value={{ toolkit }}
          style="primary"
          onClick={(interaction: InteractionContext<ConnectRequest>) =>
            connect(interaction, toolkit)
          }
        >
          {`Connect ${label}`}
        </Button>
      </Actions>
      <Context>
        {`Anyone else in this thread can click to connect their own account.`}
      </Context>
    </Message>
  );
}

/**
 * What one person sees after clicking, and nobody else does.
 *
 * A link button rather than `<url|label>` in a section. That syntax is Slack
 * mrkdwn: this component is rendered on whatever surface the person is on, and
 * on Teams it arrived as that literal string. It was wrong on Slack too — an
 * `&` inside the url half ends the link there, and a minted connect url is all
 * query parameters, so the one thing this card exists to deliver came through
 * truncated. A `<Button url>` puts the url in a url field on every surface that
 * has one, where nothing is parsed as markup.
 */
export function ConnectLink({
  toolkit,
  url,
}: {
  toolkit: string;
  url: string;
}) {
  const label = toolkit.charAt(0).toUpperCase() + toolkit.slice(1);
  return (
    <Message accent="#010507">
      <Section>
        {`This link is yours alone; it connects the ${label} account you sign in with.`}
      </Section>
      <Actions>
        <Button url={url} style="primary">{`Connect ${label}`}</Button>
      </Actions>
    </Message>
  );
}

/** What one person sees when no link could be minted. */
export function ConnectFailed({ message }: { message: string }) {
  return (
    <Message accent="#010507">
      <Section>{`⚠️ ${message}`}</Section>
    </Message>
  );
}
