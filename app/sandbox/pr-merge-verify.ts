export type PrHeadVerifyOk = {
  ok: true;
  prUrl: string;
  number: number;
  headRef: string;
  headRepo: string;
};

export type PrHeadVerifyFail = { ok: false; reason: string };

export async function verifyOpenCopilotKitPrHead(input: {
  repo: string;
  number: number;
  headRef: string;
  token: string;
  expectedSha?: string;
  fetchImpl?: typeof fetch;
}): Promise<PrHeadVerifyOk | PrHeadVerifyFail> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const apiUrl = `https://api.github.com/repos/${input.repo}/pulls/${input.number}`;
  const response = await fetchImpl(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "opentag-copilotkit",
    },
  });
  if (!response.ok) {
    return { ok: false, reason: `GitHub API ${response.status} for ${apiUrl}` };
  }
  const data = (await response.json()) as {
    html_url?: string;
    state?: string;
    head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
  };
  if (data.state !== "open") {
    return { ok: false, reason: `PR #${input.number} is ${data.state}, not open` };
  }
  const headRef = data.head?.ref ?? "";
  const headRepo = data.head?.repo?.full_name ?? "";
  if (headRef !== input.headRef) {
    return {
      ok: false,
      reason: `PR #${input.number} head is ${headRef}, expected ${input.headRef}`,
    };
  }
  if (headRepo.toLowerCase() !== input.repo.toLowerCase()) {
    return {
      ok: false,
      reason: `PR #${input.number} head repo is ${headRepo}, expected ${input.repo}`,
    };
  }
  const expectedSha = input.expectedSha?.trim();
  const headSha = data.head?.sha ?? "";
  if (expectedSha && headSha !== expectedSha) {
    return {
      ok: false,
      reason: `PR #${input.number} head sha is ${headSha}, expected ${expectedSha}`,
    };
  }
  return {
    ok: true,
    prUrl:
      data.html_url?.trim() ||
      `https://github.com/${input.repo}/pull/${input.number}`,
    number: input.number,
    headRef,
    headRepo,
  };
}
