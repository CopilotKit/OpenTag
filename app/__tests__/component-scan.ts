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
 * attribute's ancestor chain looking for the nearest enclosing declaration
 * that is a PLAUSIBLE COMPONENT ROOT — a `function Foo(...)`, a `class Foo
 * {...}`, or a `const Foo = ...` (any RHS shape: arrow, function expression,
 * class expression, or a call wrapping one, e.g. `memo(() => ...)`) — that is
 * either declared at module scope, or whose name is capitalized AND whose
 * initializer is itself function/class-shaped. A declaration that fails both
 * (a local `const actions = <JSX/>`, a `.map((i) => <JSX/>)` callback, a
 * lowercase nested `function renderRow() {}`) is NOT a plausible root: the
 * climb does not stop there, it keeps going outward past it. That is what
 * lets the `onClick` be attributed correctly regardless of how deeply the
 * JSX is nested inside the real component (a local variable, a `.map`
 * callback, a nested helper, an HOC) — because AST containment already
 * reflects the real nesting, unlike a textual span. A class component's
 * `render()` method is not itself a named-declaration candidate, so climbing
 * passes straight through it to the enclosing `class Foo`.
 *
 * A declaration is only ever added to the result if it is exported — with a
 * direct `export` modifier, OR transitively via a same-module
 * `export { Foo }` / `export { foo as Bar }`, OR via `export default Foo;`
 * referencing an already-declared identifier. Anything else can never be
 * passed to `MANAGED_COMPONENTS` as-is, so:
 *
 *  - FAILS OPEN if a real `onClick` is left unattributed. If it can't be
 *    climbed to any plausible component root at all (e.g. a bare JSX
 *    expression statement with nothing named enclosing it), or if it lands
 *    in a declaration that isn't exported by any of the routes above, this
 *    throws rather than silently returning `[]` — because "derived nothing"
 *    has historically meant "the scan doesn't understand this file," not
 *    "nothing is wrong."
 *
 *  - FAILS CLOSED if it demands registration of something that was never a
 *    component. `MANAGED_COMPONENTS` only ever takes JSX component
 *    functions — never a `defineChannelTool({...})` descriptor, a factory
 *    function whose *return value* happens to contain JSX, an exported
 *    object literal that merely CONTAINS component-shaped values (e.g.
 *    `export const Cards = { Incident: () => <.../> }`), or a plain value —
 *    so once a declaration is confirmed exported, this applies two more
 *    defensible filters before treating it as a component: is its name
 *    capitalized, AND is its own value function/class-shaped (a function
 *    declaration, a class declaration, an arrow/function/class expression,
 *    or a call wrapping one of those)? That's the actual convention this
 *    codebase (and React generally) uses to distinguish a component from a
 *    helper or a plain container value, and it's exactly what rules out
 *    `export const someTool = defineChannelTool(...)`, `export function
 *    makeCard()`, and `export const Cards = {...}` without having to model
 *    what `defineChannelTool`, `makeCard`, or the object's values do. A
 *    declaration that fails either filter is therefore left out quietly, not
 *    flagged — it was never eligible for the registry, so there is nothing
 *    to fail loud about.
 *
 *  Capitalization is tested against the EXPORTED name (the alias after `as`
 *  in `export { local as Exported }`), not the local declaration name — the
 *  exported name is what an eventual `MANAGED_COMPONENTS` entry has to
 *  reconcile against, and it's also what gets emitted into the result.
 *
 *  Note both filters above only apply once a declaration is otherwise
 *  exported. An **unexported** declaration (bare, un-re-exported) still
 *  throws regardless of casing or shape: it might be a component someone
 *  forgot to export (the dead-letter risk this guard exists to catch), or
 *  it might be dead code — either way that's a decision for a human, not a
 *  silent "all clear."
 *
 *  DOCUMENTED EXCLUSION: an `onClick` carried inside a JSX spread attribute
 *  (`<Button {...handlers} />`) is not detected — only a literal
 *  `ts.isJsxAttribute` named `onClick` is matched. Resolving whether a
 *  spread's source object carries an `onClick` would require data-flow
 *  analysis this AST-only scanner deliberately doesn't attempt (the spread
 *  source is routinely a plain identifier like `props`, whose shape isn't
 *  visible at the JSX call site). Real components in this repo spread
 *  `{...props}` on plain, non-interactive prop forwarding
 *  (app/tools/render-tools.tsx, app/tools/showcase-tools.tsx) with no
 *  `onClick` involved, so throwing on every spread would misfire constantly;
 *  documenting the gap here — rather than either silently ignoring it with
 *  no record, or throwing indiscriminately — is the deliberate choice.
 */

