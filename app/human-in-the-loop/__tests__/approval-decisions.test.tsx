import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSubscriber, RunAgentParameters, RunAgentResult } from "@ag-ui/client";
import { createChannel, FakeAdapter, FakeAgent, MemoryStore, type Channel, type ChannelNode } from "@copilotkit/channels";
import { createOpenTagChannel } from "../../channel.js";
import { createApprovalDecisions } from "../approval-decisions.js";
import { createConfirmWrite } from "../confirm-write.js";

const ConfirmWrite = createConfirmWrite(async () => false);

type Step = (subscriber: AgentSubscriber) => void;
class RecordingAgent extends FakeAgent {
  constructor(readonly steps: Step[], readonly calls: Array<RunAgentParameters | undefined> = []) {
    super();
  }
  override clone() {
    const clone = new RecordingAgent(this.steps, this.calls);
    clone.threadId = this.threadId;
    clone.agentId = this.agentId;
    clone.messages = structuredClone(this.messages);
    clone.state = structuredClone(this.state);
    return clone;
  }
  override async runAgent(parameters?: RunAgentParameters, subscriber?: AgentSubscriber): Promise<RunAgentResult> {
    this.calls.push(parameters);
    const step = this.steps.shift();
    if (step && subscriber) step(subscriber);
    return { result: undefined, newMessages: [] };
  }
}

const channels: Channel[] = [];
afterEach(async () => {
  await Promise.all(channels.splice(0).map((channel) => channel.ɵruntime.stop()));
  vi.restoreAllMocks();
});

let interruptSequence = 0;
const interrupt: Step = (subscriber) => {
  subscriber.onCustomEvent?.({ event: {
    name: "on_interrupt",
    value: { __opentag_interrupt_id__: (++interruptSequence).toString(16).padStart(32, "0"), __copilotkit_interrupt_value__: {
      action: "confirm_write",
      args: { action: "Gmail send email", approver: "slack:alice", effect: "destructive" },
    } },
  } } as never);
};

function buttons(nodes: ChannelNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.type === "button" ? [String((node.props.onClick as { id: string }).id)] : []),
    ...buttons((node.props.children ?? []) as ChannelNode[]),
  ]);
}

async function runtime(store: MemoryStore, steps: Step[], legacy = false) {
  const adapter = new FakeAdapter({ platform: "slack" });
  adapter.stateStore = store;
  const agent = new RecordingAgent(steps);
  const channel = legacy
    ? createChannel({ name: "approval-tests", identifyUser: "platform", agent, adapters: [adapter], components: [ConfirmWrite] })
    : createOpenTagChannel("approval-tests", agent);
  if (legacy) {
    channel.onMention(async ({ thread }) => { await thread.runAgent(); });
    channel.onInterrupt("on_interrupt", async ({ thread }) => {
      await thread.post(<ConfirmWrite action="Gmail send email" approver="slack:alice" />);
    });
  } else {
    channel.ɵruntime.addAdapter(adapter);
  }
  channels.push(channel);
  await channel.ɵruntime.start();
  let event = 0;
  return {
    adapter, agent, channel,
    async turn() {
      await adapter.getSink().onTurn({
        conversationKey: "thread-1", replyTarget: {}, userText: "@OpenTag send email", platform: "slack",
        actor: { id: "alice", kind: "human" },
        operation: { kind: "created", logicalMessageId: `m${++event}`, revisionId: `r${event}`, mentioned: true },
      });
    },
    async click(id: string, conversationKey = "thread-1") {
      await adapter.getSink().onInteraction({
        id, conversationKey, replyTarget: {}, messageRef: { id: "card-1" },
        eventId: `click-${crypto.randomUUID()}`, actor: { id: "alice", kind: "human" },
      });
    },
  };
}

