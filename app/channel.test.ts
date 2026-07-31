import type {
  AgentSubscriber,
  RunAgentParameters,
  RunAgentResult,
} from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeAdapter,
  FakeAgent,
  MemoryStore,
  type Channel,
  type ChannelNode,
  type MessageOperation,
} from "@copilotkit/channels";
import {
  defaultSlackContext,
  defaultSlackTools,
  renderSlackMessage,
} from "@copilotkit/channels/slack";
import { appContext } from "./context/app-context.js";
import { appTools } from "./tools/index.js";
import { createOpenTagChannel } from "./channel.js";

/**
 * Run inputs observed by whichever agent instance actually executed.
 *
 * The Channel isolates the agent per turn (`isolateAgentInstance`), so a turn
 * runs on a clone and any state recorded on an instance field is invisible to
 * the original object the test holds. Recording outside the instance keeps the
 * assertions about what OpenTag *sent*, independent of clone semantics.
 */
interface RecordedRun {
  parameters?: RunAgentParameters;
  /** Snapshot at call time — the executing clone owns its own message log. */
  messages: FakeAgent["messages"];
}

const agentRuns: RecordedRun[] = [];

class CapturingAgent extends FakeAgent {
  /**
   * `FakeAgent.clone()` builds `new FakeAgent(...)`, which drops subclass
   * overrides — and the Channel runs every turn on a clone. Re-apply this
   * prototype so the recorder survives per-turn isolation.
   */
  override clone(): this {
    const cloned = super.clone();
    Object.setPrototypeOf(cloned, Object.getPrototypeOf(this));
    return cloned as this;
  }

  override async runAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    agentRuns.push({ parameters, messages: structuredClone(this.messages) });
    return super.runAgent(parameters, subscriber);
  }
}

const channels: Channel[] = [];

let turnSeq = 0;

// Managed turns carry provider-neutral revision identity. A plain inbound
// mention is a `created` revision that addresses the Channel; each turn needs
// its own logical id so revisions are never conflated.
function turnOperation(
  overrides: Partial<MessageOperation> = {},
): MessageOperation {
  turnSeq += 1;
  return {
    kind: "created",
    logicalMessageId: `m${turnSeq}`,
    revisionId: `m${turnSeq}r1`,
    mentioned: true,
    ...overrides,
  };
}

function confirmWriteEnvelope(
  action = "Create Linear issue",
  detail: string | null = "CPK-9: Checkout 500s",
) {
  return {
    __copilotkit_interrupt_value__: {
      action: "confirm_write",
      args: { action, detail },
    },
    __copilotkit_messages__: [
      {
        content: "",
        type: "ai",
        tool_calls: [
          {
            id: "tool-confirm-write",
            name: "confirm_write",
            args: { action, detail },
            type: "tool_call",
          },
        ],
      },
    ],
  };
}

function findButton(
  nodes: ChannelNode[],
  confirmed: boolean,
): ChannelNode | undefined {
  for (const node of nodes) {
    if (
      node.type === "button" &&
      (node.props.value as { confirmed?: boolean } | undefined)?.confirmed ===
        confirmed
    ) {
      return node;
    }
    const children = node.props.children;
    if (Array.isArray(children)) {
      const found = findButton(children as ChannelNode[], confirmed);
      if (found) return found;
    }
  }
  return undefined;
}

function findIncidentButton(
  nodes: ChannelNode[],
  action: "ack" | "escalate",
): ChannelNode | undefined {
  for (const node of nodes) {
    if (
      node.type === "button" &&
      (node.props.value as { action?: string } | undefined)?.action === action
    ) {
      return node;
    }
    const children = node.props.children;
    if (Array.isArray(children)) {
      const found = findIncidentButton(children as ChannelNode[], action);
      if (found) return found;
    }
  }
  return undefined;
}

afterEach(async () => {
  await Promise.all(channels.splice(0).map((channel) => channel.ɵruntime.stop()));
  agentRuns.length = 0;
  vi.restoreAllMocks();
});

