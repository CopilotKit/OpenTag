/**
 * Daytona sandbox for Linear ticket investigation + fix PRs.
 *
 * - Clone: CopilotKit/CopilotKit
 * - Skills: ponytail, CopilotKit/internal-skills (debugging-discipline),
 *   AlemTuzlak/skills (docs)
 * - git/gh auth via GITHUB_TOKEN (same bootstrap as docs-PR)
 */
import {
  createSecrets,
  defineSandbox,
  defineSandboxPolicy,
  defineWorkspace,
  gitSkill,
  githubRepo,
} from "@tanstack/ai-sandbox";
import {
  createOpenTagDaytonaProvider,
  DAYTONA_WORKSPACE_ROOT,
} from "./daytona-provider.js";
import {
  buildGithubCodexSetupCommands,
  COPILOTKIT_REPO,
  requireGithubCodexEnv,
} from "./github-codex-bootstrap.js";

export const LINEAR_FIX_SANDBOX_ID = "opentag-linear-fix";
export const LINEAR_FIX_PONYTAIL_REPO = "dietrichgebert/ponytail";
export const LINEAR_FIX_INTERNAL_SKILLS_REPO = "CopilotKit/internal-skills";
export const LINEAR_FIX_DOCS_SKILLS_REPO = "AlemTuzlak/skills";

/** Default Codex model for Linear fixes (GPT-5.6 Luna). Override with LINEAR_FIX_CODEX_MODEL. */
export const LINEAR_FIX_DEFAULT_MODEL = "gpt-5.6-luna";

/** Reasoning effort for Linear fixes. Override with LINEAR_FIX_REASONING. */
export const LINEAR_FIX_DEFAULT_REASONING = "xhigh";

export function resolveLinearFixModel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.LINEAR_FIX_CODEX_MODEL?.trim() || LINEAR_FIX_DEFAULT_MODEL;
}

export function resolveLinearFixReasoning(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.LINEAR_FIX_REASONING?.trim() || LINEAR_FIX_DEFAULT_REASONING;
}

export function requireLinearFixEnv(env: NodeJS.ProcessEnv = process.env) {
  const base = requireGithubCodexEnv(env);
  return {
    ...base,
    model: resolveLinearFixModel(env),
    reasoning: resolveLinearFixReasoning(env),
  };
}

export function createLinearFixSandbox(env: NodeJS.ProcessEnv = process.env) {
  const { githubToken, openaiApiKey, codexApiKey } = requireLinearFixEnv(env);

  const secrets = createSecrets({
    GITHUB_TOKEN: githubToken,
    GH_TOKEN: githubToken,
    OPENAI_API_KEY: openaiApiKey,
    CODEX_API_KEY: codexApiKey,
  });

  return defineSandbox({
    id: LINEAR_FIX_SANDBOX_ID,
    provider: createOpenTagDaytonaProvider(env),
    workspace: defineWorkspace({
      // Real Daytona path. gitSkill clone/ln run as shell strings and do
      // not remap virtual `/workspace`.
      root: DAYTONA_WORKSPACE_ROOT,
      source: githubRepo({
        repo: COPILOTKIT_REPO,
        ref: "main",
        depth: 1,
        auth: {
          username: "x-access-token",
          token: githubToken,
        },
      }),
      packageManager: "pnpm",
      setup: buildGithubCodexSetupCommands({ logTag: "linear-fix" }),
      secrets,
      skills: [
        // Public minimal-fix skill
        gitSkill({
          repo: LINEAR_FIX_PONYTAIL_REPO,
        }),
        // Private: systematic debugging skill pack
        gitSkill({
          repo: LINEAR_FIX_INTERNAL_SKILLS_REPO,
          secret: secrets.GITHUB_TOKEN,
        }),
        // Docs skill (and neighbors) from AlemTuzlak/skills
        gitSkill({
          repo: LINEAR_FIX_DOCS_SKILLS_REPO,
          secret: secrets.GITHUB_TOKEN,
        }),
      ],
      instructions: [
        "You are OpenTag's Linear fix agent inside a Daytona sandbox.",
        `Working tree: shallow clone of ${COPILOTKIT_REPO} (origin).`,
        "git and gh are authenticated with GITHUB_TOKEN / GH_TOKEN.",
        "Skills cloned under .tanstack-skills/:",
        "  - dietrichgebert/ponytail — prefer the simplest correct fix (ponytail discipline).",
        "  - CopilotKit/internal-skills — use skills/debugging-discipline for root-cause debugging.",
        "  - AlemTuzlak/skills — use the docs skill when the fix changes product behavior that needs docs.",
        "Find the real root cause with systematic debugging. Do not paper over symptoms.",
        "Fix the bug properly. Update docs when behavior changes.",
        "Push a branch to origin and open a PR with gh pr create.",
        "PR title MUST reference the Linear ticket id (e.g. [ENG-123] fix: …).",
        "PR body MUST include Root cause and How it was fixed sections.",
        "Do not run a full monorepo install unless required for a minimal check.",
      ].join("\n"),
    }),
    policy: defineSandboxPolicy({
      commands: {
        allow: [
          "git *",
          "gh *",
          "codex *",
          "npm *",
          "node *",
          "pnpm *",
          "yarn *",
          "bun *",
          "npx *",
          "vitest *",
          "tsc *",
          "ls *",
          "cat *",
          "find *",
          "rg *",
          "grep *",
          "echo *",
          "mkdir *",
          "cp *",
          "mv *",
          "which *",
          "head *",
          "tail *",
          "diff *",
          "sed *",
          "awk *",
          "python *",
          "python3 *",
          "sudo apt-get *",
        ],
        // Empty deny is load-bearing. Any commands.deny makes
        // @tanstack/ai-codex mapPolicyToCodexFlags set approval_policy
        // on-request. Headless `codex exec` then refuses tools.
      },
      capabilities: {
        fileWrite: "allow",
        network: "allow",
      },
      default: "allow",
    }),
    lifecycle: {
      reuse: "none",
      snapshot: "none",
      destroyOnComplete: true,
    },
    hooks: {
      onReady: () => {
        console.log(
          `[linear-fix] sandbox ready (${COPILOTKIT_REPO} + skills + git/gh)`,
        );
      },
      onError: (err) => {
        console.error(
          "[linear-fix] sandbox error",
          err instanceof Error ? err.message : err,
        );
      },
      onDestroy: () => {
        console.log("[linear-fix] sandbox destroyed");
      },
    },
  });
}
