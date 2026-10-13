/**
 * Asking the agent for one person's connect link.
 *
 * The Channel holds no Composio session and no api key. It knows two things the
 * agent cannot: who pressed the button, and how to put something in front of
 * that person alone. So it asks for a link and delivers it. The URL never
 * reaches the model and is never posted where a second person could open it —
 * whoever completes a connect flow binds their account to the id the link was
 * minted for, which makes a shared link an account-takeover hazard.
 *
 * Two rules run through every branch below. Nothing a person is shown may carry
 * a credential or a variable name — those go to the log, where only an operator
 * looks. And nothing fails without saying so: every `return { ok: false }` here
 * either repeats a sentence the agent wrote for a person, or logs the reason it
 * could not.
 */

/** How long a click waits for the agent before it is told to try again. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface ConnectRequestInput {
  agentUrl: string;
  agentAuthHeader?: string;
  actorId: string;
  /**
   * The clicker's `ProviderActor.kind`. Sent because the agent refuses to mint
   * a link for anything but a person, and only this side knows what clicked.
   */
  actorKind: string;
  platform: string;
  toolkit: string;
  fetchImpl?: typeof fetch;
  /** Overridden only by tests; a click cannot wait on a hung agent forever. */
  timeoutMs?: number;
}

/** A link for exactly one person, or the sentence to show them instead. */
export type ConnectResult =
  | { ok: true; url: string }
  | { ok: false; message: string };

/**
 * The one shape a toolkit slug may have.
 *
 * The model chooses this string, and it is rendered into a card posted publicly
 * in the thread — as Slack mrkdwn, where `<https://evil.example|gmail>` is a
 * live hyperlink and `*gmail*` is bold. Escaping at the render site would have
 * to be repeated at every render site and got missed at the first one. A
 * toolkit is an identifier, so the identifier charset is the whole of what it
 * may contain and anything else is not a toolkit name at all.
 *
 * Returns the normalized slug, or `null` when the string was never one.
 */
export function normalizeToolkit(raw: string): string | null {
  const slug = raw.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug) ? slug : null;
}

/**
 * The agent's connect endpoint, derived from the URL the Channel already uses
 * to run it. Derived rather than configured separately: two variables pointing
 * at one service drift, and the second one is always the stale one.
 */
export function connectEndpoint(agentUrl: string): string {
  return new URL("composio/connect", agentUrl.endsWith("/") ? agentUrl : `${agentUrl}/`).toString();
}

/** Said when the two services do not share a secret. Names no variable. */
const NO_SHARED_SECRET =
  "Connecting your own account needs a shared secret set on both this app and " +
  "its agent, and this deployment has not set one. Ask whoever runs it.";

/** Said when they both set one and the two do not match. Names no credential. */
const SECRET_REJECTED =
  "Connecting your own account needs this app and its agent to present the " +
  "same shared secret, and the agent rejected the one this app sent. Ask " +
  "whoever runs this deployment.";

export async function requestConnectLink({
  agentUrl,
  agentAuthHeader,
  actorId,
  actorKind,
  platform,
  toolkit,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
}: ConnectRequestInput): Promise<ConnectResult> {
  // The endpoint refuses to mint anything without this header, so a deployment
  // that never set it gets a clear sentence rather than a 401 the person cannot
  // act on. Trimmed rather than tested for truthiness: a value of `" "` is set
  // everywhere it is checked and authorizes nothing, and one with a newline in
  // it is not a legal header value — `fetch` rejects the whole request.
  const secret = agentAuthHeader?.trim();
  if (!secret) {
    console.error(
      "[opentag] no connect link can be minted: AGENT_AUTH_HEADER is unset or " +
        "blank on this service, and the agent's connect route requires it",
    );
    return { ok: false, message: NO_SHARED_SECRET };
  }

  // Built before the request and outside its catch. `new URL()` throws on a
  // malformed AGENT_URL, which is a configuration mistake that will never
  // resolve itself; sharing a catch with the fetch reported it as "try again
  // shortly" forever and logged nothing.
  let endpoint: string;
  let body: string;
  try {
    endpoint = connectEndpoint(agentUrl);
    body = JSON.stringify({
      actor_id: actorId,
      kind: actorKind,
      platform,
      toolkit,
    });
  } catch (error) {
    console.error(
      `[opentag] could not build the connect request for ${toolkit}; check AGENT_URL`,
      error,
    );
    return {
      ok: false,
      message:
        `Could not start the ${toolkit} connection: this deployment's agent ` +
        "address is not a usable URL. Ask whoever runs it.",
    };
  }

  const controller = new AbortController();
  // Held until the whole reply is in hand, not until the headers are. `fetch`
  // resolves on the status line, with the body still an open stream, so
  // clearing the deadline here left `response.json()` below awaiting with
  // nothing behind it — an agent that answers 200 and then stops sending hung
  // the click exactly as it did before there was a timeout at all. Aborting
  // after the headers errors the body stream, which is the wanted effect.
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await exchange({
      endpoint,
      body,
      secret,
      toolkit,
      fetchImpl,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(deadline);
  }
}

/** One request and its whole reply, inside the caller's deadline. */
async function exchange({
  endpoint,
  body,
  secret,
  toolkit,
  fetchImpl,
  signal,
}: {
  endpoint: string;
  body: string;
  secret: string;
  toolkit: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<ConnectResult> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: secret,
      },
      body,
      signal,
    });
  } catch (error) {
    // The reason is a network detail; the person can only retry either way. It
    // still belongs in the log, where the operator can see whether every click
    // is failing and why.
    console.error(
      `[opentag] the agent could not be reached to mint a ${toolkit} connect link`,
      error,
    );
    return {
      ok: false,
      message: `Could not reach the agent to start the ${toolkit} connection. Try again shortly.`,
    };
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      // The agent's own body here is the bare word "unauthorized", which tells
      // the person nothing they can act on. It is also the one response that
      // could quote the credential back, and a thread is the last place that
      // may appear.
      console.error(
        `[opentag] the agent rejected this service's AGENT_AUTH_HEADER (${response.status}) ` +
          `while minting a ${toolkit} connect link; the two halves do not match`,
      );
      return { ok: false, message: SECRET_REJECTED };
    }

    const detail = withoutSecret(await readErrorMessage(response), secret);
    if (detail === null) {
      console.error(
        `[opentag] the agent answered ${response.status} with no usable reason ` +
          `while minting a ${toolkit} connect link`,
      );
    }
    return {
      ok: false,
      message: detail ?? `Could not start the ${toolkit} connection.`,
    };
  }

  let payload: { redirectUrl?: unknown } | null;
  try {
    payload = (await response.json()) as { redirectUrl?: unknown } | null;
  } catch (error) {
    // Not the same thing as "the agent had no link for you": this is something
    // other than the agent answering — a proxy, usually — and conflating the
    // two sent the person off to check their Composio configuration.
    console.error(
      `[opentag] the agent's ${toolkit} connect reply was not JSON`,
      error,
    );
    return {
      ok: false,
      message: `Could not start the ${toolkit} connection: the reply was unreadable. Try again shortly.`,
    };
  }

  const url = safeConnectUrl(payload?.redirectUrl);
  if (url === null) {
    console.error(
      `[opentag] the agent returned no usable ${toolkit} connect link`,
    );
    return {
      ok: false,
      message: `Could not start the ${toolkit} connection: no link came back. Try again shortly.`,
    };
  }
  return { ok: true, url };
}

