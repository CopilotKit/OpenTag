/**
 * Developer-only Slack Block Kit regression harness. Not a product feature and
 * not a component — nothing in OpenTag's normal behaviour reaches this file.
 *
 * Mentioning the bot with `test-run` posts every block, element and composition
 * object the Channels Slack catalog claims to support, **one per message**, so a
 * human can look at each one and click it. Interactive controls report back what
 * actually arrived, so a control that renders but never dispatches is visible as
 * silence rather than passing unnoticed.
 *
 * Three properties are load-bearing:
 *
 * 1. **Gated, and absent rather than declining.** `OPENTAG_BLOCK_DEBUG_TEST=1`
 *    or the harness never runs. With the variable unset `createBlockTestRunHook`
 *    returns nothing, so `app/channel.tsx` installs no hook at all and a mention
 *    reaches the agent exactly as it does without this file.
 * 2. **One message per item, each in its own try/catch — and the known-bad ones
 *    last.** Measured here on 2026-08-13: a refusal does not just lose its own
 *    message, it terminates the whole *turn's* delivery. `element:rich_text_input`
 *    was refused with `invalid field at /blocks/1` and the fifteen posts behind
 *    it — every one of them a payload that had delivered a minute earlier —
 *    never went out, and the summary went with them. The try/catch keeps the
 *    loop alive but cannot re-open the path: a delivery belongs to the turn, and
 *    the SDK exposes no way to start a second one. So the run instead (a) sorts
 *    every payload with a recorded expectation of refusal into a tail, (b) posts
 *    its summary before that tail, and (c) stops attempting once the path is
 *    terminated, reporting the remainder as `blocked` rather than as a refusal
 *    they did not earn.
 *
 *    That makes the tail's own verdicts collateral rather than earned, so the
 *    only way to get a real verdict for a tail item is to give it a delivery of
 *    its own: `test-run <substring>` runs just the entries whose key contains
 *    that substring. Every tail item's verdict below was taken that way.
 * 3. **Derived from the SDK's own manifest.** The payloads below are the
 *    live-verified corpus from `channels-slack`'s catalog fixtures; the
 *    accounting test in `__tests__/block-testrun.test.ts` diffs this list
 *    against `SLACK_NATIVE_MANIFEST`, so a catalog entry added upstream fails
 *    the build instead of silently going untested.
 */
import type {
  ChannelNode,
  ClickHandler,
  InteractionContext,
  Renderable,
} from "@copilotkit/channels";
import {
  channelDeliveryErrorDetails,
  isChannelDeliveryTerminatedError,
} from "@copilotkit/channels";
import { Slack } from "@copilotkit/channels/slack";

/** Only this value arms the harness; anything else leaves OpenTag untouched. */
export const BLOCK_TESTRUN_ENV_VAR = "OPENTAG_BLOCK_DEBUG_TEST";

/** The phrase that starts a run, matched anywhere in the mention text. */
export const BLOCK_TESTRUN_TRIGGER = "test-run";

/**
 * Printed at the top of every run. Bump it when changing this file: a run whose
 * log does not show the current marker was served by a stale process, which has
 * twice been mistaken here for a product defect.
 */
const BLOCK_TESTRUN_MARKER = "block-testrun/5";

/**
 * Slack special-tiers `chat.postMessage` at roughly one call per second per
 * channel. A 60-message run fired flat out gets rate-limited, and a throttled
 * message is refused with an error that looks nothing like a Block Kit problem —
 * which would make the harness lie about the thing it exists to measure.
 */
const POST_INTERVAL_MS = 1_100;

/**
 * Every image URL in the run. Slack fetches image URLs at post time and refuses
 * the whole message when the fetch fails, so the host has to be both live and
 * stable — a randomised picsum path occasionally is not, an id-pinned one is.
 */
const IMAGE = "https://picsum.photos/id/1015";

const mrkdwn = (text: string) => Slack.Object.MarkdownText({ text });
const plain = (text: string) => Slack.Object.PlainText({ text });
const rawText = (text: string) => ({ type: "raw_text", text });
const richRun = (text: string) => Slack.Object.RichTextText({ text });

const SERVICES: ReadonlyArray<[string, string]> = [
  ["Payments", "payments"],
  ["Checkout", "checkout"],
  ["Search", "search"],
];

const option = (label: string, value: string) =>
  Slack.Object.Option({ text: plain(label), value });
const serviceOptions = SERVICES.map(([label, value]) => option(label, value));

/**
 * The return path. Delivery is only half the question — an element that renders
 * but whose value never reaches a handler is still broken — so every interactive
 * item carries this. It posts what actually arrived, raw value and JavaScript
 * type, as a threaded reply so a human clicking sees it immediately.
 *
 * Note what it can and cannot prove. When an element declares a static `value`
 * prop the SDK replays that authored value to the handler instead of Slack's
 * echo, so a value-carrying button proves the round-trip only up to that
 * substitution. Controls that carry no `value` (every picker, every input) report
 * genuinely what Slack sent, and `ctx.values` carries the input-block state.
 */
