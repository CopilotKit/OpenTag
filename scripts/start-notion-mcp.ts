/**
 * Starts the official Notion MCP server as a Streamable-HTTP sidecar for the
 * OpenTag Python deep-research agent (`agent/`). Run with `pnpm notion-mcp`
 * for optional local Notion access.
 *
 * Why a launcher instead of a raw npm script: the two `.env` values need to be
 * mapped to the two DIFFERENT things the Notion server expects — the Notion
 * integration secret (`NOTION_TOKEN`) becomes the OUTBOUND `Authorization:
 * Bearer` the server sends to Notion's API (passed via `OPENAPI_MCP_HEADERS`,
 * see below), and `NOTION_MCP_AUTH_TOKEN` becomes the server's INBOUND HTTP
 * transport bearer (`AUTH_TOKEN` / `--auth-token`) that the agent presents to
 * reach this sidecar. Doing the mapping here works identically on
 * Windows/macOS/Linux without shell-specific env interpolation.
 */
import "dotenv/config";
import { spawn } from "node:child_process";

const authToken = process.env["NOTION_MCP_AUTH_TOKEN"];
const notionToken = process.env["NOTION_TOKEN"];

if (!authToken) {
  console.error(
    "[notion-mcp] NOTION_MCP_AUTH_TOKEN is required — it's the bearer the " +
      "agent uses to reach this sidecar. Set it in .env (any strong string).",
  );
  process.exit(1);
}
if (!notionToken) {
  console.error(
    "[notion-mcp] NOTION_TOKEN is required — the Notion integration secret " +
      "(ntn_...). Create one at notion.so → Settings → Connections.",
  );
  process.exit(1);
}

// Port the sidecar listens on. Must agree with NOTION_MCP_URL as dialed by the
// Python agent; both default to http://127.0.0.1:3001/mcp. Validated up front
// because it's passed
// as a `--port` arg to the spawn below, which uses a shell on Windows
// (`shell: isWindows`) — an unvalidated value with spaces/shell metacharacters
// could mangle or inject the command there. An empty string (a bare
// `NOTION_MCP_PORT=` in .env) is treated as unset → default.
const rawPort = process.env["NOTION_MCP_PORT"] || undefined;
if (rawPort !== undefined && !/^\d+$/.test(rawPort)) {
  console.error(
    `[notion-mcp] NOTION_MCP_PORT must be a positive integer (1–65535), got: ${JSON.stringify(rawPort)}`,
  );
  process.exit(1);
}
const portNumber = rawPort === undefined ? 3001 : Number(rawPort);
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
  console.error(
    `[notion-mcp] NOTION_MCP_PORT must be an integer between 1 and 65535, got: ${JSON.stringify(rawPort)}`,
  );
  process.exit(1);
}
const port = String(portNumber);

// Host the sidecar binds to. Defaults to loopback for local dev (matches the
// upstream server's own default). Validated because it's
// passed as a `--host` arg to the spawn below (which uses a shell on Windows,
// `shell: isWindows`), and to prevent a leading `-` being read as a flag.
const rawHost = process.env["NOTION_MCP_HOST"] || undefined;
// Must start with an alphanumeric or ":" (for IPv6 like "::") — this both keeps
// it shell-inert and prevents a leading-"-" value being consumed as a flag by
// the child CLI rather than as the host.
if (rawHost !== undefined && !/^[A-Za-z0-9:][A-Za-z0-9.:_-]*$/.test(rawHost)) {
  console.error(
    `[notion-mcp] NOTION_MCP_HOST must be a hostname or IP address starting ` +
      `with a letter, digit, or ":" (e.g. "::", "0.0.0.0", "localhost"), got: ` +
      `${JSON.stringify(rawHost)}`,
  );
  process.exit(1);
}
const host = rawHost ?? "127.0.0.1";

