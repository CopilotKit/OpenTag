/**
 * `render_table` posts a `<Table>` JSX component to the thread. We drive the
 * handler with a fake `thread` whose `post` records the posted Renderable (or
 * throws to exercise the monospace fallback), then assert the rendering through
 * `renderToIR` → `renderSlackMessage` yields the expected Block Kit shape.
 */
import { describe, it, expect } from "vitest";
import { renderToIR } from "@copilotkit/channels-ui";
import { renderSlackMessage } from "@copilotkit/channels-slack";
import {
  renderTableTool,
  toMonospaceTable,
  toBudgetedMonospaceTable,
  clamp,
} from "../render-table.js";

type HandlerCtx = Parameters<typeof renderTableTool.handler>[1];

const COLS = [
  { header: "Issue" },
  { header: "Priority", align: "right" as const },
];
const ROWS = [
  ["CPK-1", "High"],
  ["CPK-2", "Low"],
];

/**
 * Build a table whose column-aligned monospace render comfortably exceeds
 * the monospace-fallback's section-text budget (Slack's own <Section> cap is
 * 3000 chars) — used to force and verify size-based row truncation on the
 * fallback path, distinct from the row/column COUNT clamp exercised above.
 * 8 columns x 99 rows, every cell padded to a uniform 12 chars, renders to
 * well over 12,000 chars.
 */
function makeOversizedTable(numCols: number, numRows: number) {
  const columns = Array.from({ length: numCols }, (_, i) => ({
    header: `Column${i}`.padEnd(12, "X"),
  }));
  const rows = Array.from({ length: numRows }, (_, r) =>
    columns.map((_, c) => `r${r}c${c}`.padEnd(12, "-")),
  );
  return { columns, rows };
}

interface TableBlock {
  type: string;
  rows?: Array<Array<{ type: string; text: string }>>;
  column_settings?: Array<{ align?: string }>;
}

/**
 * A fake `thread` recording each posted Renderable. `throwOnPosts` names which
 * 1-indexed post numbers should reject (e.g. `[1]` fails just the native post,
 * `[1, 2]` fails both the native post and the monospace fallback).
 */
function fakeThread(throwOnPosts?: number[]) {
  const posts: unknown[] = [];
  let n = 0;
  const thread = {
    post: async (ui: unknown) => {
      n += 1;
      if (throwOnPosts?.includes(n)) throw new Error("invalid_blocks");
      posts.push(ui);
      return { id: `m${n}` };
    },
  };
  return { posts, ctx: { thread } as unknown as HandlerCtx };
}

describe("toMonospaceTable", () => {
  it("renders a column-aligned, code-fenced table", () => {
    const out = toMonospaceTable(COLS, ROWS);
    expect(out.startsWith("```\n")).toBe(true);
    expect(out.endsWith("\n```")).toBe(true);
    // "Priority" (8) is the widest in column 2 and is align: "right", so
    // "High" (4) is left-padded (padStart) to width 8, not right-padded.
    expect(out).toContain("| CPK-1 |     High |");
    expect(out).toContain("| Issue | Priority |");
  });

  it("right-aligns cells (padStart) in columns with align: 'right'", () => {
    // Column 2 ("Priority", align: right) is 8 chars wide; "Low" (3) should be
    // left-padded with 5 spaces, not right-padded (padEnd) like a left-aligned cell.
    const out = toMonospaceTable(COLS, ROWS);
    expect(out).toContain("| CPK-2 |      Low |");
    // Column 1 ("Issue", no align — defaults left) still pads on the right.
    expect(out).toContain("| CPK-1 |");
  });

  it("center-aligns cells (padded roughly evenly on both sides) in columns with align: 'center'", () => {
    const centerCols = [
      { header: "Issue" },
      { header: "Status", align: "center" as const },
    ];
    const centerRows = [
      ["CPK-1", "OK"],
      ["CPK-2", "FAILED"],
    ];
    // Column 2 ("Status", align: center) is 6 chars wide ("FAILED").
    // "OK" (2) needs 4 spaces total: 2 left, 2 right.
    const out = toMonospaceTable(centerCols, centerRows);
    expect(out).toContain("| CPK-1 |   OK   |");
    // "FAILED" (6) exactly fills the width — no padding needed.
    expect(out).toContain("| CPK-2 | FAILED |");
  });
});

