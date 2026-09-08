import { describe, expect, it, vi } from "vitest";
import { renderToIR, type Renderable } from "@copilotkit/channels";
import { renderSlackMessage } from "@copilotkit/channels/slack";
import { handleConnectClick } from "../connect-click.js";

const LINK = "https://backend.composio.dev/connect/abc123";

type Ephemeral = { ok: boolean; usedFallback?: boolean; error?: string } | null;

/**
 * `postEphemeral` resolving `null` is not an edge case: it is what the SDK does
 * on every surface without a native ephemeral message, which is what the
 * managed Slack adapter reports and therefore what the default deployment does.
 * Every test here says which of the two outcomes it is exercising.
 */
function interaction(
  actor: { id: string; kind: string } | undefined,
  options: { ephemeral?: Ephemeral; postRejects?: Error } = {},
) {
  const ephemeral: Ephemeral =
    options.ephemeral === undefined ? { ok: true, usedFallback: false } : options.ephemeral;
  // Typed parameters, not a cast: the assertions below read the recorded
  // arguments, and an untyped mock records an empty tuple.
  const postEphemeral = vi.fn(
    async (_user: unknown, _ui: unknown, _options: { fallbackToDM: boolean }) =>
      ephemeral,
  );
  const post = vi.fn(async (_ui: unknown) => {
    if (options.postRejects) throw options.postRejects;
    return { id: "m1" };
  });
  return {
    ctx: {
      actor,
      platform: "slack",
      thread: { postEphemeral, post },
      message: { ref: "m1" },
      action: { id: "a1" },
      values: {},
      user: null,
    } as never,
    postEphemeral,
    post,
  };
}

const environment = {
  agentUrl: "http://agent:8123/",
  agentAuthHeader: "Bearer s3cret",
} as never;

/** Everything either delivery path was handed, as one searchable string. */
function everythingRendered(
  postEphemeral: ReturnType<typeof vi.fn>,
  post: ReturnType<typeof vi.fn>,
): string {
  return JSON.stringify([...postEphemeral.mock.calls, ...post.mock.calls]);
}

