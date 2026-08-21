/**
 * The two decisions `scripts/composio-connect.ts` makes before it calls
 * anything. Nothing here touches the network — the script's own API calls are
 * deliberately not exercised, since a success path would mint a real Connect
 * Link against a real project.
 */
import { describe, expect, it } from "vitest";
import {
  resolveSharedToolkit,
  selectAuthConfig,
  type AuthConfigSummary,
} from "../connect-link.js";

const config = { workspaceToolkits: ["linear", "jira"], userToolkits: ["gmail"] };

function authConfig(id: string, slug: string, managed = false): AuthConfigSummary {
  return { id, toolkit: { slug }, isComposioManaged: managed };
}

describe("resolveSharedToolkit", () => {
  it("accepts a slug in COMPOSIO_TOOLKITS", () => {
    expect(resolveSharedToolkit(config, "linear")).toEqual({ ok: true, value: "linear" });
  });

  it("normalizes a shouted or padded slug", () => {
    expect(resolveSharedToolkit(config, "  LINEAR ")).toEqual({ ok: true, value: "linear" });
  });

  it("refuses a personal toolkit and points at the in-thread flow", () => {
    const result = resolveSharedToolkit(config, "gmail");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("personal toolkit");
    expect(result.message).toContain("Connect card");
  });

  it("refuses an unconfigured toolkit and lists the shared ones", () => {
    const result = resolveSharedToolkit(config, "salesforce");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("COMPOSIO_TOOLKITS");
    expect(result.message).toContain("linear, jira");
  });

  // Table-driven rather than a loop with an early return: `if (result.ok)
  // return` inside a loop exits the whole test as a pass, so a regression that
  // accepted only the *second* case would never fail it.
  it.each([["undefined", undefined], ["empty", ""], ["whitespace", "   "]])(
    "prints usage when the argument is %s",
    (_label, missing) => {
      const result = resolveSharedToolkit(config, missing);

      expect(result).toEqual({ ok: false, message: expect.stringContaining("Usage:") });
    },
  );

  it("says so plainly when no shared toolkit is configured at all", () => {
    const result = resolveSharedToolkit({ workspaceToolkits: [], userToolkits: [] }, undefined);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("(none configured)");
  });
});

describe("selectAuthConfig", () => {
  it("uses the pin without consulting the listing", () => {
    // Pinning is the override for a bad guess, so an empty listing is not an
    // error when a pin exists.
    expect(selectAuthConfig("linear", "ac_ExAmPle1-aB", [])).toEqual({
      ok: true,
      value: "ac_ExAmPle1-aB",
    });
  });

  it("ignores a whitespace-only pin", () => {
    const result = selectAuthConfig("linear", "   ", [authConfig("ac_one", "linear")]);

    expect(result).toEqual({ ok: true, value: "ac_one" });
  });

  it("takes the only auth config for the toolkit", () => {
    const result = selectAuthConfig("linear", undefined, [
      authConfig("ac_gmail", "gmail"),
      authConfig("ac_linear", "linear"),
    ]);

    expect(result).toEqual({ ok: true, value: "ac_linear" });
  });

  it("matches a slug the API returned in another case", () => {
    const result = selectAuthConfig("linear", undefined, [authConfig("ac_linear", "LINEAR")]);

    expect(result).toEqual({ ok: true, value: "ac_linear" });
  });

  it("tells the operator to add the toolkit when none exists", () => {
    const result = selectAuthConfig("linear", undefined, [authConfig("ac_gmail", "gmail")]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("No auth config exists");
    expect(result.message).toContain("app.composio.dev");
  });

  it("refuses to guess between several and asks for a pin", () => {
    const result = selectAuthConfig("linear", undefined, [
      authConfig("ac_one", "linear", true),
      authConfig("ac_two", "linear"),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("ac_one");
    expect(result.message).toContain("Composio-managed");
    expect(result.message).toContain("ac_two");
    expect(result.message).toContain("COMPOSIO_AUTH_CONFIGS=linear:<id>");
  });

  it("does not crash on an item with no toolkit", () => {
    const result = selectAuthConfig("linear", undefined, [{ id: "ac_orphan" }]);

    expect(result.ok).toBe(false);
  });
});
