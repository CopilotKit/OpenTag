/**
 * Source scan backing the `MANAGED_COMPONENTS` guard in `app/managed.test.ts`.
 *
 * A component whose buttons carry an `onClick` must be registered via
 * `createChannel({ components })`, or a click that arrives as a fresh delivery
 * can't be resolved and dead-letters. Deriving the expectation from the source
 * — rather than restating the list — is what makes a NEW interactive card fail
 * the suite instead of failing in production.
 *
 * This is a real TypeScript AST walk (via the `typescript` compiler API), not
 * a regex scan. Parsing gives this for free: comments, string literals,
 * template literals, and regex literals are just non-code text/tokens to the
 * parser, so a `//` inside a URL string or an `onClick` mentioned in a
 * comment can never be mistaken for a JSX attribute the way it can with a
 * line-oriented regex. It also means every declaration shape (a type
 * annotation, a generic arrow, an HOC wrapper like `memo(...)`, two
 * declarations back to back) is handled by construction — there is no
 * fixed-width "peek past the `=`" to defeat.
 *
 * Algorithm: parse the file with `ts.createSourceFile`, walk every node
 * looking for a JSX attribute literally named `onClick`, then climb that
 * attribute's ancestor chain to the nearest enclosing *named* declaration —
 * a `function Foo(...)` or a `const Foo = ...` (any RHS shape: arrow,
 * function expression, or a call wrapping one, e.g. `memo(() => ...)`).
 * That declaration is what the `onClick` is attributed to, regardless of how
 * deeply the JSX is nested inside it (a nested handler, an HOC, a helper
 * that returns a fragment) — because AST containment already reflects the
 * real nesting, unlike a textual span.
 *
 * A declaration is only ever added to the result if it is exported — with a
 * direct `export` modifier, OR transitively via a same-module
 * `export { Foo }` / `export { foo as Foo }`, OR via `export default Foo;`
 * referencing an already-declared identifier. Anything else can never be
 * passed to `MANAGED_COMPONENTS` as-is, so:
 *
 *  - FAILS OPEN if a real `onClick` is left unattributed. If it can't be
 *    climbed to any named declaration at all (e.g. floating at module scope
 *    outside any function/variable), or if it lands in a declaration that
 *    isn't exported by any of the routes above, this throws rather than
 *    silently returning `[]` — because "derived nothing" has historically
 *    meant "the scan doesn't understand this file," not "nothing is wrong."
 *
 *  - FAILS CLOSED if it demands registration of something that was never a
 *    component. `MANAGED_COMPONENTS` only ever takes JSX component
 *    functions — never a `defineChannelTool({...})` descriptor, a factory
 *    function whose *return value* happens to contain JSX, or a plain
 *    value — so once a declaration is confirmed exported, this applies one
 *    more defensible filter before treating it as a component: is its name
 *    capitalized? That's the actual convention this codebase (and React
 *    generally) uses to distinguish a component from a helper, and it's
 *    exactly what rules out `export const someTool = defineChannelTool(...)`
 *    and `export function makeCard()` without having to model what
 *    `defineChannelTool` or `makeCard` do. A lowercase-named exported
 *    declaration that contains a real `onClick` is therefore left out
 *    quietly, not flagged — it was never eligible for the registry, so
 *    there is nothing to fail loud about.
 *
 *  Note the capitalization filter only applies once a declaration is
 *  otherwise exported. An **unexported** declaration (bare, un-re-exported)
 *  still throws regardless of casing: it might be a component someone
 *  forgot to export (the dead-letter risk this guard exists to catch), or
 *  it might be dead code — either way that's a decision for a human, not a
 *  silent "all clear."
 */

import ts from "typescript";

const COMPONENT_NAME = /^[A-Z]/;

interface EnclosingDecl {
  name: string;
  /** Has its own `export` (and/or `export default`) modifier. */
  directlyExported: boolean;
}