function makeChannel(options: { agent?: FakeAgent } = {}) {
  const adapter = new FakeAdapter({ platform: "intelligence" });
  const agent = options.agent ?? new CapturingAgent();
  const channel = createOpenTagChannel("opentag", agent);
  channel.ɵruntime.addAdapter(adapter);
  channels.push(channel);
  return { adapter, agent, channel };
}

describe("createOpenTagChannel", () => {
  it("declares one managed Channel and retains app commands", () => {
    const channel = createOpenTagChannel("custom-channel", new FakeAgent());
    channels.push(channel);

    expect(channel.name).toBe("custom-channel");
    expect(channel.provider).toBeUndefined();
    expect(channel.adapters).toEqual([]);
    expect(channel.commandNames.sort()).toEqual([
      "agent",
      "file_issue",
      "preview",
      "triage",
    ]);
    expect(appTools.map(({ name }) => name).sort()).toEqual([
      "issue_card",
      "issue_list",
      "page_list",
      "read_thread",
      "render_chart",
      "render_diagram",
      "render_table",
      "show_incident",
      "show_links",
      "show_status",
    ]);
    expect(appTools.map(({ name }) => name)).not.toContain("confirm_write");
  });

  it("injects Slack defaults per managed Slack run", async () => {
    const { adapter, agent, channel } = makeChannel();

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      operation: turnOperation(),
      conversationKey: "c1",
      replyTarget: {},
      userText: "hello",
      platform: "slack",
      user: { id: "U1", name: "Ada" },
    });

    const call = agentRuns[0]?.parameters;
    expect(call?.tools?.map(({ name }) => name).sort()).toEqual(
      [...appTools, ...defaultSlackTools].map(({ name }) => name).sort(),
    );
    expect(call?.context).toEqual([
      ...appContext,
      ...defaultSlackContext,
      {
        description: "Requesting slack user",
        value: "Ada (slack id U1)",
      },
    ]);
  });

  it("does not inject Slack defaults into managed Teams", async () => {
    const { adapter, agent, channel } = makeChannel();

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      operation: turnOperation(),
      conversationKey: "c1",
      replyTarget: {},
      userText: "hello",
      platform: "teams",
      user: { id: "T1", name: "Ada" },
    });

    const call = agentRuns[0]?.parameters;
    expect(call?.tools?.map(({ name }) => name).sort()).toEqual(
      appTools.map(({ name }) => name).sort(),
    );
    expect(call?.context).toEqual([
      ...appContext,
      {
        description: "Requesting teams user",
        value: "Ada (teams id T1)",
      },
    ]);
  });

  it("injects managed content parts as the current agent prompt", async () => {
    const { adapter, agent, channel } = makeChannel();
    const parts = [{ type: "text" as const, text: "from content parts" }];

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      operation: turnOperation(),
      conversationKey: "c1",
      replyTarget: {},
      userText: "fallback text",
      contentParts: parts,
      platform: "slack",
      user: { id: "U1" },
    });

    expect(agentRuns[0]?.messages).toContainEqual(
      expect.objectContaining({ role: "user", content: parts }),
    );
  });

  it("personalizes suggested prompts when a thread starts", async () => {
    const { adapter, channel } = makeChannel();

    await channel.ɵruntime.start();
    await adapter.emitThreadStarted({
      conversationKey: "c1",
      replyTarget: {},
      user: { id: "U1", name: "Ada" },
    });

    expect(adapter.suggestedPromptsCalls[0]?.prompts[0]?.title).toBe(
      "Triage Ada's issues",
    );
  });

  it("surfaces a structured recoverable error when suggested prompts fail", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { adapter, channel } = makeChannel();
    adapter.setSuggestedPrompts = vi.fn(async () => {
      throw new Error("suggested prompts unavailable");
    });

    await channel.ɵruntime.start();
    await adapter.emitThreadStarted({
      conversationKey: "c1",
      replyTarget: {},
      user: { id: "U1", name: "Ada" },
    });

    expect(consoleError).toHaveBeenCalledWith(
      "[channel] recoverable error",
      expect.objectContaining({
        error: expect.any(Error),
        context: {
          operation: "set_suggested_prompts",
          recovery: "continue_without_suggested_prompts",
        },
        timestamp: expect.any(String),
      }),
    );
  });

  it("posts a user-facing error when the agent run fails", async () => {
    const error = new Error("agent unavailable");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { adapter, channel } = makeChannel({
      agent: new FakeAgent([
        () => {
          throw error;
        },
      ]),
    });

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      operation: turnOperation(),
      conversationKey: "c1",
      replyTarget: {},
      userText: "hello",
      platform: "slack",
      user: { id: "U1" },
    });

    expect(JSON.stringify(adapter.posted)).toMatch(/sorry.*error/i);
    expect(consoleError).toHaveBeenCalledWith(
      "[channel] recoverable error",
      expect.objectContaining({
        error,
        context: {
          operation: "run_agent",
          recovery: "posted_user_facing_error",
        },
        timestamp: expect.any(String),
      }),
    );
  });

  it("posts a real JSON-stringified confirm_write interrupt card and returns immediately", async () => {
    const agent = new FakeAgent([
      (subscriber) => {
        subscriber.onCustomEvent?.({
          event: {
            type: EventType.CUSTOM,
            name: "on_interrupt",
            value: JSON.stringify(confirmWriteEnvelope()),
          },
        } as never);
      },
    ]);
    const { adapter, channel } = makeChannel({
      agent,
    });

    await channel.ɵruntime.start();
    const turn = adapter.getSink().onTurn({
      operation: turnOperation(),
      conversationKey: "c1",
      replyTarget: {},
      userText: "file this",
      platform: "slack",
      user: { id: "U1" },
    });
    const result = await Promise.race([
      Promise.resolve(turn).then(() => "returned"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("blocked"), 100),
      ),
    ]);

    expect(result).toBe("returned");
    expect(adapter.posted).toHaveLength(1);
    const { blocks, accent } = renderSlackMessage(adapter.posted[0]!);
    expect(accent).toBe("#E2B340");
    expect(JSON.stringify(blocks)).toContain("Create Linear issue");
    expect(JSON.stringify(blocks)).toContain("CPK-9: Checkout 500s");
  });

  it("rejects malformed confirm_write interrupt payloads", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const agent = new FakeAgent([
      (subscriber) => {
        subscriber.onCustomEvent?.({
          event: {
            type: EventType.CUSTOM,
            name: "on_interrupt",
            value: JSON.stringify({
              ...confirmWriteEnvelope("Injected write"),
              __copilotkit_interrupt_value__: {
                action: "unexpected_action",
                args: { action: "Injected write" },
              },
            }),
          },
        } as never);
      },
    ]);
    const { adapter, channel } = makeChannel({
      agent,
    });

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      operation: turnOperation(),
      conversationKey: "c1",
      replyTarget: {},
      userText: "file this",
      platform: "slack",
      user: { id: "U1" },
    });

    expect(JSON.stringify(adapter.posted)).toMatch(/sorry.*error/i);
    expect(JSON.stringify(adapter.posted)).not.toContain("Injected write");
    consoleError.mockRestore();
  });

  it("re-registers confirm_write actions when a new Channel uses the same store", async () => {
    const sharedState = new MemoryStore();
    const firstAdapter = new FakeAdapter({ platform: "intelligence" });
    firstAdapter.stateStore = sharedState;
    const firstAgent = new FakeAgent([
      (subscriber) => {
        subscriber.onCustomEvent?.({
          event: {
            type: EventType.CUSTOM,
            name: "on_interrupt",
            value: confirmWriteEnvelope("Create Linear issue", "CPK-9"),
          },
        } as never);
      },
    ]);
    const firstChannel = createOpenTagChannel("opentag", firstAgent);
    firstChannel.ɵruntime.addAdapter(firstAdapter);
    channels.push(firstChannel);
    await firstChannel.ɵruntime.start();
    await firstAdapter.getSink().onTurn({
      operation: turnOperation(),
      conversationKey: "c1",
      replyTarget: {},
      userText: "file this",
      platform: "slack",
      user: { id: "U1" },
    });

    const createButton = findButton(firstAdapter.posted[0]!, true);
    expect(createButton).toBeDefined();
    const actionId = (
      createButton?.props.onClick as { id?: string } | undefined
    )?.id;
    expect(actionId).toMatch(/^ck:/);
    await firstChannel.ɵruntime.stop();

    const secondAdapter = new FakeAdapter({ platform: "intelligence" });
    secondAdapter.stateStore = sharedState;
    const secondAgent = new CapturingAgent();
    const secondChannel = createOpenTagChannel("opentag", secondAgent);
    secondChannel.ɵruntime.addAdapter(secondAdapter);
    channels.push(secondChannel);
    await secondChannel.ɵruntime.start();
    await secondAdapter.getSink().onInteraction({
      id: actionId!,
      conversationKey: "c1",
      replyTarget: {},
      messageRef: { id: "msg-1" },
      value: { confirmed: true },
    });

    expect(secondAdapter.updated).toHaveLength(1);
    expect(JSON.stringify(secondAdapter.updated)).toContain("Approved");
    expect(agentRuns).toHaveLength(1);
  });

  it("re-registers incident actions when a new Channel uses the same store", async () => {
    const sharedState = new MemoryStore();
    const firstAdapter = new FakeAdapter({ platform: "intelligence" });
    firstAdapter.stateStore = sharedState;
    const firstAgent = new FakeAgent([
      (subscriber) => {
        subscriber.onToolCallEndEvent?.({
          event: { toolCallId: "show-incident-1" },
          toolCallName: "show_incident",
          toolCallArgs: {
            id: "INC-42",
            title: "Checkout unavailable",
            severity: "SEV1",
            summary: "Requests are returning 500.",
          },
        } as never);
        subscriber.onRunFinishedEvent?.({ event: {} } as never);
      },
      (subscriber) =>
        subscriber.onRunFinishedEvent?.({ event: {} } as never),
    ]);
    const firstChannel = createOpenTagChannel("opentag", firstAgent);
    firstChannel.ɵruntime.addAdapter(firstAdapter);
    channels.push(firstChannel);
    await firstChannel.ɵruntime.start();
    await firstAdapter.getSink().onTurn({
      operation: turnOperation(),
      conversationKey: "incident-thread",
      replyTarget: {},
      userText: "show the incident",
      platform: "slack",
      user: { id: "U1" },
    });

    const acknowledge = findIncidentButton(firstAdapter.posted[0]!, "ack");
    const actionId = (
      acknowledge?.props.onClick as { id?: string } | undefined
    )?.id;
    expect(actionId).toMatch(/^ck:/);
    await firstChannel.ɵruntime.stop();

    const secondAdapter = new FakeAdapter({ platform: "intelligence" });
    secondAdapter.stateStore = sharedState;
    const secondChannel = createOpenTagChannel("opentag", new FakeAgent());
    secondChannel.ɵruntime.addAdapter(secondAdapter);
    channels.push(secondChannel);
    await secondChannel.ɵruntime.start();
    await secondAdapter.getSink().onInteraction({
      id: actionId!,
      conversationKey: "incident-thread",
      replyTarget: {},
      messageRef: { id: "incident-message" },
      user: { id: "U2", name: "Ada" },
      value: { action: "ack", id: "INC-42" },
    });

    expect(secondAdapter.updated).toHaveLength(1);
    expect(JSON.stringify(secondAdapter.updated)).toContain(
      "Acknowledged · Checkout unavailable",
    );
    expect(JSON.stringify(secondAdapter.updated)).toContain("Ack'd by Ada");
  });
});
