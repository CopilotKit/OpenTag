/**
 * The Connect button's click path.
 *
 * The card is posted publicly and pressed minutes later, so its handler is
 * re-derived rather than remembered — and a throw on that path is the failure
 * this whole card was shaped to avoid: the person presses it and nothing
 * happens, with nothing anywhere to explain it.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToIR } from "@copilotkit/channels";
import type {
  ClickHandler,
  EphemeralResult,
  InteractionContext,
  MessageRef,
  ProviderActor,
  Renderable,
} from "@copilotkit/channels";
import { renderSlackMessage } from "@copilotkit/channels/slack";
import { renderAdaptiveCard } from "@copilotkit/channels/teams";
import { ConnectAccount, ConnectLink } from "../connect-account.js";

/**
 * The click handler's own module, with a switch on the one failure the card's
 * catch exists for. Kept delegating by default so the test below that exercises
 * the real click path still does.
 */
const boot = vi.hoisted(() => ({ fails: false }));
vi.mock("../../tools/connect-click.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../tools/connect-click.js")>();
  return {
    ...actual,
    handleConnectClick: async (
      ...args: Parameters<typeof actual.handleConnectClick>
    ) => {
      if (boot.fails) throw new Error("connect-click could not be loaded");
      return actual.handleConnectClick(...args);
    },
  };
});

/** The card's single button, as a click handler. */
function connectButton(node: unknown): ClickHandler {
  const found: ClickHandler[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const element = value as {
      props?: Record<string, unknown>;
      children?: unknown;
    };
    if (typeof element.props?.onClick === "function") {
      found.push(element.props.onClick as ClickHandler);
    }
    if (element.props?.children) visit(element.props.children);
    if (element.children) visit(element.children);
  };
  visit(node);
  expect(found).toHaveLength(1);
  return found[0]!;
}

function interaction(
  actor: ProviderActor | undefined,
  ephemeral: EphemeralResult | null = { ok: true, usedFallback: false },
) {
  const postEphemeral = vi.fn(
    async (
      _user: ProviderActor | string,
      _ui: Renderable,
      _opts: { fallbackToDM: boolean },
    ): Promise<EphemeralResult | null> => ephemeral,
  );
  const post = vi.fn(async (_ui: Renderable): Promise<MessageRef> => ({
    id: "m2",
  }));
  return {
    ctx: {
      actor,
      platform: "slack",
      thread: { postEphemeral, post },
      message: { ref: { id: "m1" } },
    } as unknown as InteractionContext,
    postEphemeral,
    post,
  };
}

describe("ConnectAccount", () => {
  it("tells the clicker when the connection could not even be started", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    // `handleConnectClick` reads the environment before anything else, so an
    // incomplete deployment throws out of the click. Unguarded, that throw is
    // the dead button this card's whole design exists to prevent.
    vi.stubEnv("AGENT_URL", "");
    const press = connectButton(ConnectAccount({ toolkit: "gmail" }));
    const { ctx, postEphemeral } = interaction({ id: "U1", kind: "human" });

    await press(ctx);

    // The click is answered by `handleConnectClick`'s configuration guard, which
    // says what is wrong and who can fix it rather than "could not start".
    expect(postEphemeral).toHaveBeenCalledTimes(1);
    const notice = JSON.stringify(postEphemeral.mock.calls[0]);
    expect(notice).toMatch(/not configured to connect accounts/i);
    expect(notice).toMatch(/ask whoever runs it/i);
    // The notice carries no credential and no variable name. A connect failure
    // is read by whoever pressed the button, not by whoever operates the
    // deployment, and `AGENT_URL` in a thread teaches nobody anything useful.
    expect(notice).not.toMatch(/AGENT_URL|AGENT_AUTH_HEADER|INTELLIGENCE_API_KEY/);
    // Private either way: DM fallback is scoped to the clicker exactly as an
    // ephemeral message is, which is why the link path asks for it too.
    expect(postEphemeral.mock.calls[0]![2]).toEqual({ fallbackToDM: true });
    expect(JSON.stringify(consoleError.mock.calls)).toMatch(
      /connect_click_environment/,
    );
    vi.unstubAllEnvs();
    consoleError.mockRestore();
  });
});

