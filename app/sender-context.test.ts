import { describe, it, expect } from "vitest";
import { senderContext } from "./sender-context.js";

describe("senderContext", () => {
  it("returns [] when there is no user", () => {
    expect(senderContext(undefined, "slack")).toEqual([]);
  });

  it("labels a slack user with email", () => {
    const out = senderContext(
      { id: "U1", name: "Ada", email: "ada@x.io" },
      "slack",
    );
    expect(out).toEqual([
      {
        description: "Requesting slack user",
        value: "Ada <ada@x.io> (slack id U1)",
      },
    ]);
  });

  it("labels a Teams user without an email with the platform", () => {
    const out = senderContext({ id: "teams-user", name: "Bob" }, "teams");
    expect(out).toEqual([
      {
        description: "Requesting teams user",
        value: "Bob (teams id teams-user)",
      },
    ]);
  });

  it("falls back to the id when a Teams user has no name", () => {
    const out = senderContext({ id: "teams-user" }, "teams");
    expect(out).toEqual([
      {
        description: "Requesting teams user",
        value: "teams-user (teams id teams-user)",
      },
    ]);
  });
});
