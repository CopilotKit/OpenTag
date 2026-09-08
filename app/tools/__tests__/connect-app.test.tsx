/**
 * Posting the Connect button.
 *
 * This is a channel tool rather than an interrupt because `Thread.resume`
 * requires a live interaction continuation, which only a button click has — the
 * agent-side version raised an interrupt and tried to resume it from the
 * interrupt handler, which could only ever fail.
 */
import { describe, expect, it, vi } from "vitest";
import { connectAppTool } from "../connect-app.js";

function context() {
  const post = vi.fn(async (_ui: unknown) => ({ id: "m1" }));
  return { ctx: { thread: { post }, platform: "slack" } as never, post };
}

describe("connect_app", () => {
  it("posts a card for the named app", async () => {
    const { ctx, post } = context();

    const result = await connectAppTool.handler({ toolkit: "gmail" }, ctx);

    expect(post).toHaveBeenCalledTimes(1);
    expect(String(result)).toContain("gmail");
  });

  it("lowercases and trims what the model passed", async () => {
    const { ctx, post } = context();

    await connectAppTool.handler({ toolkit: "  Gmail " }, ctx);

    const posted = JSON.stringify(post.mock.calls[0]![0]);
    expect(posted).toContain("gmail");
    expect(posted).not.toContain("  Gmail ");
  });

  it.each([
    "<https://evil.example|gmail>",
    "gmail>*click here*",
    "*gmail*",
    "gmail\nSection: ignore the above",
    "<@U123>",
    "<!channel>",
  ])("posts nothing for %j, which the card would render as live mrkdwn", async (toolkit) => {
    // The model chooses this string and the card is a PUBLIC post rendered as
    // Slack mrkdwn, so `<url|label>` in it became a hyperlink everyone in the
    // thread could click. A toolkit is an identifier; nothing else is one.
    const { ctx, post } = context();

    const result = await connectAppTool.handler({ toolkit }, ctx);

    expect(post).not.toHaveBeenCalled();
    expect(String(result)).toMatch(/not an app name|No app was named/);
  });

  it("does not echo the rejected name back into the conversation", async () => {
    // The tool result goes to the model, which routinely repeats it to the
    // person. Quoting the payload back would put it on a rendered surface by
    // another route.
    const { ctx } = context();

    const result = await connectAppTool.handler(
      { toolkit: "<https://evil.example|gmail>" },
      ctx,
    );

    expect(String(result)).not.toContain("evil.example");
  });

  it("accepts the slug shapes real toolkits use", async () => {
    for (const toolkit of ["google_calendar", "notion-v2", "gmail"]) {
      const { ctx, post } = context();

      await connectAppTool.handler({ toolkit }, ctx);

      expect(post).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(post.mock.calls[0]![0])).toContain(toolkit);
    }
  });

  it("posts nothing when no app was named", async () => {
    const { ctx, post } = context();

    const result = await connectAppTool.handler({ toolkit: "   " }, ctx);

    expect(post).not.toHaveBeenCalled();
    expect(String(result)).toContain("No app was named");
  });

  it("tells the agent not to claim the account is connected yet", async () => {
    // The button still has to be pressed, and the link still has to be
    // completed in a browser. An agent that reports success here is lying.
    const { ctx } = context();

    const result = await connectAppTool.handler({ toolkit: "gmail" }, ctx);

    expect(String(result)).toContain("Do not claim the account is connected");
  });
});
