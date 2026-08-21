import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPending,
  mayApprove,
  registerPending,
  restorePending,
  takePending,
} from "../pending.js";

function call(overrides: Partial<Parameters<typeof registerPending>[0]> = {}) {
  return {
    session: {} as never,
    slug: "GMAIL_DELETE_THREAD",
    args: { id: "t1" },
    effect: "destructive" as const,
    userId: "U_ALICE",
    workspaceUserId: "open-tag",
    action: "Gmail delete thread",
    ...overrides,
  };
}

beforeEach(() => clearPending());

describe("pending registry", () => {
  it("round-trips a call by token", () => {
    const token = registerPending(call());
    expect(takePending(token)?.slug).toBe("GMAIL_DELETE_THREAD");
  });

  it("issues distinct tokens", () => {
    expect(registerPending(call())).not.toBe(registerPending(call()));
  });

  it("consumes the token so a card cannot be replayed", () => {
    const token = registerPending(call());
    takePending(token);
    expect(takePending(token)).toBeUndefined();
  });

  it("returns undefined for an unknown token", () => {
    expect(takePending("nope")).toBeUndefined();
  });

  it("draws the token from the CSPRNG, not from Math.random", () => {
    // For a workspace-scope call, holding the token IS the authorization, so
    // the ~41 predictable bits of `Math.random()` are not enough to defend a
    // delete with. A v4 UUID is 122 bits from `crypto`.
    const token = registerPending(call());
    expect(token).toMatch(
      /^ctr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("keeps the arguments out of the token itself", () => {
    // The token is what travels in the Slack action value. Anything the caller
    // passed must stay in this process.
    const token = registerPending(call({ args: { body: "secret-payload" } }));
    expect(token).not.toContain("secret-payload");
  });
});

describe("bounded registry", () => {
  it("evicts the oldest call once the cap is passed", () => {
    // Each entry pins a live session and the call's arguments — mail bodies
    // included — and this map outlives every conversation.
    const first = registerPending(call({ slug: "FIRST" }));
    const tokens = [first];
    for (let i = 0; i < 64; i++) tokens.push(registerPending(call({ slug: `T_${i}` })));

    expect(takePending(first)).toBeUndefined();
    // Only the oldest went: everything after it is still approvable.
    for (const token of tokens.slice(1)) expect(takePending(token)).toBeDefined();
  });

  it("keeps exactly the cap's worth without evicting", () => {
    const first = registerPending(call({ slug: "FIRST" }));
    for (let i = 0; i < 63; i++) registerPending(call());
    expect(takePending(first)?.slug).toBe("FIRST");
  });

  it("never evicts the call it was just handed", () => {
    for (let i = 0; i < 64; i++) registerPending(call());
    const newest = registerPending(call({ slug: "NEWEST" }));
    expect(takePending(newest)?.slug).toBe("NEWEST");
  });
});

describe("restorePending", () => {
  it("puts a call back under the same token the live card carries", () => {
    const token = registerPending(call());
    const taken = takePending(token);
    expect(taken).toBeDefined();
    if (!taken) return;

    restorePending(token, taken);
    // A fresh token would strand the call: the posted card still carries the
    // original one, so the rightful approver's click would read "expired".
    expect(takePending(token)?.slug).toBe("GMAIL_DELETE_THREAD");
  });

  it("still consumes on the next read", () => {
    const token = registerPending(call());
    const taken = takePending(token);
    if (!taken) throw new Error("expected a call");
    restorePending(token, taken);
    takePending(token);
    expect(takePending(token)).toBeUndefined();
  });
});

describe("mayApprove", () => {
  it("lets anyone approve a workspace-scope call", () => {
    const c = call({ userId: "open-tag" });
    expect(mayApprove(c, "U_BOB")).toBe(true);
  });

  it("lets the originator approve their own personal-scope call", () => {
    expect(mayApprove(call({ userId: "U_ALICE" }), "U_ALICE")).toBe(true);
  });

  it("refuses someone else approving a personal-scope call", () => {
    expect(mayApprove(call({ userId: "U_ALICE" }), "U_BOB")).toBe(false);
  });

  it("refuses an unidentified clicker on a personal-scope call", () => {
    expect(mayApprove(call({ userId: "U_ALICE" }), undefined)).toBe(false);
  });

  it("refuses a blank clicker id on a personal-scope call", () => {
    // `""` is not an identity, and `"" === call.userId` must never be the test
    // that admits a click.
    expect(mayApprove(call({ userId: "U_ALICE" }), "")).toBe(false);
    expect(mayApprove(call({ userId: "" }), "")).toBe(false);
  });
});
