/**
 * App-specific human-in-the-loop components — interactive Block Kit cards the
 * Channel interrupt handlers can render to ask the user a structured question
 * before resuming the paused agent.
 *
 * The backend MCP write interceptor emits `confirm_write`. Its `on_interrupt`
 * event posts `ConfirmWrite`; the card's buttons call `thread.resume(...)`.
 *
 * `ConfirmToolRun` is its sibling for Composio tool runs, which have no paused
 * graph behind them: the decision rides in the button `value` and a click
 * handler does the work.
 *
 * `ConnectAccount` asks one person to connect one of their own accounts. It is
 * public in the thread but carries no link — see the file for why a pre-minted
 * connect URL must never be posted where someone else can click it.
 */
export { ConfirmWrite } from "./confirm-write.js";
export {
  ConfirmToolRun,
  ToolRunOutcome,
  toolRunFields,
} from "./confirm-tool-run.js";
export type {
  ConfirmDecision,
  ConfirmToolRunField,
} from "./confirm-tool-run.js";
export { ConnectAccount } from "./connect-account.js";
export type { ConnectRequest } from "./connect-account.js";
