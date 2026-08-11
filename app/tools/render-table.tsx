/**
 * `render_table` — render tabular data as a native Table block,
 * posted into the current thread. Use this for "show X as a table": a list of
 * issues with several fields, metrics parsed from an uploaded CSV, side-by-side
 * comparisons — anything where a chart isn't the right shape.
 *
 * Authored as JSX over `@copilotkit/channels`'s `<Table>/<Row>/<Cell>` vocabulary
 * and posted via `thread.post`. If the platform rejects the native Table block,
 * we fall back to a column-aligned monospace (code-fenced) table posted as a
 * platform-neutral `<Message>` so the data always lands — the same look the
 * bridge gives GFM tables in prose.
 */
import { z } from "zod";
import {
  Message,
  Header,
  Section,
  Table,
  Row,
  Cell,
  Context,
} from "@copilotkit/channels";
import { getTelemetry } from "../telemetry.js";
import { defineChannelTool } from "@copilotkit/channels";

const schema = z.object({
  title: z
    .string()
    .optional()
    .describe("Optional heading shown above the table."),
  columns: z
    .array(
      z.object({
        header: z.string().describe("Column header text."),
        align: z
          .enum(["left", "center", "right"])
          .optional()
          .describe(
            "Alignment for this column's cells. Default left; right for numbers.",
          ),
      }),
    )
    .min(1)
    .describe(
      "Columns, left to right. At most 20 are used; extras are dropped.",
    ),
  rows: z
    .array(z.array(z.coerce.string()))
    .describe(
      "Data rows; each row is an array of cell values in column order " +
        "(numbers are fine — they're rendered as text). Max 99 rows.",
    ),
});

type Column = z.infer<typeof schema>["columns"][number];

// Cap the native Table block at 100 rows (header included) and 20 cols.
const MAX_COLUMNS = 20;
const MAX_DATA_ROWS = 99;

/** Clamp to platform limits, recording what was dropped. */
export function clamp(
  columns: Column[],
  rows: string[][],
): { cols: Column[]; dataRows: string[][]; notes: string[] } {
  const cols = columns.slice(0, MAX_COLUMNS);
  const dataRows = rows.slice(0, MAX_DATA_ROWS);
  const notes: string[] = [];
  if (columns.length > MAX_COLUMNS) {
    notes.push(
      `only the first ${MAX_COLUMNS} of ${columns.length} columns shown`,
    );
  }
  if (rows.length > MAX_DATA_ROWS) {
    notes.push(`only the first ${MAX_DATA_ROWS} of ${rows.length} rows shown`);
  }
  // Compare against the ORIGINAL declared column count, not the clamped
  // `cols.length` — otherwise a well-formed table with >MAX_COLUMNS columns
  // would have every row spuriously flagged as "extra cells dropped" (the
  // column truncation itself is already reported above).
  const extraCellRows = dataRows.filter((r) => r.length > columns.length).length;
  if (extraCellRows > 0) {
    notes.push(
      `${extraCellRows} row(s) had extra cells beyond the ${columns.length} ` +
        "columns; extras were dropped",
    );
  }
  return { cols, dataRows, notes };
}

/**
 * Column-aligned monospace fallback, wrapped in a code fence — matches the
 * `alignTable` render the bridge applies to GFM tables in streamed prose.
 */
export function toMonospaceTable(cols: Column[], dataRows: string[][]): string {
  const header = cols.map((c) => c.header);
  const body = dataRows.map((r) => cols.map((_, i) => String(r[i] ?? "")));
  const widths = cols.map((_, c) =>
    Math.max(
      (header[c] ?? "").length,
      ...body.map((row) => (row[c] ?? "").length),
    ),
  );
  const fmt = (row: string[]) =>
    "| " +
    cols
      .map((col, c) => {
        const cell = row[c] ?? "";
        const width = widths[c] ?? 0;
        if (col.align === "right") return cell.padStart(width);
        if (col.align === "center") {
          const total = Math.max(width - cell.length, 0);
          const left = Math.floor(total / 2);
          const right = total - left;
          return " ".repeat(left) + cell + " ".repeat(right);
        }
        return cell.padEnd(width);
      })
      .join(" | ") +
    " |";
  return "```\n" + [fmt(header), ...body.map(fmt)].join("\n") + "\n```";
}

export const renderTableTool = defineChannelTool({
  name: "render_table",
  description:
    "Render tabular data as a table posted to the conversation thread. Pass " +
    "columns (each with a header and optional alignment) and rows (arrays of " +
    "cell values in column order). Use for 'show as a table' — issue lists " +
    "with several fields, metrics from a CSV, comparisons — when a chart " +
    "isn't the right shape. Max 20 columns and 99 rows.",
  parameters: schema,
  async handler({ title, columns, rows }, { thread }) {
    const { cols, dataRows, notes } = clamp(columns, rows);
    // When rows/columns were truncated, surface it both to the user (a
    // trailing <Context> note under the table) and to the agent (appended to
    // the returned status string), so a silent drop never happens.
    const noteBlock = notes.length > 0 ? <Context>{notes.join("; ")}</Context> : null;
    const noteSuffix = notes.length > 0 ? ` (${notes.join("; ")})` : "";

    const table = (
      <Message>
        {title ? <Header>{title}</Header> : null}
        <Table columns={cols}>
          {dataRows.map((r) => (
            <Row>
              {cols.map((_, i) => (
                <Cell>{String(r[i] ?? "")}</Cell>
              ))}
            </Row>
          ))}
        </Table>
        {noteBlock}
      </Message>
    );

    try {
      await thread.post(table);
      return `Rendered the table for the user.${noteSuffix}`;
    } catch (err) {
      // Native Table block not accepted (platform unsupported) — post the same
      // data as a monospace code-fenced table via a platform-neutral <Message>
      // so it still lands on any adapter.
      getTelemetry().logger.warn("render_table_native_post_failed", {
        error: err,
        recovery: "try_monospace_fallback",
      });
      const mono = toMonospaceTable(cols, dataRows);
      const fallback = (
        <Message>
          {title ? <Header>{title}</Header> : null}
          <Section>{mono}</Section>
          {noteBlock}
        </Message>
      );
      try {
        await thread.post(fallback);
        return `Rendered the table (monospace fallback) for the user.${noteSuffix}`;
      } catch (fallbackErr) {
        // Both the native table and the monospace fallback were rejected —
        // likely the same transient/platform failure hit both posts. Return a
        // clear status string instead of letting the handler throw, so the
        // agent gets an actionable message rather than an opaque tool error.
        getTelemetry().logger.error("render_table_fallback_post_failed", {
          error: fallbackErr,
          recovery: "return_actionable_status",
        });
        return `The table couldn't be posted (both native and monospace rendering failed).${noteSuffix}`;
      }
    }
  },
});
