import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setLinearFixJobForTests,
  fixLinearTicketTool,
} from "../fix-linear-ticket.js";

describe("fix_linear_ticket tool", () => {
  afterEach(() => {
    __setLinearFixJobForTests(null);
  });

  it("posts On it and starts the job in the background", async () => {
    const job = vi.fn(async () => {
      throw new Error("job must not be awaited");
    });
    __setLinearFixJobForTests(job as never);

    const post = vi.fn(async () => ({}));
    const result = await fixLinearTicketTool.handler(
      {
        issueId: "ENG-7",
        title: "Bug",
        description: "Desc",
        url: "https://linear.app/x/issue/ENG-7",
      },
      {
        thread: { post, conversationKey: "slack:C:lf" },
      } as never,
    );

    expect(result).toMatch(/STARTED/i);
    expect(result).toMatch(/runId=/i);
    expect(result).toContain("ENG-7");
    expect(post).toHaveBeenCalledWith(expect.stringContaining("fixing Linear"));
    expect(job).toHaveBeenCalledOnce();
    expect(job).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationKey: "slack:C:lf",
        runId: expect.any(String),
      }),
    );
  });
});
