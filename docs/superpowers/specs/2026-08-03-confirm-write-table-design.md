# confirm_write: render args as a table, not raw JSON

**Date:** 2026-08-03
**Ticket:** [CPK-7748](https://linear.app/copilotkit/issue/CPK-7748/confirm-write-card-dumps-raw-json-args-instead-of-a-readable-summary)
**Status:** Approved

## Problem

The `confirm_write` approval card renders the mutating tool's arguments as a raw
`json.dumps` string. For a Linear project write the card body is a single ~15-field
JSON line, long enough that Slack collapses it behind **Show more** — so the approver
cannot see the full payload at the moment they authorize the write. That defeats the
purpose of the human-in-the-loop gate.

The two fields that matter (`name`, `description`) sit mid-blob among empty defaults:
`"color": ""`, `"id": ""`, and six empty arrays.

This also contradicts the component's own contract. `ConfirmWrite`'s `detail` prop is
documented as "the specifics being approved — issue title + one-line description",
so the card was built for a summary and is being handed a dump.

Fixing the non-functional Create button is tracked separately and owned by Tyler.
This design covers presentation only.

## Constraints discovered

`@copilotkit/channels` exports `Table` / `Row` / `Cell`, and both renderers support
them natively:

| Surface | Output | Column cap | Row cap | Cell cap |
| --- | --- | --- | --- | --- |
| Slack | Block Kit `table` block | 20 | 100 | 2000 |
| Teams | Adaptive Card `Table` (+ GFM pipe-table markdown fallback) | 12 | 100 | — |

Two behaviors shape the design:

- **Slack table cells are `raw_text`.** No bold, no links inside a cell. Bold labels
  would require `Fields` / `Field label=` instead, which renders as a two-up grid
  rather than aligned rows.
- **`firstRowAsHeader` is conditional on the `columns` prop** on Teams, matching
  Slack's behavior of only emitting a header row when `columns` is supplied. So
  omitting `columns` yields a headerless table consistently on both surfaces.

## Design

The seam: **Python decides what to show, TypeScript decides how to show it.** Each
side is independently testable, and the card stays presentational.

### 1. `agent/write_confirmation.py`

Replace the `json.dumps(request.args)` call with a module-level
`summarize_args(args) -> list[dict]` helper emitting `[{"label", "value"}]`.

**Omission policy.** Skip values that are `None`, `""`, `[]`, or `{}`. This is an
explicit membership test, **not** Python falsiness — `0` and `False` must survive.
`priority: 0` is a real Linear value ("No priority"), and dropping numeric zero is a
recurring class of bug.

**Key humanizing.** `addTeams` → "Add teams". Split camelCase, replace `_` and `-`
with spaces, capitalize the first letter — reusing the idiom already applied to
`action` in the same function.

**Value stringifying.** Lists join with `", "`; bools become Yes/No; dicts and other
nested values become compact JSON; everything else is `str()`. Each value then
truncates to 300 characters with an ellipsis.

**Row cap.** 12 rows. When more remain, a 13th entry is appended as
`{"label": "…", "value": "N more fields"}` so the approver is told something was
withheld rather than silently seeing a partial list. This mirrors the existing `MAX` +
footer pattern in `app/components/page-list.tsx`. Well under both platform row caps;
the cap exists for readability, not protocol limits.

The interrupt payload becomes `args={"action": ..., "fields": [...]}`.

### 2. `app/interrupt.ts`

Add `fields: z.array(z.object({ label: z.string(), value: z.string() })).optional()`
to the schema, and **keep `detail` accepted**.

Keeping `detail` costs three lines and covers the window where a stale agent revision
is still sending the old shape. Without it, a version skew renders a card with no body
at all.

### 3. `app/human-in-the-loop/confirm-write.tsx`

Props become `{ action: string; fields?: Field[]; detail?: string }`.

Render precedence:

1. `fields` non-empty → a headerless `<Table>` of
   `<Row><Cell>{label}</Cell><Cell>{value}</Cell></Row>`.
2. `detail` present → the existing `<Section>{detail}</Section>` (legacy path).
3. Neither → no body block, as today.

No `columns` prop: labels render unbold, which is accepted in exchange for dropping a
redundant "Field | Value" header row.

### 4. `app/channel.tsx`

The interrupt handler passes `fields={args.fields}` alongside the existing `action`
and `detail`.

## Testing

Tests are written before the implementation.

**Python — `agent/tests/test_write_confirmation.py`**

- empty string, empty list, empty dict, and `None` values are omitted
- `0` and `False` are retained
- camelCase and snake_case keys humanize correctly
- lists join, nested values become compact JSON
- an over-long value truncates
- more than 12 fields produces a capped list plus an overflow note
- the two existing envelope assertions update from `detail` to `fields`

**TypeScript — `app/human-in-the-loop/__tests__/confirm-write.test.tsx`**

- `fields` renders a Slack `table` block whose rows match the input, with no header row
- `detail` alone still renders a `section` (legacy path)
- neither prop renders no body block
- the Teams Adaptive Card contains a `Table` with `firstRowAsHeader: false`
- existing button, resume, and failure-path tests continue to pass unchanged

## Out of scope

- **The non-functional Create button.** Owned by Tyler, tracked separately.
- **The hardcoded "Nothing is written until you click Create" wording** at
  `confirm-write.tsx:67`, which reads wrong for updates and deletes. Noted in
  CPK-7748; deliberately not bundled here.
- **Retaining the full payload for auditability.** Considered and rejected: appending
  the raw JSON would reintroduce the truncation this change exists to remove.

## Files touched

| File | Change |
| --- | --- |
| `agent/write_confirmation.py` | `summarize_args` helper; emit `fields` |
| `agent/tests/test_write_confirmation.py` | new helper tests; update envelope assertions |
| `app/interrupt.ts` | accept `fields`, keep `detail` |
| `app/human-in-the-loop/confirm-write.tsx` | render a headerless `Table` |
| `app/human-in-the-loop/__tests__/confirm-write.test.tsx` | table and fallback rendering tests |
| `app/channel.tsx` | thread `fields` through the interrupt handler |
