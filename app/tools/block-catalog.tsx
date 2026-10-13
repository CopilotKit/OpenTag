/**
 * `showcase_all_slack_blocks_catalog` — one message, two pages, showing what
 * this bot can put in a Slack channel.
 *
 * Page 1 is fourteen worked examples. Each is a heading in plain language, the
 * block names it is built from, a sentence or two of orientation, and then the
 * real thing rendered live. The order runs everyday → text → data → media →
 * interaction → agent, so it reads as a demonstration rather than an inventory.
 *
 * Inside the interaction stretch the order is `actions` and then `input`: the
 * order agreed with the product owner, and the one the pinned heading test
 * holds.
 *
 * Page 2 is one situation carried through: booking a meeting. A form — channel,
 * time, length, email — a Confirm button, and a confirmation that reports the
 * values that actually arrived.
 *
 * ## One message, updated in place
 *
 * Next and Back call `thread.update` on the SAME message rather than posting a
 * new one. Interaction ids derive from a control's position, so two identical
 * controls at the same position in two different messages collide and a click
 * on one drives the other. Staying inside one message removes the problem.
 *
 * Which page is showing lives in thread state, so navigation survives a click
 * that arrives twenty minutes later.
 *
 * ## What a click carries back
 *
 * Slack sends `state.values` — the state of every input block in the message —
 * alongside a button click, so a form could in principle be read all at once
 * when Confirm is pressed. It does not reach us: `decodeInteraction` in
 * `@copilotkit/channels-slack` sets `values` only for a modal `view_submission`,
 * and `create-channel`'s interaction path passes `evt.values ?? {}` straight
 * through — so `ctx.values` is always `{}` for a message click, whatever Slack
 * sent. The form therefore records each field as its own control dispatches,
 * into thread state, and Confirm reads what has accumulated.
 *
 * A recording handler deliberately does NOT redraw. A redraw is a fresh payload
 * and Slack keeps nothing from the previous version, so redrawing after the
 * first field would empty the other three in front of the reader. Only Confirm
 * redraws, and clearing the form at that point is intended.
 *
 * This is not an answer to "what can you do?" — `show_capabilities` owns that
 * question, and the two must not compete for it. The tool is only registered
 * when `OPENTAG_SHOW_BLOCK_CATALOG` is enabled, so where the flag is off the
 * agent never sees it and the topic simply does not exist.
 *
 * ## Slack constraints encoded below
 *
 * Every one of these fails silently and *whole*: the message is refused with no
 * usable error, so nothing appears rather than part of it.
 *
 * 1. A `plan` and a standalone `task_card` cannot share one message. The task
 *    cards are therefore shown inside the plan, in the last example.
 * 2. `data_table` and `data_visualization` are not allowed children of a
 *    `container`; they are siblings of it.
 * 3. A message carries at most 50 blocks. Each example's heading and its
 *    description share one section for that reason — split in two they push the
 *    message over the ceiling. The count is pinned by a test. For the same
 *    reason the headings are set off with an emoji glyph rather than a divider:
 *    a rule above each of the fourteen would cost fourteen blocks and buy
 *    nothing a glyph does not already give.
 * 4. An `actions` block accepts only buttons, single selects, overflow menus and
 *    date pickers. A multi-select belongs in an `input` block.
 * 5. An `input` block in a *message* only dispatches to a handler when
 *    `dispatch_action` is true.
 * 6. Slack fetches image, thumbnail and video URLs at post time; a dead URL
 *    refuses the whole message. Every URL used here is verified reachable.
 * 7. `icon_button` accepts only a few icon names; `trash` is verified.
 * 8. `plan.title` is a bare string, not a text object — the opposite of every
 *    other titled block, and contrary to Slack's own reference.
 * 9. The native `Section`'s children slot is `fields`, which Slack requires to
 *    be an array, so text always goes through the `text` prop.
 * 10. A `plain_text` object rewrites Unicode emoji into `:shortcode:` form
 *     unless `emoji={false}`.
 * 11. Table and data-table cells are `raw_text` and literal: no markdown, no
 *     `<url|label>`, no linkification. Links never go in a cell.
 * 12. Accent colours never reach the reader under managed delivery, so nothing
 *     here lets colour carry meaning.
 * 13. A `data_visualization` title is capped at 50 characters, series and
 *     category labels at 20, and every series' point labels must match
 *     `axis_config.categories` exactly. A `pie` chart is the exception: it
 *     carries `segments` and no `axis_config`, so there is nothing to match.
 * 14. `card` holds a title, a subtitle, a hero image, a body and actions — it
 *     has no children slot, so it cannot frame arbitrary blocks. `container` is
 *     the block that groups other blocks, and it is what frames the examples
 *     that need a visible border.
 * 15. A `markdown` block is refused as a child of a `container`, while
 *     `rich_text`, `header`, `section`, `divider` and `context` are accepted.
 *     Both were measured live against this message. The second example's
 *     `markdown` lead-in therefore sits outside its frame.
 * 16. Slack has no disabled button, so the control that would go nowhere is
 *     absent rather than inert: page 1 offers only Next, page 2 only Back.
 */
