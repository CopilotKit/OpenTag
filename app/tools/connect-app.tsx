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
import { ConnectAccount } from "../human-in-the-loop/connect-account.js";
import { normalizeToolkit } from "./composio-connect.js";

export const connectAppTool = defineChannelTool({
  name: "connect_app",
  description:
    "Post a Connect button so the person can connect their own account for one " +
    "app. Call this when a connected-app search reports that an app needs " +
    "connecting, naming that app. The button is public but the link it produces " +
    "is private to whoever presses it.",
  parameters: z.object({
    toolkit: z
      .string()
      .describe("The app to connect, as the search reported it, e.g. 'gmail'"),
  }),
  async handler({ toolkit }, { thread }) {
    if (!toolkit.trim()) return "No app was named, so no button was posted.";

    // The model chose this string and the card carrying it is a PUBLIC post
    // rendered as mrkdwn, where `<url|label>` is a live hyperlink and `*x*` is
    // bold. A toolkit is an identifier, so anything outside the identifier
    // charset is not a toolkit name and no card is posted for it. The rejected
    // value is not quoted back: the model repeats tool results to people, which
    // would put it on a rendered surface by a second route.
    const slug = normalizeToolkit(toolkit);
    if (slug === null) {
      return (
        "That is not an app name, so no button was posted. App names are " +
        "lowercase identifiers like 'gmail' or 'google_calendar'; ask the " +
        "person which app they mean."
      );
    }

    await thread.post(<ConnectAccount toolkit={slug} />);
    return (
      `Posted a Connect ${slug} button in this thread. Tell the person to press ` +
      `it; the link will be private to them. Do not claim the account is ` +
      `connected until a later message says so.`
    );
  },
});
