/**
 * `connect_my_app` is where one person's provider account gets bound to one
 * Composio user id, so the tests are mostly about who that id belongs to.
 *
 * A connect link is a bearer capability: whoever completes the flow attaches
 * THEIR mailbox to the id the link was minted for. A link minted for Alice and
 * posted into a channel therefore hands Bob a way to become Alice. Half of what
 * follows exists to hold that line — no URL in the public card, the link minted
 * from the clicker, delivered ephemerally, never logged.
 *
 * The click handler is driven both ways: directly, and through the `onClick`
 * the posted card actually carries, so a card wired to the wrong handler fails
 * here rather than in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  renderToIR,
  type ChannelNode,
  type ClickHandler,
  type InteractionContext,
} from "@copilotkit/channels";
import { ConnectAccount } from "../../../human-in-the-loop/index.js";
import { resetComposioClient } from "../client.js";
import { createConnectTool, handleConnectClick } from "../connect-tool.js";
import type { ComposioConfig } from "../config.js";
import {
  clearSessionCache,
  getSession,
  type Authorization,
  type ComposioSdk,
} from "../sessions.js";

/**
 * The click takes no SDK: it re-derives the memoized client from the
 * environment, which is what lets a card posted before a restart still work.
 * So the fake is installed where that client is constructed — `makeSdk`
 * registers itself here, and every test drives the production path.
 */
let currentSdk: object | undefined;

vi.mock("@composio/core", () => ({
  Composio: vi.fn(function fakeComposio() {
    if (!currentSdk) throw new Error("no fake SDK was installed for this test");
    return currentSdk;
  }),
}));

const config: ComposioConfig = {
  apiKey: "ak_x",
  workspaceToolkits: [],
  userToolkits: ["gmail"],
  approvals: "destructive",
  workspaceUserId: "open-tag",
  authConfigs: {},
};

/** The bearer capability under test. Nothing public may ever contain it. */
const REDIRECT = "https://connect.composio.dev/link/lk_x";

type Authorize = () => Promise<Authorization>;

/** A promise plus the handles to settle it from the test body. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-queued microtask and timer callback run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fake SDK that records every session it was asked to create. */
function makeSdk(authorize: Authorize = async () => ({ redirectUrl: REDIRECT })) {
  const created: Array<{ userId: string; options: Record<string, unknown> }> = [];
  const sdk = {
    created,
    sessions: {
      create: vi.fn(async (userId: string, options: Record<string, unknown>) => {
        created.push({ userId, options });
        return {
          sessionId: "trs_1",
          authorize: vi.fn(authorize),
          search: vi.fn(),
          execute: vi.fn(),
          toolkits: vi.fn(),
        };
      }),
    },
    tools: { getRawComposioTools: vi.fn(async () => []) },
  };
  currentSdk = sdk;
  return sdk;
}

/** `null` means the platform gave us no verified identity for this event. */
type ActorId = string | null;

function actorOf(actorId: ActorId) {
  return actorId === null ? undefined : { id: actorId };
}

/** The tool handler's context: who asked, and the thread they asked in. */
function makeCtx(actorId: ActorId = "U1") {
  const post = vi.fn();
  const postEphemeral = vi.fn();
  return {
    ctx: { actor: actorOf(actorId), thread: { post, postEphemeral } } as never,
    post,
    postEphemeral,
  };
}

/** What a surface reports back from `postEphemeral`. `null` is a real answer. */
type EphemeralOutcome = { ok: boolean; usedFallback?: boolean } | null;

/** Slack: a native only-you message, delivered. */
const NATIVE: EphemeralOutcome = { ok: true, usedFallback: false };

/** A button click: a different person, in the same thread. */
function makeInteraction(
  actorId: ActorId = "U2",
  ephemeral: (() => Promise<EphemeralOutcome>) | (() => never) = async () => NATIVE,
) {
  const post = vi.fn();
  const postEphemeral = vi.fn(
    async (_user: unknown, _ui: unknown, _opts: unknown): Promise<EphemeralOutcome> =>
      ephemeral(),
  );
  return {
    interaction: {
      actor: actorOf(actorId),
      action: { id: "b1", value: { toolkit: "gmail" } },
      platform: "teams",
      thread: { post, postEphemeral },
    } as unknown as InteractionContext<{ toolkit: string }>,
    post,
    postEphemeral,
  };
}

/** Children of an IR node as an array (empty if none). */
function childNodes(node: ChannelNode): ChannelNode[] {
  const children = node.props?.children;
  if (Array.isArray(children)) return children as ChannelNode[];
  if (children && typeof children === "object" && "type" in (children as object)) {
    return [children as ChannelNode];
  }
  return [];
}

