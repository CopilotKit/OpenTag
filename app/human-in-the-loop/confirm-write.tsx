/**
 * `confirm_write` — the human-in-the-loop gate in front of every Linear /
 * Notion write. The agent is instructed (see the system prompt in
 * `runtime.ts`) to confirm BEFORE creating an issue or a page: a tool handler
 * calls `await thread.awaitChoice(<ConfirmWrite .../>)`, which posts this
 * interactive card and **blocks until the user clicks Create or Cancel**,
 * resolving to the clicked button's `value` (`{ confirmed: true | false }`).
 * The agent only performs the write once it resolves with `{ confirmed: true }`.
 *
 * Each button also carries an `onClick` that updates the picker in place to a
 * resolved / declined state — so the card reflects the decision the moment it's
 * clicked, even minutes later (the "approve the action 20 minutes later"
 * durability story).
 *
 * The Slack-side equivalent of React's `useHumanInTheLoop`, expressed as a
 * plain JSX component over the cross-platform bot-ui vocabulary.
 */
import {
  Message,
  Header,
  Section,
  Context,
  Actions,
  Button,
} from "@copilotkit/channels-ui";
import type { InteractionContext } from "@copilotkit/channels-ui";

export interface ConfirmWriteProps {
  /** Short imperative title of the write, e.g. 'Create Linear issue'. */
  action: string;
  /** The specifics being approved — issue title + one-line description, etc. */
  detail?: string;
}

/**
 * Slack's section-text budget is ~3000 chars; an agent-supplied `detail`
 * anywhere near that risks the confirm card failing to post — and since the
 * blocking `awaitChoice` in confirm-write-tool.tsx can then never resolve,
 * that would break the write GATE instead of degrading it. Cap well under
 * the budget so the card always posts, on every channel (not just Slack's
 * own renderer, which truncates section text but not every channel does).
 * Same trim length as the `description` cap in issue-card.tsx, for
 * consistency across cards.
 */
const MAX_DETAIL_LENGTH = 600;

export function ConfirmWrite({ action, detail }: ConfirmWriteProps) {
  const detailText = detail
    ? detail.length > MAX_DETAIL_LENGTH
      ? `${detail.slice(0, MAX_DETAIL_LENGTH)}…`
      : detail
    : undefined;
  return (
    <Message accent="#E2B340">
      <Header>{`📝 ${action}?`}</Header>
      {detailText ? <Section>{detailText}</Section> : null}
      <Context>{"🔒  Nothing is written until you click **Create**."}</Context>
      <Actions>
        <Button
          value={{ confirmed: true }}
          style="primary"
          onClick={async ({ thread, message }: InteractionContext) => {
            try {
              await thread.update(
                message.ref,
                <Message accent="#27AE60">
                  <Header>{`✅ ${action}`}</Header>
                  <Context>{"✅  Approved — writing now."}</Context>
                </Message>,
              );
            } catch (err) {
              console.error("[confirm-write] onClick failed", err);
            }
          }}
        >
          Create
        </Button>
        <Button
          value={{ confirmed: false }}
          style="danger"
          onClick={async ({ thread, message }: InteractionContext) => {
            try {
              await thread.update(
                message.ref,
                <Message accent="#EB5757">
                  <Header>{`🚫 ${action}`}</Header>
                  <Context>{"🚫  Declined — nothing was written."}</Context>
                </Message>,
              );
            } catch (err) {
              console.error("[confirm-write] onClick failed", err);
            }
          }}
        >
          Cancel
        </Button>
      </Actions>
    </Message>
  );
}
