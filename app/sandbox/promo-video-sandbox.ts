/**
 * TanStack Daytona sandbox for CopilotKit-branded HyperFrames promo videos.
 *
 * - Grok Build (grok-4.5) in Daytona
 * - Skills: heygen hyperframes pack, AlemTuzlak hyperframes-video, private branding
 * - Optional PR clone (auth via GITHUB_TOKEN / GH_TOKEN)
 * - Thread reuse for multi-turn feedback
 */
import {
  createSecrets,
  defineSandbox,
  defineSandboxPolicy,
  defineWorkspace,
  gitSkill,
  githubRepo,
} from "@tanstack/ai-sandbox";
import { GROK_CLI_INSTALL_COMMAND } from "@tanstack/ai-grok-build";
import {
  createOpenTagDaytonaProvider,
  DAYTONA_WORKSPACE_ROOT,
} from "./daytona-provider.js";

export const PROMO_VIDEO_SANDBOX_ID = "opentag-promo-video";
export const DEFAULT_PROMO_VIDEO_MODEL = "grok-4.5";

/**
 * Extra `grok -p` flags for headless promo runs.
 *
 * `--always-approve` comes from a fully-permissive sandbox policy
 * (no commands.deny). These two are still required:
 * - `--no-plan` skips xAI Plan Mode, which `--always-approve` does not skip
 * - `--no-auto-update` skips the CLI update check in scripts
 */
export const PROMO_GROK_HEADLESS_ARGS = [
  "--no-plan",
  "--no-auto-update",
] as const;

/** Shared Grok Build adapter options for the promo job and the repro script. */
export function promoGrokBuildOptions() {
  return {
    permissionMode: "bypassPermissions" as const,
    protocol: "streaming-json" as const,
    extraArgs: [...PROMO_GROK_HEADLESS_ARGS],
  };
}

export function requirePromoVideoEnv(
  env: NodeJS.ProcessEnv = process.env,
): {
  xaiApiKey: string;
  githubToken: string;
  model: string;
} {
  const xaiApiKey = env.XAI_API_KEY?.trim();
  if (!xaiApiKey) {
    throw new Error(
      "Missing XAI_API_KEY — required for Grok Build in the promo-video sandbox",
    );
  }
  const githubToken =
    env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || undefined;
  if (!githubToken) {
    throw new Error(
      "Missing GITHUB_TOKEN (or GH_TOKEN) — required for private skills " +
        "(CopilotKit/internal-skills) and private PR clones",
    );
  }
  const model = env.VIDEO_SANDBOX_MODEL?.trim() || DEFAULT_PROMO_VIDEO_MODEL;
  return { xaiApiKey, githubToken, model };
}

const PROMO_INSTRUCTIONS = [
  "You are a headless promo-video producer inside a Daytona sandbox.",
  "You cannot ask the user questions. Prefer sane defaults for every choice.",
  "",
  "HARD RULES:",
  "1. Use the /hyperframes-video skill for the full video workflow.",
  "2. Use the /copilotkit-branding skill for all brand colors, fonts, and logo treatment.",
  "3. Aspect ratio is ALWAYS 1:1 (1080x1080). Never 16:9 or 9:16.",
  "4. Do not open interactive Q&A gates. Skip confirmation prompts. Use defaults.",
  "5. Still run brand detection and pre-render checks that do not need a human.",
  "6. Write final artifacts to exactly:",
  "   - out/video.mp4",
  "   - out/poster.jpg (optional but preferred)",
  "7. When the mp4 is ready, print this exact line on its own:",
  "   PROMO_VIDEO_READY: out/video.mp4",
  "8. If render fails, print PROMO_VIDEO_FAILED: <short reason> and stop.",
  "",
  "On follow-up turns, treat the user message as feedback. Refine the existing",
  "HyperFrames project when possible; re-render to the same out/ paths.",
].join("\n");

export type CreatePromoVideoSandboxOpts = {
  /** conversationKey / thread id — one sandbox per Slack thread. */
  conversationKey: string;
  repoSlug: string | null;
  prNumber?: number;
};

