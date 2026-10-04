/**
 * The mid-stream interrupt an E2E case schedules: a second user message sent `afterMs` into the
 * thread, so the bot is interrupted part-way through its first reply.
 *
 * It is handed back as something the caller has to cancel, because the delay is longer than a lot
 * of replies take. A case whose bot answers first would otherwise leave the timer armed, and the
 * runner would move on to the next case with it still ticking: the interrupt then arrives in a
 * thread nobody is watching any more, starts a bot turn nobody asked for, and appends its own
 * failure to a result that has already been reported.
 */
export type ScheduledInterrupt = {
  /** Stop the interrupt being sent. Safe to call more than once, and after it has fired. */
  cancel(): void;
};

export function scheduleInterrupt(
  afterMs: number,
  send: () => Promise<void>,
  onError: (message: string) => void,
): ScheduledInterrupt {
  const timer = setTimeout(() => {
    send().catch((error: Error) =>
      onError(`interrupt send failed: ${error.message}`),
    );
  }, afterMs);
  return {
    cancel() {
      clearTimeout(timer);
    },
  };
}