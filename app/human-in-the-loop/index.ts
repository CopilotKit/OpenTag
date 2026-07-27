/**
 * App-specific human-in-the-loop components — interactive Block Kit cards the
 * Channel interrupt handlers can render to ask the user a structured question
 * before resuming the paused agent.
 *
 * `confirm_write` is a backend LangGraph tool. Its `on_interrupt` event posts
 * `ConfirmWrite`; the card's buttons call `thread.resume(...)`.
 */
export { ConfirmWrite } from "./confirm-write.js";
export type { ConfirmWriteProps } from "./confirm-write.js";
