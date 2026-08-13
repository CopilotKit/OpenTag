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
import { createCopilotkitSandbox } from "../copilotkit-sandbox.js";

const env = {
  GITHUB_TOKEN: "ghp_x",
  OPENAI_API_KEY: "sk-x",
  DAYTONA_API_KEY: "dt-x",
};

describe("createCopilotkitSandbox", () => {
  it("clones the parsed repo at the PR head with full history", () => {
    const def = createCopilotkitSandbox({
      repo: "CopilotKit/ai",
      ref: "fix/login",
      env,
    });
    expect(createOpenTagDaytonaProvider).toHaveBeenCalled();
    expect(def.provider).toEqual({ name: "daytona" });
    expect(def.workspace?.source).toEqual(
      expect.objectContaining({
        repo: "CopilotKit/ai",
        ref: "fix/login",
        depth: "full",
      }),
    );
    expect(def.workspace?.root).toBe("/home/daytona/workspace");
    expect(def.workspace?.instructions).toMatch(/Daytona sandbox/);
    expect(def.workspace?.instructions).not.toMatch(/Docker sandbox/);
    expect(def.policy?.commands?.deny ?? []).toEqual([]);
    expect(def.policy?.default).toBe("allow");
  });

  it("does not put workdir on the Daytona provider call", () => {
    createCopilotkitSandbox({
      repo: "CopilotKit/CopilotKit",
      ref: "feat/x",
      env,
    });
    const arg = vi.mocked(createOpenTagDaytonaProvider).mock.calls.at(-1)?.[0];
    expect(arg && typeof arg === "object" ? (arg as { workdir?: string }).workdir : undefined).toBeUndefined();
  });

  it("lets the host own the box: no Codex destroy, job prompt owns push", () => {
    const def = createCopilotkitSandbox({
      repo: "CopilotKit/CopilotKit",
      ref: "feat/foo",
      env,
    });
    expect(def.lifecycle?.destroyOnComplete).toBe(false);
    expect(def.workspace?.instructions).toMatch(/Follow the current job prompt for git push/i);
    expect(def.workspace?.instructions).toMatch(/Do not run gh pr create/i);
    expect(def.workspace?.instructions).not.toMatch(/Do not push/i);
    expect(def.workspace?.instructions).not.toMatch(/host pushes/i);
  });
});