// Carry the Notion secret as the outbound `Authorization: Bearer` via
// OPENAPI_MCP_HEADERS. We deliberately do NOT set `Notion-Version` here: the
// server (@notionhq/notion-mcp-server ≥ 2.4) sources the API version
// per-operation from its bundled OpenAPI spec, and a globally-configured
// `Notion-Version` header would OVERRIDE those per-operation defaults, pinning
// every call to one (soon-stale) version and breaking newer endpoints. Leaving
// it out lets each operation use the version its schema was written for. (Set
// NOTION_VERSION only if you must force a specific version for an older server.)
const forcedVersion = process.env["NOTION_VERSION"];
const openApiHeaders = JSON.stringify({
  Authorization: `Bearer ${notionToken}`,
  ...(forcedVersion ? { "Notion-Version": forcedVersion } : {}),
});

// OPENAPI_MCP_HEADERS is our Notion auth source. It takes precedence anyway
// (the server's parseHeadersFromEnv checks OPENAPI_MCP_HEADERS before falling
// back to NOTION_TOKEN), so deleting NOTION_TOKEN from the child env is
// defensive cleanup: it removes the unused fallback and suppresses the server's
// NOTION_TOKEN startup diagnostic (a /v1/users/me probe). dotenv loaded it into
// process.env, so delete it after the spread.
const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  OPENAPI_MCP_HEADERS: openApiHeaders,
  AUTH_TOKEN: authToken,
};
delete childEnv["NOTION_TOKEN"];

const isWindows = process.platform === "win32";
const child = spawn(
  "npx",
  [
    "-y",
    "@notionhq/notion-mcp-server",
    "--transport",
    "http",
    "--host",
    host,
    "--port",
    port,
  ],
  {
    stdio: "inherit",
    // Windows only: shell:true so `npx` resolves to `npx.cmd`. Node refuses to
    // spawn `.cmd`/`.bat` without a shell (CVE-2024-27980) → `spawn EINVAL`. On
    // POSIX we spawn `npx` directly (no shell), which both removes the shell
    // wrapper entirely and lets `detached` put the server in its own process
    // group so we can signal the WHOLE tree on shutdown (see killTree below).
    shell: isWindows,
    detached: !isWindows,
    env: childEnv,
  },
);

// Set when WE forward a shutdown signal (below), so the exit handler can tell a
// clean, operator/platform-initiated stop from an abnormal termination.
let shuttingDown = false;
child.on("exit", (code, signal) => {
  // A shutdown WE initiated (SIGINT/SIGTERM forwarded below) is clean.
  if (shuttingDown) process.exit(0);
  // Anything else is an unexpected termination of a long-running server — a
  // FAILURE even on code 0 (e.g. the server exits after an unknown flag). Exit
  // non-zero and log so Railway's ON_FAILURE restart fires and it's visible;
  // preserve the child's own non-zero code when it has one.
  console.error(
    `[notion-mcp] sidecar exited unexpectedly (code=${code}, signal=${signal ?? "none"}) — treating as failure`,
  );
  process.exit(code || 1);
});
// Without this, a failed spawn (e.g. `npx` not on PATH -> ENOENT, or EACCES)
// surfaces as an uncaught 'error' event with a raw Node stack trace instead
// of the clean, actionable messages this script prints for every other
// misconfiguration.
child.on("error", (err) => {
  console.error("[notion-mcp] failed to start the sidecar:", err.message);
  process.exit(1);
});
// Signal the whole child tree. On POSIX the child is a detached group leader, so
// process.kill(-pid) reaches npx AND the underlying node server; on Windows we
// fall back to child.kill (no POSIX process groups). Wrapped because the group
// may already be gone (ESRCH) by the time the escalation fires.
const killTree = (sig: NodeJS.Signals) => {
  try {
    if (!isWindows && child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    // already exited — nothing to signal
  }
};
// Forward shutdown signals, then escalate to SIGKILL if the tree hasn't exited
// within a grace window. `.unref()` so this timer never keeps us alive.
const shutdown = (sig: NodeJS.Signals) => {
  shuttingDown = true;
  killTree(sig);
  setTimeout(() => killTree("SIGKILL"), 5000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
