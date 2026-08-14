/**
 * The showcase's whole value is that it arrives. Slack refuses a message
 * *whole* and without a usable error, so each constraint that would sink it is
 * pinned here: the block count against Slack's per-message ceiling, the
 * plan/task-card exclusivity, the blocks a container may not hold, and literal
 * table cells.
 *
 * The rendered block count is pinned deliberately. It is the check that fails
 * when a future example pushes the message past 50 blocks and takes the whole
 * showcase off screen.
 */
import { describe, it, expect } from "vitest";
import { renderToIR } from "@copilotkit/channels";
import { renderSlackMessage } from "@copilotkit/channels/slack";
import {
  BLOCK_CATALOG_HEADINGS,
  BLOCK_CATALOG_TYPES,
  BlockCatalog,
  PAGE_1_BLOCK_COUNT,
  blockCatalogTool,
  confirmBooking,
  isBlockCatalogEnabled,
  navigatePage,
  recordBookingField,
  type Booking,
  type CatalogState,
} from "../block-catalog.js";
import { createAppTools } from "../index.js";

/** Slack's hard ceiling on the blocks one message may carry. */
const SLACK_MESSAGE_BLOCK_LIMIT = 50;

/**
 * The measured size of page 1: a header and an intro line, then for each of the
 * fourteen examples one combined heading block plus its specimens, then the
 * navigator. The first example puts all of its specimens inside one container;
 * the second frames its rich text the same way but has to leave its `markdown`
 * lead-in outside, because Slack refuses a `markdown` child of a `container`.
 */
const RENDERED_BLOCK_COUNT = PAGE_1_BLOCK_COUNT;

/** The navigator at the end of every page: a rule, the button, the counter. */
const NAVIGATOR_BLOCK_COUNT = 3;

/** Page 2 with nothing confirmed: a header, an intro, four fields, Confirm. */
const PAGE_2_BLOCK_COUNT = 7 + NAVIGATOR_BLOCK_COUNT;

/** The values used wherever a test needs a complete booking. */
const BOOKING: Booking = {
  channel: "C0BM9JJK6E8",
  when: 1786451118,
  duration: "45m",
  email: "ops@example.com",
};

const page = (state: Partial<CatalogState>): Record<string, unknown>[] =>
  renderSlackMessage(
    renderToIR(BlockCatalog({ page: 0, booking: {}, ...state })),
  ).blocks as unknown as Record<string, unknown>[];

const typesOf = (blocks: Record<string, unknown>[]) =>
  blocks.map((block) => block.type);

const textOf = (blocks: Record<string, unknown>[]) => JSON.stringify(blocks);

/**
 * A fake thread that records `setState`/`update`, so a navigation or confirm
 * handler can be driven without Slack. Weaker evidence than a real click — it
 * proves the handler and the rendering, not the wiring Slack does.
 */
function fakeInteraction(stored: Partial<CatalogState> = {}) {
  let state: Record<string, unknown> = {
    blockCatalog: { page: 0, booking: {}, ...stored },
  };
  const updates: unknown[] = [];
  const thread = {
    state: async () => state,
    setState: async (value: Record<string, unknown>) => {
      state = value;
    },
    update: async (_ref: unknown, ui: unknown) => {
      updates.push(ui);
      return { id: "m1" };
    },
  };
  return {
    updates,
    read: () => state.blockCatalog as CatalogState,
    ctx: (value?: unknown) =>
      ({
        thread,
        message: { ref: { id: "m1", channel: "C0BM9JJK6E8" } },
        action: { id: "a1", value },
        values: {},
      }) as never,
  };
}

/**
 * `emoji *Heading* (`block`, `block`)`, then the description on the next line.
 * The glyph is what makes the line read as a heading; it costs no block, which
 * a divider above each of the fourteen would.
 */
