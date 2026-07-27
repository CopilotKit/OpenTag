import { describe, expect, it } from "vitest";
import { CASES } from "../e2e/cases.js";

const pendingConfirmWriteMessage = {
  attachments: [
    {
      color: "#E2B340",
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "📝 Create Linear issue?" },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "🔒 Nothing is written until you click *Create*.",
            },
          ],
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "ck:create",
              text: { type: "plain_text", text: "Create" },
              value: JSON.stringify({ confirmed: true }),
            },
            {
              type: "button",
              action_id: "ck:cancel",
              text: { type: "plain_text", text: "Cancel" },
              value: JSON.stringify({ confirmed: false }),
            },
          ],
        },
      ],
    },
  ],
};

function caseWithPrefix(prefix: string) {
  const found = CASES.find(({ name }) => name.startsWith(prefix));
  if (!found) throw new Error(`missing E2E case ${prefix}`);
  return found;
}

describe("confirm_write E2E cases", () => {
  it("recognizes the actual initial Create/Cancel Block Kit card", () => {
    const hitl = caseWithPrefix("E-hitl-1");
    expect(
      hitl.expectations?.perReplyChecks?.(
        ["📝 Create Linear issue?"],
        [pendingConfirmWriteMessage],
      ),
    ).toEqual([]);
  });

  it("describes and validates serialized action IDs and resume values without claiming a restart", () => {
    const durable = caseWithPrefix("E-durable-1");
    expect(durable.name).not.toMatch(/restart|surviv/i);
    expect(
      durable.expectations?.perReplyChecks?.(
        ["📝 Create Linear issue?"],
        [pendingConfirmWriteMessage],
      ),
    ).toEqual([]);
  });
});