function findAll(nodes: ChannelNode[], type: string): ChannelNode[] {
  const out: ChannelNode[] = [];
  for (const node of nodes) {
    if (node.type === type) out.push(node);
    out.push(...findAll(childNodes(node), type));
  }
  return out;
}

/** Every descendant `text` node's text, concatenated depth-first. */
function collectText(node: ChannelNode): string {
  if (node.type === "text") return String(node.props?.value ?? "");
  return childNodes(node).map(collectText).join("");
}

/**
 * Everything the card would carry to the platform — text, button values, props.
 * Serialized rather than walked, because the assertion is about the whole
 * payload: a URL smuggled into a button `value` is as public as one in a
 * `Section`.
 */
function payloadOf(renderable: unknown): string {
  return JSON.stringify(renderToIR(renderable as never), (_key, value) =>
    typeof value === "function" ? "[fn]" : value,
  );
}

/** The click handler the posted card actually wires to its button. */
function clickHandlerOf(renderable: unknown): ClickHandler<{ toolkit: string }> {
  const button = findAll(renderToIR(renderable as never), "button")[0];
  const onClick = button?.props?.onClick;
  if (typeof onClick !== "function") throw new Error("posted card carries no button handler");
  return onClick as ClickHandler<{ toolkit: string }>;
}

/** Post the card, then return the handler its button carries. */
async function postAndGetHandler(triggerer = "U1") {
  const tool = createConnectTool(config);
  const { ctx, post } = makeCtx(triggerer);
  await tool.handler({ toolkit: "gmail" }, ctx);
  return { onClick: clickHandlerOf(post.mock.calls[0]?.[0]), post };
}

/** Every string any console channel saw, so a leak anywhere is one assertion. */
function captureConsole() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  for (const channel of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, channel).mockImplementation(record);
  }
  return lines;
}

