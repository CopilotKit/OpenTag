/**
 * `confirm_write` — the human-in-the-loop gate in front of every Linear /
 * Notion write. The Python MCP interceptor pauses before invoking a mutating
 * tool. The Channel interrupt handler posts this card and returns immediately.
 * A click updates the card, then resumes the paused graph with
 * `{ [interruptId]: { confirmed: true | false } }`.
 *
 * Each button also carries an `onClick` that updates the picker in place to a
 * resolved / declined state — so the card reflects the decision the moment it's
 * clicked, even minutes later (the "approve the action 20 minutes later"
 * durability story).
 *
 * The Channel binds this component to a durable decision shared by both
 * buttons. SDK continuations are one-use per button, so they alone cannot
 * prevent the sibling button resuming a later interrupt after a restart.
 *
 * The Slack-side equivalent of React's `useHumanInTheLoop`, expressed as a
 * plain JSX component over the cross-platform bot-ui vocabulary.
 */
import {
  ActionExpiredError,
  ActionContinuationMismatchError,
  ChannelContinuationRequiredError,
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
import { reportRecoverableError } from "../channel-helpers.js";
import { INTERRUPT_ID_PATTERN } from "./approval-decisions.js";

/** One argument of the pending write, already labelled and stringified. */
export interface ConfirmWriteField {
  label: string;
  value: string;
}

/**
 * Everything the agent can say an action does. Closed on purpose: these are the
 * three literals `composio_tools.classify` defines, and nothing else crosses
 * the wire. Naming them here rather than accepting any string is what lets the
 * card treat a word it does not recognise as the dangerous reading instead of
 * silently sorting it with the safe ones.
 *
 * `read` is unreachable on this card — a read is never gated, so no card is
 * posted for one — and `write` is unreachable from the Composio path, whose
 * tags cannot express a write that is not destructive. Both stay in the
 * vocabulary because the MCP interceptor classifies by `readOnlyHint` metadata
 * instead, and because a schema's job here is to reject a typo, not to prove
 * which of its members production happens to use this month.
 */
export const CONFIRM_WRITE_EFFECTS = ["read", "write", "destructive"] as const;

export type ConfirmWriteEffect = (typeof CONFIRM_WRITE_EFFECTS)[number];

/**
 * The effects that may render without the warning colour. Everything else
 * carries it, and that includes both a missing classification and one this card
 * cannot read.
 *
 * The agent decides the same way: `EffectMap.effect_for` answers `destructive`
 * for a slug whose lookup failed and for one carrying no behaviour tag, on the
 * grounds that an unclassified tool and a dangerous one are indistinguishable
 * from here. Rendering the unclassified case unwarned would invert that at the
 * one point where the person deciding can see it.
 *
 * Unwarned is as far as `write` gets: see {@link confirmStyle}. `write` is what
 * the MCP interceptor makes of `readOnlyHint: false`, which is a tool saying "I
 * am not read-only" — the absence of a safety claim, not the presence of one.
 */
const NEUTRAL_EFFECTS: ReadonlySet<string> = new Set<ConfirmWriteEffect>([
  "read",
  "write",
]);

interface ConfirmWriteProps {
  /** The specific LangGraph interrupt this answer may resolve. */
  interruptId?: string;
  /** Surface-generated identifier shared by both buttons and saved with the card. */
  decisionId?: string;
  /** Conversation bound to this card by the Channel when it posts the interrupt. */
  conversationKey?: string;
  /** Short imperative title of the write, e.g. 'Create Linear issue'. */
  action: string;
  /**
   * Who may answer, as `platform:id`. Set only when the pending action runs in
   * one person's own connected account: approving it spends that person's
   * access, so a colleague pressing the button would spend somebody else's.
   * Absent means the action belongs to the workspace and anyone who can see the
   * card may answer.
   */
  approver?: string;
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
  /**
   * What the agent classified the action as. The card also checks the action's
   * words for destructive verbs.
   *
   * Both the MCP interceptor and Composio send a classification. An older or
   * malformed producer may omit it, which renders with the danger style.
   */
  effect?: ConfirmWriteEffect;
}

/**
 * Whether this failure is the SDK refusing to send, rather than a send that
 * failed.
 *
 * `Thread.resume` validates the interaction, loads its continuation, and claims
 * it before starting the agent. A missing action, expired action, or mismatched
 * binding therefore proves that this click never started an agent run.
 *
 * The code is read as well as the class. `instanceof` is one `node_modules`
 * layout away from being false for the very error it names, and being wrong
 * here means telling somebody a delete "may already have been applied" when it
 * provably was not — sending them to check a system that never heard from us.
 */
function nothingWasSent(error: unknown): boolean {
  if (
    error instanceof ChannelContinuationRequiredError ||
    error instanceof ActionExpiredError ||
    error instanceof ActionContinuationMismatchError
  ) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    [
      "channel_continuation_required",
      "channel_action_expired",
      "channel_continuation_mismatch",
    ].includes(String((error as { code?: unknown }).code))
  );
}

