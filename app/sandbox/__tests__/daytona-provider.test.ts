import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeEntry = { name: string; path: string; type: "file" | "dir" };

function createFakeHandle(seed: string[] = []) {
  const entries = new Set(seed);

  const exists = async (p: string) => {
    if (entries.has(p)) return true;
    const prefix = `${p.replace(/\/$/, "")}/`;
    return [...entries].some((e) => e.startsWith(prefix));
  };

  const list = async (p: string): Promise<FakeEntry[]> => {
    const root = p.replace(/\/$/, "");
    const prefix = `${root}/`;
    const names = new Map<string, "file" | "dir">();
    for (const e of entries) {
      if (e === root || !e.startsWith(prefix)) continue;
      const rest = e.slice(prefix.length);
      const name = rest.split("/")[0];
      if (!name) continue;
      const type = rest.includes("/") ? "dir" : "file";
      names.set(name, names.get(name) === "dir" || type === "dir" ? "dir" : "file");
    }
    return [...names].map(([name, type]) => ({
      name,
      path: `${root}/${name}`,
      type,
    }));
  };

  const mkdir = vi.fn(async (p: string) => {
    entries.add(p);
  });
  const remove = vi.fn(async (p: string) => {
    const root = p.replace(/\/$/, "");
    for (const e of [...entries]) {
      if (e === root || e.startsWith(`${root}/`)) entries.delete(e);
    }
  });
  const rename = vi.fn(async (from: string, to: string) => {
    const src = from.replace(/\/$/, "");
    for (const e of [...entries]) {
      if (e === src || e.startsWith(`${src}/`)) {
        entries.delete(e);
        entries.add(`${to}${e.slice(src.length)}`);
      }
    }
  });

  // TanStack git.clone does not throw when dest is not empty. It just
  // leaves dest without a .git. That is the live Slack merge failure.
  // Real git also fails when the dest parent dir is missing.
  const innerClone = vi.fn(async (input: { url: string; dir?: string }) => {
    const dest = input.dir ?? "/home/daytona/workspace";
    const parent = dest.replace(/\/[^/]+\/?$/, "") || "/";
    if (
      parent !== "/" &&
      parent !== "/home/daytona" &&
      !(await exists(parent))
    ) {
      throw new Error(`git clone dest parent missing: ${parent}`);
    }
    if (await exists(dest)) {
      const kids = await list(dest);
      if (kids.length > 0) return;
    }
    entries.add(`${dest}/.git`);
    entries.add(`${dest}/package.json`);
  });

  return {
    workspaceRoot: "/home/daytona/workspace",
    fs: { mkdir, exists, list, remove, rename },
    git: { clone: innerClone },
    entries,
    innerClone,
  };
}

function fakeDaytonaProvider(overrides?: {
  create?: (input: { id: string }) => Promise<{
    fs: { mkdir: (p: string) => Promise<void> };
    git?: { clone: (input: { url: string; dir?: string }) => Promise<void> };
  }>;
  resume?: (input: { id: string }) => Promise<null>;
  destroy?: (input: { id: string }) => Promise<void>;
  capabilities?: () => { fs: boolean; exec: boolean };
}) {
  return {
    name: "daytona",
    create:
      overrides?.create ??
      vi.fn(async () => ({ fs: { mkdir: vi.fn(async () => undefined) } })),
    resume: overrides?.resume ?? vi.fn(async () => null),
    destroy: overrides?.destroy ?? vi.fn(async () => undefined),
    capabilities:
      overrides?.capabilities ?? vi.fn(() => ({ fs: true, exec: true })),
  };
}

const daytonaSandbox = vi.fn((_cfg?: unknown) => fakeDaytonaProvider());

vi.mock("@tanstack/ai-sandbox-daytona", () => ({
  daytonaSandbox: (cfg: unknown) => daytonaSandbox(cfg),
}));

import {
  createOpenTagDaytonaProvider,
  DAYTONA_WORKSPACE_ROOT,
  DEFAULT_DAYTONA_SNAPSHOT,
  requireDaytonaApiKey,
} from "../daytona-provider.js";

