/**
 * App-specific human-in-the-loop components — interactive Block Kit cards the
 * Channel interrupt handlers can render to ask the user a structured question
 * before resuming the paused agent.
 *
 * The backend MCP write interceptor emits `confirm_write`. Its `on_interrupt`
 * event posts `ConfirmWrite`; the card's buttons call `thread.resume(...)`.
 */
export { createConfirmWrite, CONFIRM_WRITE_EFFECTS } from "./confirm-write.js";
export type {
  ConfirmWriteEffect,
  ConfirmWriteField,
} from "./confirm-write.js";
export {
  ConnectAccount,
  ConnectFailed,
  ConnectLink,
} from "./connect-account.js";
export type { ConnectRequest } from "./connect-account.js";
