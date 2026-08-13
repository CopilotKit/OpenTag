/**
 * Promo-video session (status / grokSessionId / PR) in SQLite metadata.
 *
 * Idle timers stay process-local in `idleTimers`. Timer starts only after a
 * run finishes (not while rendering). Next interaction clears the timer;
 * when that run finishes, the clock restarts.
 */

import { opentagSqlitePersistence } from "./opentag-persistence.js";
import { sandboxThreadId } from "./sandbox-thread-id.js";

export const PROMO_VIDEO_IDLE_MS = 10 * 60 * 1000;
export const PROMO_SESSION_META_KEY = "session";

export type PromoVideoStatus =
  | "idle"
  | "running"
  | "ready"
  | "error"
  | "ending";

export type PromoVideoSession = {
  conversationKey: string;
  status: PromoVideoStatus;
  runId?: string;
  grokSessionId?: string;
  prRepoSlug?: string;
  prNumber?: number;
  lastError?: string;
};

const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const knownSessionKeys = new Set<string>();

function sessionScope(conversationKey: string): string {
  return sandboxThreadId("promo", conversationKey);
}

export async function getPromoSession(
  conversationKey: string,
): Promise<PromoVideoSession | undefined> {
  const value = await opentagSqlitePersistence().stores.metadata.get(
    sessionScope(conversationKey),
    PROMO_SESSION_META_KEY,
  );
  if (value == null) return undefined;
  return value as PromoVideoSession;
}

export async function setPromoSession(
  session: PromoVideoSession,
): Promise<void> {
  knownSessionKeys.add(session.conversationKey);
  await opentagSqlitePersistence().stores.metadata.set(
    sessionScope(session.conversationKey),
    PROMO_SESSION_META_KEY,
    session,
  );
}

export async function clearPromoSession(
  conversationKey: string,
): Promise<void> {
  clearIdleReap(conversationKey);
  knownSessionKeys.delete(conversationKey);
  await opentagSqlitePersistence().stores.metadata.delete(
    sessionScope(conversationKey),
    PROMO_SESSION_META_KEY,
  );
}

export async function clearAllPromoSessions(): Promise<void> {
  for (const key of [...idleTimers.keys()]) clearIdleReap(key);
  const persistence = opentagSqlitePersistence();
  const keys = [...knownSessionKeys];
  knownSessionKeys.clear();
  await Promise.all(
    keys.map((key) =>
      persistence.stores.metadata.delete(
        sessionScope(key),
        PROMO_SESSION_META_KEY,
      ),
    ),
  );
}

export function clearIdleReap(conversationKey: string): void {
  const handle = idleTimers.get(conversationKey);
  if (handle !== undefined) {
    clearTimeout(handle);
    idleTimers.delete(conversationKey);
  }
}

export function scheduleIdleReap(
  conversationKey: string,
  onIdle: (conversationKey: string) => void | Promise<void>,
  ms: number = PROMO_VIDEO_IDLE_MS,
): void {
  clearIdleReap(conversationKey);
  const handle = setTimeout(() => {
    idleTimers.delete(conversationKey);
    void Promise.resolve(onIdle(conversationKey)).catch((err) => {
      console.error(
        `[promo-video] idle reap failed for ${conversationKey}:`,
        err,
      );
    });
  }, ms);
  handle.unref?.();
  idleTimers.set(conversationKey, handle);
}

export function hasIdleReap(conversationKey: string): boolean {
  return idleTimers.has(conversationKey);
}
