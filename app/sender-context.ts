import type { ContextEntry, ProviderActor } from "@copilotkit/channels";

/**
 * Build the per-turn context naming the requesting user, so the agent can act
 * "as" them (filter Linear by their email, @-mention/tag them). The platform
 * adapter resolves `{ id, kind, name?, email? }` per turn; if it's absent there's
 * nothing to attribute, so we add no entry. `platform` is the source surface,
 * so the label is correct for managed Slack and Teams turns alike.
 */
export function senderContext(
  actor: ProviderActor | undefined,
  platform: string,
): ContextEntry[] {
  if (!actor?.id) return [];
  const label = `${actor.name ?? actor.id}${actor.email ? ` <${actor.email}>` : ""} (${platform} id ${actor.id})`;
  return [{ description: `Requesting ${platform} user`, value: label }];
}
