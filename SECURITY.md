# Security policy

OpenTag is a self-hosted chat agent that connects to Slack, model providers, and optional tools
such as Linear, Notion, Redis, and WhatsApp. Treat the host running OpenTag as a trusted
automation environment.

## Supported versions

OpenTag is currently distributed as source from this repository. Please file security reports
against the current `main` branch unless a release branch is published.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the maintainers instead of opening a public
issue with exploit details or credentials. Use GitHub private vulnerability reporting if it is
enabled; otherwise use the maintainers' preferred private contact channel.

When reporting, include:

- A short description of the affected flow or file
- Reproduction steps using placeholder credentials only
- The expected impact
- Any suggested mitigation

Do **not** include real Slack tokens, model-provider keys, Linear keys, Notion tokens,
Redis URLs with passwords, cookies, private keys, or production logs containing secrets.

## Secret-handling checklist

Before sharing logs, screenshots, issues, or pull requests:

- Keep `.env`, `.env.local`, browser profiles, and `e2e/results/` out of git.
- Redact values that start with `xoxb-`, `xapp-`, `sk-`, `sk-ant-`, `lin_api_`, or
  provider-specific token prefixes.
- Redact `Authorization` headers, cookies, webhook verification tokens, and Redis URLs that
  include passwords.
- Rotate any token that was pasted into a public issue, PR, screenshot, log, or chat transcript.
- Use the example placeholders in `.env.example`; never copy production values into documentation.

## Deployment guidance

- Prefer Slack Socket Mode for local/self-hosted development so the bot does not require a public
  inbound URL.
- If exposing any endpoint publicly, put it behind HTTPS and the minimum required authentication.
- Keep the agent runtime endpoint (`AGENT_URL`) private unless you intentionally protect it with an
  auth layer.
- Use least-privilege Slack scopes and reinstall the app after changing the manifest.
- Treat MCP integrations as privileged tool execution paths; enable only the tools you need.
