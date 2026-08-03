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
  Table,
  Row,
  Cell,
} from "@copilotkit/channels";
import type { InteractionContext } from "@copilotkit/channels";

/** One argument of the pending write, already labelled and stringified. */
export interface ConfirmWriteField {
  label: string;
  value: string;
}

interface ConfirmWriteProps {
  /** Short imperative title of the write, e.g. 'Create Linear issue'. */
  action: string;
  /**
   * The write's arguments as approver-readable rows, rendered as a table. The
   * agent decides which fields are worth showing (see `summarize_args`); this
   * component only decides how they look.
   */
  fields?: ConfirmWriteField[];
  /**
   * Legacy single-string summary. Superseded by `fields`, but still rendered
   * when an agent revision predating `fields` is what sent the interrupt.
   */
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
      throw new AggregateError(
        [error, updateError],
        `Failed to resume "${action}" and show its retry state`,
      );
    }
    throw error;
  }
}

/**
 * The write's arguments, as a headerless two-column table. No `columns` prop is
 * passed, so neither renderer emits a header row — "Field | Value" would spend a
 * row restating what the layout already says. Slack renders cells as `raw_text`,
 * so labels cannot be bolded here.
 */
function fieldTable(fields: ConfirmWriteField[]) {
  return (
    <Table>
      {fields.map((field) => (
        <Row>
          <Cell>{field.label}</Cell>
          <Cell>{field.value}</Cell>
        </Row>
      ))}
    </Table>
  );
}

export function ConfirmWrite({ action, fields, detail }: ConfirmWriteProps) {
  const body = fields?.length
    ? fieldTable(fields)
    : detail
      ? <Section>{detail}</Section>
      : null;

  return (
    <Message accent="#E2B340">
      <Header>{`📝 ${action}?`}</Header>
      {body}
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
            await thread.update(
              message.ref,
              <Message accent="#EB5757">
                <Header>{`🚫 ${action}`}</Header>
                <Context>{"🚫  Declined — nothing was written."}</Context>
              </Message>,
            );
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
