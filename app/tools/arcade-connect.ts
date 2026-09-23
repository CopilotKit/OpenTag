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

/** The app half of a qualified action, for showing a person what they connect. */
export function appNameOf(action: string): string {
  return action.slice(0, action.indexOf("."));
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
    // The agent says it has no secret to check, which is an operator problem
    // and has its own sentence.
    return { ok: false, message: NO_SHARED_SECRET };
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