describe("handleConnectClick", () => {
  it("mints for whoever clicked, not for whoever the card was posted to", async () => {
    const request = vi.fn(async () => ({ ok: true as const, url: LINK }));
    const { ctx } = interaction({ id: "U2", kind: "human" });

    await handleConnectClick("gmail", ctx, { environment, request });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "U2",
        actorKind: "human",
        platform: "slack",
        toolkit: "gmail",
      }),
    );
  });

  it("reports what clicked rather than asserting it was a person", async () => {
    // The agent is the one gate on this, and it can only refuse what it is
    // told. Sending a fixed "human" would hand a bot a link to a real account.
    const request = vi.fn(async () => ({ ok: true as const, url: LINK }));
    const { ctx } = interaction({ id: "B1", kind: "bot" });

    await handleConnectClick("gmail", ctx, { environment, request });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "B1", actorKind: "bot" }),
    );
  });

  it("delivers the link to that person alone", async () => {
    const request = vi.fn(async () => ({ ok: true as const, url: LINK }));
    const { ctx, postEphemeral, post } = interaction({ id: "U2", kind: "human" });

    await handleConnectClick("gmail", ctx, { environment, request });

    expect(postEphemeral).toHaveBeenCalledTimes(1);
    expect(postEphemeral.mock.calls[0]![0]).toEqual({ id: "U2", kind: "human" });
    // Nothing public happened, because the private post landed.
    expect(post).not.toHaveBeenCalled();
  });

  it("asks for the DM fallback, because the default deployment has no ephemeral message", async () => {
    // The managed Slack adapter declares `supportsEphemeral: false`. With
    // `fallbackToDM: false` the SDK resolves `null` and the minted link is
    // simply dropped — the connect button did nothing on the default install.
    // A DM is scoped to the clicker exactly as an ephemeral message is.
    const request = vi.fn(async () => ({ ok: true as const, url: LINK }));
    const { ctx, postEphemeral } = interaction({ id: "U2", kind: "human" });

    await handleConnectClick("gmail", ctx, { environment, request });

    expect(postEphemeral.mock.calls[0]![2]).toEqual({ fallbackToDM: true });
  });

  it("says so in the thread when the link could not be delivered privately", async () => {
    // `null` is the SDK's "this surface delivered nothing". Discarding it left
    // the person staring at a button that did nothing, with no log either.
    const request = vi.fn(async () => ({ ok: true as const, url: LINK }));
    const { ctx, post } = interaction({ id: "U2", kind: "human" }, { ephemeral: null });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleConnectClick("gmail", ctx, { environment, request });

    expect(post).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("never puts the minted link anywhere public, whatever went wrong", async () => {
    // Whoever completes a connect link binds their account to the id it was
    // minted for, so a link in a thread is an account-takeover hazard.
    const request = vi.fn(async () => ({ ok: true as const, url: LINK }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    for (const ephemeral of [null, { ok: false, error: "no ephemeral" }] as Ephemeral[]) {
      const { ctx, post } = interaction({ id: "U2", kind: "human" }, { ephemeral });

      await handleConnectClick("gmail", ctx, { environment, request });

      expect(JSON.stringify(post.mock.calls)).not.toContain(LINK);
    }
    logged.mockRestore();
  });

  it("treats an ok:false ephemeral result as undelivered", async () => {
    // The SDK reports the surface's refusal this way rather than throwing.
    const request = vi.fn(async () => ({ ok: true as const, url: LINK }));
    const { ctx, post } = interaction(
      { id: "U2", kind: "human" },
      { ephemeral: { ok: false, error: "slack does not support ephemeral messages" } },
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleConnectClick("gmail", ctx, { environment, request });

    expect(post).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it("mints nothing when it cannot tell who clicked", async () => {
    // Minting anyway would bind an account to whatever id we guessed.
    const request = vi.fn();
    const { ctx, postEphemeral, post } = interaction(undefined);

    await handleConnectClick("gmail", ctx, { environment, request });

    expect(request).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not address the no-actor notice to a literal \"unknown\"", async () => {
    // There is no such user id, so `postEphemeral("unknown", …)` delivered the
    // notice to nobody. With no identifiable clicker the thread is the only
    // surface left, and the notice carries no capability.
    const request = vi.fn();
    const { ctx, postEphemeral } = interaction(undefined);

    await handleConnectClick("gmail", ctx, { environment, request });

    expect(everythingRendered(postEphemeral, vi.fn())).not.toContain("unknown");
    expect(postEphemeral).not.toHaveBeenCalled();
  });

  it("shows the reason privately when no link could be minted", async () => {
    const request = vi.fn(async () => ({
      ok: false as const,
      message: "Shared apps are connected by an operator.",
    }));
    const { ctx, postEphemeral } = interaction({ id: "U2", kind: "human" });

    await handleConnectClick("linear", ctx, { environment, request });

    expect(postEphemeral).toHaveBeenCalledTimes(1);
    expect(postEphemeral.mock.calls[0]![2]).toEqual({ fallbackToDM: true });
  });

  it("still shows the reason when the surface cannot deliver privately", async () => {
    // A refusal carries no capability, so the thread is a safe place for it and
    // silence is not.
    const request = vi.fn(async () => ({
      ok: false as const,
      message: "Shared apps are connected by an operator.",
    }));
    const { ctx, post } = interaction({ id: "U2", kind: "human" }, { ephemeral: null });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleConnectClick("linear", ctx, { environment, request });

    expect(JSON.stringify(post.mock.calls)).toContain(
      "Shared apps are connected by an operator.",
    );
    logged.mockRestore();
  });

  it("does not let a failed mint escape the click handler", async () => {
    // Nothing awaits this handler: an escaping rejection is an unhandled one,
    // and the person sees a button that did nothing.
    const request = vi.fn(async () => {
      throw new Error("boom");
    });
    const { ctx, post } = interaction({ id: "U2", kind: "human" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      handleConnectClick("gmail", ctx, { environment, request }),
    ).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it("does not let a throwing surface escape the click handler", async () => {
    const request = vi.fn(async () => ({ ok: true as const, url: LINK }));
    const { ctx } = interaction({ id: "U2", kind: "human" }, {
      ephemeral: null,
      postRejects: new Error("channel_not_found"),
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      handleConnectClick("gmail", ctx, { environment, request }),
    ).resolves.toBeUndefined();
    logged.mockRestore();
  });

  it("does not let an unreadable environment escape the click handler", async () => {
    // `readEnvironment()` throws on a deployment missing `AGENT_URL`, and it ran
    // per click inside a handler nothing awaits.
    const request = vi.fn();
    const { ctx, postEphemeral } = interaction({ id: "U2", kind: "human" });
    const environmentThatThrows = () => {
      throw new Error("Missing required env var: AGENT_URL");
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      handleConnectClick("gmail", ctx, {
        request,
        readEnvironment: environmentThatThrows,
      }),
    ).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    // The person hears about it, on whichever surface could carry it.
    expect(postEphemeral).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it("refuses a toolkit that is not a slug, because the card renders it publicly", async () => {
    // The value travels on the card the model asked for, and the card is a
    // public post rendered as mrkdwn.
    const request = vi.fn();
    const { ctx } = interaction({ id: "U2", kind: "human" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleConnectClick("<https://evil.example|gmail>", ctx, {
      environment,
      request,
    });

    expect(request).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("cannot be talked into rendering a live link by the agent's refusal text", async () => {
    // The refusal is written by another service and lands in a Slack `section`
    // as mrkdwn, where `<url|label>` is a live, labelled hyperlink. The agent's
    // own 400 quotes the toolkit it was handed, so this string has a route in
    // from outside. The rendered blocks are the assertion here, not "the guard
    // was called".
    const request = vi.fn(async () => ({
      ok: false as const,
      message:
        "<https://evil.example/steal|Finish connecting Gmail> is not one of the apps.",
    }));
    const { ctx, postEphemeral } = interaction({ id: "U2", kind: "human" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleConnectClick("gmail", ctx, { environment, request });

    const ui = postEphemeral.mock.calls[0]![1] as Renderable;
    const rendered = JSON.stringify(renderSlackMessage(renderToIR(ui)));
    expect(rendered).not.toContain("evil.example");
    // No Slack link markup survived at all: `<…|…>` is the whole mechanism.
    expect(rendered).not.toMatch(/<[^<>]*\|[^<>]*>/);
    // And the person is still told something.
    expect(rendered).toMatch(/could not start the gmail connection/i);
    logged.mockRestore();
  });

  it("keeps an ordinary refusal verbatim, underscored slug and all", async () => {
    // The guard rejects markup, not prose. `_` stays legal because the agent's
    // refusal quotes the slug it was handed and slugs contain underscores; it
    // renders as italics at worst, which carries nothing.
    const request = vi.fn(async () => ({
      ok: false as const,
      message:
        '"google_calendar" is not one of the apps people connect for themselves. ' +
        "Shared apps are connected once by an operator, not from Slack.",
    }));
    const { ctx, postEphemeral } = interaction({ id: "U2", kind: "human" });

    await handleConnectClick("google_calendar", ctx, { environment, request });

    const ui = postEphemeral.mock.calls[0]![1] as Renderable;
    const rendered = JSON.stringify(renderSlackMessage(renderToIR(ui)));
    expect(rendered).toContain("google_calendar");
    expect(rendered).toContain("connected once by an operator");
  });

  it("still shows a refusal the client had to redact the secret out of", async () => {
    // `withoutSecret` writes `[redacted]` into the sentence, so the guard has
    // to refuse the markdown link *pair* rather than the brackets — otherwise
    // the one refusal that most needs saying is the one silently swallowed.
    const request = vi.fn(async () => ({
      ok: false as const,
      message: "The token [redacted] is not valid for this workspace.",
    }));
    const { ctx, postEphemeral } = interaction({ id: "U2", kind: "human" });

    await handleConnectClick("gmail", ctx, { environment, request });

    const ui = postEphemeral.mock.calls[0]![1] as Renderable;
    expect(JSON.stringify(renderSlackMessage(renderToIR(ui)))).toContain(
      "[redacted] is not valid",
    );
  });

  it("refuses the markdown link a second surface would make live", async () => {
    const request = vi.fn(async () => ({
      ok: false as const,
      message: "Finish connecting [here](https:evil.example) to continue.",
    }));
    const { ctx, postEphemeral } = interaction({ id: "U2", kind: "human" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleConnectClick("gmail", ctx, { environment, request });

    const ui = postEphemeral.mock.calls[0]![1] as Renderable;
    expect(JSON.stringify(renderSlackMessage(renderToIR(ui)))).not.toContain(
      "evil.example",
    );
    logged.mockRestore();
  });

  it("does not render a bare url the agent handed back either", async () => {
    // An unmarked `https://…` autolinks in Slack on its own, so escaping the
    // angle brackets would not have been enough.
    const request = vi.fn(async () => ({
      ok: false as const,
      message: "Finish at https://evil.example/steal to connect.",
    }));
    const { ctx, postEphemeral } = interaction({ id: "U2", kind: "human" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleConnectClick("gmail", ctx, { environment, request });

    const ui = postEphemeral.mock.calls[0]![1] as Renderable;
    expect(JSON.stringify(renderSlackMessage(renderToIR(ui)))).not.toContain(
      "evil.example",
    );
    logged.mockRestore();
  });

  it("reports through reportRecoverableError rather than a bare console.error", async () => {
    // Every other recoverable path in this app logs through one funnel, which
    // is what an operator greps for and where a reporter would be attached.
    const request = vi.fn();
    const { ctx } = interaction(undefined);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleConnectClick("gmail", ctx, { environment, request });

    expect(logged.mock.calls[0]![0]).toBe("[channel] recoverable error");
    expect(JSON.stringify(logged.mock.calls)).toContain("connect_click");
    logged.mockRestore();
  });
});
