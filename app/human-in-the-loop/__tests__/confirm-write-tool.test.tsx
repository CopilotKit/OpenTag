import { describe, it, expect } from "vitest";
import { renderToIR, type BotNode } from "@copilotkit/bot-ui";
import { renderSlackMessage } from "@copilotkit/bot-slack";
import { confirmWriteTool } from "../confirm-write-tool.js";

/** A fake thread whose `awaitChoice` records the posted UI and returns a fixed choice. */
function fakeThread(choice: unknown) {
  const awaited: unknown[] = [];
  const thread = {
    async awaitChoice(ui: unknown) {
      awaited.push(ui);
      return choice;
    },
  };
  return { thread, awaited };
}

describe("confirm_write tool", () => {
  it("posts a ConfirmWrite picker and returns the resolved {confirmed:true}", async () => {
    const { thread, awaited } = fakeThread({ confirmed: true });

    const result = await confirmWriteTool.handler(
      {
        action: "Create Linear issue",
        detail: "CPK-9: Checkout 500s under load",
      },
      { thread, platform: "slack" } as never,
    );

    expect(result).toBe("The user APPROVED the write — proceed.");

    // The posted UI is a ConfirmWrite picker: amber accent + header carrying the action.
    expect(awaited).toHaveLength(1);
    const { blocks, accent } = renderSlackMessage(
      renderToIR(awaited[0] as BotNode),
    );
    expect(accent).toBe("#E2B340");
    const header = blocks.find((b) => b.type === "header") as
      | { text: { text: string } }
      | undefined;
    expect(header?.text.text).toContain("Create Linear issue");
  });

  it("returns {confirmed:false} when the user declines", async () => {
    const { thread } = fakeThread({ confirmed: false });

    const result = await confirmWriteTool.handler(
      { action: "Create Linear issue" },
      { thread, platform: "slack" } as never,
    );

    expect(result).toBe(
      "The user DECLINED — do not write; acknowledge and stop.",
    );
  });

  it("managed (no blocking choice): posts the picker and ends the turn without blocking", async () => {
    const posted: unknown[] = [];
    let awaitChoiceCalled = false;
    const thread = {
      supportsBlockingChoice: false,
      async post(ui: unknown) {
        posted.push(ui);
        return { id: "m1" };
      },
      async awaitChoice() {
        awaitChoiceCalled = true;
        return { confirmed: true };
      },
    };

    const result = await confirmWriteTool.handler(
      { action: "Create Linear issue", detail: "CPK-9: Checkout 500s" },
      { thread, platform: "slack" } as never,
    );

    // Must NOT block on a managed surface (that would deadlock the claim loop).
    expect(awaitChoiceCalled).toBe(false);
    // Posts the ConfirmWrite picker (amber accent, action in header).
    expect(posted).toHaveLength(1);
    const { blocks, accent } = renderSlackMessage(
      renderToIR(posted[0] as BotNode),
    );
    expect(accent).toBe("#E2B340");
    const header = blocks.find((b) => b.type === "header") as
      | { text: { text: string } }
      | undefined;
    expect(header?.text.text).toContain("Create Linear issue");
    // Returns a sentinel telling the agent to stop and wait for the follow-up.
    expect(result).toMatch(/posted/i);
    expect(result).toMatch(/STOP|stop/);
  });
});
