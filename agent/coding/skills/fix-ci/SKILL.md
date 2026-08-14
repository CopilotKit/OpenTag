---
name: fix-ci
description: >
  Reproduce a red GitHub check and make it green. Use when the brief
  skill is fix-ci or the user wants a failing CI command to exit 0.
---

# fix-ci

Reproduce a red GitHub check in the sandbox and make it green.

1. Clone the repo. Check out the PR head.
2. If the brief names a failing check, reproduce that command. Use `gh run view` only if you need the log.
3. Create a branch `opentag/fix-ci-<short-id>` if you are not already on a safe working branch.
4. Edit until the reproduced command exits 0.
5. If green, commit, push, call `open_pull_request`.
6. If red, do not call `open_pull_request`. Return the log tail.
