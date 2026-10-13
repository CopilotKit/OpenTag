import {
  createChannel,
  type Channel,
  type ChannelTool,
  type CreateChannelOptions,
  type ProviderActor,
  type Thread,
} from "@copilotkit/channels";
import {
  managedRunInput,
  reportRecoverableError,
  userFacingRunError,
} from "./channel-helpers.js";
import { appCommands } from "./commands/index.js";
import { IssueCard, IssueList, PageList } from "./components/index.js";
import { createAppContext } from "./context/app-context.js";
import { DEFAULT_AGENT_DISPLAY_NAME } from "./env.js";
import { ConnectAccount } from "./human-in-the-loop/index.js";
import { createConfirmWrite } from "./human-in-the-loop/confirm-write.js";
import { createApprovalDecisions } from "./human-in-the-loop/approval-decisions.js";
import {
  parseInterrupt,
  type ConfirmWriteArgs,
  type ParsedInterrupt,
} from "./interrupt.js";
import { FILE_ISSUE_CALLBACK, fileIssueSubmit } from "./modals/file-issue.js";
import { IncidentCard } from "./tools/showcase-tools.js";
import { RenderChart } from "./tools/render-chart.js";
import { createAppTools } from "./tools/index.js";
import {
  subscribeThreadTool,
  unsubscribeThreadTool,
} from "./tools/thread-subscription.js";

type ChannelAgent = NonNullable<CreateChannelOptions["agent"]>;

/**
 * Whether a message is a person asking for something.
 *
 * `ProviderActor.kind` is the provider's own word for what sent a message, and
 * the Channels SDK documents it as untrusted metadata rather than
 * authorization — which is why it is read here as a filter and never as a
 * grant. `human` and nothing else, the same set the agent's
 * `composio_tools.state.PERSONAL_KINDS` admits, so both ends of the wire agree
 * about who is speaking: `bot` and `app` are the reply loop, `system` is the
 * platform talking about the channel rather than into it, and `unknown` is a
 * message the surface could not attribute to anybody — which is also what an
 * ingress carrying no actor at all is normalized to.
 *
 * Optional-chained like every other read of `actor` in this app. The Channel
 * normalizes one in, so this only ever fires for something that bypassed it —
 * and that should be refused, not turned into a `TypeError` where a decision
 * belongs.
 */
function isFromAPerson(message: { actor?: ProviderActor }): boolean {
  return message.actor?.kind === "human";
}

/**
 * Whether this is somebody asking, rather than the same ask arriving again.
 *
 * Posting an answer counts as a change to the message that asked for it, so
 * Slack re-announces that message with a fresh revision id and the original
 * author still on it. Read as a message it is indistinguishable from the person
 * asking a second time — same thread, same text, same human — so the answer
 * triggers the next question and the bot talks to itself. One mention produced
 * about fifty answers in a live workspace.
 *
 * The revision is the only thing that tells them apart, so it is what gets read.
 * A `created` message is a new ask. An `updated` one is not, and neither is a
 * `deleted` tombstone.
 *
 * The cost, stated rather than hidden: somebody who edits a message to add the
 * mention is not answered, and has to say it again. That is worth one loop.
 * CopilotKit#6717 fixes this properly, one layer down, by comparing the text
 * against the previous revision — evidence this side cannot see. Delete this
 * once the pinned `@copilotkit/channels` carries that fix.
 */
function isAFreshAsk(message: { operation?: { kind?: string } }): boolean {
  return (message.operation?.kind ?? "created") === "created";
}

/**
 * What the thread is told when its approval card could not be rendered.
 *
 * It speaks for the action it was gating and for nothing else. The card sits in
 * front of one tool call, and the turn that reached it may have written three
 * other things first — none of which this handler saw. "Nothing has been
 * changed" was a claim about the whole turn made by the one part of it that
 * cannot see any of that.
 *
 * What it can say is exact: no answer was ever collected, so the write behind
 * this card was never approved, so it did not run.
 */
const APPROVAL_CARD_FAILED =
  "⚠️ I could not show the approval card for that action, so it was not approved and has not run. Anything else in this turn may already have happened. Please ask again.";

/** Interrupt names safe to quote back into a thread verbatim. */
const INTERRUPT_NAME = /^[a-z0-9_.:-]{1,64}$/i;