function reports(item: string): ClickHandler {
  return async ({ thread, action, values }: InteractionContext) => {
    const state =
      values && Object.keys(values).length > 0
        ? `\nstate: \`${json(values)}\``
        : "";

    console.log("[block-testrun] interaction", {
      item,
      actionId: action.id,
      value: action.value,
      type: typeOf(action.value),
      values,
    });

    await thread.post(
      `↩︎ **${item}** → ${describeArrival(action.value)}${state}`,
    );
  };
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function describeArrival(value: unknown): string {
  if (value === undefined) {
    return "nothing arrived (`undefined`) — the control dispatched but carried no value";
  }
  return `\`${json(value)}\` (type \`${typeOf(value)}\`)`;
}

/**
 * Host an element in an `actions` block. Slack accepts only buttons, single
 * selects, overflow menus and date pickers here; a multi-select or a text input
 * refuses the whole message with `invalid field at /blocks/N`, naming the block
 * and never the offending element. Everything else goes in `inInput`.
 */
const inActions = (element: ChannelNode): ChannelNode =>
  Slack.Block.Actions({ elements: [element] });

/**
 * Host an element in an `input` block — required for text fields and for every
 * multi-select.
 *
 * `dispatch_action` is what separates this harness from the SDK's fixtures: an
 * input block in a *message* never sends a `block_actions` payload unless it is
 * set, so without it every input-hosted control here would render perfectly and
 * report nothing, and the silence would be the harness's fault rather than a
 * finding.
 */
const inInput = (label: string, element: ChannelNode): ChannelNode =>
  Slack.Block.Input({
    label: plain(label),
    dispatch_action: true,
    element,
  } as never);

/** Put rich-text nodes in the `rich_text` block that has to carry them. */
const inRichText = (...elements: ChannelNode[]): ChannelNode =>
  Slack.Block.RichText({ elements });

/** One item of a run: a catalog entry and the payload that exercises it. */
export interface BlockTestRunItem {
  /** `${kind}:${type}` — the `SLACK_NATIVE_MANIFEST` entry this covers. */
  readonly key: string;
  /** What a human should be looking at, shown above the payload. */
  readonly label: string;
  /** The payload, authored through the public `Slack.*` namespace. */
  readonly node: ChannelNode;
  /**
   * Set when the SDK's live corpus already records a refusal for reasons
   * outside the SDK — a placeholder URL Slack cannot resolve, a workflow that
   * does not exist. Reported alongside the refusal so an expected failure reads
   * differently from a regression.
   */
  readonly expectedRefusal?: string;
}

/** A catalog entry that cannot be posted from a message at all. */
export interface BlockTestRunSkip {
  readonly key: string;
  readonly reason: string;
}

const BLOCK_ITEMS: readonly BlockTestRunItem[] = [
  {
    key: "block:section",
    label: "Section with mrkdwn text",
    node: Slack.Block.Section({ text: mrkdwn("*INC-421* checkout latency") }),
  },
  {
    key: "block:header",
    label: "Header",
    node: Slack.Block.Header({ text: plain("Incident review") }),
  },
  {
    key: "block:markdown",
    label: "Markdown block",
    node: Slack.Block.Markdown({ text: "**Impact**: 3% of checkouts" }),
  },
  {
    key: "block:divider",
    label: "Divider",
    node: Slack.Block.Divider({}),
  },
  {
    key: "block:context",
    label: "Context with one mrkdwn element",
    node: Slack.Block.Context({ elements: [mrkdwn("Updated 2m ago")] }),
  },
  {
    key: "block:actions",
    label: "Actions with one button — click it",
    node: Slack.Block.Actions({
      elements: [
        Slack.Element.Button({
          text: plain("Acknowledge"),
          onClick: reports("block:actions button"),
        }),
      ],
    }),
  },
  {
    key: "block:image",
    label: "Image",
    node: Slack.Block.Image({
      image_url: `${IMAGE}/800/400`,
      alt_text: "Checkout latency over the last hour",
    }),
  },
  {
    key: "block:input",
    label: "Input hosting a plain-text field — type and press enter",
    node: inInput(
      "Root cause",
      Slack.Element.PlainTextInput({
        multiline: true,
        onSubmit: reports("block:input plain_text_input"),
      }),
    ),
  },
  {
    key: "block:table",
    label: "Table with a header row and one data row",
    node: Slack.Block.Table({
      rows: [
        [rawText("Service"), rawText("p99")],
        [rawText("checkout"), rawText("1.9s")],
      ],
    } as never),
  },
  {
    key: "block:video",
    label: "Video",
    node: Slack.Block.Video({
      alt_text: "Incident walkthrough",
      title: plain("Incident walkthrough"),
      title_url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      thumbnail_url: `${IMAGE}/400/225`,
      video_url: "https://www.youtube.com/embed/aqz-KE-bpKQ",
    } as never),
  },
  {
    key: "block:rich_text",
    label: "Rich text: bold, code, a link and a bulleted list",
    // A single unstyled run renders identically to a plain section and would
    // prove only delivery, so this exercises styled runs, a link and a list.
    // `link` has no catalog entry at all, which is why it is a bare object.
    node: inRichText(
      Slack.Object.RichTextSection({
        elements: [
          richRun("Rolled back "),
          Slack.Object.RichTextText({
            text: "checkout-api",
            style: { bold: true },
          } as never),
          richRun(" at "),
          Slack.Object.RichTextText({
            text: "14:32",
            style: { code: true },
          } as never),
          richRun(" — "),
          {
            type: "link",
            url: "https://example.com/inc-421",
            text: "INC-421",
          } as unknown as ChannelNode,
        ],
      }),
      Slack.Object.RichTextList({
        style: "bullet",
        elements: [
          Slack.Object.RichTextSection({
            elements: [richRun("Error rate normal")],
          }),
          Slack.Object.RichTextSection({
            elements: [richRun("p99 back under SLO")],
          }),
        ],
      }),
    ),
  },
  {
    key: "block:data_visualization",
    label: "Data visualization (pie)",
    node: Slack.Block.DataVisualization({
      title: "Error budget",
      chart: {
        type: "pie",
        segments: [
          { label: "Consumed", value: 62 },
          { label: "Remaining", value: 38 },
        ],
      },
    }),
  },
  {
    key: "block:data_table",
    label: "Data table with required caption",
    node: Slack.Block.DataTable({
      caption: "Open incidents",
      rows: [
        [rawText("Incident"), rawText("Owner")],
        [rawText("INC-421"), rawText("Payments")],
      ],
    } as never),
  },
  {
    key: "block:card",
    label: "Card with title, body and one action — click it",
    node: Slack.Block.Card({
      title: mrkdwn("Payments service"),
      body: mrkdwn("Latency above SLO for 12 minutes."),
      actions: [
        Slack.Element.Button({
          text: plain("Open runbook"),
          onClick: reports("block:card button"),
        }),
      ],
    }),
  },
  {
    key: "block:carousel",
    label: "Carousel with three cards — scroll it sideways",
    // One card renders as a card, so a single-card payload cannot show the one
    // thing this block does that Card does not: scroll.
    node: Slack.Block.Carousel({
      block_id: "carousel-services",
      elements: [
        {
          id: "card-payments",
          title: "Payments",
          body: "p99 1.9s · above SLO",
        },
        { id: "card-checkout", title: "Checkout", body: "p99 0.8s · healthy" },
        { id: "card-search", title: "Search", body: "p99 1.2s · degraded" },
      ].map((card) =>
        Slack.Block.Card({
          block_id: card.id,
          title: mrkdwn(card.title),
          body: mrkdwn(card.body),
        }),
      ),
    }),
  },
  {
    key: "block:container",
    label: "Container: four grouped blocks, collapsible",
    // A container holding one block looks exactly like a card. What separates
    // it is grouping several *blocks* under one heading and collapsing them, so
    // the payload has to show both. `has_header_divider` is deliberately absent:
    // the reference says it applies only when the block is not collapsible, and
    // setting both is refused on delivery.
    node: Slack.Block.Container({
      title: plain("Bulk update: 3 incidents"),
      subtitle: plain("Review before confirming"),
      is_collapsible: true,
      children: [
        Slack.Block.Section({ text: mrkdwn("*INC-421* Payments → closed") }),
        Slack.Block.Section({ text: mrkdwn("*INC-422* Checkout → closed") }),
        Slack.Block.Divider({}),
        Slack.Block.Actions({
          elements: [
            Slack.Element.Button({
              text: plain("Confirm all"),
              onClick: reports("block:container button"),
            }),
          ],
        }),
      ],
    } as never),
  },
  {
    key: "block:task_card",
    label: "Task card, on its own",
    // Slack types `title` on task_card and plan as a bare String, not a text
    // object; passing `plain_text` here is refused on delivery. A standalone
    // task_card also cannot share a message with a `plan`, which is why these
    // are two separate items rather than one combined payload.
    node: Slack.Block.TaskCard({
      task_id: "call_001",
      title: "Fetched incident timeline",
      status: "complete",
    } as never),
  },
  {
    key: "block:plan",
    label: "Plan with one task card",
    node: Slack.Block.Plan({
      title: "Triage plan",
      children: [
        Slack.Block.TaskCard({
          task_id: "call_001",
          title: "Fetched incident timeline",
          status: "complete",
        } as never),
      ],
    }),
  },
  {
    key: "block:context_actions",
    label: "Context actions with feedback buttons — click one",
    node: Slack.Block.ContextActions({
      elements: [
        Slack.Element.FeedbackButtons({
          positive_button: {
            text: { type: "plain_text", text: "👍" },
            value: "up",
          },
          negative_button: {
            text: { type: "plain_text", text: "👎" },
            value: "down",
          },
          onClick: reports("block:context_actions feedback_buttons"),
        } as never),
      ],
    }),
  },
];

const ELEMENT_ITEMS: readonly BlockTestRunItem[] = [
  {
    key: "element:button",
    label: "Button, primary style — click it",
    node: inActions(
      Slack.Element.Button({
        text: plain("Acknowledge"),
        style: "primary",
        value: "ack",
        onClick: reports("element:button"),
      }),
    ),
  },
  {
    key: "element:static_select",
    label: "Select menu, three options, one preselected — change it",
    node: inActions(
      Slack.Element.StaticSelect({
        placeholder: plain("Pick a service"),
        options: serviceOptions,
        initial_option: option("Checkout", "checkout"),
        onSelect: reports("element:static_select"),
      }),
    ),
  },
  {
    key: "element:multi_static_select",
    label: "Multi-select, two preselected — change the selection",
    node: inInput(
      "Affected services",
      Slack.Element.MultiStaticSelect({
        options: serviceOptions,
        initial_options: [
          option("Payments", "payments"),
          option("Search", "search"),
        ],
        onSelect: reports("element:multi_static_select"),
      }),
    ),
  },
  {
    key: "element:external_select",
    label: "External select — expected to open empty",
    // Opening the menu makes Slack call an Options Load URL. Nothing in the SDK
    // or in Intelligence serves `block_suggestion`, so the menu has nothing to
    // populate from: it delivers and is not usable. Kept in the run so the gap
    // stays visible rather than being remembered.
    node: inActions(
      Slack.Element.ExternalSelect({
        placeholder: plain("Search services"),
        min_query_length: 2,
        onSelect: reports("element:external_select"),
      }),
    ),
  },
  {
    key: "element:multi_external_select",
    label: "Multi external select — expected to open empty",
    node: inInput(
      "Services",
      Slack.Element.MultiExternalSelect({
        min_query_length: 2,
        onSelect: reports("element:multi_external_select"),
      }),
    ),
  },
  {
    key: "element:users_select",
    label: "User picker — pick someone",
    node: inActions(
      Slack.Element.UsersSelect({
        placeholder: plain("Assign to"),
        onSelect: reports("element:users_select"),
      }),
    ),
  },
  {
    key: "element:multi_users_select",
    label: "Multi user picker — pick two",
    node: inInput(
      "Responders",
      Slack.Element.MultiUsersSelect({
        max_selected_items: 3,
        onSelect: reports("element:multi_users_select"),
      }),
    ),
  },
  {
    key: "element:conversations_select",
    label: "Conversation picker — pick one",
    node: inActions(
      Slack.Element.ConversationsSelect({
        placeholder: plain("Post updates to"),
        onSelect: reports("element:conversations_select"),
      }),
    ),
  },
  {
    key: "element:multi_conversations_select",
    label: "Multi conversation picker — pick two",
    node: inInput(
      "Notify",
      Slack.Element.MultiConversationsSelect({
        max_selected_items: 2,
        onSelect: reports("element:multi_conversations_select"),
      }),
    ),
  },
  {
    key: "element:channels_select",
    label: "Channel picker — pick one",
    node: inActions(
      Slack.Element.ChannelsSelect({
        placeholder: plain("Escalate in"),
        onSelect: reports("element:channels_select"),
      }),
    ),
  },
  {
    key: "element:multi_channels_select",
    label: "Multi channel picker — pick two",
    node: inInput(
      "Channels",
      Slack.Element.MultiChannelsSelect({
        max_selected_items: 2,
        onSelect: reports("element:multi_channels_select"),
      }),
    ),
  },
  {
    key: "element:datepicker",
    label: "Date picker with an initial date — change it",
    node: inActions(
      Slack.Element.DatePicker({
        initial_date: "2026-08-11",
        placeholder: plain("Target date"),
        onSelect: reports("element:datepicker"),
      }),
    ),
  },
  {
    key: "element:timepicker",
    label: "Time picker with an initial time — change it",
    node: inActions(
      Slack.Element.TimePicker({
        initial_time: "14:32",
        placeholder: plain("Cutover at"),
        onSelect: reports("element:timepicker"),
      }),
    ),
  },
  {
    key: "element:datetimepicker",
    label: "Date-and-time picker — change it",
    node: inActions(
      Slack.Element.DateTimePicker({
        initial_date_time: 1786451118,
        onSelect: reports("element:datetimepicker"),
      } as never),
    ),
  },
  {
    key: "element:checkboxes",
    label: "Checkboxes, three options, two ticked — tick another",
    node: inInput(
      "Rollback steps done",
      Slack.Element.Checkboxes({
        options: serviceOptions,
        initial_options: [
          option("Payments", "payments"),
          option("Checkout", "checkout"),
        ],
        onSelect: reports("element:checkboxes"),
      }),
    ),
  },
  {
    key: "element:radio_buttons",
    label: "Radio buttons with one preselected — pick another",
    node: inInput(
      "Severity",
      Slack.Element.RadioButtons({
        options: serviceOptions,
        initial_option: option("Search", "search"),
        onSelect: reports("element:radio_buttons"),
      }),
    ),
  },
  {
    key: "element:overflow",
    label: "Overflow menu, one entry opening a link — pick either",
    node: inActions(
      Slack.Element.Overflow({
        options: [
          option("Snooze 1h", "snooze"),
          Slack.Object.Option({
            text: plain("Open runbook"),
            value: "runbook",
            url: "https://example.com/runbook",
          }),
        ],
        onSelect: reports("element:overflow"),
      }),
    ),
  },
  {
    key: "element:plain_text_input",
    label: "Multiline text field with an initial value — edit and press enter",
    node: inInput(
      "Root cause",
      Slack.Element.PlainTextInput({
        multiline: true,
        initial_value: "Connection pool exhausted",
        placeholder: plain("What happened?"),
        onSubmit: reports("element:plain_text_input"),
      }),
    ),
  },
  {
    key: "element:number_input",
    label: "Number field, decimals allowed, bounded — edit it",
    // Slack's field is `is_decimal_allowed`. SlackNativeProps declares
    // `decimal_allowed`, a name Slack does not accept, so the documented name
    // has to come in through the cast.
    node: inInput(
      "Error budget spent (%)",
      Slack.Element.NumberInput({
        is_decimal_allowed: true,
        min_value: "0",
        max_value: "100",
        initial_value: "62",
        onSubmit: reports("element:number_input"),
      } as never),
    ),
  },
  {
    key: "element:email_text_input",
    label: "Email field — edit it",
    node: inInput(
      "Notify on close",
      Slack.Element.EmailInput({
        initial_value: "oncall@example.com",
        onSubmit: reports("element:email_text_input"),
      }),
    ),
  },
  {
    key: "element:url_text_input",
    label: "URL field — edit it",
    node: inInput(
      "Runbook",
      Slack.Element.UrlInput({
        initial_value: "https://example.com/runbook",
        onSubmit: reports("element:url_text_input"),
      }),
    ),
  },
  {
    key: "element:rich_text_input",
    label: "Rich text field — type in it",
    // Slack requires `action_id` on this element and the codec emits one only
    // when a handler is attached, so the SDK's handler-less fixture is recorded
    // as refused. Here it carries a handler, which is the only way this element
    // is authorable at all — so this item is also the test of that claim.
    //
    // Live-verified 2026-08-13, twice, in its own delivery: Slack refuses it
    // anyway with `invalid_blocks: invalid field at /blocks/1` — /blocks/1 being
    // the input block that hosts it. Recorded as an expected refusal so it runs
    // in the tail: in the main pass its refusal closed the delivery and cost the
    // fifteen items behind it their verdicts, and the summary with them.
    expectedRefusal:
      "Slack refuses an input block hosting rich_text_input in a message " +
      "(invalid_blocks at the input block). Delivers in a modal, not here.",
    node: inInput(
      "Postmortem notes",
      Slack.Element.RichTextInput({
        placeholder: plain("What did we learn?"),
        onSubmit: reports("element:rich_text_input"),
      }),
    ),
  },
  {
    key: "element:image",
    label: "Image element inside a context block",
    node: Slack.Block.Context({
      elements: [
        Slack.Element.Image({
          image_url: `${IMAGE}/48/48`,
          alt_text: "Service icon",
        }),
        mrkdwn("Payments · p99 1.9s"),
      ],
    }),
  },
  {
    key: "element:feedback_buttons",
    label: "Feedback buttons — click one",
    node: Slack.Block.ContextActions({
      elements: [
        Slack.Element.FeedbackButtons({
          positive_button: {
            text: { type: "plain_text", text: "👍" },
            value: "up",
          },
          negative_button: {
            text: { type: "plain_text", text: "👎" },
            value: "down",
          },
          onClick: reports("element:feedback_buttons"),
        } as never),
      ],
    }),
  },
  {
    key: "element:icon_button",
    label: "Icon button — click it",
    // `trash` is the only icon name verified to be accepted; anything else is
    // refused with no useful error.
    node: Slack.Block.ContextActions({
      elements: [
        Slack.Element.IconButton({
          icon: "trash",
          text: plain("Delete incident"),
          onClick: reports("element:icon_button"),
        } as never),
      ],
    }),
  },
  {
    key: "element:workflow_button",
    label: "Workflow button",
    expectedRefusal:
      "Slack refuses the placeholder trigger URL. Verifying it needs a workflow " +
      "published in Workflow Builder; nothing in the SDK is implicated.",
    node: inActions(
      Slack.Element.WorkflowButton({
        text: plain("Start rollback workflow"),
        workflow: {
          trigger: { url: "https://slack.com/shortcuts/Ft000000/placeholder" },
        },
      } as never),
    ),
  },
];

const OBJECT_ITEMS: readonly BlockTestRunItem[] = [
  {
    key: "object:plain_text",
    label: "Plain text object, as a header's text",
    node: Slack.Block.Header({ text: plain("Incident review") }),
  },
  {
    key: "object:mrkdwn",
    label: "Markdown text object, as a section's text",
    node: Slack.Block.Section({
      text: mrkdwn("*INC-421* is <https://example.com/inc-421|open>"),
    }),
  },
  {
    key: "object:option",
    label: "Option with a description — open the menu",
    node: inActions(
      Slack.Element.StaticSelect({
        placeholder: plain("Pick a service"),
        options: [
          Slack.Object.Option({
            text: plain("Payments"),
            value: "payments",
            description: plain("p99 1.9s"),
          }),
          option("Checkout", "checkout"),
        ],
        onSelect: reports("object:option"),
      }),
    ),
  },
  {
    key: "object:option_group",
    label: "Two option groups in one select — open the menu",
    node: inActions(
      Slack.Element.StaticSelect({
        placeholder: plain("Pick a service"),
        option_groups: [
          Slack.Object.OptionGroup({
            label: plain("Critical"),
            children: [option("Payments", "payments")],
          }),
          Slack.Object.OptionGroup({
            label: plain("Standard"),
            children: [
              option("Checkout", "checkout"),
              option("Search", "search"),
            ],
          }),
        ],
        onSelect: reports("object:option_group"),
      }),
    ),
  },
  {
    key: "object:confirm",
    label: "Confirmation dialog on a destructive button — click it",
    node: inActions(
      Slack.Element.Button({
        text: plain("Roll back"),
        style: "danger",
        confirm: Slack.Object.ConfirmationDialog({
          title: plain("Roll back checkout-api?"),
          text: plain("This reverts to the previous release."),
          confirm: plain("Roll back"),
          deny: plain("Cancel"),
          style: "danger",
        } as never),
        onClick: reports("object:confirm"),
      }),
    ),
  },
  {
    key: "object:conversation_filter",
    label: "Conversation filter on a conversation picker — open it",
    node: inActions(
      Slack.Element.ConversationsSelect({
        placeholder: plain("Post updates to"),
        filter: Slack.Object.ConversationFilter({
          include: ["public", "private"],
          exclude_bot_users: true,
        } as never),
        onSelect: reports("object:conversation_filter"),
      } as never),
    ),
  },
  {
    key: "object:dispatch_action_config",
    label: "Dispatch config on a text field — press enter in it",
    node: Slack.Block.Input({
      label: plain("Root cause"),
      dispatch_action: true,
      element: Slack.Element.PlainTextInput({
        dispatch_action_config: Slack.Object.DispatchActionConfig({
          trigger_actions_on: ["on_enter_pressed"],
        } as never),
        onSubmit: reports("object:dispatch_action_config"),
      }),
    } as never),
  },
  {
    key: "object:text",
    label: "Rich-text run with styling",
    node: inRichText(
      Slack.Object.RichTextSection({
        elements: [
          richRun("Rolled back "),
          Slack.Object.RichTextText({
            text: "checkout-api",
            style: { bold: true },
          } as never),
        ],
      }),
    ),
  },
  {
    key: "object:rich_text_section",
    label: "Rich-text section",
    node: inRichText(
      Slack.Object.RichTextSection({
        elements: [richRun("Back to normal.")],
      }),
    ),
  },
  {
    key: "object:rich_text_list",
    label: "Ordered rich-text list",
    node: inRichText(
      Slack.Object.RichTextList({
        style: "ordered",
        elements: [
          Slack.Object.RichTextSection({
            elements: [richRun("Drain traffic")],
          }),
          Slack.Object.RichTextSection({ elements: [richRun("Redeploy")] }),
        ],
      }),
    ),
  },
  {
    key: "object:rich_text_quote",
    label: "Rich-text quote",
    node: inRichText(
      Slack.Object.RichTextQuote({
        elements: [richRun("Latency was already climbing at 14:10.")],
      }),
    ),
  },
  {
    key: "object:rich_text_preformatted",
    label: "Rich-text preformatted block",
    node: inRichText(
      Slack.Object.RichTextPreformatted({
        elements: [richRun("kubectl rollout undo deploy/checkout-api")],
      }),
    ),
  },
  {
    key: "object:slack_file",
    label: "Slack file reference on an image block",
    expectedRefusal:
      "Slack refuses a placeholder file reference; verifying it needs a file " +
      "actually uploaded to this workspace. The payload is exactly what the " +
      "reference documents.",
    node: Slack.Block.Image({
      alt_text: "Latency chart",
      slack_file: Slack.Object.SlackFile({
        url: "https://files.slack.com/files-pri/placeholder/chart.png",
      } as never),
    } as never),
  },
  {
    key: "object:workflow",
    label: "Workflow object on a workflow button",
    expectedRefusal:
      "Same placeholder trigger URL as element:workflow_button; needs a " +
      "published workflow. The payload is exactly what the reference documents.",
    node: inActions(
      Slack.Element.WorkflowButton({
        text: plain("Start rollback"),
        workflow: Slack.Object.Workflow({
          trigger: Slack.Object.Trigger({
            url: "https://slack.com/shortcuts/Ft000000/placeholder",
          } as never),
        } as never),
      } as never),
    ),
  },
  {
    key: "object:trigger",
    label: "Trigger object inside a workflow",
    expectedRefusal:
      "Same placeholder trigger URL as object:workflow. The payload is exactly " +
      "what the reference documents.",
    node: inActions(
      Slack.Element.WorkflowButton({
        text: plain("Start rollback"),
        workflow: Slack.Object.Workflow({
          trigger: Slack.Object.Trigger({
            url: "https://slack.com/shortcuts/Ft000000/placeholder",
            customizable_input_parameters: [
              { name: "incident", value: "INC-421" },
            ],
          } as never),
        } as never),
      } as never),
    ),
  },
];

/** Every catalog entry the run posts, in the order it posts them. */
export const BLOCK_TESTRUN_ITEMS: readonly BlockTestRunItem[] = [
  ...BLOCK_ITEMS,
  ...ELEMENT_ITEMS,
  ...OBJECT_ITEMS,
];

/**
 * Catalog entries Slack documents but which an app can never post from a
 * message. They are listed in the run's summary rather than dropped, so
 * "decided against" stays distinguishable from "forgotten".
 */
export const BLOCK_TESTRUN_SKIPPED: readonly BlockTestRunSkip[] = [
  {
    key: "block:alert",
    reason:
      "Slack: alert blocks are currently only supported in modals, so a message " +
      "carrying one is always refused.",
  },
  {
    key: "block:file",
    reason:
      "Slack: an app cannot add this block to a surface directly; it only " +
      "appears when reading messages that already contain remote files. " +
      "Sending a file is thread.postFile(), a different path.",
  },
];

/** What one item did. */
export type BlockTestRunVerdict =
  | {
      readonly key: string;
      readonly label: string;
      readonly status: "delivered";
    }
  | {
      readonly key: string;
      readonly label: string;
      readonly status: "refused";
      readonly error: string;
      readonly expected?: string;
    }
  /** Never attempted: an earlier refusal had already terminated the delivery. */
  | {
      readonly key: string;
      readonly label: string;
      readonly status: "blocked";
      readonly blockedBy: string;
    }
  | {
      readonly key: string;
      readonly label: string;
      readonly status: "skipped";
      readonly reason: string;
    };

/** The only Thread capability the harness needs. */
export interface PostingThread {
  post(ui: Renderable): Promise<unknown>;
}

export function isBlockTestRunEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[BLOCK_TESTRUN_ENV_VAR] === "1";
}

