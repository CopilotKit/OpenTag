/**
 * Shared Daytona provider for every OpenTag sandbox job.
 *
 * Starts from snapshot `daytona-medium`. Do not set `workdir` on the provider.
 * Set `workspace.root` to {@link DAYTONA_WORKSPACE_ROOT} on every sandbox.
 * TanStack clones gitSkills with a path inside a shell command. Daytona only
 * remaps `cwd` and `fs` paths, not those command strings. A virtual
 * `/workspace/...` clone lands in the wrong place (or fails), then Grok/Codex
 * cannot link the skill.
 *
 * `git clone` needs an empty dest. The snapshot and a pre-made
 * `.tanstack-skills` dir make the workspace non-empty, so TanStack's
 * clone into the root can leave no `.git`. create() wraps `git.clone`:
 * the repo clone goes to a sibling empty dir, then the tree moves into
 * the workspace. gitSkill clones still mkdir their parent first.
 */
import type { SandboxHandle } from "@tanstack/ai-sandbox";
import { daytonaSandbox } from "@tanstack/ai-sandbox-daytona";

export const DEFAULT_DAYTONA_SNAPSHOT = "daytona-medium";

/** Real Daytona workdir. Virtual `/workspace` maps here. */
export const DAYTONA_WORKSPACE_ROOT = "/home/daytona/workspace";

export function requireDaytonaApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = env.DAYTONA_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "Missing DAYTONA_API_KEY — required for OpenTag sandboxes",
    );
  }
  return key;
}

export function createOpenTagDaytonaProvider(
  env: NodeJS.ProcessEnv = process.env,
) {
  const inner = daytonaSandbox({
    apiKey: requireDaytonaApiKey(env),
    snapshot: DEFAULT_DAYTONA_SNAPSHOT,
  });

  // Do not object-spread the class instance. Methods live on the
  // prototype and would be dropped.
  return {
    name: inner.name,
    capabilities: () => inner.capabilities(),
    create: async (input: Parameters<typeof inner.create>[0]) => {
      const handle = await inner.create(input);
      return wrapHandleForGitClone(handle);
    },
    resume: async (input: Parameters<typeof inner.resume>[0]) => {
      const handle = await inner.resume(input);
      return handle ? wrapHandleForGitClone(handle) : handle;
    },
    destroy: (input: Parameters<typeof inner.destroy>[0]) =>
      inner.destroy(input),
    ...(inner.restoreSnapshot
      ? {
          restoreSnapshot: (
            input: Parameters<NonNullable<typeof inner.restoreSnapshot>>[0],
          ) => inner.restoreSnapshot!(input),
        }
      : {}),
  };
}

function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

function isWorkspaceRoot(path: string): boolean {
  return (
    path === DAYTONA_WORKSPACE_ROOT ||
    path === `${DAYTONA_WORKSPACE_ROOT}/` ||
    path === "/workspace" ||
    path === "/workspace/"
  );
}

function wrapHandleForGitClone<T extends Pick<SandboxHandle, "fs" | "git">>(
  handle: T,
): T {
  const innerClone = handle.git.clone.bind(handle.git);
  handle.git.clone = async (input) => {
    const dest = input.dir ?? DAYTONA_WORKSPACE_ROOT;
    if (!isWorkspaceRoot(dest)) {
      const parent = parentDir(dest);
      if (parent !== "/") {
        await handle.fs.mkdir(parent);
      }
      await innerClone(input);
      return;
    }

    const staging = `${parentDir(DAYTONA_WORKSPACE_ROOT)}/.opentag-src`;
    if (await handle.fs.exists(staging)) {
      await handle.fs.remove(staging);
    }
    await innerClone({ ...input, dir: staging });
    if (!(await handle.fs.exists(`${staging}/.git`))) {
      throw new Error(`git clone did not create ${staging}/.git`);
    }
    for (const leftover of await handle.fs.list(DAYTONA_WORKSPACE_ROOT)) {
      await handle.fs.remove(leftover.path);
    }
    const kids = await handle.fs.list(staging);
    for (const kid of kids) {
      await handle.fs.rename(
        kid.path,
        `${DAYTONA_WORKSPACE_ROOT}/${kid.name}`,
      );
    }
    await handle.fs.remove(staging);
  };
  return handle;
}
