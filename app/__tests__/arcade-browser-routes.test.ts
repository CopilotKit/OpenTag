/**
 * The browser half of the Arcade connect flow.
 *
 * The properties under test are the ones that decide whether somebody's
 * account binds to the right person: the cookie has to survive a cross-site
 * return, it must not be readable by script or carry an identity, and a
 * browser we never issued one to must confirm nobody.
 */

import { describe, expect, it, vi } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

import {
  COOKIE_NAME,
  createArcadeAgentClient,
  handleArcadeBrowserRequest,
  readSessionCookie,
  type ArcadeAgentClient,
} from "../arcade-browser-routes.js";

function requestFor(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
): IncomingMessage {
  const request = new IncomingMessage(new Socket());
  request.url = url;
  request.method = method;
  Object.assign(request.headers, headers);
  return request;
}

function responseFor(request: IncomingMessage) {
  const response = new ServerResponse(request);
  const chunks: string[] = [];
  const end = response.end.bind(response);
  response.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return end(chunk as never);
  }) as typeof response.end;
  return {
    response,
    get body() {
      return chunks.join("");
    },
    get cookie() {
      const header = response.getHeader("Set-Cookie");
      return Array.isArray(header) ? header.join("; ") : String(header ?? "");
    },
  };
}

function clientWith(overrides: Partial<ArcadeAgentClient> = {}): ArcadeAgentClient {
  return {
    claimTicket: vi.fn(async () => ({
      providerUrl: "https://provider.example/oauth?state=abc",
      browserHandle: "handle-1",
    })),
    confirmFlow: vi.fn(async () => ({
      outcome: "confirmed" as const,
      redirectTo: "https://arcade.example/done",
      message: "Connected.",
      clearCookie: true,
    })),
    ...overrides,
  };
}

describe("routing", () => {
  it("leaves every other path to the rest of the application", async () => {
    for (const path of ["/", "/api/copilotkit", "/arcade", "/arcade/connect"]) {
      const request = requestFor(path);
      const { response } = responseFor(request);

      expect(
        await handleArcadeBrowserRequest(request, response, clientWith()),
      ).toBe(false);
    }
  });

  it("refuses a method a browser redirect never uses", async () => {
    const request = requestFor("/arcade/verify", {}, "POST");
    const sink = responseFor(request);

    await handleArcadeBrowserRequest(request, sink.response, clientWith());

    expect(sink.response.statusCode).toBe(405);
  });
});

describe("the outbound hop", () => {
  it("spends the ticket and sends the browser to the provider", async () => {
    const client = clientWith();
    const request = requestFor("/arcade/start?t=ticket-1");
    const sink = responseFor(request);

    await handleArcadeBrowserRequest(request, sink.response, client);

    expect(client.claimTicket).toHaveBeenCalledWith("ticket-1");
    expect(sink.response.statusCode).toBe(303);
    expect(sink.response.getHeader("Location")).toBe(
      "https://provider.example/oauth?state=abc",
    );
  });

  it("gives the browser a cookie no script can read", async () => {
    const request = requestFor("/arcade/start?t=ticket-1");
    const sink = responseFor(request);

    await handleArcadeBrowserRequest(request, sink.response, clientWith());

    expect(sink.cookie).toContain("HttpOnly");
    expect(sink.cookie).toContain("Secure");
    // Strict would withhold the cookie on the return leg, which is a
    // navigation from Arcade's site to ours. That is the whole flow.
    expect(sink.cookie).toContain("SameSite=Lax");
    expect(sink.cookie).toContain("Path=/arcade");
  });

  it("puts nothing identifying in the cookie", async () => {
    const request = requestFor("/arcade/start?t=ticket-1");
    const sink = responseFor(request);

    await handleArcadeBrowserRequest(request, sink.response, clientWith());

    expect(sink.cookie).toContain("handle-1");
    expect(sink.cookie).not.toContain("slack");
    expect(sink.cookie).not.toContain("ticket-1");
  });

  it("tells somebody with a spent link to ask again", async () => {
    const request = requestFor("/arcade/start?t=used");
    const sink = responseFor(request);

    await handleArcadeBrowserRequest(
      request,
      sink.response,
      clientWith({ claimTicket: vi.fn(async () => null) }),
    );

    expect(sink.response.statusCode).toBe(200);
    expect(sink.body).toContain("already been used");
    expect(sink.response.getHeader("Set-Cookie")).toBeUndefined();
  });
});