/** Env this deployment is configured with, restored after every test. */
const ENV_UNDER_TEST = {
  COMPOSIO_API_KEY: "ak_x",
  COMPOSIO_USER_TOOLKITS: "gmail",
};

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  clearSessionCache();
  // The click reads the environment, so the environment is part of the setup.
  for (const [key, value] of Object.entries(ENV_UNDER_TEST)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  // Each test installs its own fake through `makeSdk`; the memo must not carry
  // the previous test's across.
  resetComposioClient();
  currentSdk = undefined;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

describe("connect_my_app", () => {
  it("posts a card and does not mint a link", async () => {
    const sdk = makeSdk();
    const { ctx, post } = makeCtx();
    const tool = createConnectTool(config);

    const result = await tool.handler({ toolkit: "gmail" }, ctx);

    expect(post).toHaveBeenCalledTimes(1);
    expect(sdk.sessions.create).not.toHaveBeenCalled();
    expect(String(result)).toContain("Connect");
  });

  it("refuses a toolkit that is not configured", async () => {
    const tool = createConnectTool(config);
    const { ctx, post } = makeCtx();

    const result = await tool.handler({ toolkit: "salesforce" }, ctx);

    expect(String(result)).toContain("not configured");
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses a shared team toolkit and says who connects it", async () => {
    const sdk = makeSdk();
    const tool = createConnectTool({ ...config, workspaceToolkits: ["linear"] });
    const { ctx, post } = makeCtx();

    const result = await tool.handler({ toolkit: "linear" }, ctx);

    expect(String(result)).toContain("shared team app");
    // Names the one path that works. The dashboard's connect button binds to
    // the dashboard's own user id, so pointing there was worse than silence.
    expect(String(result)).toContain("pnpm composio:connect linear");
    expect(post).not.toHaveBeenCalled();
    expect(sdk.sessions.create).not.toHaveBeenCalled();
  });

  it("still connects a toolkit that is both shared and personal", async () => {
    const tool = createConnectTool({ ...config, workspaceToolkits: ["gmail"] });
    const { ctx, post } = makeCtx();

    const result = await tool.handler({ toolkit: "gmail" }, ctx);

    expect(post).toHaveBeenCalledTimes(1);
    expect(String(result)).not.toContain("shared team app");
  });

  it("refuses without a verified actor", async () => {
    const tool = createConnectTool(config);
    const { ctx, post } = makeCtx(null);

    const result = await tool.handler({ toolkit: "gmail" }, ctx);

    expect(String(result)).toContain("who you are");
    expect(post).not.toHaveBeenCalled();
  });

  it("accepts a slug the model shouted or padded", async () => {
    const tool = createConnectTool(config);
    const { ctx, post } = makeCtx();

    const result = await tool.handler({ toolkit: "  GMAIL " }, ctx);

    expect(post).toHaveBeenCalledTimes(1);
    expect(String(result)).not.toContain("not configured");
  });
});

describe("the public card", () => {
  it("carries a button and no URL", async () => {
    const { ctx, post } = makeCtx();
    const tool = createConnectTool(config);

    await tool.handler({ toolkit: "gmail" }, ctx);

    const card = post.mock.calls[0]?.[0];
    const payload = payloadOf(card);
    expect(findAll(renderToIR(card as never), "button")).toHaveLength(1);
    // Not just the known link: ANY url in the public payload is the bug.
    expect(payload).not.toContain("http");
    expect(payload).not.toContain(REDIRECT);
    expect(renderToIR(card as never).map(collectText).join("")).toContain("Connect Gmail");
  });

  it("is posted to the thread, not sent privately to the triggerer", async () => {
    const { ctx, post, postEphemeral } = makeCtx();
    const tool = createConnectTool(config);

    await tool.handler({ toolkit: "gmail" }, ctx);

    expect(post).toHaveBeenCalledTimes(1);
    expect(postEphemeral).not.toHaveBeenCalled();
  });
});

describe("the connect click", () => {
  it("mints the link for the clicker, not for whoever triggered the card", async () => {
    const sdk = makeSdk();
    const { onClick } = await postAndGetHandler("U1");
    const { interaction } = makeInteraction("U2");

    await onClick(interaction);

    expect(sdk.sessions.create).toHaveBeenCalledTimes(1);
    expect(sdk.created[0]?.userId).toBe("U2");
    expect(sdk.created[0]?.userId).not.toBe("U1");
  });

  it("creates the connect session with the workbench disabled", async () => {
    const sdk = makeSdk();
    const { interaction } = makeInteraction("U2");

    await handleConnectClick("gmail", interaction);

    expect(sdk.created[0]?.options).toMatchObject({
      toolkits: ["gmail"],
      workbench: { enable: false },
    });
  });

  it("delivers the link privately to the clicker and never to the channel", async () => {
    const sdk = makeSdk();
    const { interaction, post, postEphemeral } = makeInteraction("U2");

    await handleConnectClick("gmail", interaction);

    expect(post).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledTimes(1);
    const [target, ui, opts] = postEphemeral.mock.calls[0]!;
    expect(target).toEqual({ id: "U2" });
    expect(String(ui)).toContain(REDIRECT);
    expect(opts).toEqual({ fallbackToDM: true });
  });

  it("never logs the redirect url", async () => {
    const lines = captureConsole();
    const sdk = makeSdk();
    const { interaction } = makeInteraction("U2");

    await handleConnectClick("gmail", interaction);

    expect(lines.join("\n")).not.toContain(REDIRECT);
    expect(lines.join("\n")).not.toContain("http");
  });

  it("drops the clicker's cached sessions so the new app is usable next message", async () => {
    const sdk = makeSdk();
    const typed = sdk as unknown as ComposioSdk;
    await getSession(typed, "U2", ["gmail"]);
    expect(sdk.sessions.create).toHaveBeenCalledTimes(1);

    const { interaction } = makeInteraction("U2");
    await handleConnectClick("gmail", interaction);
    expect(sdk.sessions.create).toHaveBeenCalledTimes(2);

    // A third create means the cached entry is gone, not merely stale.
    await getSession(typed, "U2", ["gmail"]);
    expect(sdk.sessions.create).toHaveBeenCalledTimes(3);
  });

  it("leaves another user's cached session alone", async () => {
    const sdk = makeSdk();
    const typed = sdk as unknown as ComposioSdk;
    await getSession(typed, "U9", ["gmail"]);

    const { interaction } = makeInteraction("U2");
    await handleConnectClick("gmail", interaction);

    await getSession(typed, "U9", ["gmail"]);
    // Priming plus the click. A third would mean U9 was evicted too.
    expect(sdk.sessions.create).toHaveBeenCalledTimes(2);
  });

  it("ignores a click it cannot attribute to anyone", async () => {
    const sdk = makeSdk();
    const { interaction, post, postEphemeral } = makeInteraction(null);

    await handleConnectClick("gmail", interaction);

    expect(sdk.sessions.create).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(postEphemeral).not.toHaveBeenCalled();
  });

  it("reports a failed authorize privately, with no link", async () => {
    const sdk = makeSdk(async () => {
      throw new Error("composio is down");
    });
    const { interaction, post, postEphemeral } = makeInteraction("U2");

    await handleConnectClick("gmail", interaction);

    expect(post).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledTimes(1);
    expect(String(postEphemeral.mock.calls[0]?.[1])).not.toContain("http");
  });

  it("reports an authorize that came back without a link", async () => {
    const sdk = makeSdk(async () => ({ redirectUrl: "" }));
    const { interaction, postEphemeral } = makeInteraction("U2");

    await handleConnectClick("gmail", interaction);

    expect(postEphemeral).toHaveBeenCalledTimes(1);
    const text = String(postEphemeral.mock.calls[0]?.[1]);
    expect(text).not.toContain("Authorize");
    expect(text).toContain("could not");
  });
});

/**
 * A surface without a private channel is the case that decides whether this
 * flow degrades or leaks. Teams implements no `postEphemeral`, so channels-core
 * answers `{ ok: false }` — and OpenTag advertises Teams support, so an ignored
 * result is a dead platform, not an edge case.
 */
describe("a surface with no private message", () => {
  const noPrivateChannel: Array<[string, () => Promise<EphemeralOutcome>]> = [
    ["reports {ok:false} (Teams: no ephemeral path at all)", async () => ({ ok: false })],
    ["resolves null (no ephemeral, no DM fallback)", async () => null],
    [
      "throws (the transport failed)",
      async () => {
        throw new Error("request to https://teams.example/api failed");
      },
    ],
  ];

  for (const [name, ephemeral] of noPrivateChannel) {
    it(`says so instead of posting the link when the surface ${name}`, async () => {
      const sdk = makeSdk();
      const { interaction, post } = makeInteraction("U2", ephemeral);

      await expect(
        handleConnectClick("gmail", interaction),
      ).resolves.toBeUndefined();

      expect(post).toHaveBeenCalledTimes(1);
      const text = String(post.mock.calls[0]?.[0]);
      // The whole point: no private channel means the link goes nowhere.
      expect(text).not.toContain(REDIRECT);
      expect(text).not.toContain("http");
      expect(text).toContain("teams");
    });
  }

  it("keeps the provider's error out of the channel when it cannot be sent privately", async () => {
    const sdk = makeSdk(async () => {
      throw new Error("composio said U2's account is barred");
    });
    const { interaction, post } = makeInteraction("U2", async () => ({ ok: false }));

    await handleConnectClick("gmail", interaction);

    expect(post).toHaveBeenCalledTimes(1);
    expect(String(post.mock.calls[0]?.[0])).not.toContain("barred");
  });

  it("says where the link went when it fell back to a DM", async () => {
    const sdk = makeSdk();
    const { interaction, post } = makeInteraction("U2", async () => ({
      ok: true,
      usedFallback: true,
    }));

    await handleConnectClick("gmail", interaction);

    expect(post).toHaveBeenCalledTimes(1);
    const text = String(post.mock.calls[0]?.[0]);
    expect(text).toContain("direct message");
    expect(text).not.toContain("http");
  });

  it("posts nothing publicly when the private message landed natively", async () => {
    const sdk = makeSdk();
    const { interaction, post } = makeInteraction("U2");

    await handleConnectClick("gmail", interaction);

    expect(post).not.toHaveBeenCalled();
  });
});

/**
 * The mint-time invalidation is too early on its own: the tool tells the user
 * to ask again, and asking again refills the cache with a session that still
 * predates the connection. So the completion is chained too — without ever
 * being awaited, because the turn has to end before Slack cuts the update.
 */
describe("the connection completing later", () => {
  /** An SDK whose authorization exposes a wait the test settles by hand. */
  function makeWaitingSdk() {
    const pending = deferred<unknown>();
    const waitForConnection = vi.fn(async (_timeoutMs?: number) => pending.promise);
    const sdk = makeSdk(async () => ({ redirectUrl: REDIRECT, waitForConnection }));
    return { sdk, pending, waitForConnection };
  }

  it("returns without waiting for the browser flow", async () => {
    makeWaitingSdk();
    const { interaction } = makeInteraction("U2");

    const outcome = await Promise.race([
      handleConnectClick("gmail", interaction).then(
        () => "returned",
      ),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50)),
    ]);

    expect(outcome).toBe("returned");
  });

  it("waits far longer than Composio's own default", async () => {
    const { waitForConnection } = makeWaitingSdk();
    const { interaction } = makeInteraction("U2");

    await handleConnectClick("gmail", interaction);

    // Ten minutes. Composio's ~60s default would reject before a real consent
    // screen is read, making the whole chain useless.
    expect(waitForConnection).toHaveBeenCalledWith(10 * 60 * 1000);
  });

  it("drops the clicker's cache again once the connection completes", async () => {
    const { sdk, pending } = makeWaitingSdk();
    const typed = sdk as unknown as ComposioSdk;
    const { interaction } = makeInteraction("U2");

    await handleConnectClick("gmail", interaction);
    // The user does what the tool told them to: asks again, mid-flow. This
    // refills the cache with a session that predates the connection.
    await getSession(typed, "U2", ["gmail"]);
    const beforeConnect = sdk.sessions.create.mock.calls.length;

    pending.resolve({ id: "ca_1" });
    await flush();

    await getSession(typed, "U2", ["gmail"]);
    expect(sdk.sessions.create.mock.calls.length).toBe(beforeConnect + 1);
  });

  it("survives an abandoned authorization without an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const { sdk, pending } = makeWaitingSdk();
      const typed = sdk as unknown as ComposioSdk;
      const { interaction } = makeInteraction("U2");

      await handleConnectClick("gmail", interaction);
      await getSession(typed, "U2", ["gmail"]);
      const beforeTimeout = sdk.sessions.create.mock.calls.length;

      // What a closed browser tab looks like. Unhandled, this terminates the
      // process on Node 22 — the bot would go down with the user's tab.
      pending.reject(new Error("connection timed out"));
      await flush();

      expect(unhandled).toEqual([]);
      // Nothing connected, so nothing is invalidated.
      await getSession(typed, "U2", ["gmail"]);
      expect(sdk.sessions.create.mock.calls.length).toBe(beforeTimeout);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("does not chain a wait onto a link nobody could be sent", async () => {
    const { waitForConnection } = makeWaitingSdk();
    const { interaction } = makeInteraction("U2", async () => ({ ok: false }));

    await handleConnectClick("gmail", interaction);

    expect(waitForConnection).not.toHaveBeenCalled();
  });

  it("still works against a session that offers no wait at all", async () => {
    makeSdk();
    const { interaction, postEphemeral } = makeInteraction("U2");

    await expect(
      handleConnectClick("gmail", interaction),
    ).resolves.toBeUndefined();

    expect(postEphemeral).toHaveBeenCalledTimes(1);
  });
});