export function matchesTestRunTrigger(text: string | undefined): boolean {
  return (text ?? "").toLowerCase().includes(BLOCK_TESTRUN_TRIGGER);
}

/**
 * The `test-run <substring>` form, which is how an item in the deferred tail is
 * re-tested alone in its own delivery — the only place its refusal costs nothing
 * but itself.
 *
 * The token counts as a filter only when it actually names catalog entries.
 * Mentions carry prose after the trigger far more often than they carry a key
 * ("test-run — gate check B"), and letting an arbitrary word through would
 * silently select nothing and report a zero-item run as a success.
 */
export function parseTestRunFilter(
  text: string | undefined,
): string | undefined {
  const match = /test-run\s+(\S+)/i.exec(text ?? "");
  const token = match?.[1]?.toLowerCase();
  if (!token) return undefined;
  return BLOCK_TESTRUN_ITEMS.some((item) => item.key.includes(token))
    ? token
    : undefined;
}

/**
 * Slack's own words for a refusal. The delivery boundary stamps the provider's
 * validation messages onto the error; without them all that survives is a
 * generic "delivery terminated", which names neither the block nor the field.
 */
function refusalText(error: unknown): string {
  const details = channelDeliveryErrorDetails(error);
  if (details && details.validationMessages.length > 0) {
    return `${details.providerCode}: ${details.validationMessages.join("; ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Name the item above its payload. Sixty unlabelled messages are unreadable, and
 * a verdict a human cannot attach to a catalog entry is not a verdict.
 */
function caption(item: BlockTestRunItem, index: number, total: number) {
  return Slack.Block.Context({
    elements: [
      mrkdwn(`\`${item.key}\`  ·  ${item.label}  ·  ${index}/${total}`),
    ],
  });
}

