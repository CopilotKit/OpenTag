import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setLinearTriageJobForTests,
  investigateLinearTicketTool,
} from "../investigate-linear-ticket.js";

describe("investigate_linear_ticket tool", () => {
  afterEach(() => {
    __setLinearTriageJobForTests(null);
  });

  it("posts On it and starts the job in the background", async () => {
    const job = vi.fn(async () => {
      throw new Error("job must not be awaited");
    });
    __setLinearTriageJobForTests(job as never);

    const post = vi.fn(async () => ({}));
    const result = await investigateLinearTicketTool.handler(
      {
        issueId: "CPK-7630",
        title: "Bug",
        description: "Desc",
        url: "https://linear.app/x/issue/CPK-7630",
      },
      {
        thread: { post, conversationKey: "slack:C:lt" },
      } as never,
    );

    expect(result).toMatch(/STARTED/i);
    expect(result).toMatch(/runId=/i);
    expect(result).toContain("CPK-7630");
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining("investigating Linear"),
    );
    expect(job).toHaveBeenCalledOnce();
    expect(job).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "slack:C:lt",
        runId: expect.any(String),
      }),
    );
  });
});