import { z } from "zod";
import { Message, Section, defineChannelTool } from "@copilotkit/channels";
import type { ChannelNode, InteractionContext } from "@copilotkit/channels";
import { Slack } from "@copilotkit/channels/slack";

/**
 * Slack documents fields that `SlackNativeProps` does not declare yet: a
 * container's `subtitle`/`is_collapsible`, an array-of-arrays `rows`, a data
 * table's `caption`/`page_size`, an input block's `element`/`dispatch_action`, a
 * video's `title_url`/`thumbnail_url`/`video_url`, `feedback_buttons`' two
 * button objects, and `icon_button`'s `icon`. Retyping those factories as "any
 * Slack fields" keeps the nodes in JSX, which is the only form that can carry a
 * `key`.
 */
type UntypedNative = (props: Record<string, unknown>) => ChannelNode;

const Container = Slack.Block.Container as unknown as UntypedNative;
const DataTable = Slack.Block.DataTable as unknown as UntypedNative;
const Input = Slack.Block.Input as unknown as UntypedNative;
const RichText = Slack.Block.RichText as unknown as UntypedNative;
const Table = Slack.Block.Table as unknown as UntypedNative;
const Video = Slack.Block.Video as unknown as UntypedNative;
const FeedbackButtons = Slack.Element
  .FeedbackButtons as unknown as UntypedNative;
const IconButton = Slack.Element.IconButton as unknown as UntypedNative;
const ChannelsSelect = Slack.Element.ChannelsSelect as unknown as UntypedNative;
const DateTimePicker = Slack.Element.DateTimePicker as unknown as UntypedNative;
const EmailInput = Slack.Element.EmailInput as unknown as UntypedNative;
const RadioButtons = Slack.Element.RadioButtons as unknown as UntypedNative;

/** Verified reachable at post time; Slack refuses the message if a fetch fails. */
const IMAGE_URL = "https://picsum.photos/id/1015/800/400";

/**
 * The video example embeds Blender's "Big Buck Bunny" short film — the clip the
 * SDK's own `catalog-fixtures.ts` uses, and the one URL pair proven to survive
 * Slack's post-time fetch. Its thumbnail is YouTube's own still for that same
 * video, which YouTube's oEmbed response names as the video's `thumbnail_url`,
 * so the preview shows the film that plays rather than an unrelated photograph.
 * Verified reachable: 200 image/jpeg.
 */
const VIDEO_ID = "aqz-KE-bpKQ";
const VIDEO_THUMBNAIL_URL = `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`;

// ── local text helpers ─────────────────────────────────────────────────────

/** A `mrkdwn` section. `text`, never children — see constraint 9. */
const Line = (text: string) => (
  <Slack.Block.Section text={<Slack.Object.MarkdownText text={text} />} />
);

/** A one-line context note. */
const Note = (text: string) => (
  <Slack.Block.Context elements={[<Slack.Object.MarkdownText text={text} />]} />
);

/** `emoji={false}` everywhere a glyph could appear in a `plain_text`. */
const Plain = (text: string) => (
  <Slack.Object.PlainText emoji={false} text={text} />
);

const Markdown = (text: string) => <Slack.Object.MarkdownText text={text} />;

const option = (label: string, value: string) => (
  <Slack.Object.Option text={Plain(label)} value={value} />
);

/** A table cell: `raw_text`, literal, never markdown or a link. */
const cell = (text: string) => ({ type: "raw_text", text });

/** A rich-text run, optionally styled. */
const run = (text: string, style?: Record<string, boolean>) =>
  style ? { type: "text", text, style } : { type: "text", text };

/** A task card's `output` is a rich text block, not a text object. */
const output = (text: string) => ({
  type: "rich_text",
  elements: [{ type: "rich_text_section", elements: [run(text)] }],
});

/**
 * One short line back in the thread naming what arrived. A control that does
 * nothing reads as broken, which is the opposite of what this message claims.
 */
const reply =
  (control: string) =>
  async (ctx: InteractionContext): Promise<void> => {
    const value = ctx.action.value;
    await ctx.thread.post(
      `*${control}* fired · value \`${JSON.stringify(value ?? null)}\``,
    );
  };

// ── example content ────────────────────────────────────────────────────────

const REGIONS: ReadonlyArray<readonly string[]> = [
  ["Region", "Renewals", "Change"],
  ["Americas", "214", "+4%"],
  ["EMEA", "128", "+9%"],
  ["APAC", "76", "-2%"],
];

