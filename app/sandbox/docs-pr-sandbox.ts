/**
 * TanStack AI Daytona sandbox for docs-feedback PRs on CopilotKit/CopilotKit.
 *
 * - Working tree: shallow clone of CopilotKit/CopilotKit (origin)
 * - Skills: AlemTuzlak/skills
 * - git + gh authenticated with GITHUB_TOKEN for any repo the token can write
 * - No monorepo install (docs-only under showcase/)
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

export const DOCS_PR_REPO = COPILOTKIT_REPO;
export const DOCS_PR_SKILLS_REPO = "AlemTuzlak/skills";
export const DOCS_PR_SANDBOX_ID = "opentag-docs-pr";

export function requireDocsPrEnv(
  env: NodeJS.ProcessEnv = process.env,
): {
  githubToken: string;
  openaiApiKey: string;
  codexApiKey: string;
  model: string;
} {
  const base = requireGithubCodexEnv(env);
  const model = env.OPENAI_MODEL?.trim() || "gpt-5.5";
  return { ...base, model };
}

/** Build a fresh sandbox definition for one docs-PR job. */
export function createDocsPrSandbox(env: NodeJS.ProcessEnv = process.env) {
  const { githubToken, openaiApiKey, codexApiKey } = requireDocsPrEnv(env);

  // Inject both names: git helpers and many tools read GITHUB_TOKEN;
  // the GitHub CLI prefers GH_TOKEN when both are set.
  const secrets = createSecrets({
    GITHUB_TOKEN: githubToken,
    GH_TOKEN: githubToken,
    OPENAI_API_KEY: openaiApiKey,
    CODEX_API_KEY: codexApiKey,
  });

  return defineSandbox({
    id: DOCS_PR_SANDBOX_ID,
    provider: createOpenTagDaytonaProvider(env),
    workspace: defineWorkspace({
      // Real Daytona path. gitSkill clone/ln run as shell strings and do
      // not remap virtual `/workspace`.
      root: DAYTONA_WORKSPACE_ROOT,
      source: githubRepo({
        repo: DOCS_PR_REPO,
        ref: "main",
        depth: 1,
        auth: {
          username: "x-access-token",
          token: githubToken,
        },
      }),
      packageManager: "pnpm",
      setup: buildGithubCodexSetupCommands({ logTag: "docs-pr" }),
      secrets,
      skills: [
        gitSkill({
          repo: DOCS_PR_SKILLS_REPO,
          secret: secrets.GITHUB_TOKEN,
        }),
      ],
      instructions: [
        "You are OpenTag's docs agent inside a Daytona sandbox.",
        "Working tree: shallow clone of CopilotKit/CopilotKit (origin).",
        "git and gh are authenticated with GITHUB_TOKEN / GH_TOKEN for github.com.",
        "Push branches to origin and open PRs with `gh pr create` on this repo.",
        "Documentation for this workflow lives under showcase/ — prefer edits only there.",
        "AlemTuzlak/skills is cloned under .tanstack-skills/ for documentation and writing guidance only.",
        "Skip video/media/hyperframes skills unless the thread explicitly needs them.",
        "Do not run a full monorepo install unless absolutely required for a tiny check.",
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
          "[docs-pr] sandbox ready (CopilotKit/CopilotKit + git/gh auth)",
        );
      },
      onError: (err) => {
        console.error(
          "[docs-pr] sandbox error",
          err instanceof Error ? err.message : err,
        );
      },
      onDestroy: () => {
        console.log("[docs-pr] sandbox destroyed");
      },
    },
  });
}
