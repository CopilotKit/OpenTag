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

  it("does not flag a tool descriptor whose config happens to contain onClick=", () => {
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

// The nine distinct failure modes independently confirmed by a 7-agent
// review round against the old regex scanner. Each row below is the exact
// shape that used to break it — fails-open modes 1–6 used to return the
// wrong name (or nothing at all) instead of the real component; fails-closed
// modes 7–9 used to throw or demand registration when the correct answer was
// "this is fine" / "this isn't a component". The AST walk gets every one of
// these right by construction, not by another special case.
describe("interactiveComponentNames — the nine review-confirmed modes", () => {
  it("mode 1: a type annotation on `export const` does not defeat recognition or leak the onClick backward", () => {
    const src = `
export function Prior() {
  return <Section>prior</Section>;
}

export const Card: FC<Props> = (props) => {
  return <Button onClick={async () => {}}>{props.label}</Button>;
};
`;
    expect(interactiveComponentNames(src)).toEqual(["Card"]);
  });

  it("mode 2: a generic arrow component is recognized", () => {
    const src = `
export const Card = <T,>(p: P<T>) => {
  return <Button onClick={async () => {}}>{String(p)}</Button>;
};
`;
    expect(interactiveComponentNames(src)).toEqual(["Card"]);
  });

  it("mode 3: a component wrapped in `memo(...)` is recognized", () => {
    const src = `
export const Card = memo(({ label }: Props) => {
  return <Button onClick={async () => {}}>{label}</Button>;
});
`;
    expect(interactiveComponentNames(src)).toEqual(["Card"]);
  });

  it("mode 4: a preceding string-constant export does not swallow the next declaration", () => {
    const src = `
export const A = "x";
export const Card = ({ label }: Props) => {
  return <Button onClick={async () => {}}>{label}</Button>;
};
`;
    expect(interactiveComponentNames(src)).toEqual(["Card"]);
  });

  it("mode 5: a `//` inside a string literal does not blank a same-line onClick", () => {
    const src = `
export function Card({ label }: Props) {
  return (
    <a href="https://example.com//path">
      <Button onClick={async () => {}}>{label}</Button>
    </a>
  );
}
`;
    expect(interactiveComponentNames(src)).toEqual(["Card"]);
  });

  it("mode 6: `onClick = {...}` with spaces around `=` is still recognized", () => {
    const src = `
export function Card({ label }: Props) {
  return <Button onClick = {async () => {}}>{label}</Button>;
}
`;
    expect(interactiveComponentNames(src)).toEqual(["Card"]);
  });

  it("mode 7: `export default Foo;` re-exporting an already-declared identifier does not throw", () => {
    const src = `
function Card({ label }: Props) {
  return <Button onClick={async () => {}}>{label}</Button>;
}

export default Card;
`;
    expect(interactiveComponentNames(src)).toEqual(["Card"]);
  });

  it("mode 8: an exported lowercase factory function returning JSX is not demanded in the registry", () => {
    const src = `
export function makeCard() {
  return <Button onClick={async () => {}}>Click</Button>;
}
`;
    expect(interactiveComponentNames(src)).toEqual([]);
  });

  it("mode 9: a template literal containing what looks like a function declaration does not trigger a bogus throw", () => {
    const src = `
export function Card({ id }: Props) {
  const script = \`
function boot() {
  console.log("boot");
}
\`;
  return <Button onClick={async () => {}}>{id}</Button>;
}
`;
    expect(interactiveComponentNames(src)).toEqual(["Card"]);
  });
});
