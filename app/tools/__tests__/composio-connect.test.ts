import { describe, expect, it, vi } from "vitest";
import {
  connectEndpoint,
  normalizeToolkit,
  requestConnectLink,
} from "../composio-connect.js";

const LINK = "https://backend.composio.dev/connect/abc123";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const base = {
  agentUrl: "http://agent.internal:8123/",
  agentAuthHeader: "Bearer s3cret",
  actorId: "U1",
  actorKind: "human",
  platform: "slack",
  toolkit: "gmail",
};

describe("connectEndpoint", () => {
  it("derives the route from the agent url, with or without a trailing slash", () => {
    expect(connectEndpoint("http://agent:8123/")).toBe(
      "http://agent:8123/composio/connect",
    );
    expect(connectEndpoint("http://agent:8123")).toBe(
      "http://agent:8123/composio/connect",
    );
  });

  it("keeps a base path rather than replacing it", () => {
    expect(connectEndpoint("http://agent:8123/opentag/")).toBe(
      "http://agent:8123/opentag/composio/connect",
    );
  });
});

describe("requestConnectLink", () => {
  it("returns the link and never puts one in the request", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ redirectUrl: LINK }),
    ) as unknown as typeof fetch;

    const result = await requestConnectLink({ ...base, fetchImpl });

    expect(result).toEqual({ ok: true, url: LINK });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      actor_id: "U1",
      // The agent mints nothing for a bot or an app, and only this side knows
      // what clicked. Omitting it would make every connection anonymous.
      kind: "human",
      platform: "slack",
      toolkit: "gmail",
    });
  });

  it("sends the shared secret, because the route mints nothing without it", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ redirectUrl: LINK }),
    ) as unknown as typeof fetch;

    await requestConnectLink({ ...base, fetchImpl });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer s3cret",
    });
  });

  it.each([undefined, "", "   ", "\n"])(
    "explains a secret of %j instead of provoking a 401 nobody can act on",
    async (agentAuthHeader) => {
      // Truthiness alone let a whitespace-only value through, and a header
      // value with a newline in it is rejected by fetch outright.
      const fetchImpl = vi.fn() as unknown as typeof fetch;

      const result = await requestConnectLink({
        ...base,
        agentAuthHeader,
        fetchImpl,
      });

      expect(result.ok).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
      // The variable name is the operator's business. Naming it in a thread
      // tells everyone reading how this deployment is wired.
      if (!result.ok) expect(result.message).not.toContain("AGENT_AUTH_HEADER");
    },
  );

  it("logs the variable an operator has to set, where only an operator looks", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await requestConnectLink({
      ...base,
      agentAuthHeader: "   ",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(JSON.stringify(logged.mock.calls)).toContain("AGENT_AUTH_HEADER");
    logged.mockRestore();
  });

  it("trims the secret rather than putting a stray newline on the wire", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ redirectUrl: LINK }),
    ) as unknown as typeof fetch;

    await requestConnectLink({
      ...base,
      agentAuthHeader: "Bearer s3cret\n",
      fetchImpl,
    });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer s3cret",
    });
  });

  it.each([401, 403])(
    "does not repeat the agent's %i body at a person who cannot act on it",
    async (status) => {
      // The agent answers a mismatched secret with the bare word
      // "unauthorized", which tells the person nothing and tells them nothing
      // they can do. A 4xx body is also the one place a credential could be
      // echoed back, and this is the status that would echo one.
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ error: "unauthorized: Bearer s3cret" }, status),
      ) as unknown as typeof fetch;
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await requestConnectLink({ ...base, fetchImpl });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).not.toContain("s3cret");
        expect(result.message).not.toBe("unauthorized");
        expect(result.message).not.toContain("unauthorized");
        expect(result.message).not.toContain("AGENT_AUTH_HEADER");
        expect(result.message.length).toBeGreaterThan(30);
      }
      logged.mockRestore();
    },
  );

  it("never repeats the secret it was given, whatever the agent says back", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "rejected token Bearer s3cret" }, 400),
    ) as unknown as typeof fetch;

    const result = await requestConnectLink({ ...base, fetchImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain("s3cret");
  });

  it("redacts the bare token as well as the whole header value", async () => {
    // An agent that answers `token abc… is not valid` quotes only the second
    // half of what we sent, and that half is the credential.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "token 0123456789abcdef is not valid" }, 400),
    ) as unknown as typeof fetch;

    const result = await requestConnectLink({
      ...base,
      agentAuthHeader: "Bearer 0123456789abcdef",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain("0123456789abcdef");
      expect(result.message).toContain("[redacted]");
    }
  });

  it("passes the agent's own refusal through, because it is written for a person", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: '"linear" is not one of the apps people connect for themselves.' },
        400,
      ),
    ) as unknown as typeof fetch;

    const result = await requestConnectLink({
      ...base,
      toolkit: "linear",
      fetchImpl,
    });

    expect(result).toEqual({
      ok: false,
      message: '"linear" is not one of the apps people connect for themselves.',
    });
  });

  it("does not surface a server error body, which is a stack trace or proxy html", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "Traceback (most recent call last)" }, 500),
    ) as unknown as typeof fetch;

    const result = await requestConnectLink({ ...base, fetchImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain("Traceback");
      expect(result.message).toContain("gmail");
    }
  });

  it("passes the agent's own 503 through, because it says what to configure", async () => {
    // "Composio is not configured on this deployment." is the agent's own
    // sentence and the only one that tells the operator what to do. A blanket
    // >=500 filter threw it away and showed a generic retry line instead.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: "Composio is not configured on this deployment." },
        503,
      ),
    ) as unknown as typeof fetch;

    const result = await requestConnectLink({ ...base, fetchImpl });

    expect(result).toEqual({
      ok: false,
      message: "Composio is not configured on this deployment.",
    });
  });

  it("does not pass a proxy's 503 through, which is html and not a sentence", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<html><body>503 Service Unavailable</body></html>", {
          status: 503,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;

    const result = await requestConnectLink({ ...base, fetchImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain("html");
  });

  it("gives up on a hung agent instead of leaving the click pending forever", async () => {
    // Without a deadline the request can hang for the platform's timeout, or
    // never resolve at all, and the "try again shortly" sentence below is
    // unreachable — the person just watches a button that did nothing.
    const fetchImpl = vi.fn(
      async (_url: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    ) as unknown as typeof fetch;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await requestConnectLink({
      ...base,
      timeoutMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Try again shortly");
    logged.mockRestore();
  });

  it("gives up on a stalled body, not only on stalled headers", async () => {
    // The deadline was cleared the moment `fetch` resolved, which is when the
    // *headers* arrive — the body is still a stream. An agent that answers 200
    // and then stops sending left `response.json()` awaiting forever with no
    // deadline behind it, so the click hung exactly as it did before there was
    // a timeout at all.
    const stalledBody = vi.fn(
      async (_url: unknown, init: RequestInit) =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            new Promise<unknown>((_resolve, reject) => {
              init.signal?.addEventListener("abort", () => {
                reject(
                  new DOMException("The operation was aborted.", "AbortError"),
                );
              });
            }),
        }) as unknown as Response,
    ) as unknown as typeof fetch;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await requestConnectLink({
      ...base,
      timeoutMs: 10,
      fetchImpl: stalledBody,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Try again shortly");
    logged.mockRestore();
  });

  it("stops the deadline once the whole reply is in hand", async () => {
    // The abort must not fire after a successful read: the controller outlives
    // the response object, and a late `abort()` on a settled request is a timer
    // this process holds for no reason.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ redirectUrl: LINK }),
    ) as unknown as typeof fetch;
    const cleared = vi.spyOn(globalThis, "clearTimeout");

    const result = await requestConnectLink({ ...base, fetchImpl });

    expect(result).toEqual({ ok: true, url: LINK });
    expect(cleared).toHaveBeenCalled();
    cleared.mockRestore();
  });

  it("says a bad AGENT_URL is a configuration problem, not a transient one", async () => {
    // `new URL()` and the header build sat inside the same unbound `catch {}`
    // as the fetch, so a misconfigured agent address read as "try again
    // shortly" forever, and nothing was logged.
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await requestConnectLink({
      ...base,
      agentUrl: "not a url",
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain("Try again shortly");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("logs an unreachable agent rather than swallowing why", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await requestConnectLink({ ...base, fetchImpl });

    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("treats an unreachable agent as something to retry", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await requestConnectLink({ ...base, fetchImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Try again shortly");
  });

  it("treats a response with no link as a failure rather than passing undefined on", async () => {
    for (const body of [{}, { redirectUrl: "" }, { redirectUrl: 7 }]) {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(body),
      ) as unknown as typeof fetch;

      const result = await requestConnectLink({ ...base, fetchImpl });

      expect(result.ok).toBe(false);
    }
  });

  it("tells an unreadable reply apart from a reply with no link", async () => {
    // `.catch(() => null)` reported both as "no link", so an agent answering
    // 200 with html — a proxy in front of it, say — read as a Composio problem.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const unreadable = vi.fn(
      async () =>
        new Response("<html>hello</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ) as unknown as typeof fetch;
    const noLink = vi.fn(async () =>
      jsonResponse({}),
    ) as unknown as typeof fetch;

    const unreadableResult = await requestConnectLink({
      ...base,
      fetchImpl: unreadable,
    });
    const noLinkResult = await requestConnectLink({
      ...base,
      fetchImpl: noLink,
    });

    expect(unreadableResult.ok).toBe(false);
    expect(noLinkResult.ok).toBe(false);
    if (!unreadableResult.ok && !noLinkResult.ok) {
      expect(unreadableResult.message).not.toBe(noLinkResult.message);
    }
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it.each([
    "javascript:alert(1)",
    "https://evil.example/x|Click here",
    "https://evil.example/x> <https://evil.example",
    "/relative/path",
  ])("refuses a minted link of %j, which is rendered as a live hyperlink", async (redirectUrl) => {
    // The link is rendered into Slack's `<url|label>` syntax. A `|` or a `>` in
    // it ends the url half and lets the rest become a label or a second link,
    // and a `javascript:` scheme is not a connect flow at all.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ redirectUrl }),
    ) as unknown as typeof fetch;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await requestConnectLink({ ...base, fetchImpl });

    expect(result.ok).toBe(false);
    logged.mockRestore();
  });
});

describe("normalizeToolkit", () => {
  it("keeps an app name an app name", () => {
    expect(normalizeToolkit("  Gmail ")).toBe("gmail");
    expect(normalizeToolkit("google_calendar")).toBe("google_calendar");
    expect(normalizeToolkit("notion-v2")).toBe("notion-v2");
  });

  it.each([
    "",
    "   ",
    "<https://evil.example|gmail>",
    "*gmail*",
    "gmail\nSection: hi",
    "<@U123>",
    "a".repeat(65),
  ])("refuses %j, because the slug is rendered in a public post", (raw) => {
    // The model chooses this string and the card carrying it is posted where
    // everyone in the thread reads it, rendered as mrkdwn. An identifier
    // charset is the whole of what a slug may be; anything else is not one.
    expect(normalizeToolkit(raw)).toBeNull();
  });
});