/** Longer than `page_size`, so the data table actually shows its paging. */
const RENEWALS: ReadonlyArray<readonly string[]> = [
  ["Vendor", "Owner", "Renews"],
  ["Atlas Analytics", "Finance", "12 Sep"],
  ["Bridge CRM", "Sales", "30 Sep"],
  ["Cedar Payroll", "People", "14 Oct"],
  ["Delta Storage", "Platform", "02 Nov"],
  ["Ember Support Desk", "Support", "19 Nov"],
  ["Fathom Reporting", "Finance", "05 Dec"],
  ["Granite Security", "Security", "21 Dec"],
  ["Harbor Logistics", "Operations", "08 Jan"],
];

const REVIEWERS: ReadonlyArray<[string, string]> = [
  ["Finance", "finance"],
  ["Security", "security"],
  ["Legal", "legal"],
];

const TEAMS: ReadonlyArray<[string, string]> = [
  ["Product", "product"],
  ["Support", "support"],
  ["Sales", "sales"],
  ["Operations", "operations"],
];

/**
 * Twelve months, so the line has a shape rather than four points and a slope.
 * The point labels and `axis_config.categories` are built from this one list:
 * Slack refuses the message unless the two match exactly, and each label is
 * unique and inside the 20-character cap.
 */
const RENEWAL_RATE_BY_MONTH: ReadonlyArray<readonly [string, number]> = [
  ["Jan", 82],
  ["Feb", 85],
  ["Mar", 84],
  ["Apr", 88],
  ["May", 91],
  ["Jun", 89],
  ["Jul", 87],
  ["Aug", 92],
  ["Sep", 94],
  ["Oct", 93],
  ["Nov", 96],
  ["Dec", 97],
];

/**
 * The pie beneath the line, so the example shows Slack drawing more than one
 * kind of chart. A pie payload is `segments`, with no `axis_config` — the
 * categories rule applies only to bar, area and line. The counts are the ones
 * the table example already shows, so the two do not contradict each other, and
 * every label is inside the 20-character cap.
 */
const RENEWALS_BY_REGION: ReadonlyArray<readonly [string, number]> = [
  ["Americas", 214],
  ["EMEA", 128],
  ["APAC", 76],
];

const CAROUSEL_CARDS: ReadonlyArray<[string, string, string]> = [
  ["card-americas", "Americas", "214 renewals · 96% on time"],
  ["card-emea", "EMEA", "128 renewals · 91% on time"],
  ["card-apac", "APAC", "76 renewals · 88% on time"],
];

interface Example {
  /**
   * A single Unicode glyph in front of the heading, so the line reads as a
   * heading rather than as more prose. A glyph and not a `:shortcode:`: a
   * shortcode renders literally here. One codepoint each, no variation
   * selectors, so every Slack client draws them.
   */
  readonly emoji: string;
  /** The reader-facing heading, in natural language. */
  readonly heading: string;
  /** The Slack block names this example is built from, shown in parentheses. */
  readonly blocks: readonly string[];
  /** One or two sentences saying what the reader is looking at. */
  readonly description: string;
  /** The blocks the example renders below its heading. */
  readonly specimen: readonly ChannelNode[];
}