const HEADING_LINE = /^(\P{ASCII}) \*(.+?)\* \(`/u;

/**
 * The fourteen examples, in the order the message presents them — the order
 * agreed with the product owner, `actions` before `input`.
 */
const THE_14_HEADINGS = [
  "A status update the team can skim",
  "Formatted writing with lists, a quote and code",
  "Collapse the long stuff so it does not flood the channel",
  "Numbers side by side",
  "A long list you can page through",
  "A trend over time, then a share of the whole",
  "An image in the post",
  "A video that plays in place",
  "A card with a title, image and text",
  "Several cards to browse sideways",
  "Act without leaving Slack",
  "A small input right in the channel",
  "Give feedback on a result",
  "The agent at work",
];

/** Every block an app may post, still covered across the fourteen examples. */
const THE_19_BLOCKS = [
  "header",
  "section",
  "divider",
  "context",
  "markdown",
  "rich_text",
  "container",
  "table",
  "data_table",
  "data_visualization",
  "image",
  "video",
  "card",
  "carousel",
  "actions",
  "input",
  "context_actions",
  "plan",
  "task_card",
];

function catalogBlocks(): Record<string, unknown>[] {
  return page({ page: 0 });
}

/** A fake `thread` that records each posted Renderable and its thread state. */
function fakeThread() {
  const posts: unknown[] = [];
  let state: Record<string, unknown> = { unrelated: "kept" };
  const thread = {
    post: async (ui: unknown) => {
      posts.push(ui);
      return { id: "m1" };
    },
    state: async () => state,
    setState: async (value: Record<string, unknown>) => {
      state = value;
    },
  };
  return {
    posts,
    read: () => state,
    ctx: { thread, platform: "slack" } as never,
  };
}

describe("showcase_all_slack_blocks_catalog", () => {
  it("still covers the 19 blocks an app can post, in one message", () => {
    expect([...BLOCK_CATALOG_TYPES].sort()).toEqual([...THE_19_BLOCKS].sort());
  });

  it("renders a pinned block count that stays under Slack's per-message limit", () => {
    // Exceeding the limit loses the whole message, not the excess blocks. The
    // count includes the navigator, which is what page 1 had to make room for.
    expect(catalogBlocks()).toHaveLength(RENDERED_BLOCK_COUNT);
    expect(RENDERED_BLOCK_COUNT).toBeLessThan(SLACK_MESSAGE_BLOCK_LIMIT);
  });

  it("introduces the message with a heading, not with a labelled list", () => {
    const [first, second] = catalogBlocks();

    expect(first?.type).toBe("header");
    expect(JSON.stringify(first)).toContain("🧱");
    expect(second?.type).toBe("section");
    // The reader is never told this is a catalogue of every block.
    const intro = JSON.stringify(catalogBlocks().slice(0, 2));
    expect(intro).not.toMatch(/specimen|catalog|every block/i);
  });

  it("heads each example in natural language, in the agreed order", () => {
    expect([...BLOCK_CATALOG_HEADINGS]).toEqual(THE_14_HEADINGS);

    const headings = catalogBlocks().flatMap((block) => {
      const text = (block as { text?: { text?: string } }).text?.text;
      const match = text?.match(HEADING_LINE);
      return match?.[2] ? [match[2]] : [];
    });

    expect(headings).toEqual(THE_14_HEADINGS);
  });

  it("sets every heading off with a distinct emoji glyph, not a shortcode", () => {
    const glyphs = catalogBlocks().flatMap((block) => {
      const text = (block as { text?: { text?: string } }).text?.text;
      const match = text?.match(HEADING_LINE);
      return match?.[1] ? [match[1]] : [];
    });

    expect(glyphs).toHaveLength(THE_14_HEADINGS.length);
    // A `:shortcode:` renders literally in a mrkdwn section, so the glyph is
    // the only form that draws. Distinct glyphs keep the headings scannable.
    expect(new Set(glyphs).size).toBe(THE_14_HEADINGS.length);
    for (const glyph of glyphs) expect(glyph).not.toMatch(/^:/);
  });

  it("names the real blocks and describes them in the same block", () => {
    const headingBlocks = catalogBlocks().filter((block) => {
      const text = (block as { text?: { text?: string } }).text?.text;
      return Boolean(text?.match(HEADING_LINE));
    });

    expect(headingBlocks).toHaveLength(THE_14_HEADINGS.length);
    for (const block of headingBlocks) {
      const text = (block as { text: { text: string } }).text.text;
      // Heading, block names and description share one block: split in two the
      // message runs past Slack's 50-block ceiling and is refused whole.
      const [headline, ...rest] = text.split("\n");
      expect(headline).toMatch(/\(`[a-z_]+`(, `[a-z_]+`)*\)$/);
      expect(rest.join("\n").trim().length).toBeGreaterThan(0);
    }
  });

  it("carries no closing note about the blocks an app cannot post", () => {
    const rendered = JSON.stringify(catalogBlocks());

    expect(rendered).not.toContain("`alert`");
    expect(rendered).not.toContain("`file`");
  });

  it("keeps the task card inside the plan, never beside it", () => {
    const types = catalogBlocks().map((block) => block.type);

    expect(types).toContain("plan");
    // A message carrying both a plan and a standalone task card is refused.
    expect(types).not.toContain("task_card");
  });

  it("keeps data tables and charts as siblings of every container", () => {
    const blocks = catalogBlocks();
    const types = blocks.map((block) => block.type);
    const containers = blocks.filter((block) => block.type === "container");

    expect(types).toContain("data_table");
    expect(types).toContain("data_visualization");
    // Three containers now: two framing examples and the collapsible one.
    expect(containers).toHaveLength(3);
    for (const container of containers) {
      expect(JSON.stringify(container)).not.toContain("data_table");
      expect(JSON.stringify(container)).not.toContain("data_visualization");
    }
  });

  it("never puts a markdown block inside a container", () => {
    // Measured live: `invalid_blocks`, and the whole message is lost with it.
    for (const container of catalogBlocks().filter(
      (block) => block.type === "container",
    )) {
      const children = (container as { blocks?: { type: string }[] }).blocks;
      expect(children?.length).toBeGreaterThan(0);
      expect(children?.map(({ type }) => type)).not.toContain("markdown");
    }
  });

  it("frames the first two examples so they read apart from the prose", () => {
    const framed = catalogBlocks()
      .slice(2, 8)
      .map((block) => block.type);

    // Heading, framed specimen, the rule that spaces the examples apart,
    // heading, `markdown` lead-in, framed specimen. The frame is a container
    // because `card` has no children slot; the lead-in sits outside it because
    // Slack refuses `markdown` as a child of a container.
    expect(framed).toEqual([
      "section",
      "container",
      "divider",
      "section",
      "markdown",
      "container",
    ]);
  });

  /** The line chart and then the pie, in the order the example renders them. */
  const charts = () =>
    catalogBlocks().filter(
      (block) => block.type === "data_visualization",
    ) as unknown as { title: string; chart: Record<string, unknown> }[];

  it("draws two kinds of chart, a line and then a pie", () => {
    // The point of the example is that Slack draws more than one kind, so the
    // pair is pinned rather than just the presence of a chart.
    expect(charts().map(({ chart }) => chart.type)).toEqual(["line", "pie"]);
    for (const { title } of charts()) {
      expect(title.length).toBeLessThanOrEqual(50);
    }
  });

  it("gives the line chart enough points to show a shape", () => {
    const [line] = charts();
    const { series, axis_config } = line!.chart as unknown as {
      series: { name: string; data: { label: string; value: number }[] }[];
      axis_config: { categories: string[] };
    };

    expect(axis_config.categories.length).toBeGreaterThanOrEqual(10);
    expect(new Set(axis_config.categories).size).toBe(
      axis_config.categories.length,
    );
    for (const label of axis_config.categories) {
      expect(label.length).toBeLessThanOrEqual(20);
    }
    for (const { name, data } of series) {
      expect(name.length).toBeLessThanOrEqual(20);
      // Slack refuses the message unless the two sets match exactly.
      expect(data.map(({ label }) => label)).toEqual(axis_config.categories);
    }
  });

  it("gives the pie segments and no axis config", () => {
    const pie = charts()[1]!.chart as unknown as {
      segments: { label: string; value: number }[];
      axis_config?: unknown;
    };

    // A pie payload is `segments` alone; the categories rule that governs the
    // line chart has nothing to match against here.
    expect(pie.axis_config).toBeUndefined();
    expect(pie.segments.length).toBeGreaterThan(1);
    expect(new Set(pie.segments.map(({ label }) => label)).size).toBe(
      pie.segments.length,
    );
    for (const { label, value } of pie.segments) {
      expect(label.length).toBeLessThanOrEqual(20);
      expect(value).toBeGreaterThan(0);
    }
  });

  it("puts the button after the two controls it acts on", () => {
    // The example's `actions` block, not the navigator's: the navigator holds a
    // single button, so the row with three elements is the one under test.
    const row = catalogBlocks().find(
      (block) =>
        block.type === "actions" &&
        ((block as { elements?: unknown[] }).elements ?? []).length === 3,
    ) as { elements: { type: string }[] };

    // Elements render in array order, so this is what places the button to the
    // right of the select and the date picker: choose, choose, then act.
    expect(row.elements.map(({ type }) => type)).toEqual([
      "static_select",
      "datepicker",
      "button",
    ]);
  });

  it("previews the video with a still of that same video", () => {
    const video = catalogBlocks().find(({ type }) => type === "video") as {
      title_url: string;
      video_url: string;
      thumbnail_url: string;
      title: { text: string };
    };

    // A thumbnail of something else makes the preview lie about the content.
    // All three URLs name one video id, so they cannot drift apart.
    const id = "aqz-KE-bpKQ";
    expect(video.title_url).toContain(id);
    expect(video.video_url).toContain(id);
    expect(video.thumbnail_url).toContain(id);
    expect(video.title.text).toContain("Big Buck Bunny");
  });

  it("keeps table cells literal, with no markdown or links", () => {
    const rows = catalogBlocks()
      .filter((block) => block.type === "table" || block.type === "data_table")
      .flatMap((block) => (block as { rows?: unknown[] }).rows ?? []);

    expect(rows.length).toBeGreaterThan(0);
    for (const cell of rows.flat() as { type: string; text: string }[]) {
      expect(cell.type).toBe("raw_text");
      expect(cell.text).not.toMatch(/[*_`<>[\]]|https?:/);
    }
  });

  it("posts the showcase once and claims the whole answer", async () => {
    const { posts, ctx, read } = fakeThread();
    const result = await blockCatalogTool.handler({}, ctx);

    expect(posts).toHaveLength(1);
    expect(result).toContain("Do not post a separate confirmation");
    expect(
      renderSlackMessage(renderToIR(posts[0] as never)).blocks,
    ).toHaveLength(RENDERED_BLOCK_COUNT);
    // Opens on page 1 with nothing answered, and does not clobber another
    // component's slice of thread state.
    expect(read()).toEqual({
      unrelated: "kept",
      blockCatalog: { page: 0, booking: {} },
    });
  });

  it("says so rather than posting an empty message off Slack", async () => {
    const { posts, ctx } = fakeThread();
    const result = await blockCatalogTool.handler({}, {
      ...(ctx as unknown as Record<string, unknown>),
      platform: "teams",
    } as never);

    expect(posts).toHaveLength(1);
    expect(result).toContain("only renders on Slack");
  });
});

