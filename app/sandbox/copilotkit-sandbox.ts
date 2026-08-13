/**
 * Daytona sandbox for CopilotKit PR merge / conflict work.
 *
 * - Clone: caller-supplied { repo, ref } with full history
 * - Skills: ponytail, CopilotKit/internal-skills (debugging-discipline),
 *   AlemTuzlak/skills (docs)
 * - git/gh auth via GITHUB_TOKEN (same bootstrap as Linear-fix)
 * - Job prompt owns push. Merge: host pushes. PR fix: Codex pushes.
 * - Do not open a new PR.
 * - Host owns the box. destroyOnComplete is false so Codex cannot delete
 *   the sandbox before the job finishes.
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
  requireGithubCodexEnv,
} from "./github-codex-bootstrap.js";

export const COPILOTKIT_SANDBOX_ID = "opentag-copilotkit";
export const COPILOTKIT_PONYTAIL_REPO = "dietrichgebert/ponytail";
export const COPILOTKIT_INTERNAL_SKILLS_REPO = "CopilotKit/internal-skills";
export const COPILOTKIT_DOCS_SKILLS_REPO = "AlemTuzlak/skills";

export function createCopilotkitSandbox(input: {
  repo: string;
  ref: string;
  env?: NodeJS.ProcessEnv;
}) {
  const env = input.env ?? process.env;
  const { githubToken, openaiApiKey, codexApiKey } = requireGithubCodexEnv(env);

  const secrets = createSecrets({
    GITHUB_TOKEN: githubToken,
    GH_TOKEN: githubToken,
    OPENAI_API_KEY: openaiApiKey,
    CODEX_API_KEY: codexApiKey,
  });

  return defineSandbox({
    id: COPILOTKIT_SANDBOX_ID,
    provider: createOpenTagDaytonaProvider(env),
    workspace: defineWorkspace({
      // Real Daytona path. gitSkill clone/ln run as shell strings and do
      // not remap virtual `/workspace`.
      root: DAYTONA_WORKSPACE_ROOT,
      source: githubRepo({
        repo: input.repo,
        ref: input.ref,
        depth: "full",
        auth: {
          username: "x-access-token",
          token: githubToken,
        },
      }),
      packageManager: "pnpm",
      setup: buildGithubCodexSetupCommands({ logTag: "copilotkit" }),
      secrets,
      skills: [
        gitSkill({
          repo: COPILOTKIT_PONYTAIL_REPO,
        }),
        gitSkill({
          repo: COPILOTKIT_INTERNAL_SKILLS_REPO,
          secret: secrets.GITHUB_TOKEN,
        }),
        gitSkill({
          repo: COPILOTKIT_DOCS_SKILLS_REPO,
          secret: secrets.GITHUB_TOKEN,
        }),
      ],
      instructions: [
        "You are OpenTag's CopilotKit merge agent inside a Daytona sandbox.",
        `Working tree: full-history clone of ${input.repo} at ${input.ref} (origin).`,
        "git and gh are authenticated with GITHUB_TOKEN / GH_TOKEN.",
        "Skills cloned under .tanstack-skills/:",
        "  - dietrichgebert/ponytail — prefer the simplest correct fix (ponytail discipline).",
        "  - CopilotKit/internal-skills — use skills/debugging-discipline for root-cause debugging.",
        "  - AlemTuzlak/skills — use the docs skill when the merge changes product behavior that needs docs.",
        "Do merge and conflict work on this repo and this head.",
        "Do not open a new PR. Do not run gh pr create.",
        "Follow the current job prompt for git push. GITHUB_TOKEN is already set.",
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
      // Host owns teardown. Codex must not delete the box before push.
      destroyOnComplete: false,
    },
    hooks: {
      onReady: () => {
        console.log(
          `[copilotkit] sandbox ready (${input.repo}@${input.ref} + skills + git/gh)`,
        );
      },
      onError: (err) => {
        console.error(
          "[copilotkit] sandbox error",
          err instanceof Error ? err.message : err,
        );
      },
      onDestroy: () => {
        console.log("[copilotkit] sandbox destroyed");
      },
    },
  });
}
