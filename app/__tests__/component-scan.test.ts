import { describe, it, expect } from "vitest";
import { interactiveComponentNames } from "./component-scan.js";

describe("interactiveComponentNames — existing passing shapes", () => {
  it("finds a component declared with `export function`", () => {
    const src = `
export function ConfirmWrite({ action }: Props) {
  return <Button onClick={async () => {}}>Create</Button>;
}
`;
    expect(interactiveComponentNames(src)).toEqual(["ConfirmWrite"]);
  });

  it("finds a component declared with `export const` and an arrow", () => {
    const src = `
export const QuickReply = ({ label }: Props) => (
  <Button onClick={async () => {}}>{label}</Button>
);
`;
    expect(interactiveComponentNames(src)).toEqual(["QuickReply"]);
  });

  it("returns nothing for a file with no onClick", () => {
    const src = `
export function StatusCard({ heading }: Props) {
  return <Section>{heading}</Section>;
}
`;
    expect(interactiveComponentNames(src)).toEqual([]);
  });

  it("attributes an onClick to its own declaration, not a later sibling", () => {
    const src = `
export function IncidentCard({ id }: Props) {
  return <Button onClick={async () => {}}>{id}</Button>;
}

export function StatusCard({ heading }: Props) {
  return <Section>{heading}</Section>;
}
`;
    expect(interactiveComponentNames(src)).toEqual(["IncidentCard"]);
  });

  it("finds every interactive declaration in a file", () => {
    const src = `
export function CardA() {
  return <Button onClick={async () => {}}>a</Button>;
}

export const CardB = () => <Button onClick={async () => {}}>b</Button>;
`;
    expect(interactiveComponentNames(src)).toEqual(["CardA", "CardB"]);
  });
});

describe("interactiveComponentNames — false negatives (must not fail open)", () => {
  it("finds a component declared with `export default function`", () => {
    const src = `
export default function QuickReply({ label }: Props) {
  return <Button onClick={async () => {}}>{label}</Button>;
}
`;
    expect(interactiveComponentNames(src)).toEqual(["QuickReply"]);
  });

  it("finds a component declared with `export async function`", () => {
    const src = `
export async function QuickReply({ label }: Props) {
  return <Button onClick={async () => {}}>{label}</Button>;
}
`;
    expect(interactiveComponentNames(src)).toEqual(["QuickReply"]);
  });

  it("finds a component declared with `export default async function`", () => {
    // Not in the review table, but explicitly required by the fix: the
    // widened matcher must cover this combined form too.
    const src = `
export default async function QuickReply({ label }: Props) {
  return <Button onClick={async () => {}}>{label}</Button>;
}
`;
    expect(interactiveComponentNames(src)).toEqual(["QuickReply"]);
  });

  it("attributes onClick to a bare declaration surfaced via `export { }`", () => {
    const src = `
function QuickReply({ label }: Props) {
  return <Button onClick={async () => {}}>{label}</Button>;
}

export { QuickReply };
`;
    expect(interactiveComponentNames(src)).toEqual(["QuickReply"]);
  });

  it("throws rather than silently dropping onClick in a helper above the file's first export", () => {
    // The original regex only ever looked at spans *between* matched
    // exports — content before the first one was invisible to it entirely,
    // so this dead-lettering component was reported as "all clear".
    const src = `
function helperRender() {
  return <Button onClick={async () => {}}>Click</Button>;
}

export function ComponentX({ heading }: Props) {
  return <Section>{heading}</Section>;
}
`;
    expect(() => interactiveComponentNames(src, "helper-above-export.tsx")).toThrow(
      /helper-above-export\.tsx/,
    );
  });
});

