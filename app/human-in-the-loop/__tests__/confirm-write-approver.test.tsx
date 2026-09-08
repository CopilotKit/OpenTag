/**
 * Who may answer an approval card.
 *
 * A call that runs in one person's own connected account spends that person's
 * access, so a colleague pressing approve would spend somebody else's. The agent
 * can only say whose call it is; the surface knows who clicked, so the rule is
 * enforced here.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  ClickHandler,
  EphemeralResult,
  InteractionContext,
  MessageRef,
  Renderable,
} from "@copilotkit/channels";
import { createConfirmWrite } from "../confirm-write.js";

const INTERRUPT_ID = "0123456789abcdef0123456789abcdef";
const unitCard = createConfirmWrite(async () => true);
const ConfirmWrite = (props: Parameters<typeof unitCard>[0]) => unitCard({ interruptId: INTERRUPT_ID, decisionId: "unit-test", conversationKey: "unit-thread", ...props });

/**
 * The card's buttons, as click handlers: confirm first, decline second.
 *
 * The count is asserted rather than assumed. Indexing positionally into a list
 * whose length nobody checks is how a test goes on passing while pressing
 * something else — or, once the buttons are gone, nothing at all.
 */
function cardButtons(node: unknown): {
  confirm: ClickHandler;
  decline: ClickHandler;
} {
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
    const onClick = element.props?.onClick;
    if (typeof onClick === "function") {
      found.push(onClick as ClickHandler);
    }
    if (element.props?.children) visit(element.props.children);
    if (element.children) visit(element.children);
  };
  visit(node);
  expect(found).toHaveLength(2);
  return { confirm: found[0]!, decline: found[1]! };
}

/**
 * The part of an interaction a `ConfirmWrite` click reads.
 *
 * Narrowed on purpose, and checked with `satisfies` rather than cast away with
 * `as never`: the mock's method signatures are then held to the real ones, so a
 * fake that resolves to the wrong shape — the `postEphemeral` that answers
 * `null` on a surface with no ephemeral message, say — cannot quietly drift out
 * of step with the interface the card is written against.
 */
type ClickContext = Pick<
  InteractionContext,
  "actor" | "platform" | "message"
> & {
  thread: { conversationKey: string } & Pick<
    InteractionContext["thread"],
    "update" | "resume" | "post" | "postEphemeral"
  >;
};

function interaction(
  actorId: string,
  overrides: {
    platform?: string;
    postEphemeral?: ClickContext["thread"]["postEphemeral"];
  } = {},
) {
  const update = vi.fn(
    async (_ref: MessageRef, _ui: Renderable): Promise<MessageRef> => ({
      id: "m1",
    }),
  );
  const resume = vi.fn(
    async (_value: unknown): Promise<MessageRef | undefined> => undefined,
  );
  const post = vi.fn(async (_ui: Renderable): Promise<MessageRef> => ({
    id: "m2",
  }));
  const postEphemeral = vi.fn<ClickContext["thread"]["postEphemeral"]>(
    overrides.postEphemeral ??
      (async (): Promise<EphemeralResult | null> => ({
        ok: true,
        usedFallback: false,
      })),
  );
  const actor = { id: actorId, kind: "human" } as const;
  const platform = overrides.platform ?? "slack";
  const ctx = {
    actor,
    platform,
    thread: { conversationKey: "unit-thread", update, resume, postEphemeral, post },
    message: {
      text: "",
      user: null,
      actor,
      ref: { id: "m1" },
      platform,
    },
  } satisfies ClickContext;

  return {
    ctx: ctx as unknown as InteractionContext,
    update,
    resume,
    post,
    postEphemeral,
  };
}

