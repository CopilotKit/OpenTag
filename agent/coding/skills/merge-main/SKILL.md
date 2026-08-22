---
name: merge-main
description: >
  Merge origin/main into the working branch. Use when the brief skill
  is merge-main or the user wants latest main merged into a PR branch.
---

# merge-main

Merge `origin/main` into the working branch from the brief.

1. Call `prepare_repository` with the PR or named head and `sync_base: true`.
2. The host synchronizes the base through Daytona. Never fetch or pull with Git yourself.
3. Resolve conflicts with the smallest correct edits. Do not drop the PR's intent.
4. Run the test command from the brief, or the repo default test command.
5. If green, commit locally if needed and call `publish_changes`; it reuses an existing PR.
6. If red, do not call `publish_changes`. Return the log tail.