const EXAMPLES: readonly Example[] = [
  {
    emoji: "📋",
    heading: "A status update the team can skim",
    blocks: ["container", "header", "section", "divider", "context"],
    description:
      "The everyday post: a heading, the substance, a rule to break it up, " +
      "and a small line naming the source and the time — held inside a frame " +
      "so it reads as one thing rather than as loose lines.",
    specimen: [
      <Container title={Plain("Q3 onboarding review")}>
        {[
          <Slack.Block.Header
            key="head"
            text={Plain("Where completion stands")}
          />,
          Line(
            "Completion rose from *62%* to *80%* after setup guidance moved " +
              "into the product. The largest remaining drop-off is connecting " +
              "the first data source.",
          ),
          <Slack.Block.Divider key="rule" />,
          Note("Updated 4 minutes ago · source: product analytics"),
        ]}
      </Container>,
    ],
  },
  {
    emoji: "📝",
    heading: "Formatted writing with lists, a quote and code",
    blocks: ["container", "markdown", "rich_text"],
    description:
      "Longer writing keeps its shape. Emphasis and links survive, bullets " +
      "stay indented, and a quote or a line of code sits apart from the " +
      "prose. The detail sits in the same kind of frame.",
    // Measured live: a `markdown` block inside a `container` is refused with
    // `invalid_blocks`, while a `rich_text` child is accepted. The lead-in has
    // to stay outside the frame for that reason — this is the one example the
    // frame cannot swallow whole.
    specimen: [
      <Slack.Block.Markdown
        key="notes"
        text={
          "**Release notes — billing service**\n\nInvoices now render in the " +
          "customer's local currency, and a failed payment retries twice " +
          "before anyone is paged."
        }
      />,
      <Container title={Plain("The detail")}>
        {[
          <RichText
            key="detail"
            elements={[
              {
                type: "rich_text_section",
                elements: [
                  run("Currency formatting shipped in "),
                  run("week 2", { bold: true }),
                  run(" behind the flag "),
                  run("local_currency", { code: true }),
                  run(" — "),
                  {
                    type: "link",
                    url: "https://example.com/billing-release",
                    text: "read the release notes",
                  },
                ],
              },
              {
                type: "rich_text_list",
                style: "bullet",
                elements: [
                  {
                    type: "rich_text_section",
                    elements: [run("Invoice disputes fell by a third")],
                  },
                  {
                    type: "rich_text_section",
                    elements: [run("Failed payments now retry before paging")],
                  },
                ],
              },
              {
                type: "rich_text_quote",
                elements: [
                  run(
                    "Finance asked for local currency in every quarter of 2025.",
                  ),
                ],
              },
              {
                type: "rich_text_preformatted",
                elements: [run("billing invoices reissue --since 2026-07-01")],
              },
            ]}
          />,
        ]}
      </Container>,
    ],
  },
  {
    emoji: "📦",
    heading: "Collapse the long stuff so it does not flood the channel",
    blocks: ["container"],
    description:
      "The same frame again, but with a title and folded shut: a long answer " +
      "is one line until somebody opens it, so a busy channel stays readable.",
    // `has_header_divider` is documented as applying only when the block is not
    // collapsible, and setting both is refused on delivery.
    specimen: [
      <Container
        title={Plain("Vendor security review — full findings")}
        subtitle={Plain("Open it when you need the detail")}
        is_collapsible={true}
      >
        {[
          <Slack.Block.Header key="head" text={Plain("What we checked")} />,
          Line(
            "*Access controls* · Single sign-on is enforced for every seat, " +
              "and admin roles are reviewed each quarter.",
          ),
          Line(
            "*Data handling* · Customer records stay in the EU region, with " +
              "backups retained for 30 days.",
          ),
          <Slack.Block.Divider key="rule" />,
          Note("Reviewed by Security · next review due in February"),
        ]}
      </Container>,
    ],
  },
  {
    emoji: "🔢",
    heading: "Numbers side by side",
    blocks: ["table"],
    description:
      "A compact grid for the handful of rows people want to compare at a " +
      "glance. Cells are literal text, so nothing in them turns into a link.",
    specimen: [<Table rows={REGIONS.map((row) => row.map(cell))} />],
  },
  {
    emoji: "📑",
    heading: "A long list you can page through",
    blocks: ["data_table"],
    description:
      "For longer lists: a caption above it, sortable columns, and pages, so " +
      "a whole register does not land in the channel at once.",
    specimen: [
      <DataTable
        caption="Software renewals by owner"
        page_size={5}
        rows={RENEWALS.map((row) => row.map(cell))}
      />,
    ],
  },
  {
    emoji: "📈",
    heading: "A trend over time, then a share of the whole",
    blocks: ["data_visualization"],
    description:
      "Slack draws the charts itself, and more than one kind: a line for how " +
      "the renewal rate moved through the year, and a pie underneath it for " +
      "how this quarter's renewals divide between the regions.",
    specimen: [
      <Slack.Block.DataVisualization
        key="trend"
        title="Renewal rate by month"
        chart={{
          type: "line",
          series: [
            {
              name: "Renewal rate",
              data: RENEWAL_RATE_BY_MONTH.map(([label, value]) => ({
                label,
                value,
              })),
            },
          ],
          axis_config: {
            categories: RENEWAL_RATE_BY_MONTH.map(([label]) => label),
            x_label: "Month",
            y_label: "Renewal rate %",
          },
        }}
      />,
      // A second `data_visualization`, a sibling of the first and of every
      // container — a chart is never a container child (constraint 2). This is
      // the block page 1 grew by, from 47 to 48 against the ceiling of 50.
      <Slack.Block.DataVisualization
        key="share"
        title="Renewals by region this quarter"
        chart={{
          type: "pie",
          segments: RENEWALS_BY_REGION.map(([label, value]) => ({
            label,
            value,
          })),
        }}
      />,
    ],
  },
  {
    emoji: "📷",
    heading: "An image in the post",
    blocks: ["image"],
    description:
      "A picture inline at full width, with alt text so it still reads for " +
      "anyone on a screen reader.",
    specimen: [
      <Slack.Block.Image
        image_url={IMAGE_URL}
        alt_text="Photograph standing in for an attached visual"
      />,
    ],
  },
  {
    emoji: "🎬",
    heading: "A video that plays in place",
    blocks: ["video"],
    description:
      "A recording plays in the channel itself, so nobody has to open " +
      "another tab to watch it. The still above it is the video's own frame, " +
      "so the preview shows what will play.",
    specimen: [
      <Video
        alt_text="Still from Blender's Big Buck Bunny short film"
        title={Plain("Big Buck Bunny · Blender Foundation short film")}
        title_url={`https://www.youtube.com/watch?v=${VIDEO_ID}`}
        thumbnail_url={VIDEO_THUMBNAIL_URL}
        video_url={`https://www.youtube.com/embed/${VIDEO_ID}`}
      />,
    ],
  },
  {
    emoji: "🧾",
    heading: "A card with a title, image and text",
    blocks: ["card"],
    description:
      "One self-contained unit — a picture, a title and a short body held " +
      "together, so a single item reads as one thing rather than as three " +
      "loose lines.",
    // No button underneath. `card` takes only buttons in `actions`, and the
    // `actions` block has an example of its own further down, so nothing in the
    // 19 block types depends on this one.
    specimen: [
      <Slack.Block.Card
        hero_image={
          <Slack.Element.Image
            image_url={IMAGE_URL}
            alt_text="The river gorge the offsite walks on its middle day"
          />
        }
        title={Markdown("*Team offsite · Verzasca valley*")}
        subtitle={Markdown("People team · published this morning")}
        body={Markdown(
          "Three days in the mountains from 24 to 26 September, with the " +
            "gorge walk on the middle afternoon. Travel and lodging are " +
            "booked for everyone who has confirmed.",
        )}
      />,
    ],
  },
  {
    emoji: "🎠",
    heading: "Several cards to browse sideways",
    blocks: ["carousel"],
    description:
      "More than one card, side by side and scrolled horizontally, so a set " +
      "of options costs a single message.",
    specimen: [
      <Slack.Block.Carousel
        elements={CAROUSEL_CARDS.map(([id, title, body]) => (
          <Slack.Block.Card
            key={id}
            block_id={id}
            title={Markdown(`*${title}*`)}
            body={Markdown(body)}
          />
        ))}
      />,
    ],
  },
  {
    emoji: "🔘",
    heading: "Act without leaving Slack",
    blocks: ["actions"],
    description:
      "Buttons, a menu and a date picker sitting under the message, each one " +
      "wired to something that actually runs. Try them.",
    // The button is last of the three, so the row reads left to right as choose
    // a reviewer, choose a date, then act on both. Elements render in array
    // order, so this ordering is the only thing that places it.
    specimen: [
      <Slack.Block.Actions
        elements={[
          <Slack.Element.StaticSelect
            key="reviewer"
            placeholder={Plain("Choose a reviewer")}
            options={REVIEWERS.map(([label, value]) => option(label, value))}
            onSelect={reply("actions · select")}
          />,
          <Slack.Element.DatePicker
            key="date"
            placeholder={Plain("Target date")}
            initial_date="2026-09-12"
            onSelect={reply("actions · date picker")}
          />,
          <Slack.Element.Button
            key="approve"
            style="primary"
            text={Plain("Approve renewal")}
            value="approve_renewal"
            onClick={reply("actions · button")}
          />,
        ]}
      />,
    ],
  },
  {
    emoji: "📥",
    heading: "A small input right in the channel",
    blocks: ["input"],
    description:
      "A field in the message itself, so an answer can be given on the spot " +
      "instead of in a dialog somewhere else.",
    specimen: [
      <Input
        label={Plain("Teams to include in the review")}
        dispatch_action={true}
        element={
          <Slack.Element.MultiStaticSelect
            placeholder={Plain("Pick one or more teams")}
            options={TEAMS.map(([label, value]) => option(label, value))}
            onSelect={reply("input · multi-select")}
          />
        }
      />,
    ],
  },
  {
    emoji: "👍",
    heading: "Give feedback on a result",
    blocks: ["context_actions"],
    description:
      "A quiet row under an answer: say whether it was useful, or clear it " +
      "away. The reply lands where the work happened.",
    specimen: [
      <Slack.Block.ContextActions
        elements={[
          <FeedbackButtons
            key="feedback"
            positive_button={{
              text: { type: "plain_text", text: "Useful" },
              value: "positive",
            }}
            negative_button={{
              text: { type: "plain_text", text: "Not useful" },
              value: "negative",
            }}
            onClick={reply("context_actions · feedback")}
          />,
          <IconButton
            key="dismiss"
            icon="trash"
            text={Plain("Dismiss")}
            value="dismiss"
            onClick={reply("context_actions · icon button")}
          />,
        ]}
      />,
    ],
  },
  {
    emoji: "🤖",
    heading: "The agent at work",
    blocks: ["plan", "task_card"],
    description:
      "A plan that updates while it runs. Every task carries its own state, " +
      "and the finished ones leave their result behind.",
    // Slack refuses any message carrying both a plan and a standalone task
    // card, so the task cards inside this plan are the task-card example too.
    specimen: [
      <Slack.Block.Plan
        title="Quarterly renewal review"
        tasks={[
          {
            type: "task_card",
            task_id: "task_1",
            title: "Collect the renewal register from Finance",
            status: "complete",
            output: output(
              "Eight vendors renew before the end of January; two need a new " +
                "owner.",
            ),
          },
          {
            type: "task_card",
            task_id: "task_2",
            title: "Check each contract for a price increase",
            status: "in_progress",
          },
          {
            type: "task_card",
            task_id: "task_3",
            title: "Draft the summary for the finance review",
            status: "pending",
          },
          {
            type: "task_card",
            task_id: "task_4",
            title: "Confirm the security review dates",
            status: "error",
            output: output(
              "Two vendors have no review scheduled, so the dates cannot be " +
                "confirmed yet.",
            ),
          },
        ]}
      />,
    ],
  },
];

