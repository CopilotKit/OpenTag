import { describe, expect, it, vi } from "vitest";

vi.mock("../daytona-provider.js", () => ({
  createOpenTagDaytonaProvider: vi.fn(() => ({ name: "daytona" })),
  DAYTONA_WORKSPACE_ROOT: "/home/daytona/workspace",
}));

vi.mock("@tanstack/ai-sandbox", () => ({
  createSecrets: (s: unknown) => s,
  defineSandbox: (def: unknown) => def,
  defineSandboxPolicy: (p: unknown) => p,
  defineWorkspace: (w: unknown) => w,
  gitSkill: (o: unknown) => o,
  githubRepo: (o: unknown) => o,
}));

import { createOpenTagDaytonaProvider } from "../daytona-provider.js";
import { createDocsPrSandbox } from "../docs-pr-sandbox.js";
import { createLinearFixSandbox } from "../linear-fix-sandbox.js";
import { createCopilotkitSandbox } from "../copilotkit-sandbox.js";

const env = {
  GITHUB_TOKEN: "ghp_x",
  OPENAI_API_KEY: "sk-x",
  DAYTONA_API_KEY: "dt-x",
};

describe("codex sandboxes use Daytona", () => {
  it("docs-pr uses the shared Daytona provider and Daytona copy", () => {
    const def = createDocsPrSandbox(env);
    expect(createOpenTagDaytonaProvider).toHaveBeenCalled();
    expect(def.provider).toEqual({ name: "daytona" });
    expect(def.workspace?.instructions).toMatch(/Daytona sandbox/);
    expect(def.workspace?.instructions).not.toMatch(/Docker sandbox/);
  });

  it("linear-fix uses the shared Daytona provider and Daytona copy", () => {
    const def = createLinearFixSandbox(env);
    expect(def.provider).toEqual({ name: "daytona" });
    expect(def.workspace?.instructions).toMatch(/Daytona sandbox/);
    expect(def.workspace?.instructions).not.toMatch(/Docker sandbox/);
  });

  it("does not deny sudo (Daytona user needs passwordless sudo for apt)", () => {
    expect(createDocsPrSandbox(env).policy?.commands?.deny ?? []).not.toContain(
      "sudo *",
    );
    expect(
      createLinearFixSandbox(env).policy?.commands?.deny ?? [],
    ).not.toContain("sudo *");
  });

  it("leaves commands.deny empty so Codex stays approval_policy never", () => {
    expect(createDocsPrSandbox(env).policy?.commands?.deny ?? []).toEqual([]);
    expect(createLinearFixSandbox(env).policy?.commands?.deny ?? []).toEqual(
      [],
    );
    expect(createDocsPrSandbox(env).policy?.default).toBe("allow");
    expect(createLinearFixSandbox(env).policy?.default).toBe("allow");
  });

  it("sets workspace.root to the real Daytona workdir so gitSkill clone/ln paths exist", () => {
    expect(createDocsPrSandbox(env).workspace?.root).toBe(
      "/home/daytona/workspace",
    );
    expect(createLinearFixSandbox(env).workspace?.root).toBe(
      "/home/daytona/workspace",
    );
  });

  it("copilotkit factory uses Daytona, real root, and empty deny", () => {
    const def = createCopilotkitSandbox({
      repo: "CopilotKit/CopilotKit",
      ref: "feat/x",
      env,
    });
    expect(def.provider).toEqual({ name: "daytona" });
    expect(def.workspace?.root).toBe("/home/daytona/workspace");
    expect(def.policy?.commands?.deny ?? []).toEqual([]);
    expect(def.policy?.commands?.deny ?? []).not.toContain("sudo *");
  });
});