describe("toBudgetedMonospaceTable", () => {
  it("returns the full render unchanged when it's within the section budget (happy-path fallback)", () => {
    const { text, shownRows } = toBudgetedMonospaceTable(COLS, ROWS);
    expect(text).toBe(toMonospaceTable(COLS, ROWS));
    expect(shownRows).toBe(ROWS.length);
  });

  it("drops trailing rows at a row boundary (never mid-row) when the full render exceeds the budget", () => {
    const { columns, rows } = makeOversizedTable(8, 99);
    const full = toMonospaceTable(columns, rows);
    // Sanity: this table really does blow well past Slack's hard 3000-char
    // section-text limit, so this exercises real truncation, not a no-op.
    expect(full.length).toBeGreaterThan(3000);

    const { text, shownRows } = toBudgetedMonospaceTable(columns, rows);
    expect(shownRows).toBeGreaterThan(0);
    expect(shownRows).toBeLessThan(rows.length);
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).not.toContain("…");

    // Row-boundary safety: the result is a well-formed fence wrapping the
    // header plus exactly `shownRows` complete data rows — no partial row.
    const lines = text.split("\n");
    expect(lines[0]).toBe("```");
    expect(lines[lines.length - 1]).toBe("```");
    const contentLines = lines.slice(1, -1);
    expect(contentLines).toHaveLength(shownRows + 1); // + header row
    // Every column pads to a fixed width, so every content line (header and
    // data alike) is the same length; a mid-row chop would leave a shorter,
    // ragged final line instead.
    expect(new Set(contentLines.map((l) => l.length)).size).toBe(1);
    // The dropped rows are the trailing ones — the kept rows are a prefix.
    expect(contentLines.slice(1)).toEqual(
      full.split("\n").slice(2, 2 + shownRows),
    );
  });
});

describe("render_table tool", () => {
  it("posts a <Table> rendering to a header + native table block", async () => {
    const { posts, ctx } = fakeThread();
    const out = (await renderTableTool.handler(
      { title: "Open issues", columns: COLS, rows: ROWS },
      ctx,
    )) as string;
    expect(posts).toHaveLength(1);
    expect(out).toBe("Rendered the table for the user.");

    const { blocks } = renderSlackMessage(renderToIR(posts[0] as never));
    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { type: "plain_text", text: "Open issues" },
    });
    const table = blocks.find((b) => b.type === "table") as
      | TableBlock
      | undefined;
    expect(table).toBeDefined();
    // Header row from columns, then one row per data row.
    expect(table?.rows).toHaveLength(3);
    expect(table?.rows?.[0]).toEqual([
      { type: "raw_text", text: "Issue" },
      { type: "raw_text", text: "Priority" },
    ]);
    expect(table?.rows?.[1]).toEqual([
      { type: "raw_text", text: "CPK-1" },
      { type: "raw_text", text: "High" },
    ]);
    // Alignment carries through column_settings.
    expect(table?.column_settings).toEqual([
      { align: "left" },
      { align: "right" },
    ]);
  });

  it("falls back to a monospace table when the native post is rejected", async () => {
    const { posts, ctx } = fakeThread([1]);
    const out = (await renderTableTool.handler(
      { title: "Open issues", columns: COLS, rows: ROWS },
      ctx,
    )) as string;
    // First post threw; second (fallback) recorded.
    expect(posts).toHaveLength(1);
    expect(out).toBe("Rendered the table (monospace fallback) for the user.");

    // Fallback is a platform-neutral <Message><Header>…</Header><Section>…</Section></Message>.
    const { blocks } = renderSlackMessage(renderToIR(posts[0] as never));
    // Title is in a plain-text header block.
    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { type: "plain_text", text: "Open issues" },
    });
    // Monospace table is in the section block.
    const text = JSON.stringify(blocks);
    expect(text).toContain("```");
    expect(text).toContain("CPK-1");
  });

  it("resolves with an error status string (does not throw) when both the native post and the monospace fallback are rejected", async () => {
    const { posts, ctx } = fakeThread([1, 2]);
    await expect(
      renderTableTool.handler(
        { title: "Open issues", columns: COLS, rows: ROWS },
        ctx,
      ),
    ).resolves.toBe(
      "The table couldn't be posted (both native and monospace rendering failed).",
    );
    // Neither post was recorded — both rejected.
    expect(posts).toHaveLength(0);
  });

  it("clamps to 99 data rows and reports the drop", async () => {
    const { posts, ctx } = fakeThread();
    const manyRows = Array.from({ length: 150 }, (_, i) => [`r${i}`, "x"]);
    const out = (await renderTableTool.handler(
      { columns: COLS, rows: manyRows },
      ctx,
    )) as string;
    // The drop is reported back to the agent...
    expect(out).toContain("only the first 99 of 150 rows shown");
    const { blocks } = renderSlackMessage(renderToIR(posts[0] as never));
    const table = blocks.find((b) => b.type === "table") as
      | TableBlock
      | undefined;
    // 99 data rows + 1 header row.
    expect(table?.rows).toHaveLength(100);
    // ...and also posted into the thread so the user sees it, not just the agent.
    const text = JSON.stringify(blocks);
    expect(text).toContain("only the first 99 of 150 rows shown");
  });

  it("clamps to 20 columns and reports the drop", async () => {
    const { posts, ctx } = fakeThread();
    const manyCols = Array.from({ length: 25 }, (_, i) => ({
      header: `c${i}`,
    }));
    const wideRow = manyCols.map((_, i) => `v${i}`);
    const out = (await renderTableTool.handler(
      { columns: manyCols, rows: [wideRow] },
      ctx,
    )) as string;
    expect(out).toContain("only the first 20 of 25 columns shown");
    const { blocks } = renderSlackMessage(renderToIR(posts[0] as never));
    const table = blocks.find((b) => b.type === "table") as
      | TableBlock
      | undefined;
    expect(table?.rows?.[0]).toHaveLength(20);
    const text = JSON.stringify(blocks);
    expect(text).toContain("only the first 20 of 25 columns shown");
    // Well-formed rows (one cell per *declared* column) must NOT also trigger
    // the extra-cells note — that would be a misleading double note, since
    // every row here has exactly 25 cells for 25 declared columns; the only
    // "loss" is the column truncation already reported above.
    expect(out).not.toContain("extra cells");
    expect(text).not.toContain("extra cells");
  });
});