/**
 * Post one pass of items, one message each, stopping at the first terminated
 * delivery. Everything after that point is reported as `blocked` and named with
 * the item that closed the path — a refusal it did not earn would be a lie, and
 * a silent omission would be worse.
 */
async function postPass(
  thread: PostingThread,
  items: readonly BlockTestRunItem[],
  offset: number,
  total: number,
): Promise<BlockTestRunVerdict[]> {
  const verdicts: BlockTestRunVerdict[] = [];
  let closedBy: string | undefined;

  for (const [index, item] of items.entries()) {
    if (closedBy) {
      verdicts.push({
        key: item.key,
        label: item.label,
        status: "blocked",
        blockedBy: closedBy,
      });
      continue;
    }

    try {
      await thread.post([caption(item, offset + index + 1, total), item.node]);
      verdicts.push({ key: item.key, label: item.label, status: "delivered" });
    } catch (error) {
      const message = refusalText(error);
      verdicts.push({
        key: item.key,
        label: item.label,
        status: "refused",
        error: message,
        ...(item.expectedRefusal ? { expected: item.expectedRefusal } : {}),
      });
      console.error(`[block-testrun] refused ${item.key}: ${message}`);
      if (isChannelDeliveryTerminatedError(error)) closedBy = item.key;
    }

    await sleep(POST_INTERVAL_MS);
  }

  return verdicts;
}

