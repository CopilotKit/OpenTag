/**
 * App-specific human-in-the-loop components — interactive Block Kit cards the
 * Channel interrupt handlers can render to ask the user a structured question
 * before resuming the paused agent.
 *
 * The backend MCP write interceptor emits `confirm_write`. Its `on_interrupt`
 * event posts `ConfirmWrite`; the card's buttons call `thread.resume(...)`.
 */
export { ConfirmWrite } from "./confirm-write.js";