describe("clamp", () => {
  it("returns no notes when within limits", () => {
    const { notes } = clamp(COLS, ROWS);
    expect(notes).toEqual([]);
  });

  it("reports rows with more cells than declared columns instead of silently dropping them", () => {
    // COLS has 2 columns; this row carries a 3rd cell that has nowhere to go.
    const { notes } = clamp(COLS, [["CPK-1", "High", "extra-cell"]]);
    expect(notes).toEqual([
      "1 row(s) had extra cells beyond the 2 columns; extras were dropped",
    ]);
  });

  it("does not flag extra cells for a well-formed table with more than 20 declared columns", () => {
    // 25 declared columns get clamped to 20 for the native Table, but every
    // row here has exactly 25 cells — one per *declared* column — so this is
    // NOT malformed. The extra-cell note must compare against the original
    // declared column count, not the clamped one, or every row in a wide but
    // well-formed table would spuriously "have extra cells".
    const manyCols = Array.from({ length: 25 }, (_, i) => ({
      header: `c${i}`,
    }));
    const wellFormedRow = manyCols.map((_, i) => `v${i}`);
    const { notes } = clamp(manyCols, [wellFormedRow, wellFormedRow]);
    expect(notes).toEqual([
      "only the first 20 of 25 columns shown",
    ]);
  });
});

describe("render_table tool — monospace fallback size budget", () => {
  it("truncates the monospace fallback at a row boundary and annotates the drop when the rendered text would exceed the section budget", async () => {
    const { columns, rows } = makeOversizedTable(8, 99);
    const { posts, ctx } = fakeThread([1]); // native post rejected -> monospace fallback
    const out = (await renderTableTool.handler(
      { title: "Big table", columns, rows },
      ctx,
    )) as string;

    expect(posts).toHaveLength(1);

    // (b) the returned status annotates the size-driven truncation.
    const match = out.match(
      /only the first (\d+) of 99 rows shown in the text fallback/,
    );
    expect(match).not.toBeNull();
    const shownRows = Number(match?.[1]);
    expect(shownRows).toBeGreaterThan(0);
    expect(shownRows).toBeLessThan(99);

    // (a) the emitted text is within budget and cut at a row boundary, not
    // silently chopped mid-row by the renderer's own truncation.
    const { blocks } = renderSlackMessage(renderToIR(posts[0] as never));
    const section = blocks.find((b) => b.type === "section") as
      | { text?: { text: string } }
      | undefined;
    const text = section?.text?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(3000); // Slack's hard section-text cap
    expect(text.startsWith("```\n")).toBe(true);
    expect(text.endsWith("\n```")).toBe(true);
    expect(text).not.toContain("…"); // no blind renderer truncation kicked in

    const contentLines = text.split("\n").slice(1, -1); // drop the ``` fences
    expect(contentLines).toHaveLength(shownRows + 1); // + header row
    // Uniform row width (every column pads to a fixed width) — a mid-row cut
    // would leave a shorter, ragged final line instead.
    expect(new Set(contentLines.map((l) => l.length)).size).toBe(1);

    // The annotation also reaches the thread itself (a Context block), not
    // just the agent-facing status string — matching how `clamp` notes are
    // surfaced in both places.
    const fullText = JSON.stringify(blocks);
    expect(fullText).toContain("shown in the text fallback");
  });
});

describe("render_table tool — extra cells per row", () => {
  it("surfaces a note (to the agent and the thread) when a row has more cells than columns", async () => {
    const { posts, ctx } = fakeThread();
    const rowsWithExtra = [
      ["CPK-1", "High", "extra-1"],
      ["CPK-2", "Low"],
    ];
    const out = (await renderTableTool.handler(
      { title: "Open issues", columns: COLS, rows: rowsWithExtra },
      ctx,
    )) as string;
    // Reported back to the agent in the returned status string...
    expect(out).toContain(
      "1 row(s) had extra cells beyond the 2 columns; extras were dropped",
    );
    // ...and also posted into the thread so the user sees it, not just the agent.
    const { blocks } = renderSlackMessage(renderToIR(posts[0] as never));
    const text = JSON.stringify(blocks);
    expect(text).toContain(
      "1 row(s) had extra cells beyond the 2 columns; extras were dropped",
    );
  });
});