/** The reader-facing headings, in the order the message presents them. */
export const BLOCK_CATALOG_HEADINGS: readonly string[] = EXAMPLES.map(
  ({ heading }) => heading,
);

/** Every Slack block type the examples account for, first appearance first. */
export const BLOCK_CATALOG_TYPES: readonly string[] = [
  ...new Set(EXAMPLES.flatMap(({ blocks }) => blocks)),
];

/**
 * The heading and its description share one section deliberately: as two blocks
 * the message runs past Slack's 50-block ceiling and is refused whole.
 */
function ExampleHeading({
  emoji,
  heading,
  blocks,
  description,
}: Example): ChannelNode {
  const names = blocks.map((name) => `\`${name}\``).join(", ");
  return Line(`${emoji} *${heading}* (${names})\n${description}`);
}

/** Page 1: an intro, then the fourteen examples. */
function catalogPage(): ChannelNode[] {
  return [
    <Slack.Block.Header text={Plain("🧱 What I can show you in Slack")} />,
    Line(
      "A Slack message can carry far more than plain text, and I can use " +
        "all of it. Below are fourteen things I can put in a channel — " +
        "each one a working example you can read, scroll and click.",
    ),
    // A rule before every example but the first. It is spacing, not content:
    // fourteen examples run together without it, and Slack has no margin to
    // widen. Costs one block each, which the two containers freed up.
    ...EXAMPLES.flatMap((example, index) => [
      ...(index === 0 ? [] : [<Slack.Block.Divider key={`gap-${index}`} />]),
      ExampleHeading(example),
      ...example.specimen,
    ]),
  ];
}