export function createPromoVideoSandbox(
  opts: CreatePromoVideoSandboxOpts,
  env: NodeJS.ProcessEnv = process.env,
) {
  const { xaiApiKey, githubToken } = requirePromoVideoEnv(env);

  const secrets = createSecrets({
    XAI_API_KEY: xaiApiKey,
    GITHUB_TOKEN: githubToken,
    GH_TOKEN: githubToken,
  });

  const source = opts.repoSlug
    ? githubRepo({
        repo: opts.repoSlug,
        ...(opts.prNumber != null
          ? { ref: `refs/pull/${opts.prNumber}/head` }
          : {}),
        depth: 1,
        auth: {
          username: "x-access-token",
          token: githubToken,
        },
      })
    : { type: "none" as const };

  return defineSandbox({
    id: `${PROMO_VIDEO_SANDBOX_ID}-${opts.conversationKey}`,
    provider: createOpenTagDaytonaProvider(env),
    workspace: defineWorkspace({
      // Real Daytona path. gitSkill clone/ln run as shell strings and do
      // not remap virtual `/workspace`.
      root: DAYTONA_WORKSPACE_ROOT,
      source,
      secrets,
      skills: [
        gitSkill({
          repo: "AlemTuzlak/skills",
          secret: secrets.GITHUB_TOKEN,
        }),
        gitSkill({
          repo: "CopilotKit/internal-skills",
          secret: secrets.GITHUB_TOKEN,
        }),
      ],
      instructions: PROMO_INSTRUCTIONS,
      setup: ({ serial }) => {
        // Daytona runs as user `daytona`, not root. Default snapshots
        // give that user passwordless sudo. Bare apt-get cannot write
        // /var/lib/apt (Acquire 13: Permission denied).
        serial(
          "sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -qq",
        );
        serial(
          "sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates ffmpeg || true",
        );
        serial(
          "command -v ffmpeg || sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg",
        );
        serial("command -v ffmpeg");
        serial(GROK_CLI_INSTALL_COMMAND);
        serial(
          "npx --yes skills add heygen-com/hyperframes --full-depth || true",
        );
        // Grok projector links each gitSkill clone by repo basename
        // (`.grok/skills/skills`, `.grok/skills/internal-skills`).
        // It does not walk nested SKILL.md dirs. Grok only loads a skill
        // when `.grok/skills/<name>/SKILL.md` exists.
        const skillsRoot = `${DAYTONA_WORKSPACE_ROOT}/.tanstack-skills`;
        const grokSkills = `${DAYTONA_WORKSPACE_ROOT}/.grok/skills`;
        serial(`mkdir -p ${grokSkills}`);
        serial(
          `ln -sfn ${skillsRoot}/skills/skills/hyperframes-video ${grokSkills}/hyperframes-video`,
        );
        serial(
          `ln -sfn ${skillsRoot}/internal-skills/skills/copilotkit-branding ${grokSkills}/copilotkit-branding`,
        );
        serial(`test -f ${grokSkills}/hyperframes-video/SKILL.md`);
        serial(`test -f ${grokSkills}/copilotkit-branding/SKILL.md`);
      },
    }),
    policy: defineSandboxPolicy({
      commands: {
        allow: [
          "git *",
          "gh *",
          "grok *",
          "npx *",
          "npm *",
          "node *",
          "pnpm *",
          "ffmpeg *",
          "ls *",
          "cat *",
          "find *",
          "rg *",
          "grep *",
          "echo *",
          "mkdir *",
          "cp *",
          "mv *",
          "ln *",
          "which *",
          "head *",
          "tail *",
          "apt-get *",
          "sudo apt-get *",
        ],
        // Empty deny is load-bearing. Any commands.deny makes
        // @tanstack/ai-grok-build mapPolicyToGrokBuildFlags set
        // conservative=true, which replaces --always-approve with
        // --permission-mode default. Headless grok -p then auto-cancels
        // every tool ("User cancelled the execution") and exits.
      },
      capabilities: {
        fileWrite: "allow",
        network: "allow",
      },
      default: "allow",
    }),
    lifecycle: {
      reuse: "thread",
      snapshot: "after-setup",
      keepAlive: "2h",
      destroyOnComplete: false,
    },
  });
}
