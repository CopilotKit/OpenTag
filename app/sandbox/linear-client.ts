/**
 * Minimal Linear GraphQL client for ticket updates (comment + optional triage notes).
 * Uses LINEAR_API_KEY from the host env (not the sandbox).
 */

export const LINEAR_API_URL = "https://api.linear.app/graphql";

export interface LinearIssueRef {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export interface LinearCommentResult {
  id: string;
  url?: string;
}

/** Rich issue payload for sandbox prompts. */
export interface LinearIssueDetails {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  status?: string;
  priority?: string;
  labels: string[];
  /** Flattened recent comments for agentContext. */
  commentsSummary: string;
}

function requireLinearApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.LINEAR_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "Missing LINEAR_API_KEY — required to update Linear tickets after investigation",
    );
  }
  return key;
}

async function linearGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  options?: { token?: string; fetchImpl?: typeof fetch },
): Promise<T> {
  const token = options?.token?.trim() || requireLinearApiKey();
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is not available for Linear API");
  }

  const response = await fetchImpl(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };

  if (!response.ok) {
    throw new Error(
      `Linear API HTTP ${response.status}: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  if (json.errors?.length) {
    throw new Error(
      `Linear API error: ${json.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!json.data) {
    throw new Error("Linear API returned no data");
  }
  return json.data;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve a Linear issue id (UUID or human identifier like ENG-123) to a full ref.
 * Linear accepts both UUID and identifiers such as `ENG-123` on `issue(id:)`.
 */
export async function resolveLinearIssue(
  issueIdOrKey: string,
  options?: { token?: string; fetchImpl?: typeof fetch },
): Promise<LinearIssueRef> {
  const raw = issueIdOrKey.trim();
  if (!raw) {
    throw new Error("Linear issue id is empty");
  }

  try {
    const data = await linearGraphql<{
      issue: LinearIssueRef | null;
    }>(
      `query IssueById($id: String!) {
        issue(id: $id) { id identifier title url }
      }`,
      { id: raw },
      options,
    );
    if (data.issue) return data.issue;
  } catch {
    // Fall through to search for non-UUID keys / older API shapes.
    if (UUID_RE.test(raw)) {
      throw new Error(`Linear issue not found for id ${raw}`);
    }
  }

  // Fallback: search by term and prefer exact identifier match.
  const search = await linearGraphql<{
    searchIssues: { nodes: LinearIssueRef[] };
  }>(
    `query SearchIssues($term: String!) {
      searchIssues(term: $term, first: 5) {
        nodes { id identifier title url }
      }
    }`,
    { term: raw },
    options,
  );

  const nodes = search.searchIssues?.nodes ?? [];
  const exact = nodes.find(
    (n) => n.identifier.toLowerCase() === raw.toLowerCase(),
  );
  const hit = exact ?? nodes[0];
  if (!hit) {
    throw new Error(`Linear issue not found for identifier ${raw}`);
  }
  return hit;
}

/**
 * Load full issue details (description, labels, recent comments) for a sandbox prompt.
 * Accepts UUID or human identifier (e.g. CPK-7630).
 */
export async function fetchLinearIssueDetails(
  issueIdOrKey: string,
  options?: { token?: string; fetchImpl?: typeof fetch },
): Promise<LinearIssueDetails> {
  const ref = await resolveLinearIssue(issueIdOrKey, options);
  const data = await linearGraphql<{
    issue: {
      id: string;
      identifier: string;
      title: string;
      description?: string | null;
      url: string;
      priorityLabel?: string | null;
      state?: { name?: string } | null;
      labels?: { nodes?: Array<{ name?: string }> } | null;
      comments?: {
        nodes?: Array<{
          body?: string | null;
          createdAt?: string | null;
          user?: { name?: string | null } | null;
        }>;
      } | null;
    } | null;
  }>(
    `query IssueDetails($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        description
        url
        priorityLabel
        state { name }
        labels { nodes { name } }
        comments(first: 25) {
          nodes {
            body
            createdAt
            user { name }
          }
        }
      }
    }`,
    { id: ref.id },
    options,
  );

  if (!data.issue) {
    throw new Error(`Linear issue details not found for ${issueIdOrKey}`);
  }

  const labels =
    data.issue.labels?.nodes
      ?.map((n) => n.name?.trim())
      .filter((n): n is string => Boolean(n)) ?? [];

  const commentLines =
    data.issue.comments?.nodes
      ?.map((c) => {
        const who = c.user?.name?.trim() || "unknown";
        const when = c.createdAt?.trim() || "";
        const body = (c.body ?? "").trim();
        if (!body) return null;
        return `- ${who}${when ? ` (${when})` : ""}:\n${body}`;
      })
      .filter((line): line is string => Boolean(line)) ?? [];

  return {
    id: data.issue.id,
    identifier: data.issue.identifier,
    title: data.issue.title,
    description: (data.issue.description ?? "").trim(),
    url: data.issue.url,
    status: data.issue.state?.name?.trim() || undefined,
    priority: data.issue.priorityLabel?.trim() || undefined,
    labels,
    commentsSummary:
      commentLines.length > 0
        ? commentLines.join("\n\n")
        : "(no comments)",
  };
}

/**
 * Post a markdown comment on a Linear issue (by UUID).
 */
export async function createLinearComment(
  issueUuid: string,
  body: string,
  options?: { token?: string; fetchImpl?: typeof fetch },
): Promise<LinearCommentResult> {
  const data = await linearGraphql<{
    commentCreate: {
      success: boolean;
      comment: { id: string; url?: string } | null;
    };
  }>(
    `mutation CommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment { id url }
      }
    }`,
    {
      input: {
        issueId: issueUuid,
        body,
      },
    },
    options,
  );

  if (!data.commentCreate.success || !data.commentCreate.comment) {
    throw new Error("Linear commentCreate did not succeed");
  }
  return {
    id: data.commentCreate.comment.id,
    url: data.commentCreate.comment.url,
  };
}

/**
 * Resolve issue + post investigation comment in one step.
 */
export async function postInvestigationToLinear(input: {
  issueIdOrKey: string;
  reportMarkdown: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ issue: LinearIssueRef; comment: LinearCommentResult }> {
  const issue = await resolveLinearIssue(input.issueIdOrKey, {
    token: input.token,
    fetchImpl: input.fetchImpl,
  });
  const comment = await createLinearComment(issue.id, input.reportMarkdown, {
    token: input.token,
    fetchImpl: input.fetchImpl,
  });
  return { issue, comment };
}