describe("interactiveComponentNames — false positives (must not fail closed)", () => {
  it("does not flag a tool descriptor whose config happens to contain onClick=", () => {
    // `MANAGED_COMPONENTS` takes component functions; a `defineChannelTool`
    // call can never be "fixed" by adding it there, no matter what its
    // config literally contains.
    const src = `
export const someTool = defineChannelTool({
  name: "some_tool",
  description: "posts a card",
  async handler(props, { thread }) {
    await thread.post(
      <Message>
        <Actions>
          <Button onClick={async () => {}}>Click</Button>
        </Actions>
      </Message>,
    );
    return "done";
  },
});
`;
    expect(interactiveComponentNames(src)).toEqual([]);
  });

  it("ignores onClick= mentioned only inside a comment", () => {
    const src = `
export function StatusCard({ heading }: Props) {
  // legacy version used onClick={...} here; now static
  /* another note: onClick= isn't wired up anymore */
  return <Section>{heading}</Section>;
}
`;
    expect(interactiveComponentNames(src)).toEqual([]);
  });

  it("does not blame a string constant sitting between two components", () => {
    // Old bug: the regex only recognized `export function`/`export const`,
    // so `export default function` was invisible to it — the trailing
    // onClick then bled all the way to EOF and landed on the last export
    // it *did* see, an unrelated string constant.
    const src = `
export function ComponentA({ label }: Props) {
  return <Section>{label}</Section>;
}

export const BTN_STYLE = "primary";

export default function ComponentB({ label }: Props) {
  return <Button onClick={async () => {}}>{label}</Button>;
}
`;
    expect(interactiveComponentNames(src)).toEqual(["ComponentB"]);
  });
});

describe("interactiveComponentNames — mutant proof (old regex vs. new cases)", () => {
  // Not a test of interactiveComponentNames itself — a direct demonstration
  // that the false-negative fixtures above are only caught because of this
  // fix, by re-running them through the OLD regex the guard used to ship.
  const OLD_TOP_LEVEL_EXPORT = /^export (?:function|const) (\w+)/gm;
  function oldInteractiveComponentNames(src: string): string[] {
    if (!/\bonClick=/.test(src)) return [];
    const decls = [...src.matchAll(OLD_TOP_LEVEL_EXPORT)].map((m) => ({
      name: m[1] as string,
      start: m.index as number,
    }));
    const names: string[] = [];
    for (const [i, decl] of decls.entries()) {
      const end = decls[i + 1]?.start ?? src.length;
      if (/\bonClick=/.test(src.slice(decl.start, end))) names.push(decl.name);
    }
    return names;
  }

  it("the old regex missed `export default function`", () => {
    const src = `
export default function QuickReply({ label }: Props) {
  return <Button onClick={async () => {}}>{label}</Button>;
}
`;
    expect(oldInteractiveComponentNames(src)).toEqual([]);
  });

  it("the old regex missed `export async function`", () => {
    const src = `
export async function QuickReply({ label }: Props) {
  return <Button onClick={async () => {}}>{label}</Button>;
}
`;
    expect(oldInteractiveComponentNames(src)).toEqual([]);
  });

  it("the old regex missed a bare declaration surfaced via `export { }`", () => {
    const src = `
function QuickReply({ label }: Props) {
  return <Button onClick={async () => {}}>{label}</Button>;
}

export { QuickReply };
`;
    expect(oldInteractiveComponentNames(src)).toEqual([]);
  });

  it("the old regex silently dropped a helper above the file's first export", () => {
    const src = `
function helperRender() {
  return <Button onClick={async () => {}}>Click</Button>;
}

export function ComponentX({ heading }: Props) {
  return <Section>{heading}</Section>;
}
`;
    expect(oldInteractiveComponentNames(src)).toEqual([]);
  });

  it("the old regex demanded registration of a tool descriptor", () => {
    const src = `
export const someTool = defineChannelTool({
  name: "some_tool",
  async handler(props, { thread }) {
    await thread.post(
      <Message>
        <Button onClick={async () => {}}>Click</Button>
      </Message>,
    );
    return "done";
  },
});
`;
    expect(oldInteractiveComponentNames(src)).toEqual(["someTool"]);
  });

  it("the old regex blamed a string constant instead of the real component", () => {
    const src = `
export function ComponentA({ label }: Props) {
  return <Section>{label}</Section>;
}

export const BTN_STYLE = "primary";

export default function ComponentB({ label }: Props) {
  return <Button onClick={async () => {}}>{label}</Button>;
}
`;
    expect(oldInteractiveComponentNames(src)).toEqual(["BTN_STYLE"]);
  });
});