/** What the card is replaced with when the answer never left it. */
function notSentCard(action: string) {
  return (
    <Message accent="#EB5757">
      <Header>{`⚠️ ${action} — not sent`}</Header>
      <Context>
        {"This answer was not sent: the card is expired, already answered, or no longer valid here. An earlier answer may already have run the action. Check its result before asking again."}
      </Context>
    </Message>
  );
}

/** What the card is replaced with when the answer may or may not have landed. */
function unknownOutcomeCard(action: string) {
  return (
    <Message accent="#EB5757">
      <Header>{`⚠️ ${action} — outcome unknown`}</Header>
      <Context>
        {"I lost contact with the agent after sending your answer, so I cannot say whether it ran. It may already have been applied — check before asking again."}
      </Context>
    </Message>
  );
}

/**
 * Send the answer, and say what is true when sending it fails.
 *
 * A `resume` that throws is usually not evidence that nothing happened. It
 * fails on the way out as readily as on the way in, so an approval whose
 * request reached the graph before the connection dropped has already been
 * applied — and the write with it. The card therefore reports an unknown
 * outcome rather than a paused one, and the answer is not re-armed: the same
 * approval sent twice is a second destructive write, not a retry, and the card
 * this replaces has no buttons left to retry from anyway.
 *
 * The one exception is the failure that happens before anything is sent (see
 * {@link nothingWasSent}). Warning that a write "may already have been applied"
 * when the SDK refused to send the approval at all is a false alarm about a
 * destructive action — the same defect as the false calm, pointed the other
 * way, and it costs somebody a hunt through Linear for a write nobody made.
 */