describe("the two pages", () => {
  it("ends page 1 with a Next control and nothing else new", () => {
    const blocks = catalogBlocks();
    const tail = typesOf(blocks.slice(-NAVIGATOR_BLOCK_COUNT));

    expect(tail).toEqual(["divider", "actions", "context"]);
    // Page 1 is the fourteen examples plus the navigator, nothing more.
    expect(blocks).toHaveLength(45 + NAVIGATOR_BLOCK_COUNT);
    expect(textOf(blocks.slice(-NAVIGATOR_BLOCK_COUNT))).toContain("Next");
    expect(textOf(blocks.slice(-NAVIGATOR_BLOCK_COUNT))).toContain(
      "Page 1 of 2",
    );
    // Slack has no disabled button, so the one that would go nowhere is absent.
    expect(textOf(blocks.slice(-NAVIGATOR_BLOCK_COUNT))).not.toContain("Back");
  });

  it("keeps page 1 under the ceiling with the control added", () => {
    expect(PAGE_1_BLOCK_COUNT).toBe(catalogBlocks().length);
    expect(PAGE_1_BLOCK_COUNT).toBeLessThan(SLACK_MESSAGE_BLOCK_LIMIT);
  });

  it("renders page 2 as a form of five fields ending in Confirm", () => {
    const blocks = page({ page: 1 });

    expect(blocks).toHaveLength(PAGE_2_BLOCK_COUNT);
    expect(typesOf(blocks)).toEqual([
      "header",
      "section",
      // Every field is an `input` block: an `actions` block refuses a text
      // field and a radio group, and the whole message is lost with them.
      "input",
      "input",
      "input",
      "input",
      "actions",
      "divider",
      "actions",
      "context",
    ]);

    const elements = blocks
      .filter((block) => block.type === "input")
      .map((block) => (block as { element: { type: string } }).element.type);
    // Radio buttons, decided explicitly — not checkboxes.
    expect(elements).toEqual([
      "channels_select",
      "datetimepicker",
      "radio_buttons",
      "email_text_input",
    ]);
    // An input block in a *message* dispatches only when this is set.
    for (const block of blocks.filter(({ type }) => type === "input")) {
      expect(block.dispatch_action).toBe(true);
    }
    expect(textOf([blocks[6]!])).toContain("Confirm");
  });

  it("ends page 2 with a Back control and no Next", () => {
    const tail = page({ page: 1 }).slice(-NAVIGATOR_BLOCK_COUNT);

    expect(typesOf(tail)).toEqual(["divider", "actions", "context"]);
    expect(textOf(tail)).toContain("Back");
    expect(textOf(tail)).toContain("Page 2 of 2");
    expect(textOf(tail)).not.toContain("Next");
  });

  it("offers three durations as radio buttons, none preselected", () => {
    const radios = page({ page: 1 }).find(
      (block) =>
        (block as { element?: { type?: string } }).element?.type ===
        "radio_buttons",
    ) as {
      element: { options: { value: string }[]; initial_option?: unknown };
    };

    expect(radios.element.options.map(({ value }) => value)).toEqual([
      "30m",
      "45m",
      "60m",
    ]);
    expect(radios.element.initial_option).toBeUndefined();
  });

  it("asks the email field to dispatch as it is typed", () => {
    const email = page({ page: 1 }).find(
      (block) =>
        (block as { element?: { type?: string } }).element?.type ===
        "email_text_input",
    ) as {
      element: { dispatch_action_config: { trigger_actions_on: string[] } };
    };

    // The default is Enter alone, which never fires for a reader who types the
    // address and then presses Confirm.
    expect(email.element.dispatch_action_config.trigger_actions_on).toContain(
      "on_character_entered",
    );
  });

  it("shows no confirmation until Confirm has been pressed", () => {
    expect(typesOf(page({ page: 1 }))).not.toContain("container");
  });
});