describe("approval decisions through the SDK", () => {
  it("targets the original interrupt when a newer turn pauses during the old card's update", async () => {
    const current = await runtime(new MemoryStore(), [interrupt, interrupt]);
    await current.turn();
    const oldId = interruptSequence.toString(16).padStart(32, "0");
    const [approve] = buttons(current.adapter.posted[0]!);
    let unblock!: () => void;
    let entered!: () => void;
    const updating = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const update = current.adapter.update.bind(current.adapter);
    vi.spyOn(current.adapter, "update").mockImplementationOnce(async (ref, nodes) => {
      entered();
      await blocked;
      return update(ref, nodes);
    });
    const click = current.click(approve!);
    await updating;
    await current.turn();
    const newId = interruptSequence.toString(16).padStart(32, "0");
    expect(newId).not.toBe(oldId);
    unblock();
    await click;
    expect(current.agent.calls).toHaveLength(3);
    expect(current.agent.calls[2]?.forwardedProps?.command).toMatchObject({
      resume: { [oldId]: { confirmed: true } },
    });
    expect(current.agent.calls[2]?.forwardedProps?.command?.resume).not.toHaveProperty(newId);
    expect(current.agent.calls[2]?.forwardedProps?.command?.resume).not.toHaveProperty("confirmed");
  });

  it("refuses a wrong conversation before consuming the original card", async () => {
    const current = await runtime(new MemoryStore(), [interrupt]);
    await current.turn();
    const [approve] = buttons(current.adapter.posted[0]!);
    await current.click(approve!, "different-thread");
    expect(current.agent.calls).toHaveLength(1);
    await current.click(approve!);
    expect(current.agent.calls).toHaveLength(2);
  });

  it("posts no actionable card for an agent that sends no interrupt ID", async () => {
    const uncorrelated: Step = (subscriber) => {
      subscriber.onCustomEvent?.({ event: {
        name: "on_interrupt",
        value: { __copilotkit_interrupt_value__: {
          action: "confirm_write", args: { action: "Send email" },
        } },
      } } as never);
    };
    const current = await runtime(new MemoryStore(), [uncorrelated]);
    await current.turn();
    expect(buttons(current.adapter.posted.flat())).toHaveLength(0);
    expect(JSON.stringify(current.adapter.posted)).toContain("Update the agent");
  });

  it("cannot consume a new card's token when separate runtimes interleave registration and a stale claim", async () => {
    const shared = new MemoryStore();
    const firstStore = new MemoryStore();
    const otherStore = new MemoryStore();
    firstStore.kv = shared.kv;
    otherStore.kv = shared.kv;
    const first = createApprovalDecisions(() => firstStore);
    const other = createApprovalDecisions(() => otherStore);
    const oldId = await first.register("thread");
    const consume = shared.kv.consume.bind(shared.kv);
    let newId = "";
    vi.spyOn(shared.kv, "consume").mockImplementationOnce(async (key) => {
      newId = await other.register("thread");
      return consume(key);
    });
    expect(await first.claim("thread", oldId)).toBe(false);
    expect(await other.claim("thread", newId)).toBe(true);
    expect(await first.claim("thread", newId)).toBe(false);
  });

  it.each([true, false])("keeps both restored buttons on one decision (first confirmed=%s)", async (confirmed) => {
    const store = new MemoryStore();
    const first = await runtime(store, [interrupt]);
    await first.turn();
    const [approve, cancel] = buttons(first.adapter.posted[0]!);
    const firstId = interruptSequence.toString(16).padStart(32, "0");
    await first.channel.ɵruntime.stop();

    const restored = await runtime(store, [interrupt]);
    await restored.click(confirmed ? approve! : cancel!);
    expect(restored.agent.calls).toHaveLength(1);
    expect(restored.agent.calls[0]?.forwardedProps?.command).toMatchObject({ resume: { [firstId]: { confirmed } } });
    await restored.click(confirmed ? cancel! : approve!);
    expect(restored.agent.calls).toHaveLength(1);
    expect(JSON.stringify(restored.adapter.ephemeralPosts)).toContain("already been answered");
    const [nextApprove] = buttons(restored.adapter.posted[0]!);
    const nextId = interruptSequence.toString(16).padStart(32, "0");
    await restored.click(nextApprove!);
    expect(restored.agent.calls).toHaveLength(2);
    expect(restored.agent.calls[1]?.forwardedProps?.command).toMatchObject({ resume: { [nextId]: { confirmed: true } } });
  });

  it("allows only one simultaneous restored button to resume", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new MemoryStore();
    const first = await runtime(store, [interrupt]);
    await first.turn();
    const ids = buttons(first.adapter.posted[0]!);
    await first.channel.ɵruntime.stop();
    const restored = await runtime(store, []);
    await Promise.all(ids.map((id) => restored.click(id)));
    expect(restored.agent.calls).toHaveLength(1);
  });

  it("keeps the decision spent when updating the card fails, including after another restart", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new MemoryStore();
    const first = await runtime(store, [interrupt]);
    await first.turn();
    const [approve, cancel] = buttons(first.adapter.posted[0]!);
    vi.spyOn(first.adapter, "update").mockRejectedValue(new Error("Slack unavailable"));
    await first.click(approve!);
    expect(first.agent.calls).toHaveLength(2);
    await first.channel.ɵruntime.stop();
    const restored = await runtime(store, []);
    await restored.click(cancel!);
    expect(restored.agent.calls).toHaveLength(0);
  });

  it("does not let a superseded card consume the current decision", async () => {
    const current = await runtime(new MemoryStore(), [interrupt, interrupt]);
    await current.turn();
    const [stale] = buttons(current.adapter.posted[0]!);
    await current.turn();
    const [latest] = buttons(current.adapter.posted[1]!);
    await current.click(stale!);
    expect(current.agent.calls).toHaveLength(2);
    await current.click(latest!);
    expect(current.agent.calls).toHaveLength(3);
  });

  it("refuses legacy saved cards that have no durable decision ID", async () => {
    const store = new MemoryStore();
    const first = await runtime(store, [interrupt], true);
    await first.turn();
    const [approve] = buttons(first.adapter.posted[0]!);
    await first.channel.ɵruntime.stop();
    const restored = await runtime(store, []);
    await restored.click(approve!);
    expect(restored.agent.calls).toHaveLength(0);
    expect(JSON.stringify(restored.adapter.posted)).toContain("fresh card");
  });

  it("fails closed when claiming the persisted decision is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new MemoryStore();
    const current = await runtime(store, [interrupt]);
    await current.turn();
    const [approve] = buttons(current.adapter.posted[0]!);
    vi.spyOn(store.kv, "consume").mockRejectedValue(new Error("store unavailable"));
    await current.click(approve!);
    expect(current.agent.calls).toHaveLength(1);
    expect(JSON.stringify(current.adapter.posted)).toContain("did not send your answer");
  });
});