/** Climbs from `node` to the nearest enclosing declaration that has a name:
 * a `function Foo(...)` or a `const Foo = ...` (of any initializer shape —
 * arrow, function expression, or a call wrapping one). Returns `undefined`
 * if no such ancestor exists before the source file itself. */
function findEnclosingDecl(node: ts.Node): EnclosingDecl | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) {
      return { name: cur.name.text, directlyExported: hasExportModifier(cur) };
    }
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
      const declList = cur.parent;
      const stmt = declList?.parent;
      const directlyExported =
        !!stmt && ts.isVariableStatement(stmt) && hasExportModifier(stmt);
      return { name: cur.name.text, directlyExported };
    }
    cur = cur.parent;
  }
  return undefined;
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** Names made available for external import despite no direct `export`
 * modifier on their own declaration: a same-module `export { Foo }` /
 * `export { foo as Baz }` (the LOCAL name — before `as` — is what has to
 * match the bare declaration, since that's also the name used as the JSX
 * tag), and `export default Foo;` referencing an already-declared
 * identifier (as opposed to `export default function Foo() {}`, which
 * `hasExportModifier` already covers directly). */
function transitivelyExportedNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (
      ts.isExportDeclaration(stmt) &&
      !stmt.moduleSpecifier &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      for (const el of stmt.exportClause.elements) {
        names.add((el.propertyName ?? el.name).text);
      }
    }
    if (
      ts.isExportAssignment(stmt) &&
      !stmt.isExportEquals &&
      ts.isIdentifier(stmt.expression)
    ) {
      names.add(stmt.expression.text);
    }
  }
  return names;
}

function excerpt(src: string, pos: number): string {
  const start = Math.max(0, pos - 120);
  const end = Math.min(src.length, pos + 180);
  const snippet = src.slice(start, end).trim();
  return snippet.length > 0 ? snippet : "(empty region)";
}

/**
 * Returns the names of every exported component in `src` whose JSX contains
 * a real `onClick` attribute. Throws — naming `label` and quoting an
 * excerpt — if an `onClick` can't be attributed to any eligible exported
 * declaration; see the module docstring for exactly what "eligible" means
 * and why a miss here is a thrown error rather than a silently empty array.
 */
export function interactiveComponentNames(
  src: string,
  label = "<source>",
): string[] {
  const sourceFile = ts.createSourceFile(
    "component-scan-input.tsx",
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );

  const externallyExported = transitivelyExportedNames(sourceFile);
  const names: string[] = [];
  const seen = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === "onClick") {
      handleOnClick(node);
    }
    ts.forEachChild(node, visit);
  }

  function handleOnClick(attr: ts.JsxAttribute): void {
    const enclosing = findEnclosingDecl(attr);
    if (!enclosing) {
      throw new Error(
        `interactiveComponentNames: onClick= in ${label} could not be ` +
          `attributed to any named declaration (no enclosing \`function Foo\` ` +
          `or \`const Foo = ...\` was found). Either move the interactive ` +
          `markup inside a named component, or this scan doesn't understand ` +
          `this file's shape.\n\n` +
          excerpt(src, attr.getStart(sourceFile)),
      );
    }

    const { name, directlyExported } = enclosing;
    const exported = directlyExported || externallyExported.has(name);

    if (!exported) {
      throw new Error(
        `interactiveComponentNames: onClick= found in un-exported ` +
          `declaration "${name}" in ${label}. It can't be registered as-is — ` +
          `export it (\`export function ${name}\`) or re-export it ` +
          `(\`export { ${name} }\`) so it can be added to MANAGED_COMPONENTS, ` +
          `or confirm it's dead code.\n\n` +
          excerpt(src, attr.getStart(sourceFile)),
      );
    }

    // Exported, but not component-shaped by name (e.g. a lowercase factory
    // function or a `defineChannelTool({...})` descriptor): definitively not
    // a component, so left out rather than flagged — see module docstring.
    if (!COMPONENT_NAME.test(name)) return;

    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }

  visit(sourceFile);
  return names;
}
