/**
 * Asking the agent for one person's Arcade connect link.
 *
 * The rule running through every case: nothing a person is shown may carry a
 * credential or a variable name, and nothing fails silently — every refusal
 * either repeats a sentence the agent wrote for a reader, or logs why it could
 * not and shows something safe.
 */

import { describe, expect, it, vi } from "vitest";

import {
  appNameOf,
  normalizeAction,
  requestArcadeConnectLink,
} from "../arcade-connect.js";

const BASE = {
  agentUrl: "http://agent.internal:8123",
  publicUrl: "https://opentag.example",
  agentAuthHeader: "Bearer s3cret",
  actorId: "U1",
  actorKind: "human",
  platform: "slack",
  target: "Gmail.SendMail",
};

function respondWith(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
    }),
  ) as unknown as typeof fetch;
}

describe("what counts as an action name", () => {
  it("accepts a qualified action", () => {
    expect(normalizeAction("Gmail.SendMail")).toBe("Gmail.SendMail");
    expect(normalizeAction("  GoogleCalendar.CreateEvent  ")).toBe(
      "GoogleCalendar.CreateEvent",
    );
  });

  it("keeps the case", () => {
    // Arcade's names are case-sensitive inside a qualified name: `Github` and
    // `github` are not interchangeable, so folding would produce identifiers
    // that resolve to nothing.
    expect(normalizeAction("Github.ListIssues")).toBe("Github.ListIssues");
  });

  it("refuses a bare action with no app", () => {
    // Guessing the app would let a caller reach an action by leaving the
    // prefix off.
    expect(normalizeAction("SendMail")).toBeNull();
    expect(normalizeAction(".SendMail")).toBeNull();
    expect(normalizeAction("Gmail.")).toBeNull();
  });

  it("refuses anything that could change how a card renders", () => {
    // The card is a public post rendered as mrkdwn, where `<url|label>` is a
    // live hyperlink and `*x*` is bold.
    for (const hostile of [
      "<https://evil.example|Gmail>.SendMail",
      "Gmail.Send Mail",
      "*Gmail*.SendMail",
      "Gmail.SendMail\nmore",
      "Gmail.SendMail; rm -rf /",
      "Gmail..SendMail",
      "Gmail.Send.Mail",
      "",
      "   ",
    ]) {
      expect(normalizeAction(hostile)).toBeNull();
    }
  });

  it("names the app half for showing somebody", () => {
    expect(appNameOf("Gmail.SendMail")).toBe("Gmail");
  });
});

describe("asking for a link", () => {
  it("sends the clicker, the platform and the action", async () => {
    const fetchImpl = respondWith({ ticket: "tkt" });

    await requestArcadeConnectLink({ ...BASE, fetchImpl });

    const [url, init] = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://agent.internal:8123/arcade/connect");
    expect(JSON.parse(init.body as string)).toEqual({
      actor_id: "U1",
      kind: "human",
      platform: "slack",
      target: "Gmail.SendMail",
    });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer s3cret",
    );
  });

  it("builds the link from this side's own address", async () => {
    // The agent has no public address and should not learn one.
    const result = await requestArcadeConnectLink({
      ...BASE,
      fetchImpl: respondWith({ ticket: "tkt" }),
    });

    expect(result).toEqual({
      ok: true,
      url: "https://opentag.example/arcade/start?t=tkt",
    });
  });

  it("does not double a slash when the address has a trailing one", async () => {
    const result = await requestArcadeConnectLink({
      ...BASE,
      publicUrl: "https://opentag.example/",
      fetchImpl: respondWith({ ticket: "tkt" }),
    });

    expect(result).toMatchObject({
      url: "https://opentag.example/arcade/start?t=tkt",
    });
  });

  it("escapes a ticket rather than trusting its shape", async () => {
    const result = await requestArcadeConnectLink({
      ...BASE,
      fetchImpl: respondWith({ ticket: "a b&c" }),
    });

    expect(result).toMatchObject({
      url: "https://opentag.example/arcade/start?t=a%20b%26c",
    });
  });

  it("says so when the account is already connected", async () => {
    // Sending them round the provider again would work, and asks somebody to
    // do something they have already done.
    const result = await requestArcadeConnectLink({
      ...BASE,
      fetchImpl: respondWith({ alreadyConnected: true }),
    });

    expect(result).toEqual({ ok: true, alreadyConnected: true });
  });
});

describe("when it cannot", () => {
  it("repeats the agent's own sentence for a refusal", async () => {
    const result = await requestArcadeConnectLink({
      ...BASE,
      fetchImpl: respondWith(
        { error: "That app is shared by the whole workspace." },
        400,
      ),
    });

    expect(result).toEqual({
      ok: false,
      message: "That app is shared by the whole workspace.",
    });
  });

  it("has its own sentence for a missing shared secret", async () => {
    const result = await requestArcadeConnectLink({
      ...BASE,
      fetchImpl: respondWith({ error: "…" }, 503),
    });

    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toContain("shared secret");
  });

  it("shows the agent's own reason for a 503, which is not always the secret", async () => {
    // The agent also answers 503 when Arcade is not configured, e.g. an old
    // card after a provider switch. Blaming the secret there sends the operator
    // to debug a variable that is set correctly.
    const result = await requestArcadeConnectLink({
      ...BASE,
      fetchImpl: vi.fn(async () =>
        Response.json(
          { error: "Arcade is not configured on this deployment." },
          { status: 503 },
        ),
      ) as unknown as typeof fetch,
    });

    expect(result).toEqual({
      ok: false,
      message: "Arcade is not configured on this deployment.",
    });
  });

  it("never shows a variable name to whoever clicked", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await requestArcadeConnectLink({
      ...BASE,
      publicUrl: "   ",
      fetchImpl: respondWith({ ticket: "tkt" }),
    });

    expect(result).toMatchObject({ ok: false });
    const message = (result as { message: string }).message;
    expect(message).not.toContain("PUBLIC_URL");
    expect(message).not.toContain("AGENT_URL");
    // The operator does get told, in the place only they look.
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("builds no link at all without a public address", async () => {
    // A guessed address sends somebody to a page that does not exist, minutes
    // after they asked for help.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = respondWith({ ticket: "tkt" });

    const result = await requestArcadeConnectLink({
      ...BASE,
      publicUrl: "",
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("answers safely when the agent is unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await requestArcadeConnectLink({
      ...BASE,
      fetchImpl: vi.fn(async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch,
    });

    expect(result).toMatchObject({ ok: false });
    warn.mockRestore();
  });

  it("answers safely when the reply carries no ticket", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await requestArcadeConnectLink({
      ...BASE,
      fetchImpl: respondWith({ somethingElse: true }),
    });

    expect(result).toMatchObject({ ok: false });
    warn.mockRestore();
  });

  it("answers safely when the reply is not json at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await requestArcadeConnectLink({
      ...BASE,
      fetchImpl: respondWith("<html>a proxy said no</html>"),
    });

    expect(result).toMatchObject({ ok: false });
    warn.mockRestore();
  });

  it("shows nothing but a safe sentence for a refusal of the wrong shape", async () => {
    // The agent writes refusals for people to read. A body of another shape is
    // not one, and must not be rendered as if it were.
    const result = await requestArcadeConnectLink({
      ...BASE,
      fetchImpl: respondWith({ error: { nested: "object" } }, 400),
    });

    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).not.toContain("nested");
  });
});
