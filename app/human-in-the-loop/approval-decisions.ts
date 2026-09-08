import type { StateStore } from "@copilotkit/channels";

/** LangGraph assigns each interrupt a 128-bit lowercase hexadecimal ID. */
export const INTERRUPT_ID_PATTERN = /^[0-9a-f]{32}$/;

// Match the Channel's default action retention. Saved renders never recreate
// tokens; expired and consumed cards stay unusable after a runtime restart.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export function createApprovalDecisions(getStore: () => StateStore) {
  const currentKey = (conversation: string) => `opentag:approval:${conversation}`;
  const tokenKey = (conversation: string, id: string) =>
    `${currentKey(conversation)}:${id}`;

  return {
    async register(conversation: string): Promise<string> {
      const id = crypto.randomUUID();
      const store = getStore();
      await store.kv.set(tokenKey(conversation, id), true, RETENTION_MS);
      await store.kv.set(currentKey(conversation), id, RETENTION_MS);
      return id;
    },
    async claim(conversation: string, id: string): Promise<boolean> {
      const store = getStore();
      // The managed store's locks are process-local. Only consume is atomic
      // across runtimes, and its key must belong to this card: a stale click
      // must never consume a newer decision between a read and a delete.
      if ((await store.kv.consume(tokenKey(conversation, id))) !== true) {
        return false;
      }
      return (await store.kv.get(currentKey(conversation))) === id;
    },
  };
}
