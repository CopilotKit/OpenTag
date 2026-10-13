/**
 * Asking the agent for one person's Arcade connect link.
 *
 * The Composio sibling beside this file does the same job for that provider,
 * and the two are kept apart rather than parameterised because what they carry
 * differs in the one way that matters: Composio connects an *app*, Arcade
 * connects an *action*. Folding them together would mean a single validation
 * rule loose enough for both, and that rule guards a string the model chose
 * which is then rendered into a public card.
 *
 * Two steps rather than one, because the agent no longer knows where it can be
 * reached from a browser. It answers with a ticket; this side builds the link
 * from its own public address.
 */

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface ArcadeConnectInput {
  agentUrl: string;
  publicUrl: string;
  agentAuthHeader?: string;
  actorId: string;
  /**
   * The clicker's `ProviderActor.kind`. Sent because the agent refuses to mint
   * for anything but a person, and only this side knows what clicked.
   */
  actorKind: string;
  /**
   * The clicker's display name, shown on the start page so a forwarded link
   * says who it was made for. Display only; the agent decides nothing by it.
   */
  actorName?: string;
  platform: string;
  /** A qualified action, e.g. `Gmail.SendMail`. */
  target: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type ArcadeConnectResult =
  | { ok: true; url: string }
  | { ok: true; alreadyConnected: true }
  | { ok: false; message: string };

/**
 * The one shape an Arcade action name may have.
 *
 * The model chooses this string and it is rendered into a card posted publicly
 * in the thread — as Slack mrkdwn, where `<https://evil.example|Gmail>` is a
 * live hyperlink and `*Gmail*` is bold. Escaping at the render site would have
 * to be repeated at every render site and got missed at the first one.
 *
 * Deliberately not `normalizeToolkit` with the rules relaxed. Arcade's names
 * are two identifiers joined by a dot and they are case-sensitive — `Github`
 * and `github` are not interchangeable inside a qualified name — so the case
 * is preserved rather than folded, and the dot is required rather than merely
 * permitted. A bare `SendMail` is refused: it names no app, and guessing one
 * would let a caller reach an action by leaving the prefix off.
 *
 * Returns the action unchanged, or `null` when the string was never one.
 */
export function normalizeAction(raw: string): string | null {
  const action = raw.trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}\.[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(action)
    ? action
    : null;
}

/**
 * What an Arcade Connect card may carry: an app, or an action within one.
 *
 * An app is what the search reports as needing connection, so it is what the
 * model naturally names — and a live run did exactly that, which is why this
 * accepts both rather than insisting on an action. Same charset rule as
 * `normalizeAction` and for the same reason: the string came from the model and
 * is rendered into a public post. Case is preserved.
 *
 * Returns the target unchanged, or `null` when it was never one.
 */
export function normalizeArcadeTarget(raw: string): string | null {
  const target = raw.trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z][A-Za-z0-9_-]{0,63})?$/.test(
    target,
  )
    ? target
    : null;
}

/**
 * The app half of a target, for showing a person what they connect.
 *
 * A target with no dot is already an app. Slicing to `indexOf(".")` without
 * that check cut the last character off it, because `indexOf` answers `-1`.
 */
export function appNameOf(target: string): string {
  const dot = target.indexOf(".");
  return dot === -1 ? target : target.slice(0, dot);
}

import { readEnvironment } from "../env.js";

export type ConnectedAppProvider = "composio" | "arcade" | null;

/**
 * Ask the agent which connected-app provider it runs.
 *
 * The Connect button used to infer this from the shape of the name the model
 * passed, and the first live run named an app on an Arcade deployment — so the
 * card went to Composio, which was not configured. Selection lives on the
 * agent; this only reads the answer.
 *
 * `undefined` means the agent could not be asked, which is different from
 * `null` (asked, and no provider is configured). Nothing here throws.
 */