describe("the booking confirmation", () => {
  const confirmed = () =>
    page({ page: 1, booking: BOOKING, confirmed: BOOKING });

  it("appears below the form, framed, and adds two blocks", () => {
    const blocks = confirmed();

    expect(blocks).toHaveLength(PAGE_2_BLOCK_COUNT + 2);
    // A rule, then the frame — after the form, before the navigator.
    expect(typesOf(blocks.slice(6, 9))).toEqual([
      "actions",
      "divider",
      "container",
    ]);
  });

  it("renders the values it was given, not a debug dump", () => {
    const container = confirmed().find(({ type }) => type === "container")!;
    const text = textOf([container]);

    // `<#C…>` is how mrkdwn names a channel, `<!date^…>` how it renders a time
    // in the reader's own timezone.
    expect(text).toContain("<#C0BM9JJK6E8>");
    expect(text).toContain("<!date^1786451118^");
    expect(text).toContain("45 minutes");
    expect(text).toContain("ops@example.com");
    // The value arrived as `45m`; the reader is never shown the raw form.
    expect(text).not.toContain("45m");
    expect(text).not.toContain("1786451118|");
    expect(text).not.toContain("booking");
  });

  it("says so rather than inventing a value that never arrived", () => {
    const text = textOf(
      page({ page: 1, booking: {}, confirmed: { duration: "30m" } }).filter(
        ({ type }) => type === "container",
      ),
    );

    expect(text).toContain("30 minutes");
    expect(text.match(/not chosen/g)).toHaveLength(3);
  });

  it("never puts a markdown block inside the confirmation frame", () => {
    // Measured live: Slack refuses a `markdown` child of a container and loses
    // the whole message with it.
    const container = confirmed().find(({ type }) => type === "container") as {
      blocks: { type: string }[];
    };

    expect(container.blocks.map(({ type }) => type)).toEqual([
      "header",
      "section",
      "divider",
      "context",
    ]);
  });
});

