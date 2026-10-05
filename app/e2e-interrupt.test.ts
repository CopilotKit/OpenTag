import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleInterrupt } from "../e2e/interrupt.js";

describe("the mid-stream interrupt a case schedules", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is sent once the delay has passed", () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => {});

    scheduleInterrupt(15_000, send, () => {});
    vi.advanceTimersByTime(15_000);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("is not sent at all once the case has cancelled it", () => {
    /*
     * A reply that arrives before afterMs leaves the timer armed, and the runner moves on to the
     * next case. It then fires into a thread the runner is no longer watching: a message nobody
     * sent, a bot turn nobody asked for, and a failure appended to a result already reported.
     */
    vi.useFakeTimers();
    const send = vi.fn(async () => {});

    const interrupt = scheduleInterrupt(15_000, send, () => {});
    interrupt.cancel();
    vi.advanceTimersByTime(120_000);

    expect(send).not.toHaveBeenCalled();
  });

  it("reports a send that failed, and still only once", async () => {
    const errors: string[] = [];

    scheduleInterrupt(
      1,
      () => Promise.reject(new Error("thread_not_found")),
      (message) => errors.push(message),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(errors).toEqual(["interrupt send failed: thread_not_found"]);
  });

  it("can be cancelled after it has already fired without throwing", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async () => {});

    const interrupt = scheduleInterrupt(10, send, () => {});
    vi.advanceTimersByTime(10);
    interrupt.cancel();
    interrupt.cancel();

    expect(send).toHaveBeenCalledTimes(1);
  });
});