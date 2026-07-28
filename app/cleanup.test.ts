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

describe("launch dependency and cleanup contract", () => {
  it("keeps the exact Channels and Runtime canaries", () => {
    expect(packageJson.dependencies["@copilotkit/channels"]).toBe(
      "0.2.2-canary.rc-1",
    );
    expect(packageJson.dependencies["@copilotkit/runtime"]).toBe(
      "1.63.3-canary.rc-1",
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
