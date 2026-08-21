/**
 * Per-user Composio sessions, cached in process.
 *
 * Composio stores connected accounts server-side keyed by user id, so a restart
 * empties this cache but never requires anyone to re-authenticate. The first
 * message from each person after a restart pays one cache miss (~1s measured).
 */
import { effectOf, type Effect } from "./classify.js";

/**
 * What `session.authorize(toolkit)` hands back. `id` and `status` are carried
 * for completeness; the two fields anything reads are the link and the wait.
 */
export interface Authorization {
  /** The connect link. A bearer capability — see `connect-tool.tsx`. */
  redirectUrl: string;
  id?: string;
  status?: string;
  /**
   * Resolves once the person finishes the browser flow. Optional because a
   * session from an older SDK may not offer it, and a caller that only wants
   * the link must not depend on it.
   *
   * Composio's own default wait is roughly a minute — shorter than a person
   * spends on a consent screen — so every caller passes its own timeout in ms.
   */
  waitForConnection?(timeoutMs?: number): Promise<unknown>;
}

/** Structural subset of `@composio/core` we depend on, so tests can fake it. */
export interface RawSession {
  sessionId: string;
  search(params: { query: string }): Promise<unknown>;
  execute(
    slug: string,
    args: Record<string, unknown>,
  ): Promise<{ data?: unknown; error?: string | null; logId?: string }>;
  authorize(toolkit: string): Promise<Authorization>;
  toolkits(): Promise<{
    items: Array<{ slug: string; connection?: { isActive?: boolean } }>;
  }>;
}

export interface ComposioSdk {
  sessions: {
    create(userId: string, options: Record<string, unknown>): Promise<RawSession>;
  };
  tools: {
    getRawComposioTools(params: {
      toolkits: string[];
      limit: number;
    }): Promise<Array<{ slug: string; tags?: string[] }>>;
  };
}

export interface CachedSession {
  session: RawSession;
  /**
   * The Composio identity this session acts as — the shared workspace id, or
   * one person's. Carried on the entry because a caller that routed a slug to
   * this scope cannot otherwise tell whose account it is about to touch, and
   * approval depends on exactly that.
   */
  userId: string;
  /** tool slug -> effect, derived once per cache fill. */
  effects: Map<string, Effect>;
  toolkits: string[];
  filledAt: number;
}

/** Long enough that the hot path is free, short enough that a new app appears. */
const TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, CachedSession>();

/** One user can hold both a workspace and a personal session, so key on both. */
function cacheKey(userId: string, toolkits: string[]): string {
  return `${userId}::${[...toolkits].sort().join(",")}`;
}

export function clearSessionCache(): void {
  cache.clear();
}

export function invalidateSession(userId: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${userId}::`)) cache.delete(key);
  }
}

export async function getSession(
  sdk: ComposioSdk,
  userId: string,
  toolkits: string[],
): Promise<CachedSession> {
  const key = cacheKey(userId, toolkits);
  const existing = cache.get(key);
  if (existing && Date.now() - existing.filledAt <= TTL_MS) return existing;

  // workbench:false is mandatory. A default session exposes remote bash and a
  // Python sandbox, which nobody asked for by naming a toolkit.
  const session = await sdk.sessions.create(userId, {
    toolkits,
    workbench: { enable: false },
  });

  const raw = await sdk.tools.getRawComposioTools({ toolkits, limit: 300 });
  const effects = new Map<string, Effect>();
  for (const tool of raw) effects.set(tool.slug, effectOf(tool.tags));

  const entry: CachedSession = { session, userId, effects, toolkits, filledAt: Date.now() };
  cache.set(key, entry);
  return entry;
}
