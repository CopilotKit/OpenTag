import type {
  AgentSubscriber,
  RunAgentParameters,
  RunAgentResult,
} from "@ag-ui/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  defineChannelTool,
  FakeAdapter,
  FakeAgent,
  type Channel,
  type ContextEntry,
} from "@copilotkit/channels";
import { z } from "zod";
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

afterEach(async () => {
  await Promise.all(channels.splice(0).map((channel) => channel.ɵruntime.stop()));
});

function makeChannel(options: {
  platform: "intelligence" | "slack";
  agent?: FakeAgent;
}) {
  const adapter = new FakeAdapter({ platform: options.platform });
  const platformTool = defineChannelTool({
    name: "platform_lookup",
    description: "Test platform lookup.",
    parameters: z.object({}),
    handler: () => "ok",
  });
  const platformContext: ContextEntry = {
    description: "Platform guidance",
    value: "Use native formatting.",
  };
  const agent = options.agent ?? new CapturingAgent();
  const channel = createOpenTagChannel({
    name: "opentag",
    adapters: [adapter],
    agent,
    platformTools: [platformTool],
    platformContext: [platformContext],
  });
  channels.push(channel);
  return { adapter, agent, channel, platformContext, platformTool };
}

describe("createOpenTagChannel", () => {
  it("declares managed Slack and retains app commands", () => {
    const channel = createOpenTagChannel({
      name: "custom-channel",
      adapters: [],
      agent: new FakeAgent(),
      platformTools: [],
      platformContext: [],
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
  });

  it("registers app and platform tools/context on agent runs", async () => {
    const { adapter, agent, channel, platformContext, platformTool } =
      makeChannel({ platform: "slack" });

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
      [...appTools.map(({ name }) => name), platformTool.name].sort(),
    );
    expect(call?.context).toEqual([
      ...appContext,
      platformContext,
      {
        description: "Requesting slack user",
        value: "Ada (slack id U1)",
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
});
