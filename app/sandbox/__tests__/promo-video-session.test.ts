import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetOpentagSqlitePersistenceForTests } from "../opentag-persistence.js";
import {
  clearAllPromoSessions,
  clearIdleReap,
  clearPromoSession,
  getPromoSession,
  hasIdleReap,
  PROMO_VIDEO_IDLE_MS,
  scheduleIdleReap,
  setPromoSession,
} from "../promo-video-session.js";

describe("promo video session + idle", () => {
  const prev = process.env.OPENTAG_SQLITE_URL;

  beforeEach(async () => {
    vi.useFakeTimers();
    process.env.OPENTAG_SQLITE_URL = ":memory:";
    __resetOpentagSqlitePersistenceForTests();
    await clearAllPromoSessions();
  });

  afterEach(async () => {
    await clearAllPromoSessions();
    __resetOpentagSqlitePersistenceForTests();
    if (prev === undefined) delete process.env.OPENTAG_SQLITE_URL;
    else process.env.OPENTAG_SQLITE_URL = prev;
    vi.useRealTimers();
  });

  it("stores sessions by conversationKey", async () => {
    await setPromoSession({
      conversationKey: "t1",
      status: "ready",
      runId: "r1",
    });
    expect((await getPromoSession("t1"))?.runId).toBe("r1");
    await clearPromoSession("t1");
    expect(await getPromoSession("t1")).toBeUndefined();
  });

  it("fires idle after TTL and refreshes on reschedule", async () => {
    const onIdle = vi.fn();
    scheduleIdleReap("t1", onIdle, PROMO_VIDEO_IDLE_MS);
    await vi.advanceTimersByTimeAsync(PROMO_VIDEO_IDLE_MS - 1);
    expect(onIdle).not.toHaveBeenCalled();
    scheduleIdleReap("t1", onIdle, PROMO_VIDEO_IDLE_MS);
    await vi.advanceTimersByTimeAsync(PROMO_VIDEO_IDLE_MS - 1);
    expect(onIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onIdle).toHaveBeenCalledWith("t1");
  });

  it("clearIdleReap cancels the timer", async () => {
    const onIdle = vi.fn();
    scheduleIdleReap("t1", onIdle, PROMO_VIDEO_IDLE_MS);
    clearIdleReap("t1");
    expect(hasIdleReap("t1")).toBe(false);
    await vi.advanceTimersByTimeAsync(PROMO_VIDEO_IDLE_MS + 1000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("stores grokSessionId", async () => {
    await setPromoSession({
      conversationKey: "t1",
      status: "ready",
      grokSessionId: "sess-1",
    });
    expect((await getPromoSession("t1"))?.grokSessionId).toBe("sess-1");
  });

  it("returns grokSessionId after close and reopen of the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "promo-session-"));
    const file = join(dir, "opentag.sqlite");
    process.env.OPENTAG_SQLITE_URL = file;
    __resetOpentagSqlitePersistenceForTests();
    try {
      await setPromoSession({
        conversationKey: "slack:C:1.2",
        status: "ready",
        grokSessionId: "sess-persist",
      });
      __resetOpentagSqlitePersistenceForTests();
      const again = await getPromoSession("slack:C:1.2");
      expect(again?.grokSessionId).toBe("sess-persist");
      expect(again?.status).toBe("ready");
    } finally {
      __resetOpentagSqlitePersistenceForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
