/**
 * Verify a candidate CopilotKit PR URL is a real, newly opened PR —
 * not a stale link scraped from docs (e.g. showcase/RAILWAY.md → #5705).
 */
import { requireDocsPrEnv } from "./docs-pr-sandbox.js";

const PR_PATH_RE =
  /^https:\/\/github\.com\/CopilotKit\/CopilotKit\/pull\/(\d+)\/?$/i;

export interface DocsPrVerifyOk {
  ok: true;
  prUrl: string;
  number: number;
  title: string;
  headRef: string;
  headRepo: string;
  author: string;
  createdAt: string;
}

export interface DocsPrVerifyFail {
  ok: false;
  reason: string;
}

export type DocsPrVerifyResult = DocsPrVerifyOk | DocsPrVerifyFail;

export interface DocsPrVerifyOptions {
  /**
   * Earliest acceptable `created_at` (ms since epoch). PRs created before
   * this are treated as pre-existing / scraped, not opened by this job.
   * Use the job start time minus a small clock-skew buffer.
   */
  notBeforeMs: number;
  /** Override token (tests). Defaults to GITHUB_TOKEN from env. */
  token?: string;
  /** Inject fetch (tests). */
  fetchImpl?: typeof fetch;
}

/**
 * Confirm `url` is an open CopilotKit PR created after `notBeforeMs`.
 * Uses the GitHub REST API with GITHUB_TOKEN.
 */
export async function verifyCopilotKitPrUrl(
  url: string,
  options: DocsPrVerifyOptions,
): Promise<DocsPrVerifyResult> {
  const match = url.trim().match(PR_PATH_RE);
  if (!match?.[1]) {
    return {
      ok: false,
      reason: `Not a CopilotKit/CopilotKit pull URL: ${url}`,
    };
  }
  const number = Number(match[1]);
  const token =
    options.token?.trim() || requireDocsPrEnv().githubToken;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    return { ok: false, reason: "fetch is not available to verify the PR" };
  }

  const apiUrl = `https://api.github.com/repos/CopilotKit/CopilotKit/pulls/${number}`;
  let response: Response;
  try {
    response = await fetchImpl(apiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "opentag-docs-pr",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `GitHub API request failed: ${message}` };
  }

  if (response.status === 404) {
    return { ok: false, reason: `PR #${number} does not exist` };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      reason: `GitHub API ${response.status} for PR #${number}: ${body.slice(0, 200)}`,
    };
  }

  const data = (await response.json()) as {
    html_url?: string;
    state?: string;
    title?: string;
    created_at?: string;
    user?: { login?: string };
    head?: {
      ref?: string;
      repo?: { full_name?: string } | null;
    };
    merged_at?: string | null;
  };

  const state = data.state ?? "unknown";
  if (state !== "open") {
    return {
      ok: false,
      reason: `PR #${number} is ${state}, not open (likely a pre-existing / docs-scraped link)`,
    };
  }

  const createdAt = data.created_at;
  if (!createdAt) {
    return { ok: false, reason: `PR #${number} has no created_at` };
  }
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) {
    return {
      ok: false,
      reason: `PR #${number} created_at is not parseable: ${createdAt}`,
    };
  }
  if (createdMs < options.notBeforeMs) {
    return {
      ok: false,
      reason:
        `PR #${number} was created at ${createdAt}, before this job started ` +
        `(notBefore=${new Date(options.notBeforeMs).toISOString()}). ` +
        `This is almost certainly a pre-existing PR URL scraped from the repo, not a PR this job opened.`,
    };
  }

  const prUrl =
    typeof data.html_url === "string" && data.html_url.trim()
      ? data.html_url.trim()
      : `https://github.com/CopilotKit/CopilotKit/pull/${number}`;

  return {
    ok: true,
    prUrl,
    number,
    title: data.title ?? "",
    headRef: data.head?.ref ?? "",
    headRepo: data.head?.repo?.full_name ?? "",
    author: data.user?.login ?? "",
    createdAt,
  };
}
