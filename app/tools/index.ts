/**
 * App-specific frontend tools — anything that's bot-specific, not
 * universal-Slack. Universal-Slack stuff (tagging, formatting,
 * conversation model) lives in the SDK's `defaultSlackTools`.
 *
 * Add new tools here and re-export them through `appTools`. The bot starts
 * with `[...appTools]` and each active adapter appends its own default tools —
 * e.g. `app/index.ts` pushes `...defaultSlackTools` only when `SLACK_*` is set,
 * and `app/managed.ts` spreads them into `createChannel({ tools })`.
 */
import { readThreadTool } from "./read-thread.js";
import { renderChartTool } from "./render-chart.js";
import { renderDiagramTool } from "./render-diagram.js";
import { renderTableTool } from "./render-table.js";
import { issueCardTool, issueListTool, pageListTool } from "./render-tools.js";
import {
  showIncidentTool,
  showStatusTool,
  showLinksTool,
} from "./showcase-tools.js";
import { confirmWriteTool } from "../human-in-the-loop/index.js";
import type { ChannelTool } from "@copilotkit/channels";

/**
 * Every tool is a plain `ChannelTool`: its handler receives the generic
 * `ChannelToolContext` (`{ thread, message?, user?, signal?, platform }`) the
 * adapter supplies at call time. Platform power (post/stream/postFile,
 * `thread.getMessages()`, `thread.lookupUser()`, …) is reached via the
 * `thread` methods, so there's no per-adapter context and no cast needed —
 * the array assigns straight into `createChannel({ tools })`.
 */
export const appTools: ChannelTool[] = [
  readThreadTool,
  renderChartTool,
  renderDiagramTool,
  renderTableTool,
  issueCardTool,
  issueListTool,
  pageListTool,
  showIncidentTool,
  showStatusTool,
  showLinksTool,
  confirmWriteTool,
];

export {
  readThreadTool,
  renderChartTool,
  renderDiagramTool,
  renderTableTool,
  issueCardTool,
  issueListTool,
  pageListTool,
  showIncidentTool,
  showStatusTool,
  showLinksTool,
  confirmWriteTool,
};
