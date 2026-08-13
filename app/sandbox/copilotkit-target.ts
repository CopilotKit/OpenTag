export type CopilotkitParsedTarget =
  | {
      kind: "pr";
      owner: string;
      repo: string;
      number: number;
    }
  | { kind: "linear"; issueId: string }
  | {
      kind: "gh-issue";
      owner: string;
      repo: string;
      number: number;
    };

export type ParseCopilotkitTargetResult =
  | { ok: true; target: CopilotkitParsedTarget }
  | { ok: false; reason: string };

const COPILOTKIT_OWNER = "CopilotKit";
const DEFAULT_PR_REPO = "CopilotKit";

const PR_URL_RE =
  /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/i;
const ISSUE_URL_RE =
  /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/i;
const OWNER_REPO_HASH_RE =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
const REPO_HASH_RE = /^([A-Za-z0-9_.-]+)#(\d+)$/;
const BARE_NUMBER_RE = /^(\d+)$/;
const LINEAR_ID_RE = /^[A-Z][A-Z0-9]+-\d+$/i;

export function parseCopilotkitTarget(
  rawInput: string,
): ParseCopilotkitTargetResult {
  const raw = rawInput.trim();
  if (!raw) {
    return { ok: false, reason: "target is empty" };
  }

  const prUrl = raw.match(PR_URL_RE);
  if (prUrl) {
    return {
      ok: true,
      target: {
        kind: "pr",
        owner: prUrl[1]!,
        repo: prUrl[2]!,
        number: Number(prUrl[3]),
      },
    };
  }

  const issueUrl = raw.match(ISSUE_URL_RE);
  if (issueUrl) {
    return {
      ok: true,
      target: {
        kind: "gh-issue",
        owner: issueUrl[1]!,
        repo: issueUrl[2]!,
        number: Number(issueUrl[3]),
      },
    };
  }

  const ownerRepoHash = raw.match(OWNER_REPO_HASH_RE);
  if (ownerRepoHash) {
    return {
      ok: true,
      target: {
        kind: "pr",
        owner: ownerRepoHash[1]!,
        repo: ownerRepoHash[2]!,
        number: Number(ownerRepoHash[3]),
      },
    };
  }

  const repoHash = raw.match(REPO_HASH_RE);
  if (repoHash) {
    return {
      ok: true,
      target: {
        kind: "pr",
        owner: COPILOTKIT_OWNER,
        repo: repoHash[1]!,
        number: Number(repoHash[2]),
      },
    };
  }

  const bare = raw.match(BARE_NUMBER_RE);
  if (bare) {
    return {
      ok: true,
      target: {
        kind: "pr",
        owner: COPILOTKIT_OWNER,
        repo: DEFAULT_PR_REPO,
        number: Number(bare[1]),
      },
    };
  }

  if (LINEAR_ID_RE.test(raw)) {
    return { ok: true, target: { kind: "linear", issueId: raw.toUpperCase() } };
  }

  return { ok: false, reason: `Cannot parse PR target: ${raw}` };
}

export function githubRepoSlug(target: {
  owner: string;
  repo: string;
}): string {
  return `${target.owner}/${target.repo}`;
}