describe("the notice shown when the click could not even be handed over", () => {
  /** Runs one press with the click handler's module failing to load. */
  async function pressWithABrokenHandler(
    actor: ProviderActor | undefined,
    ephemeral: EphemeralResult | null = { ok: true, usedFallback: false },
  ) {
    boot.fails = true;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const press = connectButton(ConnectAccount({ toolkit: "gmail" }));
    const surface = interaction(actor, ephemeral);
    try {
      await press(surface.ctx);
      // Snapshotted before the restore below, which clears the record: read
      // afterwards it is always `[]`, and every `not.toContain` on it passes
      // for the wrong reason.
      return { ...surface, logged: JSON.stringify(consoleError.mock.calls) };
    } finally {
      boot.fails = false;
      consoleError.mockRestore();
    }
  }

  it("says it in the thread when the surface delivered no private message", async () => {
    // The managed adapter reports non-delivery by returning `null` — it does
    // not throw. The return value was discarded, so the notice vanished while
    // the log recorded `told_the_clicker_privately`.
    const { post } = await pressWithABrokenHandler(
      { id: "U1", kind: "human" },
      null,
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(post.mock.calls)).toMatch(/could not start/i);
  });

  it("treats an ok:false ephemeral result as undelivered too", async () => {
    const { post } = await pressWithABrokenHandler({ id: "U1", kind: "human" }, {
      ok: false,
      error: "this surface has no ephemeral message",
    } as EphemeralResult);

    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not log a delivery it did not make", async () => {
    // `told_the_clicker_privately` beside a dropped message is a log line that
    // lies to whoever reads it looking for why nobody was told.
    const { logged } = await pressWithABrokenHandler(
      { id: "U1", kind: "human" },
      null,
    );

    expect(logged).toContain("connect_account_click");
    expect(logged).not.toContain("told_the_clicker_privately");
    expect(logged).toContain("posted_the_notice_in_the_thread");
  });

  it("still records the private delivery when one actually happened", async () => {
    const { post, logged } = await pressWithABrokenHandler({
      id: "U1",
      kind: "human",
    });

    expect(post).not.toHaveBeenCalled();
    expect(logged).toContain("told_the_clicker_privately");
  });

  it("never addresses the notice to a literal \"unknown\" user id", async () => {
    // There is no such user, so the notice went nowhere. With no identifiable
    // clicker the thread is the only surface left, and the notice carries no
    // capability.
    const { postEphemeral, post } = await pressWithABrokenHandler(undefined);

    expect(postEphemeral).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(post.mock.calls)).not.toContain("unknown");
  });

  it("asks for the DM fallback, exactly as the link path does", async () => {
    const { postEphemeral } = await pressWithABrokenHandler({
      id: "U1",
      kind: "human",
    });

    expect(postEphemeral.mock.calls[0]![2]).toEqual({ fallbackToDM: true });
  });
});

describe("ConnectLink", () => {
  const URL_WITH_PARAMS =
    "https://backend.composio.dev/connect?state=abc&redirect=xyz";

  it("carries the url in a link button rather than Slack-only markup", () => {
    // `<url|label>` is a Slack mrkdwn construct: on Teams it renders as that
    // literal string, and on Slack an unescaped `&` inside the url half ends
    // the link early, so a connect url with query parameters arrived broken.
    const { blocks } = renderSlackMessage(
      renderToIR(<ConnectLink toolkit="gmail" url={URL_WITH_PARAMS} />),
    );

    const actions = blocks.find((b) => b.type === "actions") as
      | { elements: { type: string; url?: string }[] }
      | undefined;
    expect(actions?.elements[0]?.url).toBe(URL_WITH_PARAMS);
    // The url is in a url field, not in any rendered text.
    const sections = blocks.filter((b) => b.type !== "actions");
    expect(JSON.stringify(sections)).not.toContain("http");
    expect(JSON.stringify(blocks)).not.toMatch(/<[^<>]*\|[^<>]*>/);
  });

  it("opens the same url on a surface that is not Slack", () => {
    const card = renderAdaptiveCard(
      renderToIR(<ConnectLink toolkit="gmail" url={URL_WITH_PARAMS} />),
    ) as { actions?: { type: string; url?: string }[]; body?: unknown };

    expect(card.actions?.[0]?.type).toBe("Action.OpenUrl");
    expect(card.actions?.[0]?.url).toBe(URL_WITH_PARAMS);
    expect(JSON.stringify(card.body)).not.toContain("http");
  });
});
