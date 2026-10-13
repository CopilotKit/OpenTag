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
import {
  lookupConnectedAppProvider,
  normalizeArcadeTarget,
} from "./arcade-connect.js";
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
    // Which provider runs is decided by the agent, so it is asked rather than
    // guessed. This used to infer it from the shape of the name — a dotted
    // action meant Arcade, a bare app meant Composio — and the first live run
    // named an app on an Arcade deployment, so the card went to Composio,
    // which was not configured, and the click said so.
    const provider = await lookupConnectedAppProvider();
    if (provider === undefined) {
      return (
        "I could not check which connected-app service this deployment uses, " +
        "so no button was posted. Try again in a moment."
      );
    }
    if (provider === null) {
      return "No connected-app service is configured here, so there is nothing to connect.";
    }

    // Each provider has its own unit and its own rule for what is safe to
    // render in a public card. Composio connects an app, lowercase; Arcade
    // accepts an app or an action, case preserved.
    const arcadeTarget =
      provider === "arcade" ? normalizeArcadeTarget(toolkit) : null;
    const slug = provider === "composio" ? normalizeToolkit(toolkit) : null;
    if (arcadeTarget === null && slug === null) {
      return (
        "That is not something I can connect, so no button was posted. Use the " +
        "name exactly as the search reported it."
      );
    }

    const request =
      provider === "arcade"
        ? { target: arcadeTarget as string, provider: "arcade" as const }
        : { toolkit: slug as string, provider: "composio" as const };
    const label = requestLabel(request);

    await thread.post(<ConnectAccount request={request} />);
    return (
      `Posted a Connect ${label} button in this thread. Tell the person to press ` +
      `it; the link will be private to them. Do not claim the account is ` +
      `connected until a later message says so.`
    );
  },
});
