import { z } from "zod";

const confirmWriteInterruptSchema = z.object({
  __copilotkit_interrupt_value__: z.object({
    action: z.literal("confirm_write"),
    args: z.object({
      action: z.string().min(1),
      /** Approver-readable rows built by the agent's `summarize_args`. */
      fields: z
        .array(z.object({ label: z.string(), value: z.string() }))
        .optional(),
      /** Legacy pre-`fields` summary; still accepted across a deploy skew. */
      detail: z.string().nullish(),
      /**
       * Which attempt at this write the card is asking about. Absent on a
       * first attempt; `2` and up mean an earlier approved attempt failed.
       */
      attempt: z.number().int().min(1).optional(),
      /** Why the previous attempt at this same write failed. */
      previous_error: z.string().nullish(),
    }),
  }),
  __copilotkit_messages__: z.array(z.unknown()),
});

export function parseConfirmWriteInterrupt(payload: unknown) {
  const normalized =
    typeof payload === "string" ? JSON.parse(payload) : payload;
  return confirmWriteInterruptSchema.parse(normalized)
    .__copilotkit_interrupt_value__;
}