async function resumeOrShowFailure(
  thread: InteractionContext["thread"],
  messageRef: InteractionContext["message"]["ref"],
  action: string,
  confirmed: boolean,
  interruptId: string,
): Promise<void> {
  try {
    // A newer turn may pause while updating the receipt. A scalar resume would
    // answer that newer interrupt; LangGraph's ID map only answers this one.
    await thread.resume({ [interruptId]: { confirmed } });
  } catch (error) {
    try {
      await thread.update(
        messageRef,
        nothingWasSent(error) ? notSentCard(action) : unknownOutcomeCard(action),
      );
    } catch (updateError) {
      // Both the answer and the correction failed, so the thread is left
      // showing the optimistic receipt — "✅ Approved" — for a write nobody can
      // vouch for. Throwing says the click failed; it does not say that, and a
      // wrong receipt nobody logged is a wrong receipt nobody can find.
      reportRecoverableError(updateError, {
        operation: "confirm_write_outcome_unknown",
        recovery: "none_receipt_overstates_the_outcome",
      });
      throw new AggregateError(
        [error, updateError],
        `Failed to resume "${action}" and correct its receipt`,
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
 * Words whose presence makes an action irreversible. Matched against every word
 * of the action, not only the leading one: `NOTION_API_DELETE_A_BLOCK` reaches
 * this card as "API delete a block", and a list consulted with the first word
 * alone answers "API" — a protocol, not a verb, and not on any list of things
 * that destroy data.
 *
 * A word appearing anywhere is enough, which will occasionally warn about a
 * create whose arguments happen to mention an archive. That direction is the
 * cheap one: an unnecessary warning costs a moment's hesitation, and a missing
 * one costs the block.
 */
const DESTRUCTIVE = new Set([
  "delete",
  "deletes",
  "remove",
  "removes",
  "archive",
  "archives",
  "cancel",
  "cancels",
  "revoke",
  "revokes",
  "destroy",
  "drop",
  "purge",
  "trash",
  "wipe",
  "erase",
  "terminate",
  "deactivate",
  "uninstall",
  "unpublish",
]);

/** The label of the button that declines the write. */
const DECLINE_LABEL = "Cancel";

/** Every word of the action, lowercased, with punctuation and casing dropped. */
function wordsOf(action: string): string[] {
  return action
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The word that makes this action irreversible, if any of them do.
 *
 * Returned rather than answered yes/no, because where it sits decides how the
 * button may be labelled: a delete named by the leading word can say so, and
 * one buried further in cannot be summarised by the word in front of it.
 */
function destructiveWordOf(action: string): string | undefined {
  return wordsOf(action).find((word) => DESTRUCTIVE.has(word));
}

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
 * Falls back to `Confirm` twice over. Once when the verb would collide with the
 * decline button: `Cancel subscription` otherwise renders two buttons both
 * reading "Cancel", one cancelling the subscription and one cancelling the
 * request. And once when the action is destructive somewhere other than its
 * leading word — "API delete a block" would otherwise put `API` on the button
 * that deletes the block, and "Create a page in the archive database" would put
 * `Create` on a button this card is calling irreversible. Neither word is a
 * summary of the click; the header carries the action verbatim either way.
 *
 * Derived separately from the styling below, so relabelling never costs the
 * warning colour and the colour never costs the verb.
 */
function confirmLabel(verb: string, destructiveWord?: string): string {
  if (!verb) return "Confirm";
  if (verb.toLowerCase() === DECLINE_LABEL.toLowerCase()) return "Confirm";
  const namedByTheVerb = destructiveWord === verb.toLowerCase();
  return destructiveWord && !namedByTheVerb ? "Confirm" : verb;
}

/**
 * How the confirm button looks — and there are two answers, not three.
 *
 * `danger` for anything irreversible, and for anything nobody classified: an
 * unreadable or absent effect is an action nobody vouched for, styled the way
 * the agent's own `EffectMap.effect_for` reads it.
 *
 * No style at all for a classified `write`. Slack's `primary` is an
 * endorsement, and this card is never posted for anything but a change to
 * somebody's data — there is no reading of `write` under which the right thing
 * to show is a green button meaning "go ahead". `write` earns the absence of a
 * warning, which is what distinguishes it from `destructive`; it does not earn
 * a recommendation. Rendering it red instead would paint every card on the
 * surface red and teach approvers to click through the colour, which costs the
 * distinction this card exists to draw.
 */
function confirmStyle(dangerous: boolean): "danger" | undefined {
  return dangerous ? "danger" : undefined;
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

/** The refusal itself. Names nobody, so it is safe anywhere in the thread. */
const WRONG_APPROVER_NOTICE = (
  <Message accent="#E2B340">
    <Section>
      {"This one runs in someone else's connected account, so only they can approve it. The card is still waiting for them."}
    </Section>
  </Message>
);

/**
 * Whether the person who clicked is the one the agent named.
 *
 * The agent writes `platform:id`. Both halves must agree, because a provider id
 * is unique only within its provider and one deployment can serve two.
 *
 * There is no exception, and none is needed. `composio_tools.state` keeps a
 * closed `KNOWN_PLATFORMS`, and `_named_identity` refuses anything outside it,
 * so `actor_key` writes `slack:` or `teams:` or names nobody at all — never
 * `unknown:`, and never a bare id. Anything else reaching here is a shape this
 * side of the wire cannot account for, and a platform check with a prefix it
 * waves through is a platform check any producer can opt out of.
 */
function isNamedApprover(
  interaction: InteractionContext,
  approver: string,
): boolean {
  const clickedBy = (interaction.actor?.id ?? "").trim();
  // Nobody verified pressed this. Refusing costs a click; accepting spends
  // somebody's account on an unattributed press.
  //
  // Half of a pair with the `!namedId` check below, and each is redundant while
  // the other stands: two empty strings only compare equal when both sides are
  // empty. Deleting either leaves the suite green and the behaviour intact —
  // and leaves the remaining one load-bearing on its own, which is why both
  // stay. The equality is what must never be the whole of the test.
  if (!clickedBy) return false;

  const separator = approver.indexOf(":");
  // No separator, no platform half. Read as a bare id it would match on the id
  // alone, which is the whole of what this function exists to refuse.
  if (separator === -1) return false;
  const namedPlatform = approver.slice(0, separator).trim();
  const namedId = approver.slice(separator + 1).trim();
  // See the `!clickedBy` note above: `!namedId` is the other half of that pair.
  if (!namedId || namedId !== clickedBy) return false;

  // `composio_tools.state.actor_key` lowercases the platform before it writes
  // `approver`, so the surface's spelling has to be folded the same way.
  // Comparing raw, a surface reporting "Slack" missed `slack:U1` — and the only
  // person entitled to answer the card was the one person refused by it.
  return namedPlatform === (interaction.platform ?? "").trim().toLowerCase();
}

/**
 * Tell one person something only they need to hear, and never silently fail to.
 *
 * `postEphemeral` resolves to `null` on a surface with no ephemeral message —
 * the managed adapter reports exactly that — so an unchecked call is a message
 * that was never delivered and never reported. The refusal names nobody, so
 * when the private path cannot carry it the thread can.
 */
async function tellOrPost(interaction: InteractionContext): Promise<void> {
  try {
    const delivered = await interaction.thread.postEphemeral(
      interaction.actor,
      WRONG_APPROVER_NOTICE,
      { fallbackToDM: true },
    );
    if (delivered?.ok) return;
  } catch (error) {
    reportRecoverableError(error, {
      operation: "confirm_write_refusal_ephemeral",
      recovery: "post_refusal_in_thread",
    });
  }
  await interaction.thread.post(WRONG_APPROVER_NOTICE);
}

/**
 * Whether this click came from somebody other than the named approver.
 *
 * Enforced here rather than in the agent because only the surface knows who
 * pressed the button; the agent can say whose action it is and nothing more.
 * The wrong person is told and the graph is left paused, so the right person
 * can still answer.
 */
async function refuseWrongApprover(
  interaction: InteractionContext,
  approver: string | undefined,
): Promise<boolean> {
  if (!approver) return false;
  if (isNamedApprover(interaction, approver)) return false;

  try {
    await tellOrPost(interaction);
  } catch (error) {
    // The refusal stands whether or not it could be delivered. Falling through
    // to the click would hand somebody else's account to whoever pressed.
    reportRecoverableError(error, {
      operation: "confirm_write_refusal",
      recovery: "refused_without_telling_the_clicker",
    });
  }
  return true;
}

/** A saved sibling button may outlive the card it came from. */
async function tellStaleApprover(interaction: InteractionContext): Promise<void> {
  const notice = "This card has already been answered, expired, or been replaced. This click did not run anything; use the latest card or check the previous result.";
  try {
    const result = await interaction.thread.postEphemeral(
      interaction.actor,
      notice,
      { fallbackToDM: true },
    );
    if (result?.ok) return;
  } catch (error) {
    reportRecoverableError(error, {
      operation: "confirm_write_stale_notice",
      recovery: "post_notice_in_thread",
    });
  }
  await interaction.thread.post(notice);
}

type ClaimDecision = (conversation: string, id: string) => Promise<boolean>;

/** Dependencies live in the registered renderer, never in serialized card props. */
export function createConfirmWrite(claim: ClaimDecision) {
  return function ConfirmWrite(props: ConfirmWriteProps) {
    return renderConfirmWrite(props, claim);
  };
}

function renderConfirmWrite(
  {
    decisionId,
    interruptId,
    conversationKey,
    action,
    approver,
    fields,
    detail,
    attempt,
    previousError,
    effect,
  }: ConfirmWriteProps,
  claim: ClaimDecision,
) {
  const body = fields?.length
    ? fieldTable(fields)
    : detail
      ? <Section>{detail}</Section>
      : null;

  const retry = attempt && attempt > 1
    ? retryNotice(attempt, previousError)
    : null;

  const verb = verbOf(action);
  const destructiveWord = destructiveWordOf(action);
  const label = confirmLabel(verb, destructiveWord);
  // Either signal is enough, and neither can talk the other down. Only an
  // effect the card recognises as unalarming buys an unwarned button, so an
  // absent or unreadable classification is styled as destructive rather than
  // assumed safe. The action words still count: `readOnlyHint: false` alone
  // produces `write`, which a delete satisfies as readily as a rename. Never
  // derive this from `label`: relabeling an action cannot make it safe.
  const destructive =
    !NEUTRAL_EFFECTS.has(effect ?? "") || destructiveWord !== undefined;

  // The local flag avoids repeated work; the durable claim covers restored
  // renders, sibling buttons, and other runtime processes.
  let answered = false;

  const answer = async (
    interaction: InteractionContext,
    confirmed: boolean,
    resolvedCard: Parameters<InteractionContext["thread"]["update"]>[1],
  ): Promise<void> => {
    // Cheapest first, and the only one that costs nothing to ask: an answered
    // card has nothing to say to anybody, including the wrong person. Refusing
    // first told a colleague "the card is still waiting for them" about a card
    // that was waiting for nobody.
    if (answered) return;
    if (await refuseWrongApprover(interaction, approver)) return;
    // Read again on the far side of that await. The refusal path is I/O, and a
    // second press can land while it is in flight. Nothing between this check
    // and the assignment yields, so the pair cannot be interleaved.
    if (answered) return;
    const { thread, message } = interaction;
    if (
      !decisionId ||
      !conversationKey ||
      !interruptId ||
      !INTERRUPT_ID_PATTERN.test(interruptId)
    ) {
      await thread.post(
        "This approval card cannot identify the action it would answer. Update the agent and ask again for a fresh card; this click did not run anything.",
      );
      return;
    }
    // The UI Thread type omits this field, but the concrete SDK Thread copies
    // the ingress conversationKey unchanged. Check before consuming a token:
    // the SDK's later continuation binding rejection must leave it usable.
    if (
      !("conversationKey" in thread) ||
      thread.conversationKey !== conversationKey
    ) {
      await thread.post(
        "This approval belongs to a different conversation. Please use its original card; this click did not run anything.",
      );
      return;
    }
    answered = true;
    try {
      if (!(await claim(conversationKey, decisionId))) {
        await tellStaleApprover(interaction);
        return;
      }
    } catch (error) {
      reportRecoverableError(error, {
        operation: "confirm_write_decision",
        recovery: "refused_without_resuming",
      });
      await thread.post(
        "I could not safely record this approval, so I did not send your answer. Please ask again for a fresh card.",
      );
      return;
    }
    try {
      await thread.update(message.ref, resolvedCard);
    } catch (error) {
      // The card is the receipt, not the decision. A graph is paused on the
      // answer this person already gave, and throwing away an approval because
      // Slack would not repaint a message leaves it paused for good.
      //
      // The durable decision was already consumed, so neither visible button
      // can send a second answer even if this process restarts.
      reportRecoverableError(error, {
        operation: "confirm_write_card_update",
        recovery: "resumed_the_agent_anyway",
      });
    }
    await resumeOrShowFailure(thread, message.ref, action, confirmed, interruptId);
  };

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
          style={confirmStyle(destructive)}
          onClick={async (interaction: InteractionContext) => {
            await answer(
              interaction,
              true,
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
          }}
        >
          {label}
        </Button>
        {/*
          Never styled. Cancel is the one button on this card that changes
          nothing, and the red belongs on the irreversible choice — putting it
          here says the safe answer is the alarming one.
        */}
        <Button
          value={{ confirmed: false }}
          onClick={async (interaction: InteractionContext) => {
            await answer(
              interaction,
              false,
              <Message accent="#EB5757">
                <Header>{`🚫 ${action}`}</Header>
                <Context>{"🚫  Declined — nothing was written."}</Context>
              </Message>,
            );
          }}
        >
          Cancel
        </Button>
      </Actions>
    </Message>
  );
}
