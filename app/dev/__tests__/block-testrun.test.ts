import { describe, expect, it, vi } from "vitest";
import {
  ActionRegistry,
  InMemoryActionStore,
  renderToIR,
} from "@copilotkit/channels";
import {
  SLACK_NATIVE_MANIFEST,
  renderBlockKit,
} from "@copilotkit/channels/slack";
import {
  BLOCK_TESTRUN_ENV_VAR,
  BLOCK_TESTRUN_ITEMS,
  BLOCK_TESTRUN_SKIPPED,
  BLOCK_TESTRUN_TRIGGER,
  createBlockTestRunHook,
  handleBlockTestRun,
  isBlockTestRunEnabled,
  parseTestRunFilter,
  runBlockTestRun,
  summaryText,
} from "../block-testrun.js";

const manifestKeys = SLACK_NATIVE_MANIFEST.map(
  (entry) => `${entry.kind}:${entry.type}`,
).sort();

describe("block test-run coverage", () => {
  // The point of deriving from the manifest: an entry added to the SDK's
  // catalog fails here instead of quietly going untested for a release.
  it("posts exactly one item per catalog entry", () => {
    expect(BLOCK_TESTRUN_ITEMS.map((item) => item.key).sort()).toEqual(
      manifestKeys,
    );
  });

  it("accounts for the entries Slack refuses from a message", () => {
    // These are absent from the manifest on purpose, so they can only be
    // covered as declared skips — never as items.
    expect(BLOCK_TESTRUN_SKIPPED.map((skip) => skip.key).sort()).toEqual([
      "block:alert",
      "block:file",
    ]);
    for (const skip of BLOCK_TESTRUN_SKIPPED) {
      expect(skip.reason.length).toBeGreaterThan(0);
      expect(manifestKeys).not.toContain(skip.key);
    }
  });

  it("labels every item", () => {
    for (const item of BLOCK_TESTRUN_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  // Serialization failures are cheaper to find here than in a 70-second live
  // run: the codec rejects a missing required field before Slack ever sees it.
  it.each(BLOCK_TESTRUN_ITEMS.map((item) => [item.key, item] as const))(
    "%s serializes to Block Kit",
    (_key, item) => {
      expect(() => renderBlockKit(renderToIR([item.node]))).not.toThrow();
    },
  );
});

/**
 * The return path, as far as it can be proved without a human clicking: an
 * element whose handler never binds is delivered without an `action_id`, and
 * Slack then has nothing to call back with — the control is silent by
 * construction rather than by defect. This binds each item the way `thread.post`
 * does and asserts the id survives into the Block Kit that reaches Slack.
 */
async function actionIds(node: unknown): Promise<string[]> {
  const registry = new ActionRegistry({ store: new InMemoryActionStore() });
  const bound = await registry.bindRenderable([node] as never, "conv:test");
  const found: string[] = [];

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value !== "object" || value === null) return;
    for (const [name, child] of Object.entries(value)) {
      if (name === "action_id" && typeof child === "string") found.push(child);
      walk(child);
    }
  };
  walk(renderBlockKit(bound.root));
  return found;
}

describe("block test-run return path", () => {
  // Guards the guard: if a refactor dropped the handlers, the per-item checks
  // below would all pass by being generated from an empty list.
  it("attaches a handler to most of the catalog", () => {
    expect(
      BLOCK_TESTRUN_ITEMS.filter((item) => hasHandler(item.node)).length,
    ).toBeGreaterThan(25);
  });

  it.each(
    BLOCK_TESTRUN_ITEMS.filter((item) => hasHandler(item.node)).map(
      (item) => [item.key, item] as const,
    ),
  )("%s reaches Slack with an action_id", async (_key, item) => {
    expect(await actionIds(item.node)).not.toHaveLength(0);
  });
});

/** True when the payload carries a handler somewhere in its prop tree. */
function hasHandler(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasHandler);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([name, child]) =>
      (["onClick", "onSelect", "onSubmit"].includes(name) &&
        typeof child === "function") ||
      hasHandler(child),
  );
}

