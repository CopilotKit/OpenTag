---
name: merge-main
description: >
  Merge origin/main into the working branch. Use when the brief skill
  is merge-main or the user wants latest main merged into a PR branch.
---

# merge-main

Merge `origin/main` into the working branch from the brief.

1. Clone the repo. Check out the PR head or named branch.
2. Fetch `origin/main`. Merge it.
3. Resolve conflicts with the smallest correct edits. Do not drop the PR's intent.
4. Run the test command from the brief, or the repo default test command.
5. If green, push, call `open_pull_request` if no PR exists, or report that the branch is updated.
6. If red, do not call `open_pull_request`. Return the log tail.
