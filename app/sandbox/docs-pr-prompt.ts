/**
 * Build the Codex user prompt for a docs-feedback sandbox run.
 */

export interface ThreadMessageForDocs {
  user: string;
  text: string;
  ts?: string;
}

export function buildDocsPrPrompt(messages: ThreadMessageForDocs[]): string {
  const transcript =
    messages.length === 0
      ? "(no thread messages — use the request text if any appears above)"
      : messages
          .map((m, i) => {
            const who = m.user || "unknown";
            const ts = m.ts ? ` [${m.ts}]` : "";
            return `${i + 1}. ${who}${ts}:\n${m.text || "(empty)"}`;
          })
          .join("\n\n");

  return [
    "You are running inside a Daytona sandbox with CopilotKit/CopilotKit checked out as origin.",
    "git and gh are already authenticated with GITHUB_TOKEN / GH_TOKEN for github.com.",
    "",
    "## Mission",
    "Read the Slack thread transcript below. Apply the feedback as documentation updates.",
    "Then open a GitHub pull request on CopilotKit/CopilotKit and print the PR URL as the last line.",
    "",
    "## Scope",
    "- Docs live under `showcase/` in this repo. Prefer editing only files under `showcase/`.",
    "- Only touch files outside `showcase/` if the thread clearly requires a linked change and you keep the diff minimal.",
    "- Do not run a full monorepo install or unrelated refactors.",
    "",
    "## Skills",
    "- AlemTuzlak/skills was cloned into the workspace (under `.tanstack-skills/` or similar).",
    "- Use documentation / writing skills only (guides, README, doc structure). Skip video/media skills.",
    "",
    "## Git / GitHub",
    "- Create a short descriptive branch name (e.g. `docs/showcase-slack-feedback-<date>`).",
    "- Commit with a clear message (prefer showcase/docs files only).",
    "- Push to origin: `git push -u origin HEAD`",
    "- Open a PR against main:",
    '  `gh pr create --repo CopilotKit/CopilotKit --base main --title "..." --body "..."`',
    "- Your final line must be only the PR URL you just created,",
    "  e.g. `https://github.com/CopilotKit/CopilotKit/pull/1234`.",
    "- NEVER paste an existing PR URL from docs, git log, or search results.",
    "- If push or `gh pr create` fails, do NOT invent a URL.",
    "  End with a line starting with `FAILED:` and the error.",
    "",
    "## Slack thread transcript",
    transcript,
  ].join("\n");
}

const PR_URL_RE =
  /https:\/\/github\.com\/CopilotKit\/CopilotKit\/pull\/\d+/gi;

/**
 * Extract a CopilotKit PR URL from agent text.
 *
 * Takes the **last** match, not the first. Tool output often contains old
 * PR links from docs (e.g. `showcase/RAILWAY.md` → #5705); the intentional
 * URL is almost always at the end of the final assistant message.
 */
export function extractCopilotKitPrUrl(text: string): string | undefined {
  if (!text) return undefined;
  const matches = [...text.matchAll(PR_URL_RE)];
  const last = matches.at(-1)?.[0];
  return last;
}

/**
 * Prefer assistant narrative, then tool results (e.g. `gh pr create` stdout).
 */
export function extractDocsPrUrl(input: {
  assistantText: string;
  toolResultText: string;
}): string | undefined {
  return (
    extractCopilotKitPrUrl(input.assistantText) ??
    extractCopilotKitPrUrl(input.toolResultText)
  );
}