// ── page 2 · booking a meeting ─────────────────────────────────────────────

/**
 * The lengths on offer. The values are suffixed rather than bare digits on
 * purpose: a control's value is JSON-parsed on the way back, so `"30"` would
 * arrive as the number `30` and a bare-digit lookup would have to guess which.
 */
const DURATIONS: ReadonlyArray<[string, string]> = [
  ["30 minutes", "30m"],
  ["45 minutes", "45m"],
  ["60 minutes", "60m"],
];

/** What has arrived from the form so far, one entry per control. */
export interface Booking {
  /** A channel id, as `channels_select` reports it. */
  channel?: string;
  /** Unix seconds, as `datetimepicker` reports them. */
  when?: number;
  /** One of `DURATIONS`' values. */
  duration?: string;
  email?: string;
}

export interface CatalogState {
  /** 0 = the fourteen examples, 1 = the booking form. */
  page: number;
  /** Recorded as each control dispatches — see "What a click carries back". */
  booking: Booking;
  /** The booking as it stood when Confirm was pressed; absent before that. */
  confirmed?: Booking;
}

const STATE_KEY = "blockCatalog";
const PAGE_COUNT = 2;

const clampPage = (page: number) =>
  Math.min(Math.max(Math.trunc(page) || 0, 0), PAGE_COUNT - 1);

const INITIAL_STATE: CatalogState = { page: 0, booking: {} };

/** Read this component's slice of thread state, leaving the rest intact. */
async function readState(
  thread: InteractionContext["thread"],
): Promise<{ all: Record<string, unknown>; state: CatalogState }> {
  const all = ((await thread.state()) ?? {}) as Record<string, unknown>;
  const stored = (all[STATE_KEY] ?? {}) as Partial<CatalogState>;
  return {
    all,
    state: {
      page: clampPage(stored.page ?? 0),
      booking: stored.booking ?? {},
      ...(stored.confirmed ? { confirmed: stored.confirmed } : {}),
    },
  };
}

const write = (
  thread: InteractionContext["thread"],
  all: Record<string, unknown>,
  state: CatalogState,
) => thread.setState({ ...all, [STATE_KEY]: state });

/** Persist the new state and redraw the same message from it. */
async function redraw(
  ctx: InteractionContext,
  all: Record<string, unknown>,
  state: CatalogState,
): Promise<void> {
  await write(ctx.thread, all, state);
  await ctx.thread.update(ctx.message.ref, BlockCatalog(state));
}

/** Move one page forward or back, clamped at either end. Exported for the tests. */
export const navigatePage =
  (delta: number) =>
  async (ctx: InteractionContext): Promise<void> => {
    const { all, state } = await readState(ctx.thread);
    await redraw(ctx, all, { ...state, page: clampPage(state.page + delta) });
  };

/**
 * Record one field. No redraw: a redraw is a fresh payload and Slack keeps
 * nothing from the previous one, so redrawing here would empty the fields the
 * reader has not answered yet.
 */
