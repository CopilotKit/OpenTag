import { describe, expect, it, vi } from "vitest";
import { resolveTicketContext } from "../linear-ticket-args.js";

describe("resolveTicketContext", () => {
  it("returns args as-is when title and description are present", async () => {
    const ticket = await resolveTicketContext({
      issueId: "CPK-1",
      title: "T",
      description: "D",
      url: "https://linear.app/x/issue/CPK-1",
    });
    expect(ticket.title).toBe("T");
    expect(ticket.description).toBe("D");
  });

  it("enriches from Linear when fields are missing", async () => {
    const fetchDetails = vi.fn(async () => ({
      id: "uuid",
      identifier: "CPK-7630",
      title: "From API",
      description: "Body from API",
      url: "https://linear.app/x/issue/CPK-7630",
      status: "Todo",
      priority: "High",
      labels: ["bug"],
      commentsSummary: "- Ada: repro on staging",
    }));

    const ticket = await resolveTicketContext(
      { issueId: "CPK-7630" },
      { fetchDetails },
    );

    expect(fetchDetails).toHaveBeenCalledWith("CPK-7630");
    expect(ticket.issueId).toBe("CPK-7630");
    expect(ticket.title).toBe("From API");
    expect(ticket.description).toBe("Body from API");
    expect(ticket.agentContext).toContain("repro on staging");
  });
});
