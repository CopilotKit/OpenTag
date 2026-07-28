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

  it("throws rather than silently dropping onClick in an un-exported module-scope helper (unexported, not merely positioned before the first export)", () => {
    // The throw is driven by `helperRender` never being exported by any
    // route (no `export` modifier, no `export { helperRender }`, no
    // `export default helperRender;`) — its position in the file relative
    // to `ComponentX`'s `export` is irrelevant to the implementation.
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

// Four review-confirmed attribution bugs found AFTER the regex->AST rewrite
// above (which fixed the nine modes in the previous describe block). Each of
// these was independently reproduced by execution.
describe("interactiveComponentNames — four post-rewrite attribution bugs", () => {
  describe("finding 1: climbing must not stop at the nearest named declaration — it must climb to the nearest PLAUSIBLE COMPONENT ROOT", () => {
    it("attributes onClick in a local `const` inside the component to the enclosing component, not the local", () => {
      // THE BUG: `findEnclosingDecl` used to stop at the nearest named
      // declaration of ANY kind, so this threw `onClick= found in
      // un-exported declaration "actions"` and told the caller to
      // `export function actions` — actively wrong remediation advice for
      // perfectly ordinary code.
      const src = `
export function IncidentCard({ id }: Props) {
  const actions = <Button onClick={async () => {}}>{id}</Button>;
  return <Message>{actions}</Message>;
}
`;
      expect(interactiveComponentNames(src)).toEqual(["IncidentCard"]);
    });

    it("attributes onClick inside `items.map(...)` to the enclosing component, not the local `rows`", () => {
      // THE BUG: same stop-at-nearest failure, hitting the standard shape
      // this codebase uses to render issue/page lists (see
      // app/components/issue-list.tsx, app/components/page-list.tsx) — the
      // next contributor to write this shape got a red CI with wrong advice.
      const src = `
export function IssueList({ items }: Props) {
  const rows = items.map((i) => <Button onClick={async () => {}}>{i.id}</Button>);
  return <Section>{rows}</Section>;
}
`;
      expect(interactiveComponentNames(src)).toEqual(["IssueList"]);
    });

    it("attributes onClick inside a nested helper function to the enclosing component, not the helper", () => {
      const src = `
export function PageList({ pages }: Props) {
  function renderRow(p) {
    return <Button onClick={async () => {}}>{p.title}</Button>;
  }
  return <Section>{pages.map(renderRow)}</Section>;
}
`;
      expect(interactiveComponentNames(src)).toEqual(["PageList"]);
    });

    it("attributes onClick inside a class component's render() to the class, not the un-attributable method", () => {
      // THE BUG: `render()` has no matching ancestor in the old kind list
      // (function declaration / variable declaration only), so this threw
      // "could not be attributed to any named declaration" for an ordinary
      // class component.
      const src = `
export class LegacyCard extends React.Component {
  render() {
    return <Button onClick={async () => {}}>{this.props.label}</Button>;
  }
}
`;
      expect(interactiveComponentNames(src)).toEqual(["LegacyCard"]);
    });

    it("still throws when there truly is no enclosing declaration at all (a bare JSX expression statement)", () => {
      // The fix widens the stop condition; it must not widen it into never
      // throwing. A bare `<Button onClick .../>` expression statement with
      // no enclosing function/variable/class declaration at all is still
      // the "this scan doesn't understand this file" case.
      const src = `
<Button onClick={async () => {}}>Click</Button>;
`;
      expect(() => interactiveComponentNames(src, "bare-jsx.tsx")).toThrow(
        /could not be attributed to any named declaration/,
      );
    });
  });

  it("finding 2: an exported object literal (not function-shaped) is not demanded in the registry, even though its name is capitalized", () => {
    // THE BUG: `Cards` passes the capitalization filter (it's a plain
    // object, not a component), so this used to return ["Cards"] and the
    // guard demanded a non-component object be added to MANAGED_COMPONENTS.
    const src = `
export const Cards = {
  Incident: () => <Button onClick={async () => {}}>Ack</Button>,
};
`;
    expect(interactiveComponentNames(src)).toEqual([]);
  });

  it("finding 2b: a component wrapped in memo(...) still counts as function-shaped (does not regress mode 3)", () => {
    const src = `
export const Card = memo(({ label }: Props) => {
  return <Button onClick={async () => {}}>{label}</Button>;
});
`;
    expect(interactiveComponentNames(src)).toEqual(["Card"]);
  });

  it("finding 3: `export { card as Card }` attributes to and emits the EXPORTED alias, not the local name", () => {
    // THE BUG: capitalization was tested against the local name "card"
    // (lowercase), so this component was silently dropped from the
    // expectation set entirely — a genuinely exported interactive component
    // vanishing is exactly the fail-open mode this guard exists to prevent.
    // A second bug: even if capitalization passed, the emitted name was the
    // local identifier ("card"), which can't reconcile against
    // MANAGED_COMPONENTS (keyed by the exported name "Card").
    const src = `
function card({ label }: Props) {
  return <Button onClick={async () => {}}>{label}</Button>;
}

export { card as Card };
`;
    expect(interactiveComponentNames(src)).toEqual(["Card"]);
  });

  it("the `seen` dedup guard collapses two onClicks in the same component to a single name", () => {
    // Both real components in this app (ConfirmWrite, IncidentCard) have
    // exactly this shape — two buttons, each with its own onClick. Without
    // this test, removing the `seen` guard entirely still passes the whole
    // suite while double-reporting against real source.
    const src = `
export function DoubleButtonCard({ label }: Props) {
  return (
    <Actions>
      <Button onClick={async () => {}}>{label}</Button>
      <Button onClick={async () => {}}>{label}</Button>
    </Actions>
  );
}
`;
    expect(interactiveComponentNames(src)).toEqual(["DoubleButtonCard"]);
  });

  describe("script kind is chosen from the label's file extension, not hardcoded to TSX", () => {
    it("does not misread a non-trailing-comma generic arrow as JSX when the label says .ts", () => {
      // THE BUG THIS PROVES FIXED: with `ts.ScriptKind.TSX` hardcoded
      // (ignoring `label`), the parser reads the non-trailing-comma generic
      // arrow `<T>(x: T): T => x` as an OPENING JSX TAG — and because
      // `ts.createSourceFile` never throws on malformed syntax, it just
      // keeps consuming: the entire rest of this fixture, including the
      // real `<Button onClick={...}>` in the `Card` function below, gets
      // swallowed as JSX TEXT/CHILDREN of that one malformed element. `Card`
      // itself never becomes a sibling declaration in the tree at all, so
      // climbing from the (still-detected) `onClick` JsxAttribute lands
      // directly on the `identity` variable declaration instead — which is
      // how this used to throw `onClick= found in un-exported declaration
      // "identity"` for a file that never mentions `identity` anywhere near
      // an onClick. (Confirmed directly against the `typescript` parser:
      // forcing TSX on this source produces a single root JsxElement whose
      // JsxClosingElement's tag is "T", with `Card`'s FunctionDeclaration
      // nowhere in the tree.)
      //
      // A real `.ts` file can never contain JSX at all (TypeScript itself
      // rejects it), so once the script kind is correctly picked as TS for
      // a `.ts` label, no `JsxAttribute` node is produced anywhere in this
      // source — not a misattribution, not a throw, just a correctly empty
      // result, because there is genuinely no parseable JSX in a `.ts` file.
      const src = `
const identity = <T>(x: T): T => x;

export function Card({ label }: Props) {
  return <Button onClick={async () => {}}>{label}</Button>;
}
`;
      expect(interactiveComponentNames(src, "helpers.ts")).toEqual([]);
    });

    it("still parses ordinary JSX correctly when the label says .tsx", () => {
      const src = `
export function Card({ label }: Props) {
  return <Button onClick={async () => {}}>{label}</Button>;
}
`;
      expect(interactiveComponentNames(src, "card.tsx")).toEqual(["Card"]);
    });
  });

  it("does not detect an onClick hidden inside a spread attribute (documented limitation, not a silent miss)", () => {
    // `<Button {...handlers} />` is a known, DOCUMENTED exclusion (see the
    // module docstring) rather than a silent one: resolving whether a
    // spread's source object carries an `onClick` would require data-flow
    // analysis this AST-only scanner deliberately doesn't attempt (the
    // spread source is routinely a plain identifier like `props`, whose
    // shape isn't visible at this node). A blanket throw on every spread
    // was considered and rejected — this codebase's own real components
    // (app/tools/render-tools.tsx, app/tools/showcase-tools.tsx) spread
    // `{...props}` on plain non-interactive forwarding with no onClick
    // involved at all, so that would misfire constantly.
    const src = `
export function Card({ handlers }: Props) {
  return <Button {...handlers} />;
}
`;
    expect(interactiveComponentNames(src)).toEqual([]);
  });
});