export async function fetchConnectedAppProvider(input: {
  agentUrl: string;
  agentAuthHeader?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ConnectedAppProvider | undefined> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let url: string;
  try {
    url = endpoint(input.agentUrl, "connected-apps/provider");
  } catch {
    console.error(
      "[opentag] could not build the provider request; check AGENT_URL",
    );
    return undefined;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(url, {
      headers: input.agentAuthHeader
        ? { Authorization: input.agentAuthHeader }
        : {},
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(
        `[opentag] the agent answered ${response.status} when asked its provider`,
      );
      return undefined;
    }
    const body = (await response.json()) as { provider?: unknown };
    if (body.provider === "composio" || body.provider === "arcade") {
      return body.provider;
    }
    return body.provider === null ? null : undefined;
  } catch (error) {
    console.warn("[opentag] could not ask the agent its provider:", error);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Said when the two services do not share a secret. Names no variable. */
const NO_SHARED_SECRET =
  "Connecting your own account needs a shared secret set on both this app and " +
  "its agent, and the agent has not set one. Ask whoever runs this deployment.";

const UNAVAILABLE =
  "The connection could not be started just now. Try again in a moment.";

function endpoint(agentUrl: string, path: string): string {
  const base = agentUrl.endsWith("/") ? agentUrl : `${agentUrl}/`;
  return new URL(path, base).toString();
}

/**
 * Ask for a ticket, and build the link a browser should open.
 *
 * Nothing here throws. A click that rejects is an unhandled rejection and a
 * button that silently did nothing, so every branch either returns a link or
 * returns a sentence to show the person.
 */
export async function requestArcadeConnectLink(
  input: ArcadeConnectInput,
): Promise<ArcadeConnectResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  let url: string;
  try {
    url = endpoint(input.agentUrl, "arcade/connect");
  } catch {
    // A configuration mistake that will never resolve itself, so it is not
    // reported to the person as something to retry.
    console.error(
      "[opentag] could not build the Arcade connect request; check AGENT_URL",
    );
    return { ok: false, message: UNAVAILABLE };
  }

  if (!input.publicUrl.trim()) {
    // Caught here rather than by building a link on a guess: a guessed address
    // sends somebody to a page that does not exist, minutes after they asked
    // for help.
    console.error(
      "[opentag] no public address is configured, so no connect link can be " +
        "built. Personal Arcade connections need one.",
    );
    return { ok: false, message: UNAVAILABLE };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(input.agentAuthHeader
          ? { Authorization: input.agentAuthHeader }
          : {}),
      },
      body: JSON.stringify({
        actor_id: input.actorId,
        kind: input.actorKind,
        platform: input.platform,
        target: input.target,
        ...(input.actorName ? { display_name: input.actorName } : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    console.warn("[opentag] could not reach the agent to connect:", error);
    return { ok: false, message: UNAVAILABLE };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 503) {
    // The agent is not configured for this: no shared secret, or no Arcade at
    // all. Its own sentence names which, so it is shown. A 503 that is not the
    // agent's JSON — a proxy's HTML page — carries no sentence for anyone.
    const isJson = (response.headers.get("content-type") ?? "").includes("json");
    const reason = isJson ? await safeRefusal(response) : null;
    return { ok: false, message: reason ?? NO_SHARED_SECRET };
  }
  if (response.status === 400) {
    // A refusal the agent wrote for a person to read — a shared app, an
    // unconfigured one, an actor it would not mint for.
    const refusal = await safeRefusal(response);
    return { ok: false, message: refusal ?? UNAVAILABLE };
  }
  if (!response.ok) {
    console.warn(
      `[opentag] the agent answered ${response.status} to a connect request`,
    );
    return { ok: false, message: UNAVAILABLE };
  }

  let body: { ticket?: unknown; alreadyConnected?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch (error) {
    console.warn("[opentag] the agent's connect reply was unreadable:", error);
    return { ok: false, message: UNAVAILABLE };
  }

  if (body.alreadyConnected === true) {
    return { ok: true, alreadyConnected: true };
  }
  if (typeof body.ticket !== "string" || !body.ticket) {
    console.warn("[opentag] the agent's connect reply carried no ticket");
    return { ok: false, message: UNAVAILABLE };
  }

  const base = input.publicUrl.replace(/\/+$/, "");
  return {
    ok: true,
    url: `${base}/arcade/start?t=${encodeURIComponent(body.ticket)}`,
  };
}

/**
 * The agent's own sentence, or nothing.
 *
 * Only a string, and only from the field the agent writes for a reader. A
 * body of another shape is not a message to show somebody.
 */
async function safeRefusal(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error.trim()
      ? body.error
      : null;
  } catch {
    return null;
  }
}


/**
 * Which provider this deployment runs, read from this process's environment.
 *
 * The one call the Connect button makes, and the one seam a test stubs. A
 * deployment missing `AGENT_URL` makes `readEnvironment` throw; that is
 * reported as "could not ask" rather than escaping into a tool handler nothing
 * awaits.
 */
export async function lookupConnectedAppProvider(): Promise<
  ConnectedAppProvider | undefined
> {
  let environment: ReturnType<typeof readEnvironment>;
  try {
    environment = readEnvironment();
  } catch (error) {
    console.error("[opentag] could not read the environment to ask the agent its provider:", error);
    return undefined;
  }
  return fetchConnectedAppProvider({
    agentUrl: environment.agentUrl,
    agentAuthHeader: environment.agentAuthHeader,
  });
}