describe("navigation state", () => {
  it("moves to page 2 and back, updating the same message", async () => {
    const forward = fakeInteraction();
    await navigatePage(1)(forward.ctx("next"));

    expect(forward.read().page).toBe(1);
    expect(forward.updates).toHaveLength(1);
    expect(
      renderSlackMessage(renderToIR(forward.updates[0] as never)).blocks,
    ).toHaveLength(PAGE_2_BLOCK_COUNT);

    const back = fakeInteraction({ page: 1 });
    await navigatePage(-1)(back.ctx("back"));

    expect(back.read().page).toBe(0);
    expect(
      renderSlackMessage(renderToIR(back.updates[0] as never)).blocks,
    ).toHaveLength(PAGE_1_BLOCK_COUNT);
  });

  it("clamps at either end rather than leaving the pages", async () => {
    const first = fakeInteraction();
    await navigatePage(-1)(first.ctx("back"));
    expect(first.read().page).toBe(0);

    const last = fakeInteraction({ page: 1 });
    await navigatePage(1)(last.ctx("next"));
    expect(last.read().page).toBe(1);
  });

  it("keeps the page across an unrelated recording", async () => {
    const session = fakeInteraction({ page: 1 });
    await recordBookingField("email")(session.ctx("ops@example.com"));

    expect(session.read().page).toBe(1);
  });
});

