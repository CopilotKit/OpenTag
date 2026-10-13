import { z } from "zod";
import { INTERRUPT_ID_PATTERN } from "./human-in-the-loop/approval-decisions.js";
import {
  CONFIRM_WRITE_EFFECTS,
  type ConfirmWriteEffect,
} from "./human-in-the-loop/confirm-write.js";

/** What an unreadable classification is treated as, on both sides of the wire. */
const DANGEROUS_READING: ConfirmWriteEffect = "destructive";

/**
 * The classification the agent sends, or the dangerous reading when it sends
 * something this side does not know.
 *
 * `.catch` rather than a bare enum, because the two ways of being strict here
 * both fail in the wrong direction. Accepting any string lets an unreadable
 * word render as a harmless one — the agent's fail-safe inverted on this side
 * of the wire. Throwing on it kills the whole card, and a graph paused on a
 * question nobody was asked is worse than one asked in red. Falling back to
 * `destructive` is the same answer `EffectMap.effect_for` gives when it cannot
 * classify a slug.
 */
const effectSchema = z
  .enum(CONFIRM_WRITE_EFFECTS)
  .nullish()
  .catch(DANGEROUS_READING);

const confirmWriteArgsSchema = z.object({
  action: z.string().min(1),
  /**
   * Approver-readable rows built by the agent's `summarize_args`.
   *
   * Nullish, not optional. The agent sends explicit nulls for the extras a
   * card does not carry, and a schema that only tolerates `undefined`
   * throws inside the interrupt handler — which posts no card at all and
   * leaves the graph paused on a question nobody was ever asked.
   */
  fields: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .nullish(),
  /** Legacy pre-`fields` summary; still accepted across a deploy skew. */
  detail: z.string().nullish(),
  /**
   * Which attempt at this write the card is asking about. Absent on a
   * first attempt; `2` and up mean an earlier approved attempt failed.
   * Nullish for the same reason `fields` is.
   */
  attempt: z.number().int().min(1).nullish(),
  /** Why the previous attempt at this same write failed. */
  previous_error: z.string().nullish(),
  /**
   * Who may answer this card, as `platform:id`. Present only when the call
   * runs in one person's own account: approving it spends that person's
   * access, so a colleague pressing the button would spend somebody else's.
   * Absent means the action belongs to the workspace and anyone who can see
   * the card may answer.
   */
  approver: z.string().min(1).nullish(),
  /** `read`, `write`, or `destructive` — what the agent classified it as. */
  effect: effectSchema,
});

/** The `confirm_write` arguments, as the card receives them. */
export type ConfirmWriteArgs = z.infer<typeof confirmWriteArgsSchema>;

/**
 * The envelope every interrupt arrives in, read only as far as its name.
 *
 * `action` is a string rather than the `confirm_write` literal, because an
 * interrupt naming something else is not a malformed approval — it is a
 * different request, and collapsing the two made the surface report a graph
 * asking for `connect_account` as an approval card it had failed to render.
 * The reader then goes looking for a card, and for the write behind it, and
 * neither exists.
 *
 * `__copilotkit_messages__` is deliberately absent. The envelope carries the
 * run's message history and nothing here reads it, so requiring it only gave a
 * producer that omits it a way to kill the card. Unknown keys pass.
 */
const interruptEnvelopeSchema = z.object({
  __opentag_interrupt_id__: z.string().regex(INTERRUPT_ID_PATTERN).optional(),
  __copilotkit_interrupt_value__: z.object({
    action: z.string().min(1),
    args: z.unknown(),
  }),
});

/**
 * The envelope as an object, whichever way it arrived.
 *
 * The JSON parse is folded into the schema rather than run ahead of it so this
 * module has exactly one throw shape. An unguarded `JSON.parse` threw a raw
 * `SyntaxError` for a truncated payload and a `ZodError` for a structurally
 * wrong one — the same failure, in two shapes, for the handler that has to
 * report it.
 */
const envelopeSchema = z
  .unknown()
  .transform((payload, ctx) => {
    if (typeof payload !== "string") return payload;
    try {
      return JSON.parse(payload) as unknown;
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `interrupt payload is not JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return z.NEVER;
    }
  })
  .pipe(interruptEnvelopeSchema);

/**
 * What an interrupt turned out to be.
 *
 * `unsupported` is a value rather than a throw because the two failures need
 * different words in the thread: an approval this surface could not render is a
 * bug in the card, and a request it has no handler for is a bug somewhere else
 * entirely. A caller that cannot tell them apart has to guess, and it guessed
 * wrong in the direction that costs the reader a search.
 */
export type ParsedInterrupt =
  | { kind: "confirm_write"; args: ConfirmWriteArgs; interruptId?: string }
  | { kind: "unsupported"; action: string };

/**
 * Read one interrupt envelope.
 *
 * Throws only when the payload cannot be read at all, or when a `confirm_write`
 * carries arguments the card cannot be built from — the two cases where there
 * is genuinely no card to post.
 */
export function parseInterrupt(payload: unknown): ParsedInterrupt {
  const envelope = envelopeSchema.parse(payload);
  const { action, args } = envelope.__copilotkit_interrupt_value__;
  if (action !== "confirm_write") {
    return { kind: "unsupported", action };
  }
  return {
    kind: "confirm_write",
    args: confirmWriteArgsSchema.parse(args),
    interruptId: envelope.__opentag_interrupt_id__,
  };
}
