import { z } from "zod";

const confirmWriteInterruptSchema = z.object({
  __copilotkit_interrupt_value__: z.object({
    action: z.literal("confirm_write"),
    args: z.object({
      action: z.string().min(1),
      detail: z.string().nullish(),
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