export const recordBookingField =
  <K extends keyof Booking>(field: K) =>
  async (ctx: InteractionContext): Promise<void> => {
    const { all, state } = await readState(ctx.thread);
    const value = ctx.action.value as Booking[K];
    await write(ctx.thread, all, {
      ...state,
      booking: { ...state.booking, [field]: value },
    });
  };

/** Freeze what has arrived and redraw the page with the confirmation below it. */
export const confirmBooking = async (
  ctx: InteractionContext,
): Promise<void> => {
  const { all, state } = await readState(ctx.thread);
  await redraw(ctx, all, { ...state, confirmed: state.booking });
};

/** Nothing arrived for this field, said plainly rather than left blank. */
const MISSING = "_not chosen_";

/** `<#C…>` is how mrkdwn names a channel; the reader sees its name, not the id. */
const formatChannel = (channel?: string) =>
  channel ? `<#${channel}>` : MISSING;

/**
 * Slack renders `<!date^…>` in the reader's own timezone and locale, which is
 * the whole point of asking for a time in a shared channel. The pipe segment is
 * the fallback for clients that cannot.
 */
function formatWhen(when?: number): string {
  if (typeof when !== "number" || !Number.isFinite(when)) return MISSING;
  const iso = new Date(when * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 16);
  return `<!date^${Math.trunc(when)}^{date_long_pretty} at {time}|${iso} UTC>`;
}

const formatDuration = (duration?: string) =>
  DURATIONS.find(([, value]) => value === duration)?.[0] ?? MISSING;

const formatEmail = (email?: string) => (email ? email.trim() : MISSING);

/**
 * The confirmation, below the form. One container, so it reads as the outcome
 * rather than as four more loose lines, and every line carries the value that
 * actually arrived.
 */
function bookingConfirmation(booking: Booking): ChannelNode[] {
  return [
    <Slack.Block.Divider key="booked-rule" />,
    <Container key="booked" title={Plain("✅ The meeting is booked")}>
      {[
        <Slack.Block.Header key="head" text={Plain("Invitation sent")} />,
        Line(
          [
            `*When* · ${formatWhen(booking.when)}`,
            `*Length* · ${formatDuration(booking.duration)}`,
            `*Posted in* · ${formatChannel(booking.channel)}`,
            `*Emailed to* · ${formatEmail(booking.email)}`,
          ].join("\n"),
        ),
        <Slack.Block.Divider key="rule" />,
        Note(
          "Anyone in that channel can add it to their calendar from the " +
            "invitation. The mailed copy carries the same details.",
        ),
      ]}
    </Container>,
  ];
}

/**
 * Page 2: the form, the Confirm button at the bottom of it, and — once Confirm
 * has been pressed — the confirmation under both.
 */
function bookingPage(state: CatalogState): ChannelNode[] {
  return [
    <Slack.Block.Header key="head" text={Plain("📅 Book a meeting")} />,
    Line(
      "The same blocks can collect an answer as well as present one. Choose " +
        "where the invitation should be posted, when the meeting is and how " +
        "long it runs, and give an address for the mailed copy — then confirm.",
    ),
    // Every field is an `input` block: an `actions` block accepts only buttons,
    // single selects, overflow menus and date pickers, so a text field or a
    // radio group there is refused and the whole message is lost. And an input
    // block in a *message* dispatches only with `dispatch_action`.
    <Input
      key="channel"
      label={Plain("Post the invitation in")}
      dispatch_action={true}
      element={
        <ChannelsSelect
          placeholder={Plain("Choose a channel")}
          onSelect={recordBookingField("channel")}
        />
      }
    />,
    <Input
      key="when"
      label={Plain("When")}
      dispatch_action={true}
      element={<DateTimePicker onSelect={recordBookingField("when")} />}
    />,
    <Input
      key="duration"
      label={Plain("How long")}
      dispatch_action={true}
      element={
        <RadioButtons
          options={DURATIONS.map(([label, value]) => option(label, value))}
          onSelect={recordBookingField("duration")}
        />
      }
    />,
    <Input
      key="email"
      label={Plain("Also send it to")}
      dispatch_action={true}
      element={
        <EmailInput
          placeholder={Plain("name@example.com")}
          // A text field's default trigger is Enter alone, which is a silent
          // trap: the address is typed, the reader presses Confirm, and nothing
          // ever dispatched. Firing per character costs a request per keystroke
          // and no redraw, which is the cheaper of the two failures.
          dispatch_action_config={{
            trigger_actions_on: ["on_character_entered", "on_enter_pressed"],
          }}
          onSelect={recordBookingField("email")}
        />
      }
    />,
    <Slack.Block.Actions
      key="confirm"
      elements={[
        <Slack.Element.Button
          key="book"
          style="primary"
          text={Plain("Confirm the booking")}
          value="confirm_booking"
          onClick={confirmBooking}
        />,
      ]}
    />,
    ...(state.confirmed ? bookingConfirmation(state.confirmed) : []),
  ];
}

