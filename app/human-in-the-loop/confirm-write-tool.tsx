/**
 * `confirm_write` — the agent-facing write-gate TOOL.
 *
 * The migration kept the {@link ConfirmWrite} JSX card but this tool is what
 * makes the system prompt's contract real: "call the confirm_write tool before
 * any Linear/Notion write". HITL is DUAL-MODE, gated on the surface's
 * `supportsBlockingChoice` capability:
 *
 *   • Interactive surfaces (native Slack Socket Mode, Discord, …): a BLOCKING
 *     frontend tool — the handler `await`s `thread.awaitChoice(<ConfirmWrite/>)`,
 *     which posts the picker and BLOCKS until the click, resolving to the
 *     button's `value` (`{ confirmed: boolean }`); the agent writes only on
 *     `{ confirmed: true }`.
 *   • Managed (Intelligence HTTP) surfaces (`supportsBlockingChoice === false`):
 *     a blocking wait would deadlock the one-delivery-at-a-time claim loop (the
 *     click arrives as a *separate* delivery). So the tool posts the picker and
 *     ENDS the turn (ack-first); the write happens in a follow-up turn driven by
 *     the ConfirmWrite button's `onClick` when the click's `interaction`
 *     delivery is processed (see {@link ConfirmWrite}).
 */
import { z } from "zod";
import { defineBotTool } from "@copilotkit/channels";
import { ConfirmWrite } from "./confirm-write.js";

export const confirmWriteSchema = z.object({
  action: z
    .string()
    .describe(
      "One-line summary of exactly what you are about to write, e.g. 'Create Linear issue: CPK-123 — Checkout 500s'",
    ),
  detail: z
    .string()
    .optional()
    .describe(
      "Optional detail block shown under the prompt, e.g. the drafted title + description/outline",
    ),
});

export const confirmWriteTool = defineBotTool({
  name: "confirm_write",
  description:
    "Ask the user to approve a write before you perform it. Posts a " +
    "confirm/cancel card and BLOCKS until the user clicks; returns " +
    "{confirmed: boolean}. You MUST call this before creating or modifying " +
    "anything in Linear or Notion. Reads never need confirmation.",
  parameters: confirmWriteSchema,
  async handler({ action, detail }, { thread }) {
    // Managed (Intelligence HTTP) surface: the claim loop processes one
    // lease-bounded delivery at a time, so a blocking `awaitChoice` would
    // deadlock — the click arrives as a *separate* inbound delivery the loop
    // can't claim while blocked. Post the picker and END this turn; the
    // ConfirmWrite button's `onClick` runs the follow-up turn (perform / cancel)
    // when the click's `interaction` delivery is processed.
    if (thread.supportsBlockingChoice === false) {
      await thread.post(<ConfirmWrite action={action} detail={detail} />);
      return (
        "A confirmation card has been posted to the user. STOP now and take no " +
        "further action — do not write anything and do not call any more tools. " +
        "The user's decision will arrive as a separate follow-up."
      );
    }

    // Interactive surface (native Socket Mode, etc.): block until the click.
    const choice = await thread.awaitChoice<{ confirmed?: boolean }>(
      <ConfirmWrite action={action} detail={detail} />,
    );
    return choice?.confirmed
      ? "The user APPROVED the write — proceed."
      : "The user DECLINED — do not write; acknowledge and stop.";
  },
});