/**
 * The agent's sentence with the one credential this side knows taken out of it.
 *
 * A 4xx body is written for a person and goes straight into a thread. We handed
 * the agent exactly one secret, so that is exactly one string we can recognize
 * on the way back — both as the whole header value and as the token inside it,
 * because an error like `token abc… is not valid` quotes only the second.
 */
function withoutSecret(message: string | null, secret: string): string | null {
  if (message === null) return null;
  let scrubbed = message;
  for (const needle of secretNeedles(secret)) {
    scrubbed = scrubbed.split(needle).join("[redacted]");
  }
  return scrubbed;
}

/** The header value, and the token in it when that is long enough to be one. */
function secretNeedles(secret: string): string[] {
  const needles = new Set<string>();
  if (secret.length > 0) needles.add(secret);
  const token = secret.split(/\s+/).at(-1);
  if (token && token.length >= 6) needles.add(token);
  return [...needles].sort((a, b) => b.length - a.length);
}

/**
 * The minted link, if it is one that may be rendered.
 *
 * It is rendered into Slack's `<url|label>` syntax, where `|` and `>` end the
 * url half — a link carrying either could smuggle a label of its own or a
 * second link past the person reading it. The scheme is checked because a
 * `javascript:` or `data:` URL in that position is not a connect flow.
 */
function safeConnectUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (/[<>|"'\s]/.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return raw;
}

/**
 * The agent's refusal, if it is one that may be rendered.
 *
 * The sibling of `normalizeToolkit` and `safeConnectUrl`, for the third value
 * on this path that another service wrote: a 4xx body, which goes into a Slack
 * `section` as mrkdwn. There, `<https://evil.example|Finish connecting Gmail>`
 * is a live, labelled hyperlink and a bare `https://…` autolinks on its own —
 * so escaping the angle brackets would not have been enough, and the guard
 * has to be the same one the other two use: a value outside the shape we
 * accept is not rendered at all.
 *
 * The shape is "a sentence": prose, with nothing in it that opens markup on a
 * surface this app renders to and nothing that reads as a web address.
 *
 * `_` stays legal because the agent's own refusal quotes the slug it was handed
 * and slugs contain underscores; italics carry nothing anyway. `/` is refused,
 * and that is what puts `://` out of reach. `](` is refused because a section's
 * text is run through a markdown-to-mrkdwn pass on the way out, so
 * `[here](https:evil.example)` arrives in the thread as a live `<url|label>`
 * without ever containing an angle bracket. It is the pair that is refused
 * rather than the brackets, so that `withoutSecret`'s `[redacted]` still reads
 * as a sentence — that refusal is the one that most needs saying.
 *
 * Returns the trimmed sentence, or `null` when it was never one — the caller
 * shows its own words instead and logs what it dropped.
 */
export function safeRefusalMessage(raw: string): string | null {
  const message = raw.trim();
  if (message.length === 0 || message.length > 400) return null;
  if (/[<>|*~`\/\\]/.test(message)) return null;
  if (message.includes("](")) return null;
  if (/www\./i.test(message)) return null;
  return message;
}

/** A JSON body is the agent answering; anything else is something in front of it. */
function isJson(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("json");
}

/**
 * The agent's own sentence when it has one.
 *
 * From a 4xx: those are its considered refusals ("that app is connected by an
 * operator, not from Slack"), and they are written for a person. And from a
 * 503, which is the agent saying it is not configured for this — equally its
 * own sentence and the only one that names what to fix. Every other 5xx is a
 * stack trace. The content type is checked because a proxy's 503 is HTML and
 * carries no sentence for anyone.
 */
async function readErrorMessage(response: Response): Promise<string | null> {
  if (response.status >= 500 && response.status !== 503) return null;
  if (!isJson(response)) return null;
  try {
    const payload = (await response.json()) as { error?: unknown } | null;
    const error = payload?.error;
    if (typeof error !== "string") return null;
    const trimmed = error.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
