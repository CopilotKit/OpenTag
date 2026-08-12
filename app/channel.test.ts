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
} from "@copilotkit/channels";
import {
  defaultSlackContext,
  defaultSlackTools,
  renderSlackMessage,
} from "@copilotkit/channels/slack";
import { appContext } from "./context/app-context.js";
import { appTools } from "./tools/index.js";
import { RenderChart } from "./tools/render-chart.js";
import { createOpenTagChannel } from "./channel.js";
import {
  subscribeThreadTool,
  unsubscribeThreadTool,
} from "./tools/thread-subscription.js";

class CapturingAgent extends FakeAgent {
  readonly calls: Array<RunAgentParameters | undefined>;
  readonly messageSnapshots: unknown[][];

  constructor(
    calls: Array<RunAgentParameters | undefined> = [],
    messageSnapshots: unknown[][] = [],
  ) {
    super();
    this.calls = calls;
    this.messageSnapshots = messageSnapshots;
  }

  override clone(): CapturingAgent {
    const cloned = new CapturingAgent(this.calls, this.messageSnapshots);
    cloned.threadId = this.threadId;
    cloned.agentId = this.agentId;
    cloned.messages = structuredClone(this.messages);
    cloned.state = structuredClone(this.state);
    return cloned;
  }

  override async runAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    this.calls.push(parameters);
    this.messageSnapshots.push(structuredClone(this.messages));
    return super.runAgent(parameters, subscriber);
  }
}

type AgentStep = (subscriber: AgentSubscriber) => void | Promise<void>;

class SharedScriptAgent extends FakeAgent {
  constructor(
    private readonly steps: AgentStep[],
    readonly calls: Array<RunAgentParameters | undefined> = [],
  ) {
    super();
  }

  override clone(): SharedScriptAgent {
    const cloned = new SharedScriptAgent(this.steps, this.calls);
    cloned.threadId = this.threadId;
    cloned.agentId = this.agentId;
    cloned.messages = structuredClone(this.messages);
    cloned.state = structuredClone(this.state);
    return cloned;
  }

  override async runAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    this.calls.push(parameters);
    const step = this.steps.shift();
    if (step && subscriber) await step(subscriber);
    return { result: undefined, newMessages: [] };
  }
}

function callTool(name: string, id: string): AgentStep {
  return (subscriber) => {
    subscriber.onToolCallEndEvent?.({
      event: { toolCallId: id },
      toolCallName: name,
      toolCallArgs: {},
    } as never);
  };
}

function toolNames(call: RunAgentParameters | undefined): string[] {
  return call?.tools?.map(({ name }) => name) ?? [];
}

const channels: Channel[] = [];

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
  await Promise.all(
    channels.splice(0).map((channel) => channel.ɵruntime.stop()),
  );
  vi.restoreAllMocks();
});

function makeChannel(options: { agent?: FakeAgent } = {}) {
  const adapter = new FakeAdapter({ platform: "intelligence" });
  const stateStore = new MemoryStore();
  adapter.stateStore = stateStore;
  const agent = options.agent ?? new CapturingAgent();
  const channel = createOpenTagChannel("opentag", agent);
  channel.ɵruntime.addAdapter(adapter);
  channels.push(channel);
  return { adapter, agent, channel, stateStore };
}

