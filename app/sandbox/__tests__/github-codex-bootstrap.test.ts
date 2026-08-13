import { describe, expect, it } from "vitest";
import { buildGithubCodexSetupCommands } from "../github-codex-bootstrap.js";

describe("buildGithubCodexSetupCommands", () => {
  it("skips Codex install when codex is already on PATH", () => {
    const cmds = buildGithubCodexSetupCommands({ logTag: "docs-pr" });
    const joined = cmds.join("\n");
    expect(joined).toMatch(/command -v codex \|\|/);
    expect(joined).toContain("gh auth setup-git");
    expect(joined).toContain("git --version && gh --version");
    expect(joined).toContain("[docs-pr]");
  });

  it("uses passwordless sudo for apt and /etc /usr writes", () => {
    const cmds = buildGithubCodexSetupCommands({ logTag: "docs-pr" });
    const joined = cmds.join("\n");
    expect(joined).toMatch(/sudo -n(?:\s+\S+)*\s+apt-get update/);
    expect(joined).not.toMatch(/(^|\n)apt-get /);
    expect(joined).toMatch(/sudo -n dd of=\/usr\/share\/keyrings/);
    expect(joined).toMatch(/sudo -n chmod go\+r \/usr\/share\/keyrings/);
    expect(joined).toMatch(/sudo -n tee \/etc\/apt\/sources\.list\.d\/github-cli\.list/);
  });
});
