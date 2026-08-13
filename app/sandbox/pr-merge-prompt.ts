export function buildPrMergePrompt(input: {
  repo: string;
  number: number;
  baseRef: string;
  headRef: string;
  prUrl: string;
  conflictFiles: string[];
  note?: string;
}): string {
  const files = input.conflictFiles.map((f) => `- ${f}`).join("\n");
  const note = input.note?.trim();
  return [
    `You are resolving merge conflicts in a Daytona sandbox on ${input.repo}.`,
    `PR: ${input.prUrl} (#${input.number}).`,
    `Head branch: ${input.headRef}. Base branch: ${input.baseRef}.`,
    "git merge already ran and is dirty. Conflict files:",
    files,
    "",
    "## Mission",
    `Resolve only the conflicted files listed above so the merge of origin/${input.baseRef} can complete.`,
    "Do not rewrite the rest of the branch.",
    "Do not create another pull request.",
    "Do not run the GitHub CLI create-pr command.",
    `Stay on ${input.headRef} and leave the merge commit ready to push.`,
    "",
    note ? `### Current request note\n${note}\n` : "",
    "## Method (required)",
    "1. Edit only the conflict files.",
    "2. Keep both sides when they do not fight. Prefer the head-branch feature when they do, unless the note says otherwise.",
    "3. Remove conflict markers.",
    "4. git add the conflict files.",
    `5. git commit to complete the merge if git still needs a merge commit.`,
    "6. Do not push. The host pushes the same branch.",
    "",
    "Print a one-line summary: RESOLVED <n> files.",
  ]
    .filter(Boolean)
    .join("\n");
}