describe("createOpenTagChannel", () => {
  it("subscribes a new mentioned conversation and handles a later managed delivery", async () => {
    const { adapter, agent, channel, stateStore } = makeChannel();

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "mentioned-thread",
      replyTarget: {},
      userText: "@Kite help me triage this",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
      operation: {
        kind: "created",
        logicalMessageId: "m1",
        revisionId: "m1",
        mentioned: true,
      },
    });
    expect(await stateStore.kv.get<boolean>("sub:mentioned-thread")).toBe(true);
    expect(toolNames((agent as CapturingAgent).calls[0])).toContain(
      unsubscribeThreadTool.name,
    );
    expect(toolNames((agent as CapturingAgent).calls[0])).not.toContain(
      subscribeThreadTool.name,
    );

    await adapter.getSink().onTurn({
      conversationKey: "mentioned-thread",
      replyTarget: {},
      userText: "What should I do first?",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
      operation: {
        kind: "created",
        logicalMessageId: "m2",
        revisionId: "m2",
        mentioned: false,
      },
    });

    expect((agent as CapturingAgent).calls).toHaveLength(2);
    expect(toolNames((agent as CapturingAgent).calls[1])).toContain(
      unsubscribeThreadTool.name,
    );
  });

  it("keeps an existing unsubscribed conversation mention-only and offers subscribe", async () => {
    const { adapter, agent, channel, stateStore } = makeChannel();
    adapter.messages = [
      { text: "existing root", ts: "1" },
      { text: "@Kite answer this", ts: "2" },
    ];

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "existing-thread",
      replyTarget: {},
      userText: "@Kite answer this",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
      operation: {
        kind: "created",
        logicalMessageId: "m2",
        revisionId: "m2",
        mentioned: true,
      },
    });

    expect(await stateStore.kv.get<boolean>("sub:existing-thread")).toBeUndefined();
    expect(toolNames((agent as CapturingAgent).calls[0])).toContain(
      subscribeThreadTool.name,
    );
    expect(toolNames((agent as CapturingAgent).calls[0])).not.toContain(
      unsubscribeThreadTool.name,
    );
  });

  it("offers unsubscribe on a mention in an already subscribed conversation", async () => {
    const { adapter, agent, channel, stateStore } = makeChannel();
    await stateStore.kv.set("sub:subscribed-thread", true);

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "subscribed-thread",
      replyTarget: {},
      userText: "@Kite status?",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
      operation: {
        kind: "created",
        logicalMessageId: "m2",
        revisionId: "m2",
        mentioned: true,
      },
    });

    expect(toolNames((agent as CapturingAgent).calls[0])).toContain(
      unsubscribeThreadTool.name,
    );
    expect(toolNames((agent as CapturingAgent).calls[0])).not.toContain(
      subscribeThreadTool.name,
    );
  });

  it("falls back to a new conversation when history loading fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { adapter, agent, channel, stateStore } = makeChannel();
    adapter.getMessages = vi.fn(async () => {
      throw new Error("history unavailable");
    });

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "history-failure",
      replyTarget: {},
      userText: "@Kite help",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
      operation: {
        kind: "created",
        logicalMessageId: "m1",
        revisionId: "m1",
        mentioned: true,
      },
    });

    expect(await stateStore.kv.get<boolean>("sub:history-failure")).toBe(true);
    expect(toolNames((agent as CapturingAgent).calls[0])).toContain(
      unsubscribeThreadTool.name,
    );
    expect(consoleError).toHaveBeenCalledWith(
      "[channel] recoverable error",
      expect.objectContaining({
        context: {
          operation: "get_thread_history",
          recovery: "treat_as_new_conversation",
        },
      }),
    );
  });

  it("ignores unmentioned turns after unsubscribe and resumes them after subscribe", async () => {
    const agent = new SharedScriptAgent([
      callTool(unsubscribeThreadTool.name, "unsubscribe-1"),
      () => undefined,
      callTool(subscribeThreadTool.name, "subscribe-1"),
      () => undefined,
      () => undefined,
    ]);
    const { adapter, channel, stateStore } = makeChannel({ agent });

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "toggle-thread",
      replyTarget: {},
      userText: "@Kite only answer mentions from now on",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
      operation: {
        kind: "created",
        logicalMessageId: "m1",
        revisionId: "m1",
        mentioned: true,
      },
    });
    expect(await stateStore.kv.get<boolean>("sub:toggle-thread")).toBeUndefined();
    expect(toolNames(agent.calls[0])).toContain(unsubscribeThreadTool.name);

    await adapter.getSink().onTurn({
      conversationKey: "toggle-thread",
      replyTarget: {},
      userText: "this should be ignored",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
      operation: {
        kind: "created",
        logicalMessageId: "m2",
        revisionId: "m2",
        mentioned: false,
      },
    });
    expect(agent.calls).toHaveLength(2);

    adapter.messages = [
      { text: "existing root", ts: "1" },
      { text: "@Kite start following again", ts: "3" },
    ];
    await adapter.getSink().onTurn({
      conversationKey: "toggle-thread",
      replyTarget: {},
      userText: "@Kite start following again",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
      operation: {
        kind: "created",
        logicalMessageId: "m3",
        revisionId: "m3",
        mentioned: true,
      },
    });
    expect(await stateStore.kv.get<boolean>("sub:toggle-thread")).toBe(true);
    expect(toolNames(agent.calls[2])).toContain(subscribeThreadTool.name);

    await adapter.getSink().onTurn({
      conversationKey: "toggle-thread",
      replyTarget: {},
      userText: "this should run",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
      operation: {
        kind: "created",
        logicalMessageId: "m4",
        revisionId: "m4",
        mentioned: false,
      },
    });
    expect(agent.calls).toHaveLength(5);
    expect(toolNames(agent.calls[4])).toContain(unsubscribeThreadTool.name);
  });

  it.each(["bot", "app"] as const)(
    "ignores %s-authored messages in a subscribed thread",
    async (actorKind) => {
      const { adapter, agent, channel } = makeChannel();

      await channel.ɵruntime.start();
      await adapter.getSink().onTurn({
        conversationKey: "bot-loop-thread",
        replyTarget: {},
        userText: "@Kite join us",
        platform: "slack",
        actor: { id: "U1", kind: "human" },
        operation: {
          kind: "created",
          logicalMessageId: "m1",
          revisionId: "m1",
          mentioned: true,
        },
      });

      await adapter.getSink().onTurn({
        conversationKey: "bot-loop-thread",
        replyTarget: {},
        userText: "Canonical status confirmed: vibing cat it is.",
        platform: "slack",
        actor: { id: "B1", kind: actorKind },
        operation: {
          kind: "created",
          logicalMessageId: "m2",
          revisionId: "m2",
          mentioned: false,
        },
      });

      await adapter.getSink().onTurn({
        conversationKey: "bot-loop-thread",
        replyTarget: {},
        userText: "@Kite automated follow-up",
        platform: "slack",
        actor: { id: "B1", kind: actorKind },
        operation: {
          kind: "created",
          logicalMessageId: "m3",
          revisionId: "m3",
          mentioned: true,
        },
      });

      expect((agent as CapturingAgent).calls).toHaveLength(1);
    },
  );

  it("ignores an unmentioned turn in an unsubscribed thread", async () => {
    const { adapter, agent, channel } = makeChannel();

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "managed-thread",
      replyTarget: {},
      userText: "This thread is not subscribed",
      platform: "slack",
      actor: { id: "U2", kind: "human" },
      operation: {
        kind: "created",
        logicalMessageId: "m1",
        revisionId: "m1",
        mentioned: false,
      },
    });

    expect((agent as CapturingAgent).calls).toHaveLength(0);
  });

  it("declares one managed Channel and retains app commands", () => {
    const channel = createOpenTagChannel("custom-channel", new FakeAgent());
    channels.push(channel);

    expect(channel.name).toBe("custom-channel");
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
      "render_diagram",
      "render_table",
      "show_capabilities",
      "show_decision_brief",
      "show_incident",
      "show_knowledge_summary",
      "show_links",
      "show_status",
      "show_work_plan",
    ]);
    expect(RenderChart.name).toBe("render_chart");
    expect(appTools.map(({ name }) => name)).not.toContain("confirm_write");
  });

  it("renders render_chart through the registered Channel component", async () => {
    const agent = new FakeAgent([
      (subscriber) => {
        subscriber.onToolCallEndEvent?.({
          event: { toolCallId: "chart-1" },
          toolCallName: RenderChart.name,
          toolCallArgs: {
            title: "Incidents",
            chart: {
              type: "pie",
              segments: [
                { label: "SEV1", value: 2 },
                { label: "SEV2", value: 5 },
              ],
            },
          },
        } as never);
      },
      () => undefined,
    ]);
    const { adapter, channel } = makeChannel({ agent });

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "chart-thread",
      replyTarget: {},
      userText: "chart incidents by severity",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
    });

    expect(adapter.posted).toHaveLength(1);
    const { blocks } = renderSlackMessage(adapter.posted[0]!);
    expect(blocks[0]).toMatchObject({
      type: "data_visualization",
      title: "Incidents",
      chart: {
        type: "pie",
        segments: [
          { label: "SEV1", value: 2 },
          { label: "SEV2", value: 5 },
        ],
      },
    });
  });

  it("injects Slack defaults per managed Slack run", async () => {
    const { adapter, agent, channel } = makeChannel();

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "c1",
      replyTarget: {},
      userText: "hello",
      platform: "slack",
      actor: { id: "U1", kind: "human", name: "Ada" },
    });

    const call = (agent as CapturingAgent).calls[0];
    expect(call?.tools?.map(({ name }) => name).sort()).toEqual(
      [
        ...appTools.map(({ name }) => name),
        RenderChart.name,
        ...defaultSlackTools.map(({ name }) => name),
        unsubscribeThreadTool.name,
      ].sort(),
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
      conversationKey: "c1",
      replyTarget: {},
      userText: "hello",
      platform: "teams",
      actor: { id: "T1", kind: "human", name: "Ada" },
    });

    const call = (agent as CapturingAgent).calls[0];
    expect(call?.tools?.map(({ name }) => name).sort()).toEqual(
      [
        ...appTools.map(({ name }) => name),
        RenderChart.name,
        unsubscribeThreadTool.name,
      ].sort(),
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
      conversationKey: "c1",
      replyTarget: {},
      userText: "fallback text",
      contentParts: parts,
      platform: "slack",
      actor: { id: "U1", kind: "human" },
    });

    expect((agent as CapturingAgent).messageSnapshots.flat()).toContainEqual(
      expect.objectContaining({ role: "user", content: parts }),
    );
  });

  it("suggests knowledge-work prompts when a thread starts", async () => {
    const { adapter, channel } = makeChannel();

    await channel.ɵruntime.start();
    await adapter.emitThreadStarted({
      conversationKey: "c1",
      replyTarget: {},
      actor: { id: "U1", kind: "human", name: "Ada" },
    });

    expect(adapter.suggestedPromptsCalls[0]?.prompts).toEqual([
      {
        title: "Synthesize this discussion",
        message:
          "Summarize this thread into key findings, decisions, open questions, and next steps",
      },
      {
        title: "Help me make a decision",
        message:
          "Compare the options in this thread and recommend a path forward",
      },
    ]);
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
      actor: { id: "U1", kind: "human", name: "Ada" },
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
      conversationKey: "c1",
      replyTarget: {},
      userText: "hello",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
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
      conversationKey: "c1",
      replyTarget: {},
      userText: "file this",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
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

  it("renders the interrupt's fields as a table on the posted card", async () => {
    const envelope = {
      __copilotkit_interrupt_value__: {
        action: "confirm_write",
        args: {
          action: "Save project",
          fields: [
            { label: "Name", value: "OpenTag" },
            { label: "Lead", value: "jerel@copilotkit.ai" },
          ],
        },
      },
      __copilotkit_messages__: [],
    };
    const agent = new FakeAgent([
      (subscriber) => {
        subscriber.onCustomEvent?.({
          event: {
            type: EventType.CUSTOM,
            name: "on_interrupt",
            value: JSON.stringify(envelope),
          },
        } as never);
      },
    ]);
    const { adapter, channel } = makeChannel({ agent });

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "c1",
      replyTarget: {},
      userText: "save it",
      platform: "slack",
    });

    expect(adapter.posted).toHaveLength(1);
    const { blocks } = renderSlackMessage(adapter.posted[0]!);
    const table = blocks.find((b) => b.type === "table") as
      { rows: { text: string }[][] } | undefined;
    expect(table?.rows.map((row) => row.map((cell) => cell.text))).toEqual([
      ["Name", "OpenTag"],
      ["Lead", "jerel@copilotkit.ai"],
    ]);
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
      conversationKey: "c1",
      replyTarget: {},
      userText: "file this",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
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
      conversationKey: "c1",
      replyTarget: {},
      userText: "file this",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
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
    expect(secondAgent.calls).toHaveLength(1);
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
      (subscriber) => subscriber.onRunFinishedEvent?.({ event: {} } as never),
    ]);
    const firstChannel = createOpenTagChannel("opentag", firstAgent);
    firstChannel.ɵruntime.addAdapter(firstAdapter);
    channels.push(firstChannel);
    await firstChannel.ɵruntime.start();
    await firstAdapter.getSink().onTurn({
      conversationKey: "incident-thread",
      replyTarget: {},
      userText: "show the incident",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
    });

    const acknowledge = findIncidentButton(firstAdapter.posted[0]!, "ack");
    const actionId = (acknowledge?.props.onClick as { id?: string } | undefined)
      ?.id;
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
      actor: { id: "U2", kind: "human", name: "Ada" },
      value: { action: "ack", id: "INC-42" },
    });

    expect(secondAdapter.updated).toHaveLength(1);
    expect(JSON.stringify(secondAdapter.updated)).toContain(
      "Acknowledged · Checkout unavailable",
    );
    expect(JSON.stringify(secondAdapter.updated)).toContain("Ack'd by Ada");
  });
});
