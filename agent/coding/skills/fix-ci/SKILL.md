---
name: fix-ci
description: >
  Reproduce a red GitHub check and make it green. Use when the brief
  skill is fix-ci or the user wants a failing CI command to exit 0.
---

# fix-ci

Reproduce a red GitHub check in the sandbox and make it green.

1. Call `prepare_repository`, including `pr_number` for an existing PR.
2. If the brief names a failing check, reproduce that command. Use the read-only GitHub Actions tools if you need its log. Never use `gh`.
3. Work on the returned safe head branch.
4. Edit until the reproduced command exits 0.
5. If green, commit locally and call `publish_changes`.
6. If red, do not call `publish_changes`. Return the log tail.
