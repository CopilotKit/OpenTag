/**
 * `run_my_tool` is the gate between the model and irreversible action, so the
 * tests split in two.
 *
 * The first half drives `tool.handler` and asserts what reaches Composio and
 * what only reaches a card. The second half drives `handleToolRunDecision` —
 * the Approve/Cancel click — directly. That handler carries the whole
 * authorization story (expired token, wrong approver, provider failure), which
 * is why it is an exported function rather than a closure inside the JSX.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToIR, type ChannelNode, type InteractionContext } from "@copilotkit/channels";
import { createRunTool, handleToolRunDecision } from "../run-tool.js";
import { clearPending, registerPending, type PendingCall } from "../pending.js";
import type { CachedSession, RawSession } from "../sessions.js";
import type { ConfirmDecision } from "../../../human-in-the-loop/index.js";

/** Exactly what the SDK hands back — note that a failure resolves, never throws. */
type ExecuteResult = Awaited<ReturnType<RawSession["execute"]>>;

/** What `session.execute` resolves to on a successful run. */
function okResult(): ExecuteResult {
  return { data: { ok: true }, error: null, logId: "log_1" };
}

function cached(
  execute: RawSession["execute"] = vi.fn(async () => okResult()),
  userId = "open-tag",
) {
  return {
    session: { sessionId: "trs_1", execute },
    userId,
    effects: new Map([
      ["GMAIL_SEND_EMAIL", "write"],
      ["GMAIL_DELETE_THREAD", "destructive"],
      ["GMAIL_FETCH_EMAILS", "read"],
    ]),
    toolkits: ["gmail"],
    filledAt: Date.now(),
  } as unknown as CachedSession;
}

function makeCtx() {
  const post = vi.fn();
  return { ctx: { actor: { id: "U1" }, thread: { post } } as never, post };
}

/** Children of an IR node as an array (empty if none). */
function childNodes(node: ChannelNode): ChannelNode[] {
  const children = node.props?.children;
  if (Array.isArray(children)) return children as ChannelNode[];
  if (children && typeof children === "object" && "type" in (children as object)) {
    return [children as ChannelNode];
  }
  return [];
}

function findAll(nodes: ChannelNode[], type: string): ChannelNode[] {
  const out: ChannelNode[] = [];
  for (const node of nodes) {
    if (node.type === type) out.push(node);
    out.push(...findAll(childNodes(node), type));
  }
  return out;
}

/** Every descendant `text` node's text, concatenated depth-first. */
function collectText(node: ChannelNode): string {
  if (node.type === "text") return String(node.props?.value ?? "");
  return childNodes(node).map(collectText).join("");
}

/** The approval token a posted card carries in its buttons. */
function tokenOf(renderable: unknown): string {
  const button = findAll(renderToIR(renderable as never), "button")[0];
  const value = button?.props?.value as ConfirmDecision | undefined;
  if (!value?.token) throw new Error("posted card carries no token");
  return value.token;
}

function textOf(renderable: unknown): string {
  return renderToIR(renderable as never)
    .map(collectText)
    .join(" ");
}

beforeEach(() => clearPending());