/**
 * Post every selected item and report a verdict for all of them.
 *
 * `filter` narrows the run to catalog keys containing that substring, which is
 * how a payload in the known-bad tail gets re-tested: alone, in its own
 * delivery, where a refusal costs nothing but itself.
 */
export async function runBlockTestRun(
  thread: PostingThread,
  filter?: string,
): Promise<readonly BlockTestRunVerdict[]> {
  const selected = filter
    ? BLOCK_TESTRUN_ITEMS.filter((item) => item.key.includes(filter))
    : BLOCK_TESTRUN_ITEMS;
  const total = selected.length;
  const main = selected.filter((item) => !item.expectedRefusal);
  const tail = selected.filter((item) => item.expectedRefusal);

  console.log(
    `[block-testrun] ${BLOCK_TESTRUN_MARKER} start — ${total} items` +
      `${filter ? ` matching "${filter}"` : ""}, ${tail.length} deferred, ` +
      `${BLOCK_TESTRUN_SKIPPED.length} skipped`,
  );

  await postSafely(
    thread,
    `🧪 **Block Kit test-run** (${BLOCK_TESTRUN_MARKER}) — ${total} items, one message each. ` +
      "Interactive controls reply with what actually reached the handler.",
  );

  const skipped: BlockTestRunVerdict[] = filter
    ? []
    : BLOCK_TESTRUN_SKIPPED.map((skip) => ({
        key: skip.key,
        label: "not postable from a message",
        status: "skipped" as const,
        reason: skip.reason,
      }));

  const verdicts = await postPass(thread, main, 0, total);

  // The summary goes out here, before the tail, because the tail is made of
  // payloads already known to be refused — and the refusal that terminates the
  // delivery would take the summary with it.
  //
  // With a filter naming only tail items the main pass runs nothing, and a
  // summary of nothing reads as a run that did nothing — the opposite of the
  // verdict it is about to produce. In that case only the notice goes out, and
  // it names what is being attempted.
  if (tail.length > 0) {
    const attempting =
      `_Attempting ${tail.length} payload(s) already known to be refused: ` +
      `${tail.map((item) => `\`${item.key}\``).join(", ")}. The first refusal ` +
      "closes this delivery, so their verdicts are on the console._";

    await postSafely(
      thread,
      verdicts.length > 0
        ? `${summaryText([...verdicts, ...skipped])}\n\n${attempting}`
        : attempting,
    );
  }

  verdicts.push(...(await postPass(thread, tail, main.length, total)));
  verdicts.push(...skipped);

  console.table(
    verdicts.map((verdict) => ({
      item: verdict.key,
      status: verdict.status,
      detail: detailOf(verdict),
    })),
  );

  await postSafely(thread, summaryText(verdicts));
  return verdicts;
}

function detailOf(verdict: BlockTestRunVerdict): string {
  switch (verdict.status) {
    case "refused":
      return verdict.error;
    case "blocked":
      return `not attempted; delivery closed at ${verdict.blockedBy}`;
    case "skipped":
      return verdict.reason;
    default:
      return "";
  }
}

/**
 * The run's own bookkeeping must not be able to end the run. A refused summary
 * would otherwise throw out of `runBlockTestRun` and lose every verdict the
 * console already holds.
 */
async function postSafely(thread: PostingThread, text: string): Promise<void> {
  try {
    await thread.post(text);
  } catch (error) {
    console.error(`[block-testrun] could not post: ${refusalText(error)}`);
  }
}

export function summaryText(verdicts: readonly BlockTestRunVerdict[]): string {
  const delivered = verdicts.filter((v) => v.status === "delivered");
  const refused = verdicts.filter((v) => v.status === "refused");
  const skipped = verdicts.filter((v) => v.status === "skipped");

  const lines = [
    `🧪 **Block Kit test-run summary** — ${delivered.length} delivered, ` +
      `${refused.length} refused, ${skipped.length} skipped.`,
    "",
    `**Delivered (${delivered.length})**: ${
      delivered.map((v) => v.key).join(", ") || "none"
    }`,
  ];

  lines.push("", `**Refused (${refused.length})**`);
  if (refused.length === 0) {
    lines.push("_none_");
  } else {
    for (const verdict of refused) {
      const expected = verdict.expected
        ? ` _(expected: ${verdict.expected})_`
        : "";
      lines.push(`• \`${verdict.key}\` — ${verdict.error}${expected}`);
    }
  }

  lines.push("", `**Skipped (${skipped.length})**`);
  for (const verdict of skipped) {
    lines.push(`• \`${verdict.key}\` — ${verdict.reason}`);
  }

  return lines.join("\n");
}