/**
 * What the thread is told when the agent pauses for something this surface has
 * no handler for.
 *
 * The name is quoted because it is the only thing that makes the notice
 * actionable — and only the name, because the arguments belong to a request
 * nothing here could read, and a thread is not the place to paste them. A name
 * that is not a plain identifier is not quoted at all.
 */
function unsupportedInterruptNotice(action: string): string {
  const named = INTERRUPT_NAME.test(action)
    ? `\`${action}\``
    : "an unrecognised request";
  return (
    `⚠️ The agent paused for ${named}, which I do not know how to show, ` +
    "so I could not put it in front of you. Nothing was approved. Please ask again."
  );
}

/** Build the managed OpenTag Channel; Intelligence owns its platform adapters. */
export function createOpenTagChannel(
  name: string,
  agent: ChannelAgent,
  agentDisplayName = DEFAULT_AGENT_DISPLAY_NAME,
): Channel {
  const decisions = createApprovalDecisions(() => {
    const store = channel.adapters.find(
      (adapter) => adapter.stateStore,
    )?.stateStore;
    if (!store) throw new Error("The Channel has no durable approval store");
    return store;
  });
  const ConfirmWrite = createConfirmWrite(decisions.claim);
  const channel = createChannel({
    name,
    agent,
    identifyUser: "platform",
    tools: createAppTools(agentDisplayName),
    context: [...createAppContext(agentDisplayName)],
    commands: appCommands,
    components: [
      IssueCard,
      IssueList,
      PageList,
      IncidentCard,
      ConfirmWrite,
      // Load-bearing, not bookkeeping: once the in-process cache is gone, a
      // click is served by re-rendering the named component from here. An
      // unregistered card's buttons raise an error the Channel swallows, so the
      // person clicks and nothing happens at all. `ConnectAccount` exists to be
      // pressed minutes later, by several different people.
      ConnectAccount,
      RenderChart,
    ],
  });

  type MessageHandlerInput = Parameters<
    Parameters<typeof channel.onMessage>[0]
  >[0];

  const runAgentSafely = async (
    { thread, message }: MessageHandlerInput,
    conditionalTools: ChannelTool[],
  ) => {
    try {
      await thread.runAgent(managedRunInput(message, conditionalTools));
    } catch (error) {
      try {
        await thread.post(
          userFacingRunError(error, { sourceText: message.text }),
        );
      } catch (postError) {
        const bothFailed = new AggregateError(
          [error, postError],
          "The agent run and its user-facing error reply both failed",
        );
        // Recorded here because there is nowhere else. This handler is
        // unguarded, the Channel takes the throw and keeps no copy of it, and
        // the user was never told either — so without this line the turn
        // simply stops, and both reasons stop with it.
        reportRecoverableError(bothFailed, {
          operation: "run_agent_error_reply",
          recovery: "none_the_user_was_never_told",
        });
        throw bothFailed;
      }

      // A failed turn is isolated from future turns. Once the user receives an
      // explicit failure response, the Channel can safely remain available.
      reportRecoverableError(error, {
        operation: "run_agent",
        recovery: "posted_user_facing_error",
      });
    }
  };

  /**
   * Whether this thread is one the bot follows — with `unknown` as an answer.
   *
   * Three values rather than two because the two call sites below want
   * different things from a store that cannot answer. On a mention it decides
   * which subscription tool the run offers, and the mention is answered either
   * way. On an unmentioned turn it is the WHOLE gate, and a `false` invented
   * for an unreadable store drops the next thing somebody says in a thread the
   * bot is following — silently, which from their side looks like being
   * ignored. Collapsing the two into one boolean is what made a store blip
   * cost a turn.
   */
  const readSubscription = async (
    thread: MessageHandlerInput["thread"],
  ): Promise<"following" | "not-following" | "unknown"> => {
    try {
      return (await thread.isSubscribed()) ? "following" : "not-following";
    } catch (error) {
      reportRecoverableError(error, {
        operation: "read_thread_subscription",
        recovery: "asked_the_thread_instead",
      });
      return "unknown";
    }
  };

  /**
   * Whether this Channel has been posting in this thread.
   *
   * The second source, consulted only when the store cannot say. A thread the
   * bot has been answering in is one it belongs in, and that is a fact the
   * conversation itself carries — no store required. It is a weaker signal
   * than a subscription (a one-off mention answered here also leaves a bot
   * message behind) and it is deliberately the weaker mistake: over-answering
   * inside a conversation the bot is already part of, rather than either
   * dropping a follow-up or barging into every thread on the workspace for as
   * long as the outage lasts.
   */
  const hasSpokenHere = async (
    thread: MessageHandlerInput["thread"],
  ): Promise<boolean> => {
    try {
      const history = await thread.getMessages();
      return Array.isArray(history) && history.some((m) => m.isBot === true);
    } catch (error) {
      reportRecoverableError(error, {
        operation: "read_thread_participation",
        recovery: "treat_as_a_thread_we_are_not_in",
      });
      return false;
    }
  };

  /**
   * Say something in the thread, and log it when the thread will not take it.
   *
   * The last step of every failure path here, so the failure of the last step
   * is the one place a failure cannot be reported anywhere else.
   */
  const tellThread = async (
    thread: Pick<Thread, "post">,
    text: string,
    operation: string,
  ): Promise<void> => {
    try {
      await thread.post(text);
    } catch (postError) {
      reportRecoverableError(postError, {
        operation,
        recovery: "none_the_thread_shows_nothing",
      });
    }
  };

  channel.onMention(async ({ thread, message }) => {
    if (!isFromAPerson(message) || !isAFreshAsk(message)) return;

    const subscription = await readSubscription(thread);
    if (subscription === "following") {
      await runAgentSafely({ thread, message }, [unsubscribeThreadTool]);
      return;
    }
    if (subscription === "unknown") {
      // A mention is answered whatever the store is doing. No subscription
      // tool is offered with it: the run would be acting on a state nobody
      // could read, and "unsubscribe" from a thread that was never subscribed
      // is an answer to a question the user did not ask.
      await runAgentSafely({ thread, message }, []);
      return;
    }

    // Only a history that positively says so. Following a thread is a standing
    // commitment to answer everything said in it from here on, and it is taken
    // on the strength of one read: an empty history on the managed adapter,
    // whose transcript excludes the in-flight turn, or a single message on a
    // local one, where the mention itself is that message. A read that failed
    // says nothing about either, and used to say "new".
    let isNewConversation = false;
    try {
      const history = await thread.getMessages();
      isNewConversation = Array.isArray(history) && history.length <= 1;
    } catch (error) {
      reportRecoverableError(error, {
        operation: "get_thread_history",
        recovery: "answered_without_following",
      });
    }

    if (isNewConversation) {
      try {
        await thread.subscribe();
      } catch (error) {
        // Following the thread is an affordance for later turns. This turn is
        // an answered mention either way, and a failed write here used to
        // throw past the run that had not happened yet.
        reportRecoverableError(error, {
          operation: "record_thread_subscription",
          recovery: "answered_without_subscribing",
        });
      }
      await runAgentSafely({ thread, message }, [unsubscribeThreadTool]);
      return;
    }

    await runAgentSafely({ thread, message }, [subscribeThreadTool]);
  });

  channel.onMessage(async ({ thread, message }) => {
    if (!isFromAPerson(message) || !isAFreshAsk(message)) return;

    const subscription = await readSubscription(thread);
    if (subscription === "following") {
      await runAgentSafely({ thread, message }, [unsubscribeThreadTool]);
      return;
    }
    if (subscription === "not-following") return;

    if (await hasSpokenHere(thread)) {
      await runAgentSafely({ thread, message }, []);
      return;
    }
    // Nothing said the bot belongs in this thread, so it stays out — but a
    // dropped turn that nobody can see is the same defect one layer down, so
    // it says so where an operator can find it.
    reportRecoverableError(
      new Error(
        "Unreadable subscription in a thread this Channel has not posted in",
      ),
      {
        operation: "skipped_unmentioned_turn",
        recovery: "answer_by_mention",
      },
    );
  });

  channel.onModalSubmit(FILE_ISSUE_CALLBACK, fileIssueSubmit);

  channel.onInterrupt("on_interrupt", async ({ payload, thread }) => {
    let interrupt: ParsedInterrupt;
    try {
      interrupt = parseInterrupt(payload);
    } catch (error) {
      // The only handler here that had no guard, and the one whose failure is
      // least visible: `parseInterrupt` throws on a payload it cannot read,
      // the graph stays paused on a question nobody was asked, and the thread
      // showed the parser's own words — "I hit an error: ZodError: [." —
      // logged as a run that recovered.
      reportRecoverableError(error, {
        operation: "confirm_write_interrupt",
        recovery: "posted_card_failure_notice",
      });
      await tellThread(
        thread,
        APPROVAL_CARD_FAILED,
        "confirm_write_interrupt_notice",
      );
      return;
    }

    if (interrupt.kind !== "confirm_write") {
      // Not this surface's card to render, and not a failure of it. Reported
      // under its own name so the log says which handler is missing rather
      // than implicating the one that works.
      //
      // The graph stays paused either way, here and below. `Thread.resume`
      // needs the one-use continuation a button click carries, and this Thread
      // came from a turn — so answering the interrupt from inside the handler
      // that failed to ask the question rejects with
      // `ChannelContinuationRequiredError` before it sends anything. Which is
      // why the notice tells the person what to do instead of implying the
      // agent has moved on.
      reportRecoverableError(
        new Error(`No handler for interrupt "${interrupt.action}"`),
        {
          operation: "unsupported_interrupt",
          recovery: "posted_unsupported_notice",
        },
      );
      await tellThread(
        thread,
        unsupportedInterruptNotice(interrupt.action),
        "unsupported_interrupt_notice",
      );
      return;
    }

    if (!interrupt.interruptId) {
      await tellThread(
        thread,
        "I could not safely identify this approval, so I did not show an actionable card. Update the agent and ask again for a fresh approval; this action has not run.",
        "confirm_write_missing_interrupt_id",
      );
      return;
    }

    try {
      const decisionId = await decisions.register(thread.conversationKey);
      await postConfirmWriteCard(thread, interrupt.args, ConfirmWrite, decisionId, interrupt.interruptId);
    } catch (error) {
      reportRecoverableError(error, {
        operation: "confirm_write_interrupt",
        recovery: "posted_card_failure_notice",
      });
      await tellThread(
        thread,
        APPROVAL_CARD_FAILED,
        "confirm_write_interrupt_notice",
      );
    }
  });

  channel.onThreadStarted(async ({ thread, user }) => {
    if (!user?.name) return;

    try {
      // `{ ok: false }`, not a throw, is how a surface with no prompt pane
      // answers — and how the adapter reports a call it rejected. A `catch`
      // alone watches the one door this failure does not come through.
      const result = await thread.setSuggestedPrompts([
        {
          title: "Synthesize this discussion",
          message:
            "Summarize this thread into key findings, decisions, open questions, and next steps",
        },
        {
          title: "Help me make a decision",
          message:
            "Compare the options in this thread and recommend a path forward",
        },
      ]);
      if (!result?.ok) {
        reportRecoverableError(
          new Error(result?.error ?? "suggested prompts were not set"),
          {
            operation: "set_suggested_prompts",
            recovery: "continue_without_suggested_prompts",
          },
        );
      }
    } catch (error) {
      // Suggested prompts are an optional affordance; their absence does not
      // affect message delivery, agent execution, or later thread turns.
      reportRecoverableError(error, {
        operation: "set_suggested_prompts",
        recovery: "continue_without_suggested_prompts",
      });
    }
  });

  return channel;
}

/**
 * Post the approval card this interrupt is asking for.
 *
 * Extracted so the handler above is a guard and nothing else.
 */
async function postConfirmWriteCard(
  thread: Pick<Thread, "post" | "conversationKey">,
  args: ConfirmWriteArgs,
  ConfirmWrite: ReturnType<typeof createConfirmWrite>,
  decisionId: string,
  interruptId: string,
): Promise<void> {
  await thread.post(
    <ConfirmWrite
      decisionId={decisionId}
      interruptId={interruptId}
      conversationKey={thread.conversationKey}
      action={args.action}
      approver={args.approver ?? undefined}
      fields={args.fields ?? undefined}
      detail={args.detail ?? undefined}
      attempt={args.attempt ?? undefined}
      previousError={args.previous_error ?? undefined}
      // The agent looked the slug up and decided what it does. Dropping that
      // here left the card guessing from the action's first word, which for
      // every Composio action is the name of the app.
      effect={args.effect ?? undefined}
    />,
  );
}
