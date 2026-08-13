/** Parse GitHub PR URLs / owner/repo#n for workspace clone. */

export type GitHubPrRef = {
  owner: string;
  repo: string;
  number: number;
};

const PR_URL_RE =
  /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/i;
const OWNER_REPO_HASH_RE =
  /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/;

export function parseGitHubPr(text: string): GitHubPrRef | null {
  const url = text.match(PR_URL_RE);
  if (url) {
    return {
      owner: url[1]!,
      repo: url[2]!,
      number: Number(url[3]),
    };
  }
  const short = text.match(OWNER_REPO_HASH_RE);
  if (short) {
    return {
      owner: short[1]!,
      repo: short[2]!,
      number: Number(short[3]),
    };
  }
  return null;
}

export function resolvePrRepo(input: {
  prompt: string;
  prUrl?: string;
}): GitHubPrRef | null {
  if (input.prUrl) {
    const fromExplicit = parseGitHubPr(input.prUrl);
    if (fromExplicit) return fromExplicit;
  }
  return parseGitHubPr(input.prompt);
}

export function repoSlug(ref: GitHubPrRef | null): string | null {
  return ref ? `${ref.owner}/${ref.repo}` : null;
}
