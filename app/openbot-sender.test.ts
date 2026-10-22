import { describe, expect, it } from "vitest";
import type { ChannelIdentityContext } from "@copilotkit/channels";
import {
  OPENBOT_SENDER_CONTEXT,
  createTurnConversations,
  openbotSenderContext,
} from "./openbot-sender.js";

function identity(
  overrides: Partial<{
    provider: string;
    tenant: string;
    actor: { id: string; kind: string; name?: string; handle?: string };
    conversation: { id: string; kind?: string };
    event: string;
  }> = {},
): ChannelIdentityContext {
  return {
    provider: overrides.provider ?? "slack",
    tenant: { id: overrides.tenant ?? "T0123" },
    installation: { id: "inst" },
    actor: overrides.actor ?? { id: "U42", kind: "human", name: "Ada" },
    conversation: overrides.conversation ?? { id: "D0ABCDEFGH", kind: "im" },
    trigger: "message",
    event: { id: overrides.event ?? "Ev1" },
  } as unknown as ChannelIdentityContext;
}

describe("createTurnConversations", () => {
  it("names a person exactly as the Channel's platform strategy does", async () => {
    const turns = createTurnConversations();
    expect(await turns.identifyUser(identity())).toEqual({
      id: "slack:T0123:U42",
      name: "Ada",
    });
  });

  it("falls back to the handle, then the id, for the name", async () => {
    const turns = createTurnConversations();
    expect(
      await turns.identifyUser(
        identity({ actor: { id: "U1", kind: "human", handle: "ada" } }),
      ),
    ).toEqual({ id: "slack:T0123:U1", name: "ada" });
    expect(
      await turns.identifyUser(
        identity({ actor: { id: "U2", kind: "human" } }),
      ),
    ).toEqual({ id: "slack:T0123:U2", name: "U2" });
  });

  it("names nobody for anything that is not a person", async () => {
    const turns = createTurnConversations();
    expect(
      await turns.identifyUser(
        identity({ actor: { id: "B1", kind: "bot", name: "Some bot" } }),
      ),
    ).toBeNull();
  });

  it("hands back the conversation of the turn it was told about, once", async () => {
    const turns = createTurnConversations();
    await turns.identifyUser(
      identity({ event: "Ev7", conversation: { id: "C0XYZ", kind: "channel" } }),
    );
    expect(turns.take("Ev7")).toEqual({ id: "C0XYZ", kind: "channel" });
    expect(turns.take("Ev7")).toBeUndefined();
  });

  it("knows nothing about a turn without an event id", async () => {
    const turns = createTurnConversations();
    expect(turns.take(undefined)).toBeUndefined();
  });

  it("forgets the oldest turns past its limit, so unanswered turns cannot pile up", async () => {
    const turns = createTurnConversations(2);
    await turns.identifyUser(identity({ event: "a" }));
    await turns.identifyUser(identity({ event: "b" }));
    await turns.identifyUser(identity({ event: "c" }));
    expect(turns.take("a")).toBeUndefined();
    expect(turns.take("b")).toBeDefined();
    expect(turns.take("c")).toBeDefined();
  });
});

describe("openbotSenderContext", () => {
  const message = {
    user: { id: "slack:T0123:U42", name: "Ada" },
    eventId: "Ev1",
    operation: { mentioned: true },
  };

  it("is one structured entry under the name OpenBot reads", () => {
    const entries = openbotSenderContext(message, {
      id: "D0ABCDEFGH",
      kind: "im",
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.description).toBe(OPENBOT_SENDER_CONTEXT);
    expect(OPENBOT_SENDER_CONTEXT).toBe("openbot.sender");
    expect(JSON.parse(entries[0]!.value)).toEqual({
      user: "slack:T0123:U42",
      event: "Ev1",
      mentioned: true,
      conversation: { id: "D0ABCDEFGH", kind: "im" },
    });
  });

  it("leaves the conversation out rather than inventing one", () => {
    const [entry] = openbotSenderContext(
      { ...message, operation: { mentioned: false } },
      undefined,
    );
    expect(JSON.parse(entry!.value)).toEqual({
      user: "slack:T0123:U42",
      event: "Ev1",
      mentioned: false,
    });
  });

  it("vouches for nobody when the Channel could not name a person", () => {
    expect(
      openbotSenderContext({ ...message, user: null }, undefined),
    ).toEqual([]);
  });
});
