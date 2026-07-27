/**
 * `confirm_write` — the human-in-the-loop gate in front of every Linear /
 * Notion write. The Python MCP interceptor pauses before invoking a mutating
 * tool. The Channel interrupt handler posts this card and returns immediately.
 * A click updates the card, then resumes the paused graph with
 * `{ confirmed: true | false }`.
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
} from "@copilotkit/channels";
import type { InteractionContext } from "@copilotkit/channels";

export interface ConfirmWriteProps {
  /** Short imperative title of the write, e.g. 'Create Linear issue'. */
  action: string;
  /** The specifics being approved — issue title + one-line description, etc. */
  detail?: string;
}

async function resumeOrShowFailure(
  thread: InteractionContext["thread"],
  messageRef: InteractionContext["message"]["ref"],
  action: string,
  confirmed: boolean,
): Promise<void> {
  try {
    await thread.resume({ confirmed });
  } catch (error) {
    try {
      await thread.update(
        messageRef,
        <Message accent="#EB5757">
          <Header>{`⚠️ ${action} paused`}</Header>
          <Context>
            {"I couldn't resume the agent. Please retry the action."}
          </Context>
        </Message>,
      );
    } catch (updateError) {
      console.error(
        "[confirm-write] failed to show resume error",
        updateError,
      );
    }
    throw error;
  }
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
            try {
              await thread.update(
                message.ref,
                <Message accent="#27AE60">
                  <Header>{`✅ ${action}`}</Header>
                  <Context>{"✅  Approved — writing now."}</Context>
                </Message>,
              );
            } catch (err) {
              console.error("[confirm-write] approval update failed", err);
            }
            await resumeOrShowFailure(
              thread,
              message.ref,
              action,
              true,
            );
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
              console.error("[confirm-write] decline update failed", err);
            }
            await resumeOrShowFailure(
              thread,
              message.ref,
              action,
              false,
            );
          }}
        >
          Cancel
        </Button>
      </Actions>
    </Message>
  );
}