describe("ConfirmWrite approver", () => {
  it("lets the named person answer", async () => {
    const { confirm } = cardButtons(
      ConfirmWrite({ action: "Gmail send email", approver: "slack:U1" }),
    );
    const { ctx, update, postEphemeral } = interaction("U1");

    await confirm(ctx);

    expect(update).toHaveBeenCalled();
    expect(postEphemeral).not.toHaveBeenCalled();
  });

  it("refuses anybody else, and leaves the card for the right person", async () => {
    const { confirm } = cardButtons(
      ConfirmWrite({ action: "Gmail send email", approver: "slack:U1" }),
    );
    const { ctx, update, resume, postEphemeral } = interaction("U2");

    await confirm(ctx);

    expect(update).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledTimes(1);
    // Told privately where the surface can, and by DM where it cannot. The
    // notice names nobody, so it is not a secret that has to stay undelivered
    // — unlike a connect link, which is a bearer capability and does not fall
    // back to a DM.
    expect(postEphemeral.mock.calls[0]![2]).toEqual({ fallbackToDM: true });
  });

  it("refuses the decline button too, not only approve", async () => {
    const { decline } = cardButtons(
      ConfirmWrite({ action: "Gmail send email", approver: "slack:U1" }),
    );
    const { ctx, update, postEphemeral } = interaction("U2");

    await decline(ctx);

    expect(update).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledTimes(1);
  });

  it("lets anyone answer a workspace action, which names no approver", async () => {
    const { confirm } = cardButtons(
      ConfirmWrite({ action: "Create issue" }),
    );
    const { ctx, update, postEphemeral } = interaction("U2");

    await confirm(ctx);

    expect(update).toHaveBeenCalled();
    expect(postEphemeral).not.toHaveBeenCalled();
  });

  it("says so in the thread when the surface cannot deliver privately", async () => {
    // `postEphemeral` resolves to `null` on a surface with no ephemeral
    // message — the managed adapter reports exactly that. Ignoring the answer
    // makes the refusal invisible: the person clicks, nothing happens, and the
    // card sits there looking unclicked.
    const { confirm } = cardButtons(
      ConfirmWrite({ action: "Gmail send email", approver: "slack:U1" }),
    );
    const { ctx, resume, post, postEphemeral } = interaction("U2", {
      postEphemeral: async () => null,
    });

    await confirm(ctx);

    expect(postEphemeral).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    // The notice names nobody, so a public fallback leaks no account.
    expect(JSON.stringify(post.mock.calls[0])).toMatch(/only they can approve/i);
  });

  it("still refuses, and says so, when the private message throws", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { confirm } = cardButtons(
      ConfirmWrite({ action: "Gmail send email", approver: "slack:U1" }),
    );
    const { ctx, update, resume, post } = interaction("U2", {
      postEphemeral: async () => {
        throw new Error("ephemeral unavailable");
      },
    });

    await confirm(ctx);

    expect(update).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("has no platform it waves through, not even `unknown`", async () => {
    // `composio_tools.state.KNOWN_PLATFORMS` is closed, and `_named_identity`
    // refuses anything outside it, so `actor_key` cannot spell an approver
    // `unknown:`. A prefix this card matched on trust would be a platform check
    // that any producer could opt out of by naming a platform nobody serves.
    const { confirm } = cardButtons(
      ConfirmWrite({ action: "Gmail send email", approver: "unknown:U1" }),
    );
    const { ctx, update, resume, postEphemeral } = interaction("U1");

    await confirm(ctx);

    expect(update).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledTimes(1);
  });

  it("refuses an approver carrying no platform at all", async () => {
    // Not reachable from the agent — `actor_key` writes `platform:id` or
    // nothing — which is exactly why it is asserted here rather than assumed.
    // Read as a bare id, `U1` would match its own id and let this card be
    // answered by whoever shares it on any surface.
    const { confirm } = cardButtons(
      ConfirmWrite({ action: "Gmail send email", approver: "U1" }),
    );
    const { ctx, update, resume, postEphemeral } = interaction("U1");

    await confirm(ctx);

    expect(update).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledTimes(1);
  });

  it("refuses an approver whose id half is empty", async () => {
    const { confirm } = cardButtons(
      ConfirmWrite({ action: "Gmail send email", approver: "slack:" }),
    );
    const { ctx, update, resume, postEphemeral } = interaction("U1");

    await confirm(ctx);

    expect(update).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledTimes(1);
  });

  it("refuses a click nobody can be identified with", async () => {
    const { confirm } = cardButtons(
      ConfirmWrite({ action: "Gmail send email", approver: "slack:U1" }),
    );
    const { ctx, update, resume } = interaction("");

    await confirm(ctx);

    expect(update).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("does not match a person on another platform who shares an id", async () => {
    const { confirm } = cardButtons(
      ConfirmWrite({ action: "Gmail send email", approver: "teams:U1" }),
    );
    const { ctx, update, postEphemeral } = interaction("U1");

    await confirm(ctx);

    expect(update).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledTimes(1);
  });

  it("does not tell a colleague the card is waiting once it has been answered", async () => {
    // One card, one answer — and the approver already gave it. "The card is
    // still waiting for them" is then a statement about a card that is waiting
    // for nobody, sent to the one person it misleads. The check that costs a
    // message has to come after the check that says there is nothing to say.
    const { confirm, decline } = cardButtons(
      ConfirmWrite({ action: "Gmail send email", approver: "slack:U1" }),
    );
    const approver = interaction("U1");
    const colleague = interaction("U2");

    await confirm(approver.ctx);
    await decline(colleague.ctx);

    expect(approver.resume).toHaveBeenCalledTimes(1);
    expect(colleague.resume).not.toHaveBeenCalled();
    expect(colleague.postEphemeral).not.toHaveBeenCalled();
    expect(colleague.post).not.toHaveBeenCalled();
  });

  it("spells the platform the way the agent does, so casing cannot refuse the right person", async () => {
    // The approver string is built by `actor_key` in the agent, which lowercases
    // the platform. A surface reporting "Slack" would otherwise never match the
    // `slack:U1` the card names, and the one person entitled to answer could not.
    const { confirm } = cardButtons(
      ConfirmWrite({ action: "Gmail send email", approver: "slack:U1" }),
    );
    const { ctx, update, postEphemeral } = interaction("U1", {
      platform: "Slack",
    });

    await confirm(ctx);

    expect(update).toHaveBeenCalled();
    expect(postEphemeral).not.toHaveBeenCalled();
  });
});