describe("daytona-provider", () => {
  beforeEach(() => {
    daytonaSandbox.mockClear();
  });

  it("requireDaytonaApiKey throws when missing or blank", () => {
    expect(() => requireDaytonaApiKey({})).toThrow(/DAYTONA_API_KEY/);
    expect(() => requireDaytonaApiKey({ DAYTONA_API_KEY: "   " })).toThrow(
      /DAYTONA_API_KEY/,
    );
  });

  it("requireDaytonaApiKey trims the key", () => {
    expect(requireDaytonaApiKey({ DAYTONA_API_KEY: "  dt-key  " })).toBe(
      "dt-key",
    );
  });

  it("createOpenTagDaytonaProvider passes apiKey + daytona-medium and no workdir", () => {
    createOpenTagDaytonaProvider({ DAYTONA_API_KEY: "dt-key" });
    expect(daytonaSandbox).toHaveBeenCalledWith({
      apiKey: "dt-key",
      snapshot: DEFAULT_DAYTONA_SNAPSHOT,
    });
    expect(DEFAULT_DAYTONA_SNAPSHOT).toBe("daytona-medium");
    const arg = daytonaSandbox.mock.calls[0]?.[0];
    expect(arg).toEqual({
      apiKey: "dt-key",
      snapshot: DEFAULT_DAYTONA_SNAPSHOT,
    });
    expect(arg).not.toHaveProperty("workdir");
  });

  it("exports the real Daytona workspace path (virtual /workspace maps here)", () => {
    expect(DAYTONA_WORKSPACE_ROOT).toBe("/home/daytona/workspace");
  });

  it("create leaves the workspace empty so git clone can land the PR repo", async () => {
    const handle = createFakeHandle([
      `${DAYTONA_WORKSPACE_ROOT}/README.md`,
    ]);
    const innerCreate = vi.fn(async () => handle);
    daytonaSandbox.mockReturnValue(
      fakeDaytonaProvider({ create: innerCreate }),
    );

    const provider = createOpenTagDaytonaProvider({ DAYTONA_API_KEY: "dt-key" });
    const wrapped = await provider.create({ id: "box-1" });
    if (!("git" in wrapped) || !wrapped.git) {
      throw new Error("expected provider.create to return a handle with git");
    }

    await wrapped.git.clone({
      url: "https://github.com/CopilotKit/CopilotKit.git",
    });

    expect(await wrapped.fs.exists(`${DAYTONA_WORKSPACE_ROOT}/.git`)).toBe(
      true,
    );
  });

  it("create still has a parent dir for later gitSkill clones", async () => {
    const handle = createFakeHandle();
    const innerCreate = vi.fn(async () => handle);
    daytonaSandbox.mockReturnValue(
      fakeDaytonaProvider({ create: innerCreate }),
    );

    const provider = createOpenTagDaytonaProvider({ DAYTONA_API_KEY: "dt-key" });
    const wrapped = await provider.create({ id: "box-1" });
    if (!("git" in wrapped) || !wrapped.git) {
      throw new Error("expected provider.create to return a handle with git");
    }

    await wrapped.git.clone({
      url: "https://github.com/dietrichgebert/ponytail.git",
      dir: `${DAYTONA_WORKSPACE_ROOT}/.tanstack-skills/ponytail`,
    });

    expect(
      await wrapped.fs.exists(
        `${DAYTONA_WORKSPACE_ROOT}/.tanstack-skills/ponytail/.git`,
      ),
    ).toBe(true);
  });

  it("delegates resume, destroy, and capabilities to the Daytona provider", async () => {
    const resume = vi.fn(async () => null);
    const destroy = vi.fn(async () => undefined);
    const capabilities = vi.fn(() => ({ fs: true, exec: true }));
    daytonaSandbox.mockReturnValue(
      fakeDaytonaProvider({ resume, destroy, capabilities }),
    );

    const provider = createOpenTagDaytonaProvider({ DAYTONA_API_KEY: "dt-key" });
    expect(provider.name).toBe("daytona");
    expect(provider.capabilities()).toEqual({ fs: true, exec: true });
    await provider.resume({ id: "box-1" });
    await provider.destroy({ id: "box-1" });
    expect(resume).toHaveBeenCalledWith({ id: "box-1" });
    expect(destroy).toHaveBeenCalledWith({ id: "box-1" });
  });
});
