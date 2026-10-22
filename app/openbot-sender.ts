import type {
  ApplicationUser,
  ChannelConversation,
  ChannelIdentityContext,
  ContextEntry,
  IncomingMessage,
} from "@copilotkit/channels";

/**
 * The context entry OpenBot reads to learn who a turn is from, when OpenBot is
 * the agent at `AGENT_URL` (`OPENBOT_PAIRING`).
 *
 * OpenBot accepts exactly one entry under this name and refuses the turn
 * without it, so the human-readable sender label stays beside it for every
 * other agent. The shape is OpenBot's `senderFromContext`
 * (`server/src/delivery/opentag.ts`): `user` is the Channel's own
 * `provider:tenant:actor` id, and the conversation is what decides whether a
 * reply may draw on the person's private context and whether a link code may
 * be redeemed, so it is sent as the provider reported it or not at all.
 */
export const OPENBOT_SENDER_CONTEXT = "openbot.sender";

type TurnConversation = { id: string; kind?: string };

/**
 * Remembers each turn's conversation between identity resolution and the
 * handler.
 *
 * The managed Channel tells `identifyUser` which conversation a turn is in and
 * then hands the handler a message without it. `identifyUser` therefore stands
 * in for the `"platform"` strategy, returning the same person, and notes the
 * conversation under the turn's event id for the handler to take. Turns the
 * handler drops (a bot, an edit) are never taken, so the oldest are forgotten
 * past `limit`.
 */
export function createTurnConversations(limit = 1_000) {
  const conversations = new Map<string, TurnConversation>();

  return {
    async identifyUser(
      context: ChannelIdentityContext,
    ): Promise<ApplicationUser | null> {
      const eventId = context.event.id;
      if (eventId && context.conversation.id) {
        conversations.delete(eventId);
        conversations.set(eventId, conversationOf(context.conversation));
        while (conversations.size > limit) {
          const oldest = conversations.keys().next().value;
          if (oldest === undefined) break;
          conversations.delete(oldest);
        }
      }
      // The `"platform"` strategy, unchanged: OpenTag's per-person identity and
      // OpenBot's identity links are both keyed on this id.
      if (context.actor.kind !== "human") return null;
      return {
        id: [context.provider, context.tenant.id, context.actor.id].join(":"),
        name: context.actor.name ?? context.actor.handle ?? context.actor.id,
      };
    },

    take(eventId: string | undefined): TurnConversation | undefined {
      if (!eventId) return undefined;
      const conversation = conversations.get(eventId);
      conversations.delete(eventId);
      return conversation;
    },
  };
}

function conversationOf(conversation: ChannelConversation): TurnConversation {
  return conversation.kind
    ? { id: conversation.id, kind: conversation.kind }
    : { id: conversation.id };
}

export type TurnConversations = ReturnType<typeof createTurnConversations>;

/** The `openbot.sender` entry for one turn, or none when no person was named. */
export function openbotSenderContext(
  message: Pick<IncomingMessage, "user" | "eventId"> & {
    operation?: { mentioned: boolean };
  },
  conversation: TurnConversation | undefined,
): ContextEntry[] {
  if (!message.user) return [];
  const sender = {
    user: message.user.id,
    ...(message.eventId ? { event: message.eventId } : {}),
    mentioned: message.operation?.mentioned === true,
    ...(conversation ? { conversation } : {}),
  };
  return [{ description: OPENBOT_SENDER_CONTEXT, value: JSON.stringify(sender) }];
}