// ── the navigator ──────────────────────────────────────────────────────────

/**
 * Next or Back at the end of the message, never both: Slack has no disabled
 * button, and a Back button on page 1 that silently does nothing reads as a bug.
 */
function navigation(page: number): ChannelNode[] {
  const buttons =
    page === 0
      ? [
          <Slack.Element.Button
            key="next"
            style="primary"
            text={Plain("Next · book a meeting →")}
            value="next"
            onClick={navigatePage(1)}
          />,
        ]
      : [
          <Slack.Element.Button
            key="back"
            text={Plain("← Back to the examples")}
            value="back"
            onClick={navigatePage(-1)}
          />,
        ];
  return [
    <Slack.Block.Divider key="nav-rule" />,
    <Slack.Block.Actions key="nav" elements={buttons} />,
    Note(`Page ${page + 1} of ${PAGE_COUNT}`),
  ];
}

/**
 * The whole demonstration as one message: the page the state names, then the
 * navigator. Page 1 sits close to Slack's 50-block ceiling — see
 * `PAGE_1_BLOCK_COUNT` — so nothing else may be added to it.
 */
export function BlockCatalog(state: CatalogState = INITIAL_STATE): ChannelNode {
  const page = clampPage(state.page);
  return (
    <Message>
      {[
        ...(page === 0 ? catalogPage() : bookingPage(state)),
        ...navigation(page),
      ]}
    </Message>
  );
}

/**
 * The measured size of page 1 with the navigator on it: the fourteen examples'
 * 45 blocks plus the rule, the Next button and the page counter. Pinned by a
 * test against Slack's ceiling of 50, because exceeding it loses the whole
 * message rather than the excess blocks. Two blocks of headroom is all that is
 * left, so an example that needs a new block has to trade for one.
 */
export const PAGE_1_BLOCK_COUNT = 48;

// Printed at load, not through the logger: it is the one line that answers "is
// the running process the code I just edited?" before anything is triggered —
// the stale-process trap AGENTS.md warns about.
console.warn(
  `[showcase_all_slack_blocks_catalog] loaded · page 1 renders ` +
    `${PAGE_1_BLOCK_COUNT} blocks, page 2 is the meeting form`,
);

/**
 * The catalog is a launch and community-demo surface, off by default. The tool
 * is registered only when the flag is enabled: a tool that is visible but
 * refuses leaks into the agent's reasoning and produces "I can't do that here"
 * answers instead of the topic simply not existing.
 */
export function isBlockCatalogEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.OPENTAG_SHOW_BLOCK_CATALOG?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Slack-native blocks are dropped silently on other platforms, so returning the
 * catalog there would post an empty message. One visible sentence instead.
 */
function unavailableOffSlack(): ChannelNode {
  return (
    <Message>
      <Section>
        This showcase is built from Slack's own message blocks, so there is
        nothing for it to draw here.
      </Section>
    </Message>
  );
}

export const blockCatalogTool = defineChannelTool({
  name: "showcase_all_slack_blocks_catalog",
  /**
   * The description is the only lever on how often the model reaches for this.
   * The boundary against `show_capabilities` is stated outright, because both
   * tools are plausible answers to a loosely worded question and only one of
   * them is right.
   */
  description:
    "ONLY when the user explicitly asks to see all Slack blocks, the full " +
    "Slack block catalog, or one message containing every supported Slack " +
    "block type — 'show me all Slack blocks', 'show the whole block " +
    "catalog', 'every block you can post'. Posts a single reference message " +
    "with one labelled specimen of each block. NEVER call this for identity " +
    "or capability questions such as 'who are you?', 'what can you do?', or " +
    "'how can you help?' — show_capabilities is the only right answer to " +
    "those. NEVER call it to present real content: use render_table for " +
    "tabular data, render_chart for charts, render_diagram for diagrams, and " +
    "the purpose-built cards for plans, briefs and summaries. Takes no " +
    "arguments.",
  parameters: z.object({}),
  async handler(_props, { thread, platform }) {
    if (platform !== "slack") {
      await thread.post(unavailableOffSlack());
      return "Told the user the Slack block catalog only renders on Slack.";
    }

    console.warn(
      `[showcase_all_slack_blocks_catalog] posting ${EXAMPLES.length} worked ` +
        `examples as page 1 of ${PAGE_COUNT} (${PAGE_1_BLOCK_COUNT} blocks)`,
    );

    // A fresh call opens on page 1 with nothing answered. The rest of thread
    // state is preserved so an unrelated component's slice is not clobbered.
    const all = ((await thread.state()) ?? {}) as Record<string, unknown>;
    await thread.setState({ ...all, [STATE_KEY]: INITIAL_STATE });
    await thread.post(BlockCatalog(INITIAL_STATE));

    return (
      "The showcase message is the complete user-facing answer. It has a " +
      "second page, reached with the Next button at the end of it. Do not post " +
      "a separate confirmation, restatement, or list of the blocks."
    );
  },
});