import ts from "typescript";

const COMPONENT_NAME = /^[A-Z]/;

interface EnclosingDecl {
  /** The declaration's own (local) name. */
  name: string;
  /** Has its own `export` (and/or `export default`) modifier. */
  directlyExported: boolean;
  /** Is the declaration's value itself function/class-shaped — a function
   * declaration, a class declaration, an arrow/function/class expression, or
   * a call wrapping one of those (e.g. `memo(...)`)? False for e.g. a plain
   * object literal, a string, or a bare JSX value assigned to a variable —
   * see the module docstring's finding-2 discussion. */
  componentShaped: boolean;
}

interface DeclarationCandidate extends EnclosingDecl {
  /** Declared directly among the source file's top-level statements. */
  moduleScope: boolean;
}

/** True if `node`'s own statement/declaration sits directly at the top level
 * of the source file (as opposed to nested inside a function/block/class). */
function isModuleScopeStatement(node: ts.Node): boolean {
  return !!node.parent && ts.isSourceFile(node.parent);
}

/** True for anything that could plausibly BE a component definition on its
 * own: a function expression, an arrow function, a class expression, or a
 * call wrapping one of those at any nesting depth (an HOC like
 * `memo(...)`/`forwardRef(...)`). False for an object literal, a string
 * literal, a bare JSX value, or anything else that merely CONTAINS a
 * component-shaped value without itself being one. */
function isFunctionShapedValue(expr: ts.Expression | undefined): boolean {
  if (!expr) return false;
  if (
    ts.isArrowFunction(expr) ||
    ts.isFunctionExpression(expr) ||
    ts.isClassExpression(expr)
  ) {
    return true;
  }
  if (ts.isCallExpression(expr)) {
    return expr.arguments.some((arg) => isFunctionShapedValue(arg));
  }
  return false;
}

/** Recognizes `node` as one of the three named-declaration shapes this scan
 * understands (`function Foo(...)`, `class Foo {...}`, `const Foo = ...`)
 * and reports what's needed to decide whether climbing should stop here:
 * whether it's module-scope, directly exported, and component-shaped.
 * Returns `undefined` for anything else (an anonymous arrow, a method, an
 * object property, etc.) — the climb simply passes through those. */
function declarationCandidate(node: ts.Node): DeclarationCandidate | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return {
      name: node.name.text,
      moduleScope: isModuleScopeStatement(node),
      directlyExported: hasExportModifier(node),
      componentShaped: true, // a `function Foo() {}` is a component by construction
    };
  }
  if (ts.isClassDeclaration(node) && node.name) {
    return {
      name: node.name.text,
      moduleScope: isModuleScopeStatement(node),
      directlyExported: hasExportModifier(node),
      componentShaped: true, // a `class Foo { render() {...} }` is a component by construction
    };
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const declList = node.parent;
    const stmt = declList?.parent;
    const isVarStatement = !!stmt && ts.isVariableStatement(stmt);
    return {
      name: node.name.text,
      moduleScope: isVarStatement && isModuleScopeStatement(stmt),
      directlyExported: isVarStatement && hasExportModifier(stmt),
      componentShaped: isFunctionShapedValue(node.initializer),
    };
  }
  return undefined;
}

/** Climbs from `node` to the nearest enclosing declaration that is a
 * PLAUSIBLE COMPONENT ROOT: one declared at module scope, OR one whose name
 * is capitalized and whose value is itself function/class-shaped. A named
 * declaration that is neither (a local `const actions = <JSX/>`, a `.map`
 * callback's implicit binding, a lowercase nested helper function) is NOT a
 * stopping point — the climb continues past it to the next ancestor, all the
 * way out to the real enclosing component. Returns `undefined` if no such
 * ancestor exists before the source file itself (e.g. a bare JSX expression
 * statement). */
