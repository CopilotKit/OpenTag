/**
 * The connect prompt. Public in the thread, and deliberately carries no URL: a
 * connect link binds whoever completes it to the user id it was minted for, so
 * a link posted in a channel is an account-takeover hazard. The link is minted
 * on click, for the clicker, and delivered privately.
 */
import { Actions, Button, Context, Header, Message, Section } from "@copilotkit/channels";
import type { InteractionContext } from "@copilotkit/channels";

/** What the button carries. The toolkit only — never an id, never a link. */
export type ConnectRequest = { toolkit: string };

/**
 * Mint and deliver the link for whoever clicked.
 *
 * Defined here rather than taken as a prop, and that is the difference between
 * a working button and a dead one. A click after a restart is served by
 * re-rendering this card from its **stored props**; a function passed in as a
 * prop does not survive that, so the button would come back with no handler and
 * the Channel swallows the resulting `ActionExpiredError` — the person clicks
 * "Connect" and nothing happens, every time, with nothing to explain it. This
 * flow needs no in-process state at all (the link is minted fresh, for the
 * clicker), so re-derived it works exactly as well as it did before the
 * restart.
 *
 * The import is dynamic only to keep the module graph acyclic: `connect-tool.tsx`
 * imports this card. It resolves from the module cache — the runtime loaded
 * that module at startup, before any card could be posted.
 */
async function connect(interaction: InteractionContext<ConnectRequest>, toolkit: string) {
  const { handleConnectClick } = await import("../tools/composio/connect-tool.js");
  await handleConnectClick(toolkit, interaction);
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
        {`Google will show "Composio" — that's the service OpenTag uses to connect apps. Anyone else in this thread can click to connect their own account.`}
      </Context>
    </Message>
  );
}
