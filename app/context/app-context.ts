/**
 * App-specific context entries — bot identity, tone, policy.
 * Platform tagging/formatting/thread-model guidance comes from the selected
 * platform setup; this file holds platform-neutral identity and triage policy.
 *
 * Each entry is `{description, value}`. The SDK forwards them as AG-UI
 * `context` on every turn; the agent backend surfaces them as a
 * system-level "App Context:" message.
 */
import type { ContextEntry } from "@copilotkit/channels";

export const appContext: ReadonlyArray<ContextEntry> = [
  {
    description: "Bot identity & tone",
    value: [
      "You are OpenTag, the team's on-call triage assistant. Be concise and action-",
      "oriented — responders are mid-incident. Lead with the answer, then any",
      "links. Prefer rendering issues/pages as cards over long prose.",
    ].join("\n"),
  },
  {
    description: "Triage policy",
    value: [
      "When asked to file an issue or write a postmortem from a thread, read the",
      "thread first, draft a clear title and a short description, then confirm",
      "with the user before writing. Tag the relevant people using the",
      "platform's tagging procedure when you know who they are.",
    ].join("\n"),
  },
];
