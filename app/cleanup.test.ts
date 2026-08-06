import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
};

// A bare semver with no range operator, so deploys resolve reproducibly.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

describe("launch dependency and cleanup contract", () => {
  // Asserts the pin *shape*, not a literal version: the docs and this test both
  // used to restate "0.7.0", and both drifted the moment the deps were bumped.
  it("pins the Channels and Runtime versions exactly", () => {
    expect(packageJson.dependencies["@copilotkit/channels"]).toMatch(
      EXACT_VERSION,
    );
    expect(packageJson.dependencies["@copilotkit/runtime"]).toMatch(
      EXACT_VERSION,
    );
  });

  it("has no local Notion sidecar or token-grabbing browser automation", () => {
    expect(packageJson.scripts).not.toHaveProperty("notion-mcp");
    expect(packageJson.dependencies).not.toHaveProperty(
      "@notionhq/notion-mcp-server",
    );
    expect(existsSync(resolve(root, "scripts/start-notion-mcp.ts"))).toBe(
      false,
    );
    expect(existsSync(resolve(root, "e2e/grab-user-token.ts"))).toBe(false);
    expect(existsSync(resolve(root, "e2e/TELEGRAM-README.md"))).toBe(false);
  });
});
