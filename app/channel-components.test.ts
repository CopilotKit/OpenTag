/**
 * What the Channel is actually told to register.
 *
 * A click that arrives after the in-process cache is gone is served by
 * re-rendering the named component from `createChannel({ components })`. A card
 * missing from that list resolves to nothing, `dispatch` raises
 * `ActionExpiredError`, and the Channel swallows it (`create-channel.js`) — so
 * the person clicks and nothing happens, with no error anywhere to explain it.
 *
 * The assertion is on the argument `createChannel` receives, not on any
 * constant this file could read: the wiring is the thing that has to be right,
 * and a future edit that passes a different array must fail here.
 */
import { describe, expect, it, vi } from "vitest";

type ChannelsModule = typeof import("@copilotkit/channels");
type CreateChannelOptions = Parameters<ChannelsModule["createChannel"]>[0];

const optionsSeen: CreateChannelOptions[] = [];

vi.mock("@copilotkit/channels", async (importOriginal) => {
  const actual = await importOriginal<ChannelsModule>();
  return {
    ...actual,
    createChannel: (options: CreateChannelOptions) => {
      optionsSeen.push(options);
      return actual.createChannel(options);
    },
  };
});

const { FakeAgent } = await import("@copilotkit/channels");
const { createOpenTagChannel } = await import("./channel.js");

/** The `components` array of the most recent `createChannel` call, by name. */
function registeredComponentNames(): string[] {
  const components = optionsSeen.at(-1)?.components;
  if (!Array.isArray(components)) {
    throw new Error("createChannel was not given a components array");
  }
  return components.map((component) =>
    typeof component === "function" ? component.name : String(component),
  );
}

describe("createOpenTagChannel component registration", () => {
  it("registers every card whose buttons outlive the turn that posted them", () => {
    createOpenTagChannel("opentag", new FakeAgent());

    // `ConfirmToolRun`'s entire premise is that the agent's turn already ended,
    // and a `ConnectAccount` click works perfectly cold — it mints a fresh link
    // and needs nothing from the process that posted the card. Dropping either
    // is a restart-only breakage that no other test would notice.
    expect(registeredComponentNames()).toEqual(
      expect.arrayContaining([
        "ConfirmWrite",
        "ConfirmToolRun",
        "ConnectAccount",
      ]),
    );
  });
});
