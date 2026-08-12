import { defineChannelTool } from "@copilotkit/channels";
import { z } from "zod";

export const unsubscribeThreadTool = defineChannelTool({
  name: "unsubscribe_thread",
  description:
    "Call only when a user clearly and explicitly asks to stop automatic " +
    "replies to future messages in this thread unless the agent is mentioned. " +
    "Ordinary questions, criticism, temporary pauses, and requests to stop or " +
    "pause only the current task do not qualify.",
  parameters: z.object({}),
  async handler(_args, { thread }) {
    await thread.unsubscribe();
    return "This thread is now mention-only; future replies require a mention.";
  },
});

export const subscribeThreadTool = defineChannelTool({
  name: "subscribe_thread",
  description:
    "Call only when a user clearly and explicitly asks to resume automatic " +
    "replies to future human messages in this thread without requiring a " +
    "mention. Ordinary questions, criticism, temporary pauses, and requests " +
    "to continue only the current task do not qualify.",
  parameters: z.object({}),
  async handler(_args, { thread }) {
    await thread.subscribe();
    return "This thread is subscribed; future human messages may receive replies without mentions.";
  },
});
