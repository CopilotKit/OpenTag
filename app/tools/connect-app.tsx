/**
 * `connect_app` — post the Connect button for one app.
 *
 * A channel tool rather than an interrupt. The agent's first attempt at this
 * raised an interrupt and resumed it immediately, on the reasoning that posting
 * a card is a render request and not a decision to wait on. The framework
 * disagrees for a good reason: `Thread.resume` requires a live interaction
 * continuation, which only a button click has. An interrupt handler has none, so
 * that call could only ever fail.
 *
 * A channel tool is the mechanism that actually fits. The agent decides *when*
 * to ask — it knows which apps are configured and which the search reported as
 * unconnected — and the surface does the posting, which is its job anyway.
 */
import { defineChannelTool } from "@copilotkit/channels";
import { z } from "zod";
import {
  ConnectAccount,
  requestLabel,
} from "../human-in-the-loop/connect-account.js";
import { normalizeAction } from "./arcade-connect.js";
import { normalizeToolkit } from "./composio-connect.js";

export const connectAppTool = defineChannelTool({
  name: "connect_app",
  description:
    "Post a Connect button so the person can connect their own account. Call " +
    "this when a connected-app search reports that something needs connecting, " +
    "naming it exactly as the search did. The button is public but the link it " +
    "produces is private to whoever presses it.",
  parameters: z.object({
    toolkit: z
      .string()
      .describe(
        "What to connect, exactly as the search reported it — an app like " +
          "'gmail', or a qualified action like 'Gmail.SendMail'",
      ),
  }),
  async handler({ toolkit }, { thread }) {
    if (!toolkit.trim()) return "Nothing was named, so no button was posted.";

    // The model chose this string and the card carrying it is a PUBLIC post
    // rendered as mrkdwn, where `<url|label>` is a live hyperlink and `*x*` is
    // bold. A toolkit is an identifier, so anything outside the identifier
    // charset is not a toolkit name and no card is posted for it. The rejected
    // value is not quoted back: the model repeats tool results to people, which
    // would put it on a rendered surface by a second route.
    // Which provider this deployment runs is decided by the agent, and the
    // shape of what it wants says which one answered: Arcade authorizes per
    // action and names one, Composio authorizes per app. Read from the value
    // rather than from configuration on this side, because a card records the
    // provider that minted it and must not be able to disagree with itself.
    const action = normalizeAction(toolkit);
    const slug = action === null ? normalizeToolkit(toolkit) : null;
    if (action === null && slug === null) {
      return (
        "That is not something I can connect, so no button was posted. Use the " +
        "name exactly as the search reported it — an app like 'gmail', or a " +
        "qualified action like 'Gmail.SendMail'."
      );
    }

    const request =
      action === null
        ? { toolkit: slug as string, provider: "composio" as const }
        : { target: action, provider: "arcade" as const };
    const label = requestLabel(request);

    await thread.post(<ConnectAccount request={request} />);
    return (
      `Posted a Connect ${label} button in this thread. Tell the person to press ` +
      `it; the link will be private to them. Do not claim the account is ` +
      `connected until a later message says so.`
    );
  },
});