function findEnclosingDecl(node: ts.Node): EnclosingDecl | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    const candidate = declarationCandidate(cur);
    if (candidate) {
      const isPlausibleRoot =
        candidate.moduleScope ||
        (COMPONENT_NAME.test(candidate.name) && candidate.componentShaped);
      if (isPlausibleRoot) {
        return {
          name: candidate.name,
          directlyExported: candidate.directlyExported,
          componentShaped: candidate.componentShaped,
        };
      }
      // Not a plausible component root — keep climbing past it rather than
      // stopping here; see the module docstring and `isPlausibleRoot` above.
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

/** Maps each LOCAL declaration name made available for external import
 * despite no direct `export` modifier on its own declaration, to the
 * EXTERNALLY-VISIBLE name it's reachable under:
 *
 *  - a same-module `export { Foo }` maps "Foo" -> "Foo" (no rename).
 *  - a same-module `export { foo as Bar }` maps "foo" -> "Bar" — the LOCAL
 *    name ("foo") is the map KEY because that's what has to match the bare
 *    declaration (and what's used as the JSX tag internally), while the
 *    VALUE ("Bar") is the externally-reconcilable name that capitalization
 *    is tested against and that gets emitted (see finding 3 in the module
 *    docstring).
 *  - `export default Foo;` referencing an already-declared identifier (as
 *    opposed to `export default function Foo() {}`, which `hasExportModifier`
 *    already covers directly) maps "Foo" -> "Foo".
 */
function exportedNameByLocal(sourceFile: ts.SourceFile): Map<string, string> {
  const byLocal = new Map<string, string>();
  for (const stmt of sourceFile.statements) {
    if (
      ts.isExportDeclaration(stmt) &&
      !stmt.moduleSpecifier &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      for (const el of stmt.exportClause.elements) {
        byLocal.set((el.propertyName ?? el.name).text, el.name.text);
      }
    }
    if (
      ts.isExportAssignment(stmt) &&
      !stmt.isExportEquals &&
      ts.isIdentifier(stmt.expression)
    ) {
      byLocal.set(stmt.expression.text, stmt.expression.text);
    }
  }
  return byLocal;
}

/** Picks the `ts.ScriptKind` to parse `label` as. A real `.ts` file can
 * never contain JSX (TypeScript itself rejects it), so forcing TSX parsing
 * there risks misreading ordinary TS syntax as JSX — a bare type-cast
 * expression (`<Foo>value`) or a non-trailing-comma generic arrow (`<T>(x:
 * T) => x`) both look like an opening JSX tag to the parser.
 * `ts.createSourceFile` never throws on the resulting malformed syntax, so
 * picking the wrong kind degrades silently (and can misattribute an
 * unrelated `onClick` elsewhere in the same file) instead of loudly. Picks
 * the kind from `label`'s extension when it has one; defaults to TSX (the
 * shape virtually every fixture and real component file scanned here
 * actually is) when `label` carries no recognized extension. */
function scriptKindFor(label: string): ts.ScriptKind {
  if (/\.tsx$/i.test(label)) return ts.ScriptKind.TSX;
  if (/\.ts$/i.test(label)) return ts.ScriptKind.TS;
  return ts.ScriptKind.TSX;
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
    scriptKindFor(label),
  );

  const exportedAliasByLocal = exportedNameByLocal(sourceFile);
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
          `attributed to any named declaration (no enclosing \`function Foo\`, ` +
          `\`class Foo\`, or \`const Foo = ...\` was found). Either move the ` +
          `interactive markup inside a named component, or this scan doesn't ` +
          `understand this file's shape.\n\n` +
          excerpt(src, attr.getStart(sourceFile)),
      );
    }

    const { name, directlyExported, componentShaped } = enclosing;
    const alias = exportedAliasByLocal.get(name);
    const exported = directlyExported || alias !== undefined;

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

    // The name it's externally reconcilable under: the declaration's own
    // name if it carries a direct `export` modifier, otherwise the alias
    // recorded for a same-module `export { local as Exported }` (or the
    // identity mapping for a plain `export { local }` / `export default
    // local;`) — see finding 3 in the module docstring.
    const exportedName = directlyExported ? name : (alias ?? name);

    // Exported, but not a component: either not capitalized (e.g. a
    // lowercase factory function or a `defineChannelTool({...})`
    // descriptor), or not component-shaped (e.g. an exported object literal
    // that merely contains component-shaped values, like `export const
    // Cards = { Incident: () => <.../> }` — finding 2 in the module
    // docstring). Left out rather than flagged either way.
    if (!COMPONENT_NAME.test(exportedName) || !componentShaped) return;

    if (!seen.has(exportedName)) {
      seen.add(exportedName);
      names.push(exportedName);
    }
  }

  visit(sourceFile);
  return names;
}
