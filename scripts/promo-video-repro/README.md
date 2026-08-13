# Promo video Daytona repro

Temporary debug folder. It runs the **same** promo sandbox + Grok Build path as Slack.

It does **not** post to Slack. It dumps sandbox state and every stream chunk to `out/`.

## Run

From the repo root:

```powershell
pnpm exec tsx scripts/promo-video-repro/run.ts
```

The script uses the same SQLite file as Slack (`.data/opentag.sqlite`,
or `OPENTAG_SQLITE_URL`). Live chunks still use `memoryStream` in this
process.

Needs the same `.env` keys as `pnpm dev`: `DAYTONA_API_KEY`, `XAI_API_KEY`, `GITHUB_TOKEN`.

Default brief is CopilotKit PR #6439 (same as the Slack fail). Override with:

```powershell
$env:PROMO_REPRO_PROMPT = "your brief"
pnpm exec tsx scripts/promo-video-repro/run.ts
```

## What it writes

`scripts/promo-video-repro/out/<runId>/`

- `inspect-before.json` — skills, grok, ffmpeg, AGENTS.md, `grok inspect`
- `chunks.ndjson` — every TanStack stream chunk
- `inspect-after.json` — same dump after Grok exits, plus `out/video.mp4`
- `summary.json` — short result

The Daytona sandbox stays up. The summary prints the sandbox id.

## Inspect an old sandbox

`--inspect` / `--destroy` on `run.ts` need the in-memory store from the same process. After the script exits, resume the Daytona box by id instead:

```powershell
pnpm exec tsx scripts/promo-video-repro/probe.ts --resume <daytonaId>
```

That runs raw `grok -p` flag combos (no TanStack chat) and dumps `out/probe-<id>/`.

## Resume a leftover Daytona sandbox

`run.ts` now uses the same production flags as Slack (`--no-plan --no-auto-update`, and `--always-approve` from an empty `commands.deny`).

Reuse a live Daytona box without a new setup:

```powershell
$env:PROMO_REPRO_PROMPT = "Write hello to out/probe.txt. Print PROBE_OK and stop."
pnpm exec tsx scripts/promo-video-repro/run.ts --resume-id <daytonaId>
```

Destroy by Daytona id when you are done:

```powershell
pnpm exec tsx scripts/promo-video-repro/run.ts --destroy-id <daytonaId>
```

`PROMO_REPRO_EXTRA_ARGS` replaces the production extra flags. Leave it unset unless you are testing a different combo.
