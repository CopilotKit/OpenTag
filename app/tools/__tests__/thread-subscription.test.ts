import type { ChannelToolContext } from "@copilotkit/channels";
import { describe, expect, it, vi } from "vitest";
import {
  subscribeThreadTool,
  unsubscribeThreadTool,
} from "../thread-subscription.js";

function makeContext() {
  const thread = {
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
  };

  return {
    thread,
    context: { thread } as unknown as ChannelToolContext,
  };
}

describe("thread subscription tools", () => {
  it("unsubscribes the current thread and returns a concise confirmation", async () => {
    const { thread, context } = makeContext();

    expect(unsubscribeThreadTool.name).toBe("unsubscribe_thread");
    expect(unsubscribeThreadTool.description).toMatch(/clearly and explicitly/i);
    expect(unsubscribeThreadTool.description).toMatch(/ordinary questions/i);
    expect(unsubscribeThreadTool.description).toMatch(/criticism/i);
    expect(unsubscribeThreadTool.description).toMatch(/temporary pauses/i);
    expect(unsubscribeThreadTool.parameters.safeParse({}).success).toBe(true);
    expect(
      unsubscribeThreadTool.parameters.safeParse({ reason: "quiet" }).data,
    ).toEqual({});

    await expect(unsubscribeThreadTool.handler({}, context)).resolves.toBe(
      "This thread is now mention-only; future replies require a mention.",
    );
    expect(thread.unsubscribe).toHaveBeenCalledTimes(1);
    expect(thread.subscribe).not.toHaveBeenCalled();
  });

  it("subscribes the current thread and returns a concise confirmation", async () => {
    const { thread, context } = makeContext();

    expect(subscribeThreadTool.name).toBe("subscribe_thread");
    expect(subscribeThreadTool.description).toMatch(/clearly and explicitly/i);
    expect(subscribeThreadTool.description).toMatch(/ordinary questions/i);
    expect(subscribeThreadTool.description).toMatch(/criticism/i);
    expect(subscribeThreadTool.description).toMatch(/temporary pauses/i);
    expect(subscribeThreadTool.parameters.safeParse({}).success).toBe(true);
    expect(
      subscribeThreadTool.parameters.safeParse({ reason: "resume" }).data,
    ).toEqual({});

    await expect(subscribeThreadTool.handler({}, context)).resolves.toBe(
      "This thread is subscribed; future human messages may receive replies without mentions.",
    );
    expect(thread.subscribe).toHaveBeenCalledTimes(1);
    expect(thread.unsubscribe).not.toHaveBeenCalled();
  });
});
