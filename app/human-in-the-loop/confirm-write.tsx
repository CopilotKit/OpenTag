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
  /**
   * Which attempt at this write is being confirmed. `2` and up mean the user
   * already approved this action once and the write was rejected — without
   * saying so, a corrected retry is indistinguishable from asking twice.
   */
  attempt?: number;
  /** Why the previous attempt failed, quoted from the tool that rejected it. */
  previousError?: string;
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

/**
 * Verbs whose confirmation must not look inviting. A destructive action gets the
 * warning colour on its confirm button, and Cancel drops to neutral so the red
 * on the card marks the irreversible choice rather than the safe one.
 */
const DESTRUCTIVE = new Set(["delete", "remove", "archive", "cancel", "revoke"]);

/** The label of the button that declines the write. */
const DECLINE_LABEL = "Cancel";

/** The action's own leading verb, e.g. `Delete customer` -> `Delete`. */
function verbOf(action: string): string {
  const word = action.trim().split(/\s+/)[0] ?? "";
  if (!word) return "";
  return word[0]!.toUpperCase() + word.slice(1);
}

/**
 * How the confirm button reads. Normally the action's own verb, so the button
 * never claims a delete is a create.
 *
 * Falls back to `Confirm` when the verb would collide with the decline button:
 * `Cancel subscription` otherwise renders two buttons both reading "Cancel",
 * one cancelling the subscription and one cancelling the request. Derived
 * separately from `destructive` below, so relabelling never costs the styling.
 */
function confirmLabel(verb: string): string {
  if (!verb) return "Confirm";
  return verb.toLowerCase() === DECLINE_LABEL.toLowerCase() ? "Confirm" : verb;
}

/**
 * The retry banner, shown only from the second attempt on. It names the
 * attempt number and quotes the failure, so an approver can tell a corrected
 * retry from the same question asked again — and can see what to fix.
 */
function retryNotice(attempt: number, previousError?: string) {
  const cause = previousError ? `: ${previousError}` : ".";
  return (
    <Context>
      {`♻️  Attempt ${attempt} — an earlier approved attempt failed${cause}`}
    </Context>
  );
}

export function ConfirmWrite({
  action,
  fields,
  detail,
  attempt,
  previousError,
}: ConfirmWriteProps) {
  const body = fields?.length
    ? fieldTable(fields)
    : detail
      ? <Section>{detail}</Section>
      : null;

  const retry = attempt && attempt > 1
    ? retryNotice(attempt, previousError)
    : null;

  const verb = verbOf(action);
  const label = confirmLabel(verb);
  // Read from the action's real verb, never from `label` — a relabelled
  // destructive action is still destructive.
  const destructive = DESTRUCTIVE.has(verb.toLowerCase());

  return (
    <Message accent="#E2B340">
      <Header>{`📝 ${action}?`}</Header>
      {retry}
      {body}
      <Context>
        {`🔒  Nothing is changed until you click **${label}**.`}
      </Context>
      <Actions>
        <Button
          value={{ confirmed: true }}
          style={destructive ? "danger" : "primary"}
          onClick={async ({ thread, message }: InteractionContext) => {
            await thread.update(
              message.ref,
              <Message accent="#27AE60">
                <Header>{`✅ ${action}`}</Header>
                {/*
                  Claims only what is true at click time. The card cannot be
                  updated with the outcome — the agent, not this handler, learns
                  whether the tool accepted the write — so the agent reports the
                  result in the thread (see `_report_failure`) rather than
                  leaving this card asserting a write that may have failed.
                */}
                <Context>
                  {"✅  Approved — running the write. The result follows below."}
                </Context>
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
          {label}
        </Button>
        <Button
          value={{ confirmed: false }}
          style={destructive ? undefined : "danger"}
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
