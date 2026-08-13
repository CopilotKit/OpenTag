/**
 * Shared Daytona bootstrap for Codex sandboxes that push to CopilotKit/CopilotKit.
 *
 * - Install git and gh with passwordless sudo (Daytona user is not root)
 * - Skip Codex install when `daytona-medium` already has it
 * - Auth via GITHUB_TOKEN / GH_TOKEN (injected by createSecrets before setup)
 * - Never run `gh auth login` when env token is set (gh exits 1)
 */
export const COPILOTKIT_REPO = "CopilotKit/CopilotKit";

const INSTALL_CODEX_IF_MISSING =
  "command -v codex || { npm install -g @openai/codex --include=optional && codex --version; }";

/**
 * Serial setup commands. Secrets (GITHUB_TOKEN, GH_TOKEN, …) are already in
 * the sandbox env when these run.
 */
export function buildGithubCodexSetupCommands(options?: {
  /** Log prefix for echo lines. */
  logTag?: string;
}): string[] {
  const tag = options?.logTag ?? "sandbox";
  return [
    // Daytona runs as user `daytona`, not root. Default snapshots
    // give that user passwordless sudo. Bare apt-get / /etc writes fail.
    "sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -qq",
    "sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates gnupg",
    "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo -n dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null",
    "sudo -n chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg",
    'echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo -n tee /etc/apt/sources.list.d/github-cli.list > /dev/null',
    "sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gh",
    "git --version && gh --version",
    INSTALL_CODEX_IF_MISSING,
    'git config --global user.email "opentag-bot@users.noreply.github.com"',
    'git config --global user.name "OpenTag Bot"',
    `if [ -z "\${GITHUB_TOKEN:-}\${GH_TOKEN:-}" ]; then echo "[${tag}] GITHUB_TOKEN/GH_TOKEN missing from sandbox env" >&2; exit 1; fi`,
    'if [ -z "${GH_TOKEN:-}" ] && [ -n "${GITHUB_TOKEN:-}" ]; then export GH_TOKEN="$GITHUB_TOKEN"; fi',
    'if [ -z "${GITHUB_TOKEN:-}" ] && [ -n "${GH_TOKEN:-}" ]; then export GITHUB_TOKEN="$GH_TOKEN"; fi',
    "gh auth setup-git -h github.com || true",
    'git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"',
    'git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:"',
    `gh api user --jq '"login=" + .login'`,
    `gh api repos/${COPILOTKIT_REPO} --jq '"repo=" + .full_name + " push=" + (.permissions.push|tostring)'`,
    "git remote -v",
    `echo "[${tag}] git+gh ready; origin is ${COPILOTKIT_REPO}"`,
  ];
}

export function requireGithubCodexEnv(
  env: NodeJS.ProcessEnv = process.env,
): {
  githubToken: string;
  openaiApiKey: string;
  codexApiKey: string;
} {
  const githubToken = env.GITHUB_TOKEN?.trim();
  if (!githubToken) {
    throw new Error(
      "Missing GITHUB_TOKEN — required for git push and gh pr create " +
        "(classic PAT with `repo`, or fine-grained with Contents + Pull requests write)",
    );
  }
  const openaiApiKey = env.OPENAI_API_KEY?.trim();
  if (!openaiApiKey) {
    throw new Error(
      "Missing OPENAI_API_KEY — required for Codex in the sandbox",
    );
  }
  const codexApiKey = env.CODEX_API_KEY?.trim() || openaiApiKey;
  return { githubToken, openaiApiKey, codexApiKey };
}
