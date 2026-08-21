/**
 * Approval card for a Composio tool run.
 *
 * `ConfirmWrite` resumes a paused LangGraph interrupt. Nothing is paused here —
 * managed Channels cannot block on a choice (`supportsBlockingChoice: false`),
 * so the decision travels in the button `value` and the click handler does the
 * work. The card carries only a token; arguments stay in process.
 */
import {
  Actions,
  Button,
  Cell,
  Header,
  Message,
  Row,
  Section,
  Table,
} from "@copilotkit/channels";
import type { InteractionContext } from "@copilotkit/channels";

/** One argument of the pending run, already labelled and stringified. */
export interface ConfirmToolRunField {
  label: string;
  value: string;
}

/** Rows past this many are collapsed into a single "n more fields" row. */
const MAX_FIELDS = 12;

/** Longest value a single row shows before it is elided. */
const MAX_VALUE = 300;

/** `recipient_email` / `addTeams` -> `Recipient email` / `Add teams`. */
function humanize(key: string): string {
  const spaced = key
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ")
    .replace(/[_-]+/g, " ")
    .trim();
  const [first, ...rest] = spaced.split(/\s+/);
  if (!first) return key;
  return [
    first[0]!.toUpperCase() + first.slice(1),
    ...rest.map((w) => w.toLowerCase()),
  ].join(" ");
}

/**
 * Carries no information for an approver. Deliberately not JS falsiness: `0` is
 * a real priority and `false` a real flag, so both must survive — dropping them
 * would show an approver an incomplete picture of what they are approving.
 */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value as object).length === 0;
}

/**
 * One member of an array value. Objects become JSON, matching what the
 * top-level object branch already does — `String({})` renders `[object
 * Object]`, a row that looks populated while withholding everything, and unlike
 * the elisions below it does not admit that anything was withheld.
 */