/** What a mention has to look like for the harness to read it. */
export interface BlockTestRunMention {
  readonly thread: PostingThread;
  readonly message: { readonly text?: string };
}

/**
 * Handle one mention. Returns `true` when it ran, so the caller skips the agent
 * run; returns `false` — having done and read nothing — for a mention that does
 * not carry the trigger, and whenever the harness is not armed.
 */
export async function handleBlockTestRun(
  args: BlockTestRunMention,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!isBlockTestRunEnabled(env)) return false;
  if (!matchesTestRunTrigger(args.message.text)) return false;

  await runBlockTestRun(args.thread, parseTestRunFilter(args.message.text));
  return true;
}

/**
 * What `app/channel.tsx` installs in front of the agent run — and only when the
 * harness is armed. With the flag unset this returns `undefined` and no hook is
 * installed at all, so the harness is *absent* from the mention path rather than
 * sitting in it and declining every mention.
 */
export function createBlockTestRunHook(
  env: NodeJS.ProcessEnv = process.env,
): ((args: BlockTestRunMention) => Promise<boolean>) | undefined {
  if (!isBlockTestRunEnabled(env)) return undefined;

  console.log(
    `[block-testrun] ${BLOCK_TESTRUN_MARKER} armed via ` +
      `${BLOCK_TESTRUN_ENV_VAR}=1 — mention me with "${BLOCK_TESTRUN_TRIGGER}"`,
  );
  return (args) => handleBlockTestRun(args, env);
}