describe("block test-run gate", () => {
  const thread = () => ({ post: vi.fn(async () => ({ id: "m1" })) });

  // The gate has to make the harness *absent*, not present-and-declining: with
  // the flag unset `app/channel.tsx` must have no hook to call, so a mention
  // takes exactly the path it takes without this file.
  it("installs no hook at all when the env var is unset", () => {
    expect(createBlockTestRunHook({})).toBeUndefined();
    for (const value of ["0", "true", "yes", ""]) {
      expect(
        createBlockTestRunHook({ [BLOCK_TESTRUN_ENV_VAR]: value }),
      ).toBeUndefined();
    }
  });

  it("installs a hook that declines mentions without the trigger", async () => {
    const hook = createBlockTestRunHook({ [BLOCK_TESTRUN_ENV_VAR]: "1" });
    expect(hook).toBeDefined();

    const target = thread();
    await expect(
      hook?.({ thread: target, message: { text: "triage my open issues" } }),
    ).resolves.toBe(false);
    expect(target.post).not.toHaveBeenCalled();
  });

  it("is inert when the env var is unset", async () => {
    const target = thread();

    await expect(
      handleBlockTestRun(
        {
          thread: target,
          message: { text: `please ${BLOCK_TESTRUN_TRIGGER}` },
        },
        {},
      ),
    ).resolves.toBe(false);
    expect(target.post).not.toHaveBeenCalled();
  });

  it("is inert when the env var is not exactly 1", async () => {
    for (const value of ["0", "true", "yes", ""]) {
      expect(isBlockTestRunEnabled({ [BLOCK_TESTRUN_ENV_VAR]: value })).toBe(
        false,
      );
    }
  });

  it("ignores a mention without the trigger phrase even when armed", async () => {
    const target = thread();

    await expect(
      handleBlockTestRun(
        { thread: target, message: { text: "triage my open issues" } },
        { [BLOCK_TESTRUN_ENV_VAR]: "1" },
      ),
    ).resolves.toBe(false);
    expect(target.post).not.toHaveBeenCalled();
  });
});

describe("block test-run filter", () => {
  it("selects the entries whose key contains the token", () => {
    expect(parseTestRunFilter("test-run element:workflow_button")).toBe(
      "element:workflow_button",
    );
    expect(parseTestRunFilter("test-run rich_text_input")).toBe(
      "rich_text_input",
    );
  });

  // Prose after the trigger is the common case, and a token that names nothing
  // must not narrow the run to zero items and call that a pass.
  it("ignores trailing prose that names no catalog entry", () => {
    expect(parseTestRunFilter("test-run — gate check B")).toBeUndefined();
    expect(parseTestRunFilter("test-run please")).toBeUndefined();
    expect(parseTestRunFilter("test-run")).toBeUndefined();
    expect(parseTestRunFilter(undefined)).toBeUndefined();
  });

  it("carries the filter from the mention into the run", async () => {
    const target = { post: vi.fn(async () => ({ id: "m1" })) };

    await expect(
      handleBlockTestRun(
        { thread: target, message: { text: "test-run block:divider" } },
        { [BLOCK_TESTRUN_ENV_VAR]: "1" },
      ),
    ).resolves.toBe(true);

    // Header, the one item, and the summary — never the whole catalog.
    expect(target.post.mock.calls.length).toBeLessThan(5);
  });
});

describe("block test-run summary", () => {
  it("names every refusal and every skip", () => {
    const text = summaryText([
      { key: "block:section", label: "Section", status: "delivered" },
      {
        key: "object:workflow",
        label: "Workflow",
        status: "refused",
        error: "invalid_blocks: invalid field at /blocks/1",
        expected: "needs a published workflow",
      },
      {
        key: "block:alert",
        label: "not postable from a message",
        status: "skipped",
        reason: "modals only",
      },
    ]);

    expect(text).toContain("1 delivered, 1 refused, 1 skipped");
    expect(text).toContain("block:section");
    expect(text).toContain("invalid field at /blocks/1");
    expect(text).toContain("needs a published workflow");
    expect(text).toContain("modals only");
  });

  // A filtered run of a deferred item runs nothing in the main pass, and a
  // "0 delivered, 0 refused, 0 skipped" notice reads as a run that did nothing —
  // the opposite of the verdict it is about to produce.
  it("posts no empty summary for a run of only deferred items", async () => {
    const posted: string[] = [];
    const target = {
      post: vi.fn(async (ui: unknown) => {
        if (typeof ui === "string") posted.push(ui);
        return { id: "m1" };
      }),
    };

    await runBlockTestRun(target, "rich_text_input");

    expect(posted.some((text) => text.includes("0 delivered"))).toBe(false);
    expect(posted.some((text) => text.includes("rich_text_input"))).toBe(true);
  });
});
