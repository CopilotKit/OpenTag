/**
 * `joke-card` — a reaction demo authored with the `@copilotkit/channels-ui` JSX
 * vocabulary. The card carries its OWN reaction handler via `<Message
 * onReaction>`: react 👍 on it and the per-message handler posts a joke.
 *
 * This is the managed-path proof for the JSX reaction path: the handler is
 * attached to the POSTED message (not a global `bot.onReaction`), so it's
 * registered/persisted under the post-time message ref and must be resolved
 * when a later reaction arrives keyed by the provider ts — which app-api now
 * reverse-maps (ts → ref) so the SDK can find it. Self-contained: needs no
 * message text or thread history (which the managed path doesn't reconstruct).
 */
import { Context, Message, Section } from "@copilotkit/channels-ui";
import type { BotNode } from "@copilotkit/channels-ui";

export const JOKES = [
  "Why do programmers prefer dark mode? Because light attracts bugs.",
  "There are 10 kinds of people: those who understand binary and those who don't.",
  "I would tell you a UDP joke, but you might not get it.",
  "A SQL query walks into a bar, walks up to two tables and asks: 'Can I join you?'",
  "Why did the developer go broke? He used up all his cache.",
  "How many programmers to change a light bulb? None — that's a hardware problem.",
  "Debugging: being the detective in a crime movie where you're also the murderer.",
];

export const pickJoke = (): string =>
  JOKES[Math.floor(Math.random() * JOKES.length)]!;

/** Slack shortnames for 👍 (arrives as `event.reaction`, without colons). */
const THUMBS_UP = new Set(["+1", "thumbsup"]);

/** A card whose OWN `<Message onReaction>` tells a joke when you react 👍. */
export function JokeCard(): BotNode {
  return (
    <Message
      onReaction={async (_emoji, reaction) => {
        // Fire only when 👍 is ADDED (ignore removes + every other emoji).
        if (!reaction.added || !THUMBS_UP.has(reaction.rawEmoji)) return;
        await reaction.thread.post(`🃏 (per-message handler) ${pickJoke()}`);
      }}
    >
      <Section>
        {"React 👍 on this card and its own handler will tell you a joke."}
      </Section>
      <Context>{"_(🔄 on any message uses the global handler instead)_"}</Context>
    </Message>
  );
}
