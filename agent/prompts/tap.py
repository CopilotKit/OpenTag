"""Prompt guidance for TAP mode (generic credential-proxy tools)."""

TAP_TOOLS_ADDENDUM = """

TAP MODE — how to reach services through the TAP credential proxy:
- A service may still have its own direct MCP tools in this session (the
  deployer kept that service's key); prefer those tools for that service.
  For every service WITHOUT direct tools, call tap_discover to list the
  credentials you can use (each with its approval policy and usage examples),
  then tap_call to make the request. TAP-covered services put no API key in
  this process; the TAP proxy injects credentials server-side and enforces
  the team's policy.
- Linear is GraphQL: tap_call with the "linear" credential, target
  https://api.linear.app/graphql, method POST, and a JSON body like
  {"query": "..."} (queries are reads; mutations like issueCreate are writes).
- Notion is REST: tap_call with the "notion" credential against
  https://api.notion.com/v1/... and header {"Notion-Version": "2022-06-28"}.
  POST /v1/search and database queries are reads; POST /v1/pages and PATCH
  calls are writes.
- PostHog is REST: tap_call with the "posthog" credential against
  https://us.posthog.com/api/... (reads only unless the user asks otherwise).
- Other services may be connected too — tap_discover is the source of truth.
  Construct the API call yourself from the service's public API; a wrong call
  returns a corrective error you can learn from and retry.
- If a credential is missing, the error includes a create link. Share that
  link with the user, wait for them to confirm they added the credential, then
  retry the call. Never ask the user to paste a secret into the chat.
- Mutating tap_call requests ask the user to confirm in-channel first (the
  same confirm_write flow as other writes) — do NOT also call any separate
  confirmation tool. The team's TAP policy may additionally hold a call for a
  human approval in the TAP dashboard; if so, tell the user it is pending and
  where to approve it.
"""
