export function buildPrFixPrompt(input: {
  repo: string;
  number: number;
  headRef: string;
  prUrl: string;
  note?: string;
}): string {
  const note = input.note?.trim();
  const mission = note
    ? `Do what the current request note says.`
    : "Fix this open pull request. Read the branch and make the change that is needed.";

  return [
    `You are fixing an open pull request in a Daytona sandbox on ${input.repo}.`,
    `PR: ${input.prUrl} (#${input.number}).`,
    `Head branch: ${input.headRef}.`,
    "git and gh are authenticated. Skills are under .tanstack-skills/.",
    "",
    "## Mission",
    mission,
    "",
    note ? `### Current request note\n${note}\n` : "",
    "## Method (required)",
    "1. Read the user note. That is the mission. The host did not fetch CI or PR feedback for you.",
    "2. If the note asks about CI or failing tests, use gh, logs, and the repo to find the cause.",
    "3. If the note asks about PR feedback, review comments, or review threads, use gh to read review comments, review threads, and issue comments.",
    "4. Apply only comments that make sense. Skip noise, style nits you disagree with, and asks that would break the change. Do not only reply. Change the code.",
    "5. Implement the correct fix on this branch.",
    "6. Commit your change.",
    `7. Push the same branch with GITHUB_TOKEN: git push origin HEAD:${input.headRef}`,
    "",
    "## Git (required)",
    `CRITICAL: Stay on ${input.headRef}. Leave the commit on this same branch.`,
    "CRITICAL: Do not create another pull request.",
    "CRITICAL: Do not run the GitHub CLI create-pr command.",
    `CRITICAL: Push this same branch with the provided GITHUB_TOKEN: git push origin HEAD:${input.headRef}`,
    "CRITICAL: Do not merge main or the PR base unless the note asks.",
    "",
    "Print a one-line summary of what you changed.",
  ]
    .filter(Boolean)
    .join("\n");
}
