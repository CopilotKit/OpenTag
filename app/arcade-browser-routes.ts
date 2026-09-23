/**
 * The two pages a browser sees while connecting an Arcade account.
 *
 * These live here rather than on the agent for one reason: they are the only
 * part of this feature the public internet must reach, and the agent is the
 * process holding the provider keys. Keeping the front door on this side means
 * the service exposed to the world holds no credentials of its own — it asks
 * the agent, over the private network and behind the shared secret, and the
 * agent answers in opaque handles.
 *
 * The problem they solve, established against the live Arcade API rather than
 * assumed: when somebody finishes authorizing, Arcade redirects their browser
 * back carrying a flow id from an id space nothing on our side can resolve, and
 * asks who they are. Arcade's verifier is built for ordinary web apps, where
 * the answer comes from a logged-in session. Nobody logs into OpenTag.
 *
 * So the outbound hop gives the browser a session. A person is handed a link to
 * `/arcade/start`; passing through, their browser collects an opaque cookie and
 * is sent on to the provider. When Arcade returns them to `/arcade/verify`,
 * that cookie is what answers the question.
 *
 * Nothing identifying travels in either direction. The link carries a ticket
 * that means nothing without the agent; the cookie carries a handle that means
 * nothing without the agent; and the identity is resolved only there.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** Name says nothing about purpose; the value is random and opaque anyway. */
export const COOKIE_NAME = "otc_session";

/**
 * Scoped to these routes, so the cookie is not attached to every other request
 * this service serves.
 */
export const COOKIE_PATH = "/arcade";

/** Matches the agent's own window for a part-finished connection. */
export const COOKIE_MAX_AGE_SECONDS = 15 * 60;

export const START_PATH = "/arcade/start";
export const VERIFY_PATH = "/arcade/verify";

/** How long a browser waits on the agent before being told to try again. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface ClaimedTicket {
  providerUrl: string;
  browserHandle: string;
}

export interface ConfirmedFlow {
  outcome: "confirmed" | "unknown" | "failed";
  redirectTo: string | null;
  message: string;
  clearCookie: boolean;
}

export interface ArcadeAgentClient {
  claimTicket(ticket: string): Promise<ClaimedTicket | null>;
  confirmFlow(input: {
    browserHandle: string | null;
    flowId: string | null;
  }): Promise<ConfirmedFlow | null>;
}

/**
 * Shown when the agent cannot be reached or answers unusably.
 *
 * Deliberately the same sentence for both: to whoever is looking they are one
 * thing — this did not work, ask again — and the difference between them is an
 * operator's business, which is why it goes to the log instead.
 */
const UNAVAILABLE =
  "This connection could not be completed just now. Ask again in the chat to " +
  "start over.";

const ALREADY_SPENT =
  "This connection link has already been used or has expired. Ask again in " +
  "the chat for a fresh one.";

function endpoint(agentUrl: string, path: string): string {
  const base = agentUrl.endsWith("/") ? agentUrl : `${agentUrl}/`;
  return new URL(path, base).toString();
}

/**
 * The agent, reached over the private network with the shared secret.
 *
 * Derived from the URL this process already uses to run the agent rather than
 * configured separately: two variables pointing at one service drift, and the
 * second one is always the stale one.
 */
export function createArcadeAgentClient(options: {
  agentUrl: string;
  agentAuthHeader?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ArcadeAgentClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post<T>(path: string, body: unknown): Promise<T | null> {
    let url: string;
    try {
      url = endpoint(options.agentUrl, path);
    } catch {
      // A malformed agent URL is a configuration mistake that will never
      // resolve itself. Separated from the fetch below so it is not reported
      // as "try again".
      console.error(
        `[opentag] could not build the ${path} request; check AGENT_URL`,
      );
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(options.agentAuthHeader
            ? { Authorization: options.agentAuthHeader }
            : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        // 404 from the claim route is an ordinary spent ticket, not a fault.
        if (response.status !== 404) {
          console.warn(
            `[opentag] the agent answered ${response.status} for ${path}`,
          );
        }
        return null;
      }
      return (await response.json()) as T;
    } catch (error) {
      console.warn(`[opentag] could not reach the agent for ${path}:`, error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    claimTicket: (ticket) => post<ClaimedTicket>("arcade/claim", { ticket }),
    confirmFlow: ({ browserHandle, flowId }) =>
      post<ConfirmedFlow>("arcade/confirm", {
        browser_handle: browserHandle,
        flow_id: flowId,
      }),
  };
}

/** The cookie this service issued, or `null` when the browser carries none. */
export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

function setSessionCookie(response: ServerResponse, handle: string): void {
  response.setHeader(
    "Set-Cookie",
    [
      `${COOKIE_NAME}=${handle}`,
      `Path=${COOKIE_PATH}`,
      `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
      "HttpOnly",
      "Secure",
      // Lax, not Strict, and the difference decides whether any of this works:
      // the journey back is a navigation from Arcade's site to ours, and Strict
      // withholds the cookie on exactly that. Lax sends it for a top-level GET
      // and nothing riskier.
      "SameSite=Lax",
    ].join("; "),
  );
}

function clearSessionCookie(response: ServerResponse): void {
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=${COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  );
}

function sendText(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  // A connection page is never worth caching, and a cached one would show the
  // last person's outcome to the next.
  response.setHeader("Cache-Control", "no-store");
  response.end(body);
}

function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 303;
  response.setHeader("Location", location);
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

/**
 * Handle one browser request, or answer `false` so the caller can route it.
 *
 * Written as a wrapper rather than a framework route because this service
 * mounts exactly one listener, and two pages do not justify a second one.
 */
export async function handleArcadeBrowserRequest(
  request: IncomingMessage,
  response: ServerResponse,
  client: ArcadeAgentClient,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://placeholder");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path !== START_PATH && path !== VERIFY_PATH) return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method not allowed.");
    return true;
  }

  if (path === START_PATH) {
    const claimed = await client.claimTicket(url.searchParams.get("t") ?? "");
    if (claimed === null) {
      sendText(response, 200, ALREADY_SPENT);
      return true;
    }
    setSessionCookie(response, claimed.browserHandle);
    redirect(response, claimed.providerUrl);
    return true;
  }

  const confirmed = await client.confirmFlow({
    browserHandle: readSessionCookie(request.headers.cookie),
    flowId: url.searchParams.get("flow_id"),
  });
  if (confirmed === null) {
    sendText(response, 200, UNAVAILABLE);
    return true;
  }
  if (confirmed.clearCookie) {
    // Spent either way. Left behind it is a stale claim on an identity sitting
    // in somebody's browser for the rest of its lifetime.
    clearSessionCookie(response);
  }
  if (confirmed.redirectTo) {
    redirect(response, confirmed.redirectTo);
    return true;
  }
  sendText(response, 200, confirmed.message || UNAVAILABLE);
  return true;
}
