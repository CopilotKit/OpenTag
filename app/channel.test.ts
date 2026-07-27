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
import { createOpenTagChannel } from "./channel.js";

class CapturingAgent extends FakeAgent {
  readonly calls: Array<RunAgentParameters | undefined> = [];

  override async runAgent(
    parameters?: RunAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    this.calls.push(parameters);
    return super.runAgent(parameters, subscriber);
  }
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

afterEach(async () => {
  await Promise.all(channels.splice(0).map((channel) => channel.ɵruntime.stop()));
});

function makeChannel(options: {
  platform: "intelligence" | "slack" | "teams";
  agent?: FakeAgent;
}) {
  const adapter = new FakeAdapter({ platform: options.platform });
  const agent = options.agent ?? new CapturingAgent();
  const channel = createOpenTagChannel({
    name: "opentag",
    adapters: [adapter],
    agent,
  });
  channels.push(channel);
  return { adapter, agent, channel };
}

describe("createOpenTagChannel", () => {
  it("declares managed Slack and retains app commands", () => {
    const channel = createOpenTagChannel({
      name: "custom-channel",
      adapters: [],
      agent: new FakeAgent(),
    });
    channels.push(channel);

    expect(channel.name).toBe("custom-channel");
    expect(channel.provider).toBe("slack");
    expect(channel.adapters).toEqual([]);
    expect(channel.commandNames.sort()).toEqual([
      "agent",
      "file_issue",
      "preview",
      "triage",
    ]);
    expect(appTools.map(({ name }) => name)).not.toContain("confirm_write");
  });

  it("injects Slack defaults per managed Slack run", async () => {
    const { adapter, agent, channel } = makeChannel({
      platform: "intelligence",
    });

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "c1",
      replyTarget: {},
      userText: "hello",
      platform: "slack",
      user: { id: "U1", name: "Ada" },
    });

    const call = (agent as CapturingAgent).calls[0];
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

  it("does not leak Slack defaults into Teams when both direct adapters share the Channel", async () => {
    const slackAdapter = new FakeAdapter({ platform: "slack" });
    const teamsAdapter = new FakeAdapter({ platform: "teams" });
    const agent = new CapturingAgent();
    const channel = createOpenTagChannel({
      name: "opentag",
      adapters: [slackAdapter, teamsAdapter],
      agent,
    });
    channels.push(channel);

    await channel.ɵruntime.start();
    await teamsAdapter.getSink().onTurn({
      conversationKey: "c1",
      replyTarget: {},
      userText: "hello",
      platform: "teams",
      user: { id: "T1", name: "Ada" },
    });

    const call = agent.calls[0];
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
    const { adapter, agent, channel } = makeChannel({
      platform: "intelligence",
    });
    const parts = [{ type: "text" as const, text: "from content parts" }];

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "c1",
      replyTarget: {},
      userText: "fallback text",
      contentParts: parts,
      platform: "slack",
      user: { id: "U1" },
    });

    expect(agent.messages).toContainEqual(
      expect.objectContaining({ role: "user", content: parts }),
    );
  });

  it("does not inject a duplicate prompt for direct adapter ingress", async () => {
    const { adapter, agent, channel } = makeChannel({ platform: "slack" });

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
      conversationKey: "c1",
      replyTarget: {},
      userText: "already in direct history",
      platform: "slack",
      user: { id: "U1" },
    });

    expect(agent.messages).toEqual([]);
  });

  it("personalizes suggested prompts when a thread starts", async () => {
    const { adapter, channel } = makeChannel({ platform: "slack" });

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

  it("posts a user-facing error when the agent run fails", async () => {
    const error = new Error("agent unavailable");
    const { adapter, channel } = makeChannel({
      platform: "slack",
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
      user: { id: "U1" },
    });

    expect(JSON.stringify(adapter.posted)).toMatch(/sorry.*error/i);
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
      platform: "intelligence",
      agent,
    });

    await channel.ɵruntime.start();
    const turn = adapter.getSink().onTurn({
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
      platform: "intelligence",
      agent,
    });

    await channel.ɵruntime.start();
    await adapter.getSink().onTurn({
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

  it("preserves confirm_write button actions across a Channel restart", async () => {
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
    const firstChannel = createOpenTagChannel({
      name: "opentag",
      adapters: [firstAdapter],
      agent: firstAgent,
    });
    channels.push(firstChannel);
    await firstChannel.ɵruntime.start();
    await firstAdapter.getSink().onTurn({
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
    const secondAgent = new FakeAgent();
    const secondChannel = createOpenTagChannel({
      name: "opentag",
      adapters: [secondAdapter],
      agent: secondAgent,
    });
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
    expect(secondAgent.runAgentCalls).toBe(1);
  });
});
