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
  extraArgs: Record<string, unknown> = {},
) {
  return {
    __opentag_interrupt_id__: crypto.randomUUID().replaceAll("-", ""),
    __copilotkit_interrupt_value__: {
      action: "confirm_write",
      args: { action, detail, ...extraArgs },
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

/** The Connect button carrying one toolkit, anywhere in a posted card. */
function findButtonByToolkit(
  nodes: ChannelNode[],
  toolkit: string,
): ChannelNode | undefined {
  for (const node of nodes) {
    if (
      node.type === "button" &&
      (node.props.value as { toolkit?: string } | undefined)?.toolkit === toolkit
    ) {
      return node;
    }
    const children = node.props.children;
    if (Array.isArray(children)) {
      const found = findButtonByToolkit(children as ChannelNode[], toolkit);
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
  // Here rather than at the end of the one test that stubs, because the end of
  // a test is exactly where a failing test does not reach: a stubbed
  // `AGENT_URL` would then leak into every test after it, and the suite would
  // report the leak as a second failure somewhere unrelated.
  vi.unstubAllEnvs();
});

function makeChannel(
  options: { agent?: FakeAgent; agentDisplayName?: string } = {},
) {
  const adapter = new FakeAdapter({ platform: "intelligence" });
  const stateStore = new MemoryStore();
  adapter.stateStore = stateStore;
  const agent = options.agent ?? new CapturingAgent();
  const channel = createOpenTagChannel(
    "opentag",
    agent,
    options.agentDisplayName,
  );
  channel.ɵruntime.addAdapter(adapter);
  channels.push(channel);
  return { adapter, agent, channel, stateStore };
}

describe("createOpenTagChannel", () => {
  it("uses the configured identity in agent context and capability tooling", async () => {
    const { adapter, agent, channel } = makeChannel({
      agentDisplayName: "Kite",
    });

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "identity-thread",
      replyTarget: {},
      userText: "@Kite who are you?",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
      operation: {
        kind: "created",
        logicalMessageId: "m1",
        revisionId: "m1",
        mentioned: true,
      },
    });

    const call = (agent as CapturingAgent).calls[0];
    expect(call?.context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: "Bot identity & tone",
          value: expect.stringContaining(
            "CRITICAL: Your user-facing name is Kite",
          ),
        }),
      ]),
    );
    expect(
      call?.tools?.find(({ name }) => name === "show_capabilities")
        ?.description,
    ).toContain("Show Kite's interactive identity");
  });

  it("does not answer a revision of a message it already answered", async () => {
    // The reply loop. Posting an answer counts as a change to the message that
    // asked, so Slack re-announces that message with a fresh revision id and
    // the ORIGINAL author still on it — indistinguishable from the person
    // asking again, unless the revision itself is read. One mention here
    // produced about fifty answers in a live workspace.
    const { adapter, agent, channel } = makeChannel();
    await channel.ɵruntime.start();

    const ask = {
      conversationKey: "loop-thread",
      replyTarget: {},
      userText: "@OpenTag say hi",
      platform: "slack" as const,
      actor: { id: "U1", kind: "human" as const },
    };

    await adapter.getSink().onTurn({
      ...ask,
      operation: {
        kind: "created" as const,
        logicalMessageId: "m1",
        revisionId: "m1",
        mentioned: true,
      },
    });
    const afterFirstAnswer = (agent as CapturingAgent).calls.length;
    expect(afterFirstAnswer).toBe(1);

    // Same message, new revision, because the answer landed in its thread.
    await adapter.getSink().onTurn({
      ...ask,
      operation: {
        kind: "updated" as const,
        logicalMessageId: "m1",
        revisionId: "m1-r2",
        mentioned: true,
      },
    });

    expect((agent as CapturingAgent).calls.length).toBe(afterFirstAnswer);
  });

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

  it("answers a mention without following the thread when the history is unreadable", async () => {
    // Following a thread is a standing commitment to answer everything said in
    // it from here on. Taking it because a history read failed is deciding on
    // evidence nobody has — and it is not the cheap direction: not following
    // costs the user one sentence, and the run is still offered the tool to
    // act on it.
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

    // The mention is answered either way. That is the part that must not
    // depend on a history read.
    expect((agent as CapturingAgent).calls).toHaveLength(1);
    expect(
      await stateStore.kv.get<boolean>("sub:history-failure"),
    ).toBeUndefined();
    expect(toolNames((agent as CapturingAgent).calls[0])).toContain(
      subscribeThreadTool.name,
    );
    expect(consoleError).toHaveBeenCalledWith(
      "[channel] recoverable error",
      expect.objectContaining({
        context: {
          operation: "get_thread_history",
          recovery: "answered_without_following",
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

  // `composio_tools.state.PERSONAL_KINDS` admits `human` and nothing else, on
  // the grounds that `ProviderActor.kind` is the provider's own untrusted word
  // for what sent a message. A surface-side filter that stops at `bot`/`app`
  // hands the other two a turn the agent would never have granted an identity.
  it.each(["bot", "app", "system", "unknown"] as const)(
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
      "connect_app",
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

  it("says so when the surface cannot take suggested prompts at all", async () => {
    // `Thread.setSuggestedPrompts` answers `{ ok: false }` on a surface with no
    // such pane — it does not throw. A `try`/`catch` around it is watching the
    // one door this failure never comes through, and the prompts are simply
    // missing with nothing anywhere saying why.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const adapter = new FakeAdapter({
      platform: "intelligence",
      paneMethods: false,
    });
    adapter.stateStore = new MemoryStore();
    const channel = createOpenTagChannel("opentag", new FakeAgent());
    channel.ɵruntime.addAdapter(adapter);
    channels.push(channel);

    await channel.ɵruntime.start();
    await adapter.emitThreadStarted({
      conversationKey: "c1",
      replyTarget: {},
      actor: { id: "U1", kind: "human", name: "Ada" },
    });

    expect(adapter.suggestedPromptsCalls).toHaveLength(0);
    expect(JSON.stringify(consoleError.mock.calls)).toContain(
      "set_suggested_prompts",
    );
    consoleError.mockRestore();
  });

  it("logs the pair when the agent run and its error reply both fail", async () => {
    // Thrown out of an unguarded handler, this is the one failure in the file
    // that leaves no trace of its own: the Channel takes the throw, and the two
    // errors inside it — why the run failed, and why the user was never told —
    // go with it.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { adapter, channel } = makeChannel({
      agent: new FakeAgent([
        () => {
          throw new Error("agent unavailable");
        },
      ]),
    });
    adapter.post = vi.fn(async () => {
      throw new Error("thread is archived");
    });

    await channel.ɵruntime.start();
    // The pair is re-raised as well as logged, and this ingress reports it
    // however the runtime chooses to; the assertion below is about the log.
    await Promise.resolve(
      adapter.getSink().onTurn({
        conversationKey: "c1",
        replyTarget: {},
        userText: "hello",
        platform: "slack",
        actor: { id: "U1", kind: "human" },
      }),
    ).catch(() => undefined);

    // Read off the logged object rather than its JSON: an Error stringifies to
    // `{}`, so a JSON assertion here would pass on a log carrying no reason at
    // all.
    const entry = consoleError.mock.calls.find(
      ([, payload]) =>
        (payload as { context?: { operation?: string } } | undefined)?.context
          ?.operation === "run_agent_error_reply",
    );
    expect(entry).toBeDefined();
    const logged = (entry![1] as { error: unknown }).error;
    expect(logged).toBeInstanceOf(AggregateError);
    expect(
      (logged as AggregateError).errors.map((e: Error) => e.message),
    ).toEqual(["agent unavailable", "thread is archived"]);
    consoleError.mockRestore();
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

    expect(JSON.stringify(adapter.posted)).toMatch(/error/i);
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

  it("explains a lost Slack reply when event delivery times out", async () => {
    const { adapter, channel } = makeChannel({
      agent: new FakeAgent([
        () => {
          throw new Error("Timed out trying to durably deliver runner events");
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

    expect(JSON.stringify(adapter.posted)).toMatch(/cut the live update/i);
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
      __opentag_interrupt_id__: crypto.randomUUID().replaceAll("-", ""),
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
      actor: { id: "U1", kind: "human" },
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

  it("styles the posted card from the effect the agent classified", async () => {
    // The agent looks the slug up, decides it is destructive, and sends that on
    // the interrupt. Dropping it between the schema and the card leaves the red
    // on Cancel and the irreversible button looking like the safe one.
    const envelope = {
      __opentag_interrupt_id__: crypto.randomUUID().replaceAll("-", ""),
    __copilotkit_interrupt_value__: {
        action: "confirm_write",
        args: {
          action: "Trash message (Gmail)",
          fields: null,
          attempt: null,
          approver: null,
          effect: "destructive",
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
      userText: "bin that mail",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
    });

    expect(adapter.posted).toHaveLength(1);
    const { blocks } = renderSlackMessage(adapter.posted[0]!);
    const actions = blocks.find((b) => b.type === "actions") as
      | { elements: { style?: string }[] }
      | undefined;
    expect(actions?.elements[0]?.style).toBe("danger");
    expect(actions?.elements[1]?.style).toBeUndefined();
  });

  it("carries a plain write onto the card as a plain write", async () => {
    // The classification is the only thing separating "the agent looked this
    // up and it changes something" from "nobody could say what this does" —
    // and the second is styled as a delete. Dropping `effect` between the
    // schema and the card left every test in this suite green, because every
    // card it checked was one the fail-safe would have reddened anyway.
    const { adapter } = await postConfirmWrite({
      action: "Send email (Gmail)",
      fields: null,
      approver: null,
      effect: "write",
    });

    const { blocks } = renderSlackMessage(adapter.posted[0]!);
    const actions = blocks.find((b) => b.type === "actions") as
      | { elements: { text: { text: string }; style?: string }[] }
      | undefined;
    expect(
      actions?.elements.map((element) => ({
        text: element.text.text,
        style: element.style,
      })),
    ).toEqual([
      { text: "Send", style: undefined },
      { text: "Cancel", style: undefined },
    ]);
  });

  it("still reddens a write whose own words say delete", async () => {
    // `NOTION_API_DELETE_A_BLOCK`, humanised, classified from
    // `readOnlyHint: false`, all the way through the real schema and handler.
    const { adapter } = await postConfirmWrite({
      action: "API delete a block",
      effect: "write",
    });

    const { blocks } = renderSlackMessage(adapter.posted[0]!);
    const actions = blocks.find((b) => b.type === "actions") as
      | { elements: { text: { text: string }; style?: string }[] }
      | undefined;
    expect(actions?.elements[0]).toMatchObject({
      text: { text: "Confirm" },
      style: "danger",
    });
  });

  it("names the approver on the posted card, so a colleague's click is refused", async () => {
    // Whose call it is travels from the agent, through the schema, onto the
    // card, and into the click. Dropping it anywhere on that path costs nothing
    // visible and quietly lets anybody in the thread spend somebody else's
    // connected account.
    const { adapter } = await postConfirmWrite({
      action: "Send email (Gmail)",
      approver: "slack:U1",
      effect: "write",
    });

    await adapter.getSink().onInteraction({
      id: confirmActionId(adapter),
      conversationKey: "c1",
      replyTarget: {},
      // The Intelligence adapter is the transport; the provider that delivered
      // the click is stamped per delivery and is what the Channel reports as
      // `interaction.platform`. Leaving it off makes the click look like it
      // came from the transport itself, which is a surface nobody clicks on.
      platform: "slack",
      messageRef: { id: "msg-1" },
      actor: { id: "U2", kind: "human", name: "Someone else" },
      value: { confirmed: true },
    });

    expect(adapter.updated).toHaveLength(0);
    expect(JSON.stringify(adapter.ephemeralPosts)).toMatch(
      /only they can approve/i,
    );
  });

  it("lets the named approver answer the posted card", async () => {
    const { adapter } = await postConfirmWrite({
      action: "Send email (Gmail)",
      approver: "slack:U1",
      effect: "write",
    });

    await adapter.getSink().onInteraction({
      id: confirmActionId(adapter),
      conversationKey: "c1",
      replyTarget: {},
      // The Intelligence adapter is the transport; the provider that delivered
      // the click is stamped per delivery and is what the Channel reports as
      // `interaction.platform`. Leaving it off makes the click look like it
      // came from the transport itself, which is a surface nobody clicks on.
      platform: "slack",
      messageRef: { id: "msg-1" },
      actor: { id: "U1", kind: "human", name: "The owner" },
      value: { confirmed: true },
    });

    expect(adapter.updated).toHaveLength(1);
    expect(JSON.stringify(adapter.updated)).toContain("Approved");
    expect(adapter.ephemeralPosts).toHaveLength(0);
  });

  it("refuses the same id arriving from a platform the approver does not name", async () => {
    // A provider id is unique only within its provider. `teams:U1` and the
    // `U1` who clicked from Slack are two people, and the id alone cannot tell
    // them apart — which is the whole reason the approver carries a platform.
    const { adapter } = await postConfirmWrite({
      action: "Send email (Gmail)",
      approver: "teams:U1",
      effect: "destructive",
    });

    await adapter.getSink().onInteraction({
      id: confirmActionId(adapter),
      conversationKey: "c1",
      replyTarget: {},
      platform: "slack",
      messageRef: { id: "msg-1" },
      actor: { id: "U1", kind: "human", name: "A different U1" },
      value: { confirmed: true },
    });

    expect(adapter.updated).toHaveLength(0);
    expect(JSON.stringify(adapter.ephemeralPosts)).toMatch(
      /only they can approve/i,
    );
  });

  it("carries the retry context from the interrupt onto the posted card", async () => {
    const { adapter } = await postConfirmWrite({
      action: "Save project",
      attempt: 2,
      previous_error: 'Team "Growth" not found',
    });

    const { blocks } = renderSlackMessage(adapter.posted[0]!);
    expect(JSON.stringify(blocks)).toContain("Attempt 2");
    expect(JSON.stringify(blocks)).toContain("Growth");
  });

  it("does not report an interrupt it never claimed to render as a broken approval card", async () => {
    // "I could not show the approval card for that action" sends the reader
    // looking for a card, and for the write behind it. Neither exists: the
    // agent asked for something this surface has no handler for at all, and
    // saying so is the difference between a bug report and a wild goose chase.
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
              __opentag_interrupt_id__: crypto.randomUUID().replaceAll("-", ""),
    __copilotkit_interrupt_value__: {
                action: "connect_account",
                args: { action: "Injected write", secret: "s3cret" },
              },
              __copilotkit_messages__: [],
            }),
          },
        } as never);
      },
    ]);
    const { adapter, channel } = makeChannel({ agent });

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "c1",
      replyTarget: {},
      userText: "do it",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
    });

    const posted = JSON.stringify(adapter.posted);
    expect(posted).toMatch(/connect_account/);
    expect(posted).not.toMatch(/approval card/i);
    // The name of the request is all that is echoed; its arguments are the
    // agent's own words about a request nobody here can read.
    expect(posted).not.toContain("Injected write");
    expect(posted).not.toContain("s3cret");
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).toContain("unsupported_interrupt");
    expect(logged).not.toContain("posted_user_facing_error");
    consoleError.mockRestore();
  });

  it("does not claim nothing has been changed when it cannot know", async () => {
    // The card gates one tool call. The turn that reached it may have written
    // three other things already, and this handler saw none of them — so the
    // notice speaks for the action it could not ask about, and for nothing
    // else.
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
              __opentag_interrupt_id__: crypto.randomUUID().replaceAll("-", ""),
    __copilotkit_interrupt_value__: {
                action: "confirm_write",
                args: { fields: [{ label: "Name" }] },
              },
              __copilotkit_messages__: [],
            }),
          },
        } as never);
      },
    ]);
    const { adapter, channel } = makeChannel({ agent });

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "c1",
      replyTarget: {},
      userText: "do it",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
    });

    const posted = JSON.stringify(adapter.posted);
    expect(posted).toMatch(/could not show the approval card/i);
    expect(posted).not.toMatch(/nothing has been changed/i);
    // What it can say: the action it was gating was never approved.
    expect(posted).toMatch(/not approved|was not approved/i);
    expect(JSON.stringify(consoleError.mock.calls)).toContain(
      "confirm_write_interrupt",
    );
    consoleError.mockRestore();
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
              __opentag_interrupt_id__: crypto.randomUUID().replaceAll("-", ""),
    __copilotkit_interrupt_value__: {
                action: "confirm_write",
                // A confirm_write the card cannot be built from: `attempt` is
                // 1-based, so this one fails the schema after the envelope has
                // already been read as an approval.
                args: { action: "Injected write", attempt: 0 },
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

    const posted = JSON.stringify(adapter.posted);
    expect(posted).toMatch(/could not show the approval card/i);
    expect(posted).not.toContain("Injected write");
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).toContain("confirm_write_interrupt");
    // Reported as an interrupt that could not be rendered, not as a run that
    // recovered — the graph is still paused on a question nobody was asked.
    expect(logged).not.toContain("posted_user_facing_error");
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
            // Stringified, as `ag_ui_langgraph` sends it, and naming an
            // approver: the point of this test is that a click served by
            // re-rendering the card from the store is served with the props
            // the card was posted with, the approver among them.
            value: JSON.stringify(
              confirmWriteEnvelope("Create Linear issue", "CPK-9", {
                approver: "slack:U1",
                effect: "destructive",
              }),
            ),
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
      platform: "slack",
      messageRef: { id: "msg-1" },
      actor: { id: "U2", kind: "human", name: "Someone else" },
      value: { confirmed: true },
    });

    // A card re-rendered from the store that forgot whose call it was would
    // let this through, and spend the first person's connected account.
    expect(secondAdapter.updated).toHaveLength(0);
    expect(secondAgent.calls).toHaveLength(0);
    expect(JSON.stringify(secondAdapter.ephemeralPosts)).toMatch(
      /only they can approve/i,
    );

    await secondAdapter.getSink().onInteraction({
      id: actionId!,
      conversationKey: "c1",
      replyTarget: {},
      platform: "slack",
      messageRef: { id: "msg-1" },
      actor: { id: "U1", kind: "human", name: "The owner" },
      value: { confirmed: true },
    });

    expect(secondAdapter.updated).toHaveLength(1);
    expect(JSON.stringify(secondAdapter.updated)).toContain("Approved");
    expect(secondAgent.calls).toHaveLength(1);
  });

  it("re-registers the Connect button when a new Channel uses the same store", async () => {
    // `ConnectAccount` is in the component list for exactly this: the button is
    // posted publicly and pressed minutes later, by several different people,
    // and a click after a restart is served by re-rendering the named component
    // from that list. Unregistered, the dispatch raises an expired-action error
    // the Channel swallows — the person presses it and nothing happens at all.
    const sharedState = new MemoryStore();
    const firstAdapter = new FakeAdapter({ platform: "intelligence" });
    firstAdapter.stateStore = sharedState;
    const firstAgent = new FakeAgent([
      (subscriber) => {
        subscriber.onToolCallEndEvent?.({
          event: { toolCallId: "connect-app-1" },
          toolCallName: "connect_app",
          toolCallArgs: { toolkit: "gmail" },
        } as never);
        subscriber.onRunFinishedEvent?.({ event: {} } as never);
      },
    ]);
    const firstChannel = createOpenTagChannel("opentag", firstAgent);
    firstChannel.ɵruntime.addAdapter(firstAdapter);
    channels.push(firstChannel);
    await firstChannel.ɵruntime.start();
    await firstAdapter.getSink().onTurn({
      conversationKey: "connect-thread",
      replyTarget: {},
      userText: "connect my gmail",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
    });

    const connectButton = findButtonByToolkit(firstAdapter.posted[0]!, "gmail");
    const actionId = (connectButton?.props.onClick as { id?: string })?.id;
    expect(actionId).toMatch(/^ck:/);
    await firstChannel.ɵruntime.stop();

    const secondAdapter = new FakeAdapter({ platform: "intelligence" });
    secondAdapter.stateStore = sharedState;
    const secondChannel = createOpenTagChannel("opentag", new FakeAgent());
    secondChannel.ɵruntime.addAdapter(secondAdapter);
    channels.push(secondChannel);
    await secondChannel.ɵruntime.start();
    // The click handler reads the environment before it reads the clicker.
    vi.stubEnv("AGENT_URL", "http://agent.test");
    vi.stubEnv("INTELLIGENCE_API_KEY", "test-key");
    // Clicked by nobody the surface could name, so the handler answers from its
    // own first guard and no connect link is minted or requested.
    await secondAdapter.getSink().onInteraction({
      id: actionId!,
      conversationKey: "connect-thread",
      replyTarget: {},
      platform: "slack",
      messageRef: { id: "connect-message" },
      value: { toolkit: "gmail" },
    });

    // The notice goes to the THREAD, not to an ephemeral message: with no
    // identifiable clicker there is no user id to address one to, and the old
    // `postEphemeral("unknown", …)` addressed a user that does not exist.
    expect(JSON.stringify(secondAdapter.posted)).toMatch(
      /could not tell who clicked/i,
    );
    expect(secondAdapter.ephemeralPosts).toHaveLength(0);
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
      platform: "slack",
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

/** Post one `confirm_write` card through the real interrupt handler. */
async function postConfirmWrite(args: Record<string, unknown>) {
  const agent = new FakeAgent([
    (subscriber) => {
      subscriber.onCustomEvent?.({
        event: {
          type: EventType.CUSTOM,
          name: "on_interrupt",
          value: JSON.stringify({
            __opentag_interrupt_id__: crypto.randomUUID().replaceAll("-", ""),
    __copilotkit_interrupt_value__: { action: "confirm_write", args },
            __copilotkit_messages__: [],
          }),
        },
      } as never);
    },
  ]);
  const made = makeChannel({ agent });

  await made.channel.ɵruntime.start();
  await made.adapter.getSink().onTurn({
    conversationKey: "c1",
    replyTarget: {},
    userText: "do it",
    platform: "slack",
    actor: { id: "U1", kind: "human" },
  });

  expect(made.adapter.posted).toHaveLength(1);
  return made;
}

/** The registered action id behind the posted card's confirm button. */
function confirmActionId(adapter: FakeAdapter): string {
  const button = findButton(adapter.posted[0]!, true);
  const id = (button?.props.onClick as { id?: string } | undefined)?.id;
  expect(id).toMatch(/^ck:/);
  return id!;
}

describe("createOpenTagChannel error paths", () => {
  it("ignores a turn the platform could not attribute to anybody", async () => {
    // An ingress with no actor is normalized to `{ id: "", kind: "unknown" }`.
    // Running on it is running on input nobody can be held to — and the card
    // that gates the resulting writes names no approver, so anyone can answer.
    const { adapter, agent, channel } = makeChannel();

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "anonymous-thread",
      replyTarget: {},
      userText: "@Kite do the thing",
      platform: "slack",
      operation: {
        kind: "created",
        logicalMessageId: "m1",
        revisionId: "m1",
        mentioned: true,
      },
    });

    expect((agent as CapturingAgent).calls).toHaveLength(0);
  });

  it("answers the mention when the subscription lookup fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { adapter, agent, channel, stateStore } = makeChannel();
    vi.spyOn(stateStore.kv, "get").mockRejectedValue(
      new Error("state store unavailable"),
    );

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "unreadable-subscription",
      replyTarget: {},
      userText: "@Kite are you there",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
      operation: {
        kind: "created",
        logicalMessageId: "m1",
        revisionId: "m1",
        mentioned: true,
      },
    });

    // Whether the thread is subscribed decides which tool the run offers, not
    // whether the person gets an answer. Dropping the mention because a lookup
    // failed is silence the user has no way to tell from being ignored.
    expect((agent as CapturingAgent).calls).toHaveLength(1);
    expect(JSON.stringify(consoleError.mock.calls)).toContain(
      "read_thread_subscription",
    );
    consoleError.mockRestore();
  });

  it("answers the mention when recording the subscription fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { adapter, agent, channel, stateStore } = makeChannel();
    vi.spyOn(stateStore.kv, "set").mockRejectedValue(
      new Error("state store unavailable"),
    );

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "unwritable-subscription",
      replyTarget: {},
      userText: "@Kite follow this thread",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
      operation: {
        kind: "created",
        logicalMessageId: "m1",
        revisionId: "m1",
        mentioned: true,
      },
    });

    expect((agent as CapturingAgent).calls).toHaveLength(1);
    expect(JSON.stringify(consoleError.mock.calls)).toContain(
      "record_thread_subscription",
    );
    consoleError.mockRestore();
  });

  it("answers a follow-up in a thread it has been talking in when the subscription is unreadable", async () => {
    // The whole gate on an unmentioned turn. Answered `false` for a store that
    // could not answer at all, a blip drops the next thing somebody says in a
    // thread the bot is following — and drops it silently, which from the
    // user's side is indistinguishable from being ignored.
    //
    // The thread itself is the second source: a conversation this bot has been
    // posting into is one it belongs in, and that is a fact the store outage
    // cannot take away.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { adapter, agent, channel, stateStore } = makeChannel();
    adapter.messages = [
      { text: "@Kite triage this", ts: "1" },
      { text: "On it — here is what I found.", ts: "2", isBot: true },
    ];
    vi.spyOn(stateStore.kv, "get").mockRejectedValue(
      new Error("state store unavailable"),
    );

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "unreadable-follow-up",
      replyTarget: {},
      userText: "and what about the second one?",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
      operation: {
        kind: "created",
        logicalMessageId: "m3",
        revisionId: "m3",
        mentioned: false,
      },
    });

    expect((agent as CapturingAgent).calls).toHaveLength(1);
    // Neither subscription tool is offered: the store cannot say what the
    // thread's subscription is, so the run must not offer to change it.
    const offered = toolNames((agent as CapturingAgent).calls[0]);
    expect(offered).not.toContain(subscribeThreadTool.name);
    expect(offered).not.toContain(unsubscribeThreadTool.name);
    expect(JSON.stringify(consoleError.mock.calls)).toContain(
      "read_thread_subscription",
    );
    consoleError.mockRestore();
  });

  it("stays out of a thread it has never spoken in when the subscription is unreadable", async () => {
    // The other side of the same coin. Answering every message in every thread
    // the bot can see, for as long as the store is down, is a failure the
    // people in those threads cannot opt out of.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { adapter, agent, channel, stateStore } = makeChannel();
    adapter.messages = [
      { text: "shipping tomorrow", ts: "1" },
      { text: "nice", ts: "2" },
    ];
    vi.spyOn(stateStore.kv, "get").mockRejectedValue(
      new Error("state store unavailable"),
    );

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "unreadable-bystander",
      replyTarget: {},
      userText: "anyone got the link?",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
      operation: {
        kind: "created",
        logicalMessageId: "m3",
        revisionId: "m3",
        mentioned: false,
      },
    });

    expect((agent as CapturingAgent).calls).toHaveLength(0);
    // Skipped, but not silently: a turn dropped on a guess nobody can see is
    // the same failure one layer down.
    expect(JSON.stringify(consoleError.mock.calls)).toContain(
      "skipped_unmentioned_turn",
    );
    consoleError.mockRestore();
  });

  it("says the card could not be shown, rather than quoting a ZodError", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const agent = new FakeAgent([
      (subscriber) => {
        subscriber.onCustomEvent?.({
          event: {
            type: EventType.CUSTOM,
            name: "on_interrupt",
            value: "{broken",
          },
        } as never);
      },
    ]);
    const { adapter, channel } = makeChannel({ agent });

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "c1",
      replyTarget: {},
      userText: "file this",
      platform: "slack",
      actor: { id: "U1", kind: "human" },
      operation: {
        kind: "created",
        logicalMessageId: "m1",
        revisionId: "m1",
        mentioned: true,
      },
    });

    const posted = JSON.stringify(adapter.posted);
    expect(posted).toMatch(/approval/i);
    // A parser's own vocabulary is not a message to a person, and it is what
    // the thread showed: "I hit an error: ZodError: [.".
    expect(posted).not.toMatch(/ZodError|SyntaxError/);
    expect(JSON.stringify(consoleError.mock.calls)).toContain(
      "confirm_write_interrupt",
    );
    consoleError.mockRestore();
  });
});
