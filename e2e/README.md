# Slack live end-to-end harness

This API-first harness sends real user messages to a Slack test channel, polls
OpenTag replies while they stream, and writes a JSON report under
`e2e/results/`.

It complements unit tests by exercising the deployed Slack path, including
mentions, threads, streaming text, rich blocks, follow-up turns, and
interruptions.

## Configure

Set these only in your local root `.env`:

```dotenv
SLACK_BOT_TOKEN=xoxb-...
SLACK_USER_TOKEN=xoxp-...
BOT_USER_ID=U...
E2E_CHANNEL=C...
```

- `SLACK_BOT_TOKEN` reads channel history and thread replies.
- `SLACK_USER_TOKEN` posts as a real user so Slack emits the user event.
- `BOT_USER_ID` identifies the OpenTag bot in replies.
- `E2E_CHANNEL` is the test channel ID.

The harness never provisions or reinstalls an app. Do not run it against the
production `@kite` app while another Socket Mode consumer owns the same token.

## Run

Start or deploy the OpenTag agent and Channel, then:

```bash
pnpm e2e
```

Run a subset by case-name substring:

```bash
CASE_FILTER='A1' pnpm e2e
```

Cases live in [`cases.ts`](./cases.ts). The harness entrypoint is
[`run.ts`](./run.ts), and Slack API helpers are in
[`slack-api.ts`](./slack-api.ts).

Microsoft Teams is supported for launch through Intelligence, but this folder
does not yet contain a Teams live harness.
