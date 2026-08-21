/**
 * Calls awaiting approval.
 *
 * The card carries only a token. Arguments stay here rather than in the Slack
 * action value, which has a size limit and should not carry user data. A token
 * missing after a restart is reported as expired rather than guessed at.
 */
import { randomUUID } from "node:crypto";
import type { Effect } from "./classify.js";
import type { RawSession } from "./sessions.js";

export interface PendingCall {
  session: RawSession;
  slug: string;
  args: Record<string, unknown>;
  effect: Effect;
  /** The identity this call was composed for. */
  userId: string;
  workspaceUserId: string;
  /** Human-readable label already computed for the card. */
  action: string;
}

/**
 * How many approvals may be outstanding at once. Matching
 * `agent/write_confirmation.py`'s `_MAX_TRACKED_FAILURES`, and bounded for the
 * same reason: this map outlives every conversation, and each entry pins a live
 * `RawSession` plus the call's arguments — which is where the mail bodies are.
 * An abandoned card is not worth holding either of those forever.
 */
const MAX_PENDING = 64;

/** Insertion-ordered by construction, which is what makes eviction oldest-first. */
const pending = new Map<string, PendingCall>();

export function clearPending(): void {
  pending.clear();
}

/**
 * A token is a capability: for a workspace-scope call, holding it is the whole
 * of the authorization. So it comes from the CSPRNG — `Math.random()` is
 * seeded, unseeded-predictable and worth about 41 bits, none of which is a
 * budget to defend a delete with.
 */
export function registerPending(call: PendingCall): string {
  const token = `ctr_${randomUUID()}`;
  pending.set(token, call);
  // Oldest-first, and after the insert so a fresh call is never the casualty.
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next();
    if (oldest.done) break;
    pending.delete(oldest.value);
  }
  return token;
}

/** Read and consume. A card cannot be clicked twice into two executions. */
export function takePending(token: string): PendingCall | undefined {
  const call = pending.get(token);
  if (call) pending.delete(token);
  return call;
}

/**
 * Undo one `takePending`, under the token the posted card already carries.
 *
 * Only for a read that turned out not to be a decision the reader was allowed
 * to make. `registerPending` would mint a fresh token and strand the call: the
 * card in the thread still holds the original, so the rightful approver's click
 * would read "expired" and the delete they asked for could never run.
 *
 * Safe against replay because the caller restores before it awaits anything —
 * no second click can be dispatched into the window between the take and this.
 */
export function restorePending(token: string, call: PendingCall): void {
  pending.set(token, call);
}

/**
 * A workspace-scope call runs against a shared identity, so anyone in the thread
 * may approve it. A personal-scope call may only be approved by the person it
 * was composed for — otherwise approving someone else's delete would execute
 * against the approver's own account.
 */
export function mayApprove(call: PendingCall, clickerId: string | undefined): boolean {
  if (call.userId === call.workspaceUserId) return true;
  return Boolean(clickerId) && clickerId === call.userId;
}
