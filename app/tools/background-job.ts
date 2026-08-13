/**
 * Fire-and-forget long sandbox jobs so the agent turn can finish immediately.
 *
 * Jobs still post results via `thread.post` when they complete. That path is
 * independent of managed delivery closing after the tool returns.
 */

/**
 * Start work without awaiting. Errors are logged; callers should still
 * surface a STARTED message to the user.
 */
export function runInBackground(
  label: string,
  work: () => Promise<unknown>,
): void {
  void work().catch((error) => {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[${label}] background job failed`, message);
  });
}
