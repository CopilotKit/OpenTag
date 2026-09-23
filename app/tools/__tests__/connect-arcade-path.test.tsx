/**
 * The Connect button when Arcade is the provider.
 *
 * Two things differ from the Composio path and both are load-bearing. Arcade
 * connects an action rather than an app, so what travels on the card is a
 * qualified name with its case intact. And the card records which provider
 * minted it, so a card that outlived a provider change refuses itself instead
 * of being answered by whichever client still happens to be configured.
 */

import { describe, expect, it, vi } from "vitest";

import { connectAppTool } from "../connect-app.js";
import { handleConnectClick } from "../connect-click.js";
import { requestLabel } from "../../human-in-the-loop/connect-account.js";

const environment = {
  agentUrl: "http://agent.internal:8123",
  publicUrl: "https://opentag.example",
  agentAuthHeader: "Bearer s3cret",
} as never;

function interaction(actor: { id: string; kind: string } | undefined) {
  const post = vi.fn(async () => undefined);
  const postEphemeral = vi.fn(async () => ({ ok: true, usedFallback: true }));
  return {
    ctx: {
      actor,
      platform: "slack",
      thread: { post, postEphemeral },
    } as never,
    post,
    postEphemeral,
  };
}

describe("posting the card", () => {
  it("records Arcade and the action when given a qualified name", async () => {
    const post = vi.fn(async () => undefined);

    const result = await connectAppTool.handler(
      { toolkit: "Gmail.SendMail" },
      { thread: { post } } as never,
    );

    const posted = (post.mock.calls as unknown as unknown[][])[0]?.[0] as {
      props: { request: unknown };
    };
    expect(posted.props.request).toEqual({
      target: "Gmail.SendMail",
      provider: "arcade",
    });
    expect(String(result)).toContain("Gmail");
  });

  it("still records Composio for a bare app name", async () => {
    const post = vi.fn(async () => undefined);

    await connectAppTool.handler(
      { toolkit: "gmail" },
      { thread: { post } } as never,
    );

    const posted = (post.mock.calls as unknown as unknown[][])[0]?.[0] as {
      props: { request: unknown };
    };
    expect(posted.props.request).toEqual({
      toolkit: "gmail",
      provider: "composio",
    });
  });

  it("posts nothing for an action name that could change how a card renders", async () => {
    const post = vi.fn(async () => undefined);

    for (const hostile of [
      "<https://evil.example|Gmail>.SendMail",
      "*Gmail*.SendMail",
      "Gmail.Send Mail",
      "Gmail.Send.Mail",
    ]) {
      await connectAppTool.handler(
        { toolkit: hostile },
        { thread: { post } } as never,
      );
    }

    expect(post).not.toHaveBeenCalled();
  });

  it("names the app half of an action for a person to read", () => {
    expect(requestLabel({ target: "GoogleCalendar.CreateEvent" })).toBe(
      "GoogleCalendar",
    );
    expect(requestLabel({ toolkit: "gmail" })).toBe("Gmail");
  });
});

describe("pressing it", () => {
  it("asks Arcade, not Composio, when the card says so", async () => {
    const requestArcade = vi.fn(async () => ({
      ok: true as const,
      url: "https://opentag.example/arcade/start?t=tkt",
    }));
    const request = vi.fn();
    const { ctx, postEphemeral } = interaction({ id: "U1", kind: "human" });

    await handleConnectClick(
      { target: "Gmail.SendMail", provider: "arcade" },
      ctx,
      { environment, request: request as never, requestArcade },
    );

    expect(request).not.toHaveBeenCalled();
    expect(requestArcade).toHaveBeenCalledTimes(1);
    expect(
      (requestArcade.mock.calls as unknown as unknown[][])[0]?.[0],
    ).toMatchObject({
      target: "Gmail.SendMail",
      actorId: "U1",
      publicUrl: "https://opentag.example",
    });
    expect(postEphemeral).toHaveBeenCalled();
  });

  it("asks Composio when the card says nothing about a provider", async () => {
    // Every card posted before the field existed is one of these.
    const requestArcade = vi.fn();
    const request = vi.fn(async () => ({
      ok: true as const,
      url: "https://provider.example/oauth",
    }));
    const { ctx } = interaction({ id: "U1", kind: "human" });

    await handleConnectClick({ toolkit: "gmail" }, ctx, {
      environment,
      request,
      requestArcade: requestArcade as never,
    });

    expect(requestArcade).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("mints nothing for an action the card should never have carried", async () => {
    // The card is re-derived from stored props after a restart, so this is the
    // last place the value is checked before it is rendered again.
    const requestArcade = vi.fn();
    const { ctx, post } = interaction({ id: "U1", kind: "human" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleConnectClick(
      { target: "<https://evil.example|Gmail>.SendMail", provider: "arcade" },
      ctx,
      { environment, requestArcade: requestArcade as never },
    );

    expect(requestArcade).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("mints nothing when it cannot tell who clicked", async () => {
    const requestArcade = vi.fn();
    const { ctx } = interaction(undefined);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleConnectClick(
      { target: "Gmail.SendMail", provider: "arcade" },
      ctx,
      { environment, requestArcade: requestArcade as never },
    );

    expect(requestArcade).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("tells somebody already connected rather than sending them round again", async () => {
    const requestArcade = vi.fn(async () => ({
      ok: true as const,
      alreadyConnected: true as const,
    }));
    const { ctx, postEphemeral } = interaction({ id: "U1", kind: "human" });

    await handleConnectClick(
      { target: "Gmail.SendMail", provider: "arcade" },
      ctx,
      { environment, requestArcade },
    );

    expect(postEphemeral).toHaveBeenCalled();
    const rendered = JSON.stringify(
      (postEphemeral.mock.calls as unknown as unknown[][])[0],
    );
    expect(rendered).toContain("already connected");
  });
});
