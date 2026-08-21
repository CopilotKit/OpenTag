import { describe, expect, it } from "vitest";
import { resolveScopes, startupWarnings } from "../scopes.js";
import type { ComposioConfig } from "../config.js";

function config(overrides: Partial<ComposioConfig> = {}): ComposioConfig {
  return {
    apiKey: "ak_x",
    workspaceToolkits: [],
    userToolkits: [],
    approvals: "destructive",
    workspaceUserId: "open-tag",
    authConfigs: {},
    ...overrides,
  };
}

describe("resolveScopes", () => {
  it("returns the workspace scope when only it is configured", () => {
    expect(resolveScopes(config({ workspaceToolkits: ["linear"] }), { id: "U1" })).toEqual([
      { userId: "open-tag", toolkits: ["linear"] },
    ]);
  });

  it("returns the personal scope when only it is configured", () => {
    expect(resolveScopes(config({ userToolkits: ["gmail"] }), { id: "U1" })).toEqual([
      { userId: "U1", toolkits: ["gmail"] },
    ]);
  });

  it("returns BOTH when both are configured", () => {
    const scopes = resolveScopes(
      config({ workspaceToolkits: ["linear"], userToolkits: ["gmail"] }),
      { id: "U1" },
    );
    expect(scopes).toEqual([
      { userId: "open-tag", toolkits: ["linear"] },
      { userId: "U1", toolkits: ["gmail"] },
    ]);
  });

  it("drops the personal scope without a verified actor", () => {
    expect(
      resolveScopes(config({ workspaceToolkits: ["linear"], userToolkits: ["gmail"] }), undefined),
    ).toEqual([{ userId: "open-tag", toolkits: ["linear"] }]);
  });

  it("returns nothing when personal-only and there is no actor", () => {
    expect(resolveScopes(config({ userToolkits: ["gmail"] }), undefined)).toEqual([]);
  });

  it("drops a toolkit from the workspace scope when it is also personal", () => {
    const scopes = resolveScopes(
      config({ workspaceToolkits: ["linear", "jira"], userToolkits: ["linear"] }),
      { id: "U1" },
    );
    expect(scopes).toEqual([
      { userId: "open-tag", toolkits: ["jira"] },
      { userId: "U1", toolkits: ["linear"] },
    ]);
  });

  it("does not fall back to the shared identity for a dual-listed toolkit", () => {
    expect(
      resolveScopes(
        config({ workspaceToolkits: ["gmail", "jira"], userToolkits: ["gmail"] }),
        undefined,
      ),
    ).toEqual([{ userId: "open-tag", toolkits: ["jira"] }]);
  });

  it("returns nothing when de-duplication empties the shared list and there is no actor", () => {
    expect(
      resolveScopes(config({ workspaceToolkits: ["gmail"], userToolkits: ["gmail"] }), undefined),
    ).toEqual([]);
  });

  it("drops the personal scope for an actor with an empty id", () => {
    expect(resolveScopes(config({ userToolkits: ["gmail"] }), { id: "" })).toEqual([]);
  });

  it("drops the personal scope for an actor with no id", () => {
    expect(resolveScopes(config({ userToolkits: ["gmail"] }), {})).toEqual([]);
  });

  it("drops the personal scope for an actor with a whitespace-only id", () => {
    expect(resolveScopes(config({ userToolkits: ["gmail"] }), { id: "   " })).toEqual([]);
  });

  it("never routes a personal toolkit to the shared identity for an idless actor", () => {
    expect(
      resolveScopes(config({ workspaceToolkits: ["gmail"], userToolkits: ["gmail"] }), { id: "" }),
    ).toEqual([]);
    expect(
      resolveScopes(config({ workspaceToolkits: ["gmail"], userToolkits: ["gmail"] }), {}),
    ).toEqual([]);
  });
});

describe("startupWarnings", () => {
  it("is silent on a clean config", () => {
    expect(startupWarnings(config({ workspaceToolkits: ["linear"] }), {})).toEqual([]);
  });

  it("warns when a toolkit is in both lists", () => {
    const warnings = startupWarnings(
      config({ workspaceToolkits: ["linear"], userToolkits: ["linear"] }),
      {},
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("linear");
    expect(warnings[0]).toContain("own account");
  });

  it("warns when a personal app sits in the shared list", () => {
    const warnings = startupWarnings(config({ workspaceToolkits: ["gmail"] }), {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("COMPOSIO_USER_TOOLKITS");
  });

  it("warns when a toolkit is also configured over MCP", () => {
    const warnings = startupWarnings(config({ workspaceToolkits: ["linear"] }), {
      LINEAR_API_KEY: "lin_x",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("LINEAR_API_KEY");
  });

  it("warns once for a toolkit listed twice in the shared list", () => {
    const warnings = startupWarnings(config({ workspaceToolkits: ["gmail", "gmail"] }), {});
    expect(warnings).toHaveLength(1);
  });

  it("is silent when only the MCP integration is configured", () => {
    expect(startupWarnings(config({ workspaceToolkits: ["jira"] }), { LINEAR_API_KEY: "x" })).toEqual(
      [],
    );
  });
});