describe("run_my_tool", () => {
  it("runs a read immediately without posting a card", async () => {
    const entry = cached();
    const { ctx, post } = makeCtx();
    const tool = createRunTool(async () => [entry], "destructive", "open-tag");
    await tool.handler({ slug: "GMAIL_FETCH_EMAILS", args: {} }, ctx);
    expect(post).not.toHaveBeenCalled();
    expect(entry.session.execute).toHaveBeenCalledWith("GMAIL_FETCH_EMAILS", {});
  });

  it("runs a write immediately in destructive mode", async () => {
    const entry = cached();
    const { ctx, post } = makeCtx();
    const tool = createRunTool(async () => [entry], "destructive", "open-tag");
    await tool.handler({ slug: "GMAIL_SEND_EMAIL", args: { to: "a@b.c" } }, ctx);
    expect(post).not.toHaveBeenCalled();
    expect(entry.session.execute).toHaveBeenCalled();
  });

  it("posts a card and does NOT execute a destructive tool", async () => {
    const entry = cached();
    const { ctx, post } = makeCtx();
    const tool = createRunTool(async () => [entry], "destructive", "open-tag");
    const result = await tool.handler({ slug: "GMAIL_DELETE_THREAD", args: { id: "t1" } }, ctx);
    expect(post).toHaveBeenCalledTimes(1);
    expect(entry.session.execute).not.toHaveBeenCalled();
    expect(String(result)).toContain("Stop here");
  });

  it("posts a card for any write in writes mode", async () => {
    const entry = cached();
    const { ctx, post } = makeCtx();
    const tool = createRunTool(async () => [entry], "writes", "open-tag");
    await tool.handler({ slug: "GMAIL_SEND_EMAIL", args: {} }, ctx);
    expect(post).toHaveBeenCalledTimes(1);
    expect(entry.session.execute).not.toHaveBeenCalled();
  });

  it("never posts a card in off mode", async () => {
    const entry = cached();
    const { ctx, post } = makeCtx();
    const tool = createRunTool(async () => [entry], "off", "open-tag");
    await tool.handler({ slug: "GMAIL_DELETE_THREAD", args: {} }, ctx);
    expect(post).not.toHaveBeenCalled();
    expect(entry.session.execute).toHaveBeenCalled();
  });

  it("gates an unmapped slug in writes mode", async () => {
    const entry = cached();
    const { ctx, post } = makeCtx();
    const tool = createRunTool(async () => [entry], "writes", "open-tag");
    await tool.handler({ slug: "MYSTERY_TOOL", args: {} }, ctx);
    expect(post).toHaveBeenCalledTimes(1);
    expect(entry.session.execute).not.toHaveBeenCalled();
  });

  it("gates an unmapped slug in destructive mode, the default", async () => {
    // The effect map is filled with `limit: 300`, so a real slug past the cap
    // is unmapped, as is anything hallucinated or injected. Calling those
    // "writes" would run them unapproved in the mode that ships by default.
    const entry = cached();
    const { ctx, post } = makeCtx();
    const tool = createRunTool(async () => [entry], "destructive", "open-tag");
    await tool.handler({ slug: "MYSTERY_TOOL", args: { id: "x" } }, ctx);
    expect(entry.session.execute).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("still runs a classified write unapproved in destructive mode", async () => {
    // The other half of the rule: gating the unmapped case must not quietly
    // gate every write and turn `destructive` mode into `writes` mode.
    const entry = cached();
    const { ctx, post } = makeCtx();
    const tool = createRunTool(async () => [entry], "destructive", "open-tag");
    await tool.handler({ slug: "GMAIL_SEND_EMAIL", args: {} }, ctx);
    expect(entry.session.execute).toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("runs an unmapped slug in off mode", async () => {
    const entry = cached();
    const { ctx, post } = makeCtx();
    const tool = createRunTool(async () => [entry], "off", "open-tag");
    await tool.handler({ slug: "MYSTERY_TOOL", args: {} }, ctx);
    expect(post).not.toHaveBeenCalled();
    expect(entry.session.execute).toHaveBeenCalled();
  });

  it("routes to the scope holding the slug", async () => {
    const other = cached();
    other.effects = new Map([["LINEAR_LIST_ISSUES", "read"]]) as never;
    const gmail = cached();
    const { ctx } = makeCtx();
    const tool = createRunTool(async () => [other, gmail], "destructive", "open-tag");
    await tool.handler({ slug: "GMAIL_FETCH_EMAILS", args: {} }, ctx);
    expect(gmail.session.execute).toHaveBeenCalled();
    expect(other.session.execute).not.toHaveBeenCalled();
  });

  it("surfaces a returned error rather than treating it as success", async () => {
    const entry = cached(
      vi.fn(async () => ({ data: {}, error: "recipient_email must be a string", logId: "log_9" })),
    );
    const { ctx } = makeCtx();
    const tool = createRunTool(async () => [entry], "off", "open-tag");
    const result = await tool.handler({ slug: "GMAIL_SEND_EMAIL", args: {} }, ctx);
    expect(String(result)).toContain("recipient_email must be a string");
  });

  it("returns an error string when nothing resolves", async () => {
    const { ctx } = makeCtx();
    const tool = createRunTool(async () => [], "off", "open-tag");
    expect(String(await tool.handler({ slug: "X", args: {} }, ctx))).toContain("not configured");
  });

  it("puts only the token in the button payload, never the arguments", async () => {
    const entry = cached();
    const { ctx, post } = makeCtx();
    const tool = createRunTool(async () => [entry], "destructive", "open-tag");
    await tool.handler(
      { slug: "GMAIL_DELETE_THREAD", args: { id: "t1", body: "secret-payload" } },
      ctx,
    );

    const buttons = findAll(renderToIR(post.mock.calls[0]?.[0] as never), "button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      const value = button.props?.value as ConfirmDecision;
      // Slack action values are size-capped and must not carry user data.
      expect(Object.keys(value).sort()).toEqual(["approved", "token"]);
      expect(JSON.stringify(value)).not.toContain("secret-payload");
    }
  });
});

/** A pending call plus the `execute` spy behind its session. */
function pending(overrides: Partial<PendingCall> = {}, result: ExecuteResult = okResult()) {
  const execute = vi.fn(async () => result);
  const call: PendingCall = {
    session: { sessionId: "trs_1", execute } as unknown as RawSession,
    slug: "GMAIL_DELETE_THREAD",
    args: { id: "t1" },
    effect: "destructive",
    userId: "U_ALICE",
    workspaceUserId: "open-tag",
    action: "Gmail delete thread",
    ...overrides,
  };
  return { call, token: registerPending(call), execute };
}

function click(value: ConfirmDecision | undefined, clickerId: string | undefined) {
  const update = vi.fn();
  const post = vi.fn();
  const interaction = {
    thread: { update, post },
    message: { ref: { id: "m1" } },
    action: { id: "act_1", value },
    values: {},
    user: null,
    actor: clickerId === undefined ? undefined : { id: clickerId, kind: "human" },
    platform: "slack",
  } as unknown as InteractionContext<ConfirmDecision>;
  return { interaction, update, post };
}

describe("handleToolRunDecision", () => {
  it("reports an unknown token as expired and executes nothing", async () => {
    const { execute } = pending();
    const { interaction, update } = click({ token: "ctr_gone", approved: true }, "U_ALICE");

    await handleToolRunDecision(interaction, "Gmail delete thread");

    expect(execute).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(textOf(update.mock.calls[0]?.[1])).toContain("expired");
  });

  it("treats a token consumed by an earlier click as expired", async () => {
    const { token, execute } = pending();
    await handleToolRunDecision(click({ token, approved: true }, "U_ALICE").interaction, "x");
    expect(execute).toHaveBeenCalledTimes(1);

    const replay = click({ token, approved: true }, "U_ALICE");
    await handleToolRunDecision(replay.interaction, "Gmail delete thread");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(textOf(replay.update.mock.calls[0]?.[1])).toContain("expired");
  });

  it("ignores a click carrying no decision", async () => {
    const { execute } = pending();
    const { interaction, update, post } = click(undefined, "U_ALICE");

    await handleToolRunDecision(interaction, "Gmail delete thread");

    expect(execute).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses someone else's approval and leaves the request standing", async () => {
    const { token, execute } = pending({ userId: "U_ALICE" });
    const bob = click({ token, approved: true }, "U_BOB");

    await handleToolRunDecision(bob.interaction, "Gmail delete thread");

    expect(execute).not.toHaveBeenCalled();
    // The card keeps its buttons — refusing Bob must not cancel Alice's request.
    expect(bob.update).not.toHaveBeenCalled();
    expect(String(bob.post.mock.calls[0]?.[0])).toContain("Only the person who asked");

    // And the same card, clicked by Alice, still works.
    const alice = click({ token, approved: true }, "U_ALICE");
    await handleToolRunDecision(alice.interaction, "Gmail delete thread");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses an unidentified clicker on a personal-scope call", async () => {
    const { token, execute } = pending({ userId: "U_ALICE" });
    const { interaction, post } = click({ token, approved: true }, undefined);

    await handleToolRunDecision(interaction, "Gmail delete thread");

    expect(execute).not.toHaveBeenCalled();
    expect(String(post.mock.calls[0]?.[0])).toContain("Only the person who asked");
  });

  it("lets anyone approve a workspace-scope call", async () => {
    const { token, execute } = pending({ userId: "open-tag" });
    const { interaction } = click({ token, approved: true }, "U_BOB");

    await handleToolRunDecision(interaction, "Gmail delete thread");

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("executes nothing on a decline and says so on the card", async () => {
    const { token, execute } = pending();
    const { interaction, update } = click({ token, approved: false }, "U_ALICE");

    await handleToolRunDecision(interaction, "Gmail delete thread");

    expect(execute).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(textOf(update.mock.calls[0]?.[1])).toContain("Cancelled");
  });

  it("runs the approved call with the arguments held in process", async () => {
    const { token, execute } = pending({ args: { id: "t1", body: "secret-payload" } });
    const { interaction, update } = click({ token, approved: true }, "U_ALICE");

    await handleToolRunDecision(interaction, "Gmail delete thread");

    expect(execute).toHaveBeenCalledWith("GMAIL_DELETE_THREAD", {
      id: "t1",
      body: "secret-payload",
    });
    expect(textOf(update.mock.calls[0]?.[1])).toContain("Done");
  });

  it("puts a returned error on the card instead of reporting success", async () => {
    // `execute` resolves rather than throws on failure, so a try/catch alone
    // would rewrite the card to "Done." after deleting nothing.
    const { token } = pending({}, { data: {}, error: "Invalid request data provided", logId: "l" });
    const { interaction, update } = click({ token, approved: true }, "U_ALICE");

    await handleToolRunDecision(interaction, "Gmail delete thread");

    const text = textOf(update.mock.calls[0]?.[1]);
    expect(text).toContain("Invalid request data provided");
    expect(text).not.toContain("Done.");
  });

  it("reports a transport-level throw on the card instead of freezing it", async () => {
    // The token is consumed before `execute` runs, so a throw that escaped
    // would leave a card with dead buttons and no result at all.
    const { call } = pending();
    const execute = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    call.session = { sessionId: "trs_1", execute } as unknown as RawSession;
    const token = registerPending(call);
    const { interaction, update } = click({ token, approved: true }, "U_ALICE");

    await handleToolRunDecision(interaction, "Gmail delete thread");

    expect(update).toHaveBeenCalledTimes(1);
    const text = textOf(update.mock.calls[0]?.[1]);
    expect(text).toContain("socket hang up");
    expect(text).not.toContain("Done.");
  });

  it("gives an empty token the same answer as an expired one", async () => {
    const { execute } = pending();
    const { interaction, update } = click({ token: "", approved: true }, "U_ALICE");

    await handleToolRunDecision(interaction, "Gmail delete thread");

    expect(execute).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(textOf(update.mock.calls[0]?.[1])).toContain("expired");
  });

  it("reports an evicted card as expired rather than crashing", async () => {
    const { token, execute } = pending();
    for (let i = 0; i < 64; i++) pending({ slug: `FILLER_${i}` });

    const { interaction, update } = click({ token, approved: true }, "U_ALICE");
    await handleToolRunDecision(interaction, "Gmail delete thread");

    expect(execute).not.toHaveBeenCalled();
    expect(textOf(update.mock.calls[0]?.[1])).toContain("expired");
  });

  it("names the pending call's own action, not the label passed by the caller", async () => {
    const { token } = pending({ action: "Gmail delete thread" });
    const { interaction, update } = click({ token, approved: false }, "U_ALICE");

    await handleToolRunDecision(interaction, "Some other card");

    expect(textOf(update.mock.calls[0]?.[1])).toContain("Gmail delete thread");
  });
});

describe("scope identity decides who may approve", () => {
  /** Gate one destructive call and hand back the token its card carries. */
  async function gate(scope: CachedSession, actorId: string) {
    const post = vi.fn();
    const tool = createRunTool(async () => [scope], "destructive", "open-tag");
    await tool.handler({ slug: "GMAIL_DELETE_THREAD", args: { id: "t1" } }, {
      actor: { id: actorId },
      thread: { post },
    } as never);
    return tokenOf(post.mock.calls[0]?.[0]);
  }

  it("binds a card routed to a personal scope to that scope's owner", async () => {
    const entry = cached(undefined, "U_ALICE");
    const token = await gate(entry, "U_ALICE");

    await handleToolRunDecision(click({ token, approved: true }, "U_BOB").interaction, "x");
    expect(entry.session.execute).not.toHaveBeenCalled();

    await handleToolRunDecision(click({ token, approved: true }, "U_ALICE").interaction, "x");
    expect(entry.session.execute).toHaveBeenCalledTimes(1);
  });

  it("lets a colleague approve a workspace-scope card a named person asked for", async () => {
    // Alice sent the message, but the slug routed to the shared account. The
    // call is the thread's, not hers, so Bob approving it touches nothing of
    // his own — binding it to the actor would strand it behind one person.
    const entry = cached(undefined, "open-tag");
    const token = await gate(entry, "U_ALICE");

    await handleToolRunDecision(click({ token, approved: true }, "U_BOB").interaction, "x");
    expect(entry.session.execute).toHaveBeenCalledTimes(1);
  });

  it("routes an unmapped personal slug by toolkit, not to the first scope", async () => {
    // The effect map is filled with `limit: 300`, so a real slug can be absent
    // from it. Falling back to `scopes[0]` would run Alice's gmail call through
    // the shared session — which does not carry gmail — and bind its card to
    // `workspaceUserId`, letting anyone in the thread approve it.
    const workspace = cached(undefined, "open-tag");
    workspace.effects = new Map() as never;
    workspace.toolkits = ["linear"] as never;
    const personal = cached(undefined, "U_ALICE");
    personal.effects = new Map() as never;

    const post = vi.fn();
    const tool = createRunTool(async () => [workspace, personal], "destructive", "open-tag");
    await tool.handler({ slug: "GMAIL_DELETE_THREAD", args: { id: "t1" } }, {
      actor: { id: "U_ALICE" },
      thread: { post },
    } as never);

    const token = tokenOf(post.mock.calls[0]?.[0]);
    // Bound to Alice: Bob's click does nothing, hers executes — and against the
    // personal session, never the shared one.
    await handleToolRunDecision(click({ token, approved: true }, "U_BOB").interaction, "x");
    expect(personal.session.execute).not.toHaveBeenCalled();

    await handleToolRunDecision(click({ token, approved: true }, "U_ALICE").interaction, "x");
    expect(personal.session.execute).toHaveBeenCalledTimes(1);
    expect(workspace.session.execute).not.toHaveBeenCalled();
  });

  it("picks the identity of the scope the slug routed to, not the first scope", async () => {
    const workspace = cached(undefined, "open-tag");
    workspace.effects = new Map([["LINEAR_LIST_ISSUES", "read"]]) as never;
    const personal = cached(undefined, "U_ALICE");
    const post = vi.fn();
    const tool = createRunTool(async () => [workspace, personal], "destructive", "open-tag");
    await tool.handler({ slug: "GMAIL_DELETE_THREAD", args: { id: "t1" } }, {
      actor: { id: "U_ALICE" },
      thread: { post },
    } as never);

    const token = tokenOf(post.mock.calls[0]?.[0]);
    await handleToolRunDecision(click({ token, approved: true }, "U_BOB").interaction, "x");
    expect(personal.session.execute).not.toHaveBeenCalled();
  });
});
