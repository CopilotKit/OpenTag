/**
 * App-specific frontend tools. Provider defaults are added per turn by
 * `app/channel-helpers.ts`.
 *
 * Add new tools here and include them in `appTools`. Wire the array into
 * `createChannel({ tools })`.
 */
import { readThreadTool } from "./read-thread.js";
import { createShowCapabilitiesTool } from "./capabilities.js";
import { renderDiagramTool } from "./render-diagram.js";
import { renderTableTool } from "./render-table.js";
import { issueCardTool, issueListTool, pageListTool } from "./render-tools.js";
import {
  showIncidentTool,
  showStatusTool,
  showLinksTool,
  showWorkPlanTool,
  showDecisionBriefTool,
  showKnowledgeSummaryTool,
} from "./showcase-tools.js";
import type { ChannelTool } from "@copilotkit/channels";
import { DEFAULT_AGENT_DISPLAY_NAME } from "../env.js";

/**
 * Every tool is a plain `ChannelTool`: its handler receives the generic
 * `ChannelToolContext` (`{ thread, message?, user?, signal?, platform }`) the
 * adapter supplies at call time. Platform power (post/stream/postFile,
 * `thread.getMessages()`, `thread.lookupUser()`, …) is reached via the
 * `thread` methods, so there's no per-adapter context and no cast needed —
 * the array assigns straight into `createChannel({ tools })`.
 */
export function createAppTools(
  agentDisplayName = DEFAULT_AGENT_DISPLAY_NAME,
): ChannelTool[] {
  return [
    readThreadTool,
    createShowCapabilitiesTool(agentDisplayName),
    renderDiagramTool,
    renderTableTool,
    issueCardTool,
    issueListTool,
    pageListTool,
    showIncidentTool,
    showStatusTool,
    showLinksTool,
    showWorkPlanTool,
    showDecisionBriefTool,
    showKnowledgeSummaryTool,
  ];
}

export const appTools = createAppTools();
