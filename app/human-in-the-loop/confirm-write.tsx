/**
 * `confirm_write` — the human-in-the-loop gate in front of every Linear /
 * Notion write. The agent is instructed (see the system prompt in `runtime.ts`)
 * to confirm BEFORE creating an issue or a page.
 *
 * Each button carries a `value` and an `onClick`. The `onClick` always updates
 * the picker in place to a resolved / declined state — so the card reflects the
 * decision the moment it's clicked, even minutes later (the "approve the action
 * 20 minutes later" durability story).
 *
 * The card drives BOTH HITL modes (gated on `thread.supportsBlockingChoice`):
 *   • Interactive surfaces (native Socket Mode, …): the tool handler
 *     `await`s `thread.awaitChoice(<ConfirmWrite/>)`, which blocks until the
 *     click resolves to the button's `value` (`{ confirmed: boolean }`); the
 *     same run then performs the write. The `onClick` only repaints the card.
 *   • Managed (Intelligence HTTP, `supportsBlockingChoice === false`): the tool
 *     posts this card and ends the turn (a blocking wait would deadlock the
 *     claim loop); the button `onClick` additionally runs a FOLLOW-UP turn
 *     (`thread.runAgent`) to perform / cancel the gated write when the click's
 *     `interaction` delivery is processed.
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
} from "@copilotkit/bot-ui";
import type { InteractionContext } from "@copilotkit/bot-ui";

export interface ConfirmWriteProps {
  /** Short imperative title of the write, e.g. 'Create Linear issue'. */
  action: string;
  /** The specifics being approved — issue title + one-line description, etc. */
  detail?: string;
}

export function ConfirmWrite({ action, detail }: ConfirmWriteProps) {
  return (
    <Message accent="#E2B340">
      <Header>{`📝 ${action}?`}</Header>
      {detail ? <Section>{detail}</Section> : null}
      <Context>{"🔒  Nothing is written until you click **Create**."}</Context>
      <Actions>
        <Button
          value={{ confirmed: true }}
          style="primary"
          onClick={async ({ thread, message }: InteractionContext) => {
            await thread.update(
              message.ref,
              <Message accent="#27AE60">
                <Header>{`✅ ${action}`}</Header>
                <Context>{"✅  Approved — writing now."}</Context>
              </Message>,
            );
            // Managed (ack-first) surface: the original run already ended after
            // posting this card, so the approval can't resolve an in-run
            // `awaitChoice`. Drive the write as a follow-up turn — this runs as
            // the click's `interaction` delivery, reusing the same thread state.
            // (Native/blocking surfaces skip this: `awaitChoice` resolves and
            // the original run continues.)
            if (thread.supportsBlockingChoice === false) {
              await thread.runAgent({
                prompt:
                  `The user APPROVED the pending action: "${action}"` +
                  (detail ? ` — ${detail}` : "") +
                  ". Perform it now using your tools, then confirm completion. " +
                  "Do not call confirm_write again for this same action.",
              });
            }
          }}
        >
          Create
        </Button>
        <Button
          value={{ confirmed: false }}
          style="danger"
          onClick={async ({ thread, message }: InteractionContext) => {
            await thread.update(
              message.ref,
              <Message accent="#EB5757">
                <Header>{`🚫 ${action}`}</Header>
                <Context>{"🚫  Declined — nothing was written."}</Context>
              </Message>,
            );
            if (thread.supportsBlockingChoice === false) {
              await thread.runAgent({
                prompt:
                  `The user DECLINED the pending action: "${action}". Do not ` +
                  "perform it. Briefly acknowledge the cancellation. Do not " +
                  "call confirm_write again for this same action.",
              });
            }
          }}
        >
          Cancel
        </Button>
      </Actions>
    </Message>
  );
}