describe("the return leg", () => {
  it("confirms using the browser's own cookie", async () => {
    const client = clientWith();
    const request = requestFor("/arcade/verify?flow_id=uuid-1", {
      cookie: `${COOKIE_NAME}=handle-1`,
    });
    const sink = responseFor(request);

    await handleArcadeBrowserRequest(request, sink.response, client);

    expect(client.confirmFlow).toHaveBeenCalledWith({
      browserHandle: "handle-1",
      flowId: "uuid-1",
    });
    expect(sink.response.statusCode).toBe(303);
  });

  it("never takes an identity from the query string", async () => {
    // The defect this prevents: binding anybody's account by editing a URL.
    const client = clientWith();
    const request = requestFor(
      "/arcade/verify?flow_id=uuid-1&user_id=acme/slack:VICTIM",
      { cookie: `${COOKIE_NAME}=handle-1` },
    );
    const sink = responseFor(request);

    await handleArcadeBrowserRequest(request, sink.response, client);

    expect(client.confirmFlow).toHaveBeenCalledWith({
      browserHandle: "handle-1",
      flowId: "uuid-1",
    });
  });

  it("asks about a browser carrying no cookie rather than assuming one", async () => {
    // Started on a laptop, finished on a phone — and also somebody who simply
    // found the route. The agent is the one that decides, and it says nobody.
    const client = clientWith({
      confirmFlow: vi.fn(async () => ({
        outcome: "unknown" as const,
        redirectTo: null,
        message: "This connection could not be completed in this browser.",
        clearCookie: true,
      })),
    });
    const request = requestFor("/arcade/verify?flow_id=uuid-1");
    const sink = responseFor(request);

    await handleArcadeBrowserRequest(request, sink.response, client);

    expect(client.confirmFlow).toHaveBeenCalledWith({
      browserHandle: null,
      flowId: "uuid-1",
    });
    expect(sink.response.statusCode).toBe(200);
    expect(sink.body).toContain("could not be completed");
  });

  it("clears the cookie once it has been spent", async () => {
    const request = requestFor("/arcade/verify?flow_id=uuid-1", {
      cookie: `${COOKIE_NAME}=handle-1`,
    });
    const sink = responseFor(request);

    await handleArcadeBrowserRequest(request, sink.response, clientWith());

    expect(sink.cookie).toContain("Max-Age=0");
  });

  it("says something useful when the agent cannot be reached", async () => {
    const request = requestFor("/arcade/verify?flow_id=uuid-1");
    const sink = responseFor(request);

    await handleArcadeBrowserRequest(
      request,
      sink.response,
      clientWith({ confirmFlow: vi.fn(async () => null) }),
    );

    expect(sink.response.statusCode).toBe(200);
    expect(sink.body).toContain("Ask again in the chat");
  });

  it("never caches a connection page", async () => {
    // A cached one would show the last person's outcome to the next.
    const request = requestFor("/arcade/verify?flow_id=uuid-1");
    const sink = responseFor(request);

    await handleArcadeBrowserRequest(request, sink.response, clientWith());

    expect(sink.response.getHeader("Cache-Control")).toBe("no-store");
  });
});

describe("sitting in front of the rest of the application", () => {
  it("keeps the Channel control the server waits on", async () => {
    // Wrapping a function drops its properties. Without carrying them across,
    // the process starts, serves, and never activates its Channel — which
    // looks like a dead Slack app rather than like a missing property.
    const { createOpenTagRuntime } = await import("../runtime-host.js");

    const { listener } = createOpenTagRuntime({
      environment: {
        agentUrl: "http://agent.internal:8123",
        agentAuthHeader: "Bearer s3cret",
        channelName: "test-channel",
        agentDisplayName: "OpenTag",
        intelligenceApiKey: "cpk-test",
      } as never,
      channels: [],
    });

    expect("channels" in listener).toBe(true);
  });
});

describe("reading the cookie", () => {
  it("finds the value among others", () => {
    expect(readSessionCookie(`a=1; ${COOKIE_NAME}=wanted; b=2`)).toBe("wanted");
  });

  it("answers nothing when there is none", () => {
    expect(readSessionCookie(undefined)).toBeNull();
    expect(readSessionCookie("")).toBeNull();
    expect(readSessionCookie("other=1")).toBeNull();
    expect(readSessionCookie(`${COOKIE_NAME}=`)).toBeNull();
  });

  it("is not fooled by a name that merely ends the same", () => {
    expect(readSessionCookie(`not_${COOKIE_NAME}=theirs`)).toBeNull();
  });
});

describe("talking to the agent", () => {
  it("sends the shared secret", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ providerUrl: "https://x", browserHandle: "h" }), {
        status: 200,
      }),
    );
    const client = createArcadeAgentClient({
      agentUrl: "http://agent.internal:8123/",
      agentAuthHeader: "Bearer s3cret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.claimTicket("ticket-1");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://agent.internal:8123/arcade/claim");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer s3cret",
    );
  });

  it("treats a spent ticket as an ordinary answer, not a fault", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    const client = createArcadeAgentClient({
      agentUrl: "http://agent.internal:8123",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await client.claimTicket("gone")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("answers nothing when the agent is unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const client = createArcadeAgentClient({
      agentUrl: "http://agent.internal:8123",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(
      await client.confirmFlow({ browserHandle: "h", flowId: "f" }),
    ).toBeNull();
    warn.mockRestore();
  });

  it("does not report a malformed agent url as something to retry", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = createArcadeAgentClient({
      agentUrl: "not a url",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(await client.claimTicket("t")).toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