function stringifyMember(value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The approver-readable form of one argument value. */
function stringify(value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(stringifyMember).join(", ");
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** `1 more field` / `8 more fields` — one wording for every elision. */
function more(count: number, unit: string): string {
  return `${count} more ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * A value clipped to `MAX_VALUE`, naming what it withheld. A bare `…` reads the
 * same on a 305-character body as on a 4000-character one; the row cap already
 * says how much it dropped, so the value elision says so too.
 */
function elide(text: string): string {
  if (text.length <= MAX_VALUE) return text;
  return `${text.slice(0, MAX_VALUE)}… (${more(text.length - MAX_VALUE, "character")})`;
}

/**
 * A tool call's raw arguments as table rows an approver can read. Bounded on
 * both axes — a mail body or a fifty-key payload would otherwise push the
 * buttons off the bottom of the card.
 */
export function toolRunFields(
  args: Record<string, unknown>,
): ConfirmToolRunField[] {
  const rows: ConfirmToolRunField[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (isEmpty(value)) continue;
    rows.push({ label: humanize(key), value: elide(stringify(value)) });
  }

  if (rows.length > MAX_FIELDS) {
    return [
      ...rows.slice(0, MAX_FIELDS),
      { label: "…", value: more(rows.length - MAX_FIELDS, "field") },
    ];
  }
  return rows;
}

/** What a click reports back: which pending call, and whether it may run. */
export type ConfirmDecision = { token: string; approved: boolean };

/** The label of the button that declines the run. */
const DECLINE_LABEL = "Cancel";

/**
 * Verbs that name an irreversible action, so the confirm button can say which
 * one it is. `confirm-write.tsx`'s `DESTRUCTIVE` set, widened by the verbs real
 * Composio slugs use (`GOOGLECALENDAR_CLEAR_CALENDAR`,
 * `GOOGLECALENDAR_CHANNELS_STOP`).
 *
 * Unlike the sibling's set, this one does not decide *whether* a run is
 * destructive — the caller's `destructive` prop does. It only names the button
 * once the caller has said so.
 */
const DESTRUCTIVE_VERBS = new Set([
  "delete",
  "remove",
  "archive",
  "cancel",
  "revoke",
  "clear",
  "stop",
  "trash",
  "purge",
  "destroy",
  "drop",
]);

/**
 * The action's own destructive verb, e.g. `Linear remove issue label` ->
 * `Remove`. Scans every word rather than taking the first the way
 * `confirm-write.tsx`'s `verbOf` does, because a humanised Composio action
 * leads with the app (`Gmail delete thread`), not with the verb.
 */
function destructiveVerbOf(action: string): string {
  for (const word of action.trim().split(/\s+/)) {
    if (DESTRUCTIVE_VERBS.has(word.toLowerCase())) {
      return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
    }
  }
  return "";
}

/**
 * How the confirm button reads. A destructive run is named by its own verb, so
 * the button never claims a remove is a delete — `Linear remove issue label`
 * confirms with `Remove`.
 *
 * Falls back to `Confirm` twice over: when no verb is recognised (better a
 * vague button than a wrong one), and when the verb would collide with the
 * decline button — `Googlecalendar cancel event` would otherwise render two
 * buttons both reading "Cancel", one cancelling the event and one cancelling
 * the request.
 */
function confirmLabel(action: string, destructive: boolean): string {
  if (!destructive) return "Approve";
  const verb = destructiveVerbOf(action);
  if (!verb) return "Confirm";
  return verb.toLowerCase() === DECLINE_LABEL.toLowerCase() ? "Confirm" : verb;
}

interface ConfirmToolRunProps {
  /** Short imperative title of the run, e.g. 'Delete Gmail thread'. */
  action: string;
  /**
   * The run's arguments as approver-readable rows, rendered as a headerless
   * two-column table. No `columns` prop is passed, so neither renderer emits a
   * header row — "Field | Value" would spend a row restating the layout.
   */
  fields: ConfirmToolRunField[];
  /**
   * Whether the run cannot be undone. Decided by the caller from the tool's
   * slug rather than derived from `action` here, because the Composio tool name
   * is the authority on that, not the prose title.
   */
  destructive: boolean;
  /** Looks up the pending call. The args themselves never enter the payload. */
  token: string;
}

/**
 * Run the decision this button carries.
 *
 * Defined here rather than taken as a prop, and that is load-bearing. A click
 * that arrives after a restart is resolved by re-rendering this component from
 * its **stored props** and re-plucking `onClick`; a function handed in as a
 * prop cannot survive that round trip, so the re-rendered button would carry no
 * handler, the dispatcher would raise `ActionExpiredError`, and the Channel
 * swallows that — the person would click and see nothing at all. Everything
 * this closure captures (`action`) is a serializable prop, so it is rebuilt
 * intact every time. Same reason `ConfirmWrite` defines its handlers inline.
 *
 * The import is dynamic only to keep the module graph acyclic: `run-tool.tsx`
 * imports this card. It is a cache hit — the runtime loaded that module at
 * startup, before any card could be posted.
 */
async function decide(
  interaction: InteractionContext<ConfirmDecision>,
  action: string,
): Promise<void> {
  const { handleToolRunDecision } = await import(
    "../tools/composio/run-tool.js"
  );
  await handleToolRunDecision(interaction, action);
}

export function ConfirmToolRun({
  action,
  fields,
  destructive,
  token,
}: ConfirmToolRunProps) {
  return (
    <Message accent={destructive ? "#EB5757" : "#010507"}>
      <Header>{`${destructive ? "⚠️ " : ""}${action}`}</Header>
      <Section>
        {destructive ? "This cannot be undone." : "Approve to continue."}
      </Section>
      {fields.length > 0 ? (
        <Table>
          {fields.map((field) => (
            <Row>
              <Cell>{field.label}</Cell>
              <Cell>{field.value}</Cell>
            </Row>
          ))}
        </Table>
      ) : null}
      <Actions>
        {/*
          The warning colour marks the irreversible choice, not the safe one, so
          Cancel stays neutral on a destructive card.
        */}
        <Button
          value={{ token, approved: true }}
          style={destructive ? "danger" : "primary"}
          onClick={(interaction: InteractionContext<ConfirmDecision>) =>
            decide(interaction, action)
          }
        >
          {confirmLabel(action, destructive)}
        </Button>
        <Button
          value={{ token, approved: false }}
          onClick={(interaction: InteractionContext<ConfirmDecision>) =>
            decide(interaction, action)
          }
        >
          Cancel
        </Button>
      </Actions>
    </Message>
  );
}

/** Terminal state after a decision, replacing the card in place. */
export function ToolRunOutcome({
  action,
  text,
  ok,
}: {
  action: string;
  text: string;
  ok: boolean;
}) {
  return (
    <Message accent={ok ? "#2E7D32" : "#EB5757"}>
      <Header>{`${ok ? "✅" : "⚠️"} ${action}`}</Header>
      <Section>{text}</Section>
    </Message>
  );
}
