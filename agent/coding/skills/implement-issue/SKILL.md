---
name: implement-issue
description: >
  Implement a Linear brief in a named GitHub repo. Use when the brief
  skill is implement-issue or the user wants a new branch and draft PR.
---

# implement-issue

Implement only the brief. Do not rediscover the issue. Do not explore
the repo to invent a plan.

The brief must include `repo`, `issue`, `files`, `change`, and one
`test` command. If any of those are missing, stop. Return
`status: failed` and say the brief is incomplete. Do not guess.

1. Call `prepare_repository` with the repo and branch `opentag/<issue-id>`.
2. Work from the returned directory and branch.
3. Edit only the listed files.
4. Run the one test command from the brief.
5. Do not guess `pnpm test`. Do not run the full monorepo suite.
6. If green, commit locally and call `publish_changes`.
7. If red, do not call `publish_changes` unless the brief says `open_anyway: true`.
