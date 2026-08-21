/**
 * Effect classification from Composio's MCP behavior tags.
 *
 * `ToolSchema.tags` is a generic `string[]` defaulting to empty, so an empty
 * array cannot be distinguished from "nobody classified this". Anything not
 * positively marked read-only is treated as a write — it fails safe, matching
 * `agent/internal_sources.py:139`.
 */
import type { ApprovalMode } from "./config.js";

export type Effect = "read" | "write" | "destructive";

export function effectOf(tags: string[] | undefined): Effect {
  const set = new Set(tags ?? []);
  if (set.has("destructiveHint")) return "destructive";
  if (set.has("readOnlyHint")) return "read";
  return "write";
}

export function needsApproval(effect: Effect, mode: ApprovalMode): boolean {
  if (mode === "off") return false;
  if (mode === "destructive") return effect === "destructive";
  return effect !== "read";
}