describe("what a click carries back", () => {
  /**
   * Slack sends the state of every input block alongside a button click, but it
   * never reaches a handler: the Slack adapter fills `values` only for a modal
   * submission, so `ctx.values` is `{}` for a message click. Each field is
   * therefore recorded as its own control dispatches. This test is the guard: if
   * the SDK ever delivers the payload, the fallback can go.
   */
  it("accumulates each field as its control dispatches", async () => {
    const session = fakeInteraction({ page: 1 });

    await recordBookingField("channel")(session.ctx("C0BM9JJK6E8"));
    await recordBookingField("when")(session.ctx(1786451118));
    await recordBookingField("duration")(session.ctx("45m"));
    await recordBookingField("email")(session.ctx("ops@example.com"));

    expect(session.read().booking).toEqual(BOOKING);
    // Recording never redraws: a redraw is a fresh payload, so it would empty
    // the fields the reader has not answered yet.
    expect(session.updates).toHaveLength(0);
  });

  it("freezes what arrived on confirm and redraws with it", async () => {
    const session = fakeInteraction({ page: 1, booking: BOOKING });
    await confirmBooking(session.ctx("confirm_booking"));

    expect(session.read().confirmed).toEqual(BOOKING);
    const blocks = renderSlackMessage(renderToIR(session.updates[0] as never))
      .blocks as unknown as Record<string, unknown>[];

    expect(blocks).toHaveLength(PAGE_2_BLOCK_COUNT + 2);
    expect(textOf(blocks)).toContain("ops@example.com");
  });
});

describe("OPENTAG_SHOW_BLOCK_CATALOG", () => {
  const names = (env: NodeJS.ProcessEnv) =>
    createAppTools("OpenTag", env).map(({ name }) => name);

  it("hides the tool from the agent entirely when the flag is off", () => {
    // Absent, not present-and-refusing: a visible tool the agent must not call
    // becomes "I can't do that here" instead of a topic that does not exist.
    expect(names({})).not.toContain("showcase_all_slack_blocks_catalog");
    expect(names({ OPENTAG_SHOW_BLOCK_CATALOG: "" })).not.toContain(
      "showcase_all_slack_blocks_catalog",
    );
    expect(names({ OPENTAG_SHOW_BLOCK_CATALOG: "false" })).not.toContain(
      "showcase_all_slack_blocks_catalog",
    );
  });

  it("registers the tool when the flag is enabled", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
      expect(isBlockCatalogEnabled({ OPENTAG_SHOW_BLOCK_CATALOG: value })).toBe(
        true,
      );
    }
    expect(names({ OPENTAG_SHOW_BLOCK_CATALOG: "1" })).toContain(
      "showcase_all_slack_blocks_catalog",
    );
  });

  it("leaves the other app tools untouched in both directions", () => {
    const off = names({});
    const on = names({ OPENTAG_SHOW_BLOCK_CATALOG: "1" });

    expect(on).toEqual([...off, "showcase_all_slack_blocks_catalog"]);
    expect(off).toContain("show_capabilities");
  });
});
