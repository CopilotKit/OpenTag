import { describe, expect, it, vi } from "vitest";

const daytonaProvider = { name: "daytona" };
vi.mock("../daytona-provider.js", () => ({
  createOpenTagDaytonaProvider: vi.fn(() => daytonaProvider),
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

const { GROK_CLI_INSTALL_COMMAND } = vi.hoisted(() => ({
  GROK_CLI_INSTALL_COMMAND: "FAKE_GROK_INSTALL",
}));
vi.mock("@tanstack/ai-grok-build", () => ({
  GROK_CLI_INSTALL_COMMAND,
}));

import {
  createPromoVideoSandbox,
  DEFAULT_PROMO_VIDEO_MODEL,
  PROMO_GROK_HEADLESS_ARGS,
  promoGrokBuildOptions,
  requirePromoVideoEnv,
} from "../promo-video-sandbox.js";

function setupTextOf(setup: unknown): string {
  if (typeof setup === "function") {
    const cmds: string[] = [];
    setup({ serial: (c: string) => cmds.push(c) });
    return cmds.join("\n");
  }
  if (Array.isArray(setup)) {
    return setup.join("\n");
  }
  return String(setup ?? "");
}

describe("requirePromoVideoEnv", () => {
  it("throws without XAI_API_KEY", () => {
    expect(() => requirePromoVideoEnv({ GITHUB_TOKEN: "ghp_x" })).toThrow(
      /XAI_API_KEY/,
    );
  });

  it("throws without GITHUB_TOKEN", () => {
    expect(() => requirePromoVideoEnv({ XAI_API_KEY: "xai-x" })).toThrow(
      /GITHUB_TOKEN/,
    );
  });

  it("accepts GH_TOKEN and defaults model to grok-4.5", () => {
    const got = requirePromoVideoEnv({
      XAI_API_KEY: " xai-x ",
      GH_TOKEN: " ghp_x ",
    });
    expect(got).toEqual({
      xaiApiKey: "xai-x",
      githubToken: "ghp_x",
      model: "grok-4.5",
    });
    expect(DEFAULT_PROMO_VIDEO_MODEL).toBe("grok-4.5");
  });

  it("honors VIDEO_SANDBOX_MODEL", () => {
    const got = requirePromoVideoEnv({
      XAI_API_KEY: "xai-x",
      GITHUB_TOKEN: "ghp_x",
      VIDEO_SANDBOX_MODEL: "grok-4.5-fast",
    });
    expect(got.model).toBe("grok-4.5-fast");
  });
});

describe("createPromoVideoSandbox", () => {
  const env = {
    XAI_API_KEY: "xai-x",
    GITHUB_TOKEN: "ghp_x",
    DAYTONA_API_KEY: "dt-x",
  };

  it("uses Daytona, XAI secret, grok install, and ffmpeg", () => {
    const def = createPromoVideoSandbox(
      { conversationKey: "t1", repoSlug: null },
      env,
    );

    expect(def.provider).toBe(daytonaProvider);
    expect(def.workspace?.secrets).toMatchObject({ XAI_API_KEY: "xai-x" });
    expect(def.workspace?.secrets).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(def.workspace?.instructions).toMatch(/Daytona sandbox/);
    expect(def.policy?.commands?.allow).toContain("grok *");
    expect(def.policy?.commands?.allow).not.toContain("claude *");

    const skills = def.workspace?.skills ?? [];
    expect(skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repo: "AlemTuzlak/skills" }),
        expect.objectContaining({ repo: "CopilotKit/internal-skills" }),
      ]),
    );
    for (const skill of skills) {
      expect(skill).not.toHaveProperty("into");
    }

    const setupText = setupTextOf(def.workspace?.setup);
    expect(setupText).toContain(GROK_CLI_INSTALL_COMMAND);
    expect(setupText).toMatch(/ffmpeg/);
    expect(setupText).not.toMatch(/\.claude\/skills/);
  });

  it("sets workspace.root to the real Daytona workdir so gitSkill clone/ln paths exist", () => {
    const def = createPromoVideoSandbox(
      { conversationKey: "t1", repoSlug: null },
      env,
    );
    expect(def.workspace?.root).toBe("/home/daytona/workspace");
  });

  it("links nested hyperframes-video and copilotkit-branding into .grok/skills", () => {
    const def = createPromoVideoSandbox(
      { conversationKey: "t1", repoSlug: null },
      env,
    );
    const setupText = setupTextOf(def.workspace?.setup);
    expect(setupText).toMatch(
      /ln -sfn \S+\/\.tanstack-skills\/skills\/skills\/hyperframes-video \S+\/\.grok\/skills\/hyperframes-video/,
    );
    expect(setupText).toMatch(
      /ln -sfn \S+\/\.tanstack-skills\/internal-skills\/skills\/copilotkit-branding \S+\/\.grok\/skills\/copilotkit-branding/,
    );
    expect(setupText).toMatch(
      /test -f \S+\/\.grok\/skills\/hyperframes-video\/SKILL\.md/,
    );
    expect(setupText).toMatch(
      /test -f \S+\/\.grok\/skills\/copilotkit-branding\/SKILL\.md/,
    );
  });

  it("uses passwordless sudo for apt-get (Daytona user is not root)", () => {
    const def = createPromoVideoSandbox(
      { conversationKey: "t1", repoSlug: null },
      env,
    );
    const setupText = setupTextOf(def.workspace?.setup);
    expect(setupText).toMatch(/sudo -n(?:\s+\S+)*\s+apt-get update/);
    expect(setupText).not.toMatch(/(^|\n)apt-get /);
    expect(def.policy?.commands?.deny ?? []).not.toContain("sudo *");
    expect(def.policy?.commands?.allow).toContain("sudo apt-get *");
  });

  it("leaves commands.deny empty so Grok gets --always-approve", () => {
    const def = createPromoVideoSandbox(
      { conversationKey: "t1", repoSlug: null },
      env,
    );
    expect(def.policy?.commands?.deny ?? []).toEqual([]);
    expect(def.policy?.default).toBe("allow");
  });
});

describe("promoGrokBuildOptions", () => {
  it("uses streaming-json plus headless --no-plan --no-auto-update", () => {
    expect(promoGrokBuildOptions()).toEqual({
      permissionMode: "bypassPermissions",
      protocol: "streaming-json",
      extraArgs: ["--no-plan", "--no-auto-update"],
    });
    expect(PROMO_GROK_HEADLESS_ARGS).toEqual([
      "--no-plan",
      "--no-auto-update",
    ]);
  });
});