/**
 * The regression that makes the card's shape load-bearing.
 *
 * A click arriving after a restart is served by re-rendering `ConnectAccount`
 * from its **stored** props — which have been through the state store and carry
 * no functions. A handler passed in as a prop would be gone, the re-rendered
 * button would have no `onClick`, and the Channel swallows the resulting
 * `ActionExpiredError`: the person clicks "Connect Gmail" and nothing happens,
 * every time, with nothing anywhere to explain it.
 *
 * Nothing in this flow needs the process that posted the card — the link is
 * minted fresh, for the clicker — so cold it must work exactly as warm.
 */
describe("a click that lands after a restart", () => {
  it("mints a link from the stored props alone, with no handler carried over", async () => {
    const sdk = makeSdk();
    const stored = JSON.parse(JSON.stringify({ toolkit: "gmail" })) as {
      toolkit: string;
    };

    const onClick = clickHandlerOf(<ConnectAccount {...stored} />);
    const { interaction, post, postEphemeral } = makeInteraction("U2");
    await onClick(interaction);

    expect(sdk.created[0]?.userId).toBe("U2");
    expect(postEphemeral).toHaveBeenCalledTimes(1);
    expect(String(postEphemeral.mock.calls[0]?.[1])).toContain(REDIRECT);
    // And still never in the thread, cold path or not.
    expect(post).not.toHaveBeenCalled();
  });

  it("tells the clicker privately when the deployment is no longer configured", async () => {
    // An operator pulled the key while a card was live. Silence would be
    // indistinguishable from the bug above.
    delete process.env.COMPOSIO_API_KEY;
    const { interaction, post, postEphemeral } = makeInteraction("U2");

    await handleConnectClick("gmail", interaction);

    expect(postEphemeral).toHaveBeenCalledTimes(1);
    const told = String(postEphemeral.mock.calls[0]?.[1]);
    expect(told).toContain("not configured");
    // A missing key is permanent. "Try again in a moment" would send the
    // clicker into a loop that cannot end and hide whose problem this is.
    expect(told).not.toContain("Try again in a moment");
    expect(told).toContain("Retrying will not help");
    expect(post).not.toHaveBeenCalled();
  });
});
