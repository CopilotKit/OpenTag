/**
 * Source scan backing the `MANAGED_COMPONENTS` guard in `app/managed.test.ts`.
 *
 * A component whose buttons carry an `onClick` must be registered via
 * `createChannel({ components })`, or a click that arrives as a fresh delivery
 * can't be resolved and dead-letters. Deriving the expectation from the source
 * — rather than restating the list — is what makes a NEW interactive card fail
 * the suite instead of failing in production.
 *
 * Recognizes every top-level declaration shape this codebase actually uses:
 * `export function Foo(`, `export const Foo = (...) =>` / `function`,
 * `export default function Foo(`, `export async function Foo(`,
 * `export default async function Foo(`, and a bare `function Foo(` /
 * `const Foo = ...` later surfaced via `export { Foo }`. An onClick belongs
 * to the declaration it textually falls under, i.e. before the next
 * top-level declaration (of ANY of the above shapes, exported or not — a
 * bare declaration still ends the previous one's span, it just isn't itself
 * registrable unless re-exported).
 *
 * Two failure modes this guards against:
 *
 *  - FAILS OPEN when it derives nothing for a real interactive component
 *    (an unrecognized declaration shape, or a bare helper nobody re-exports).
 *    Rather than silently returning `[]`, that's treated as a loud error:
 *    an onClick found outside every eligible span throws, because a "derived
 *    nothing" here has historically meant "found nothing wrong" when it
 *    actually meant "the scan doesn't understand this file."
 *
 *  - FAILS CLOSED when it demands registration of something that isn't a
 *    component at all: a `defineChannelTool({...})` call, a plain string
 *    constant, or an `onClick=` mentioned only in a comment. `MANAGED_COMPONENTS`
 *    takes component functions, so these can never be "fixed" by registering
 *    them — the scan must recognize they aren't function-shaped (or aren't
 *    real code at all, once comments are stripped) and leave them out.
 */

// ── declaration shapes ──────────────────────────────────────────────────────

const EXPORT_DEFAULT_ASYNC_FUNCTION = /^export default async function (\w+)/gm;
const EXPORT_DEFAULT_FUNCTION = /^export default function (\w+)/gm;
const EXPORT_ASYNC_FUNCTION = /^export async function (\w+)/gm;
const EXPORT_FUNCTION = /^export function (\w+)/gm;
// Capture the name plus a peek at the RHS so we can tell a component
// (`(...) =>`, `function`, `async (...) =>`) from a value (a string, a
// `defineChannelTool(...)` call, a number) — both look identical up to `=`.
const EXPORT_CONST = /^export const (\w+)\s*=\s*([\s\S]{0,40})/gm;
const BARE_FUNCTION = /^function (\w+)/gm;
const BARE_CONST = /^const (\w+)\s*=\s*([\s\S]{0,40})/gm;
const EXPORT_BRACES = /^export\s*\{([^}]*)\}/gm;

/** True when the text right of `=` opens a function body. Anything else
 * (a string literal, a call expression, a number…) is a value, not a
 * component — even if the word "onClick" shows up somewhere inside it. */
const FUNCTION_SHAPED_RHS = /^(?:async\s+)?(?:\(|function\b)/;

interface Decl {
  start: number;
  name: string;
  /** Declared with a leading `export` keyword (any of the recognized forms). */
  exported: boolean;
  /** RHS/keyword shape says "this could be a component function". */
  functionShaped: boolean;
}

function stripComments(src: string): string {
  // Block comments first (so a `//` inside one doesn't get treated as its
  // own line comment), then line comments. Replacement text is same-length
  // whitespace (newlines preserved) so every offset computed against the
  // stripped string still lines up with the original for excerpting.
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  return noBlocks.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

function collectDecls(clean: string): Decl[] {
  const decls: Decl[] = [];

  for (const m of clean.matchAll(EXPORT_DEFAULT_ASYNC_FUNCTION)) {
    decls.push({ start: m.index, name: m[1]!, exported: true, functionShaped: true });
  }
  for (const m of clean.matchAll(EXPORT_DEFAULT_FUNCTION)) {
    decls.push({ start: m.index, name: m[1]!, exported: true, functionShaped: true });
  }
  for (const m of clean.matchAll(EXPORT_ASYNC_FUNCTION)) {
    decls.push({ start: m.index, name: m[1]!, exported: true, functionShaped: true });
  }
  for (const m of clean.matchAll(EXPORT_FUNCTION)) {
    decls.push({ start: m.index, name: m[1]!, exported: true, functionShaped: true });
  }
  for (const m of clean.matchAll(EXPORT_CONST)) {
    decls.push({
      start: m.index,
      name: m[1]!,
      exported: true,
      functionShaped: FUNCTION_SHAPED_RHS.test(m[2] ?? ""),
    });
  }
  for (const m of clean.matchAll(BARE_FUNCTION)) {
    decls.push({ start: m.index, name: m[1]!, exported: false, functionShaped: true });
  }
  for (const m of clean.matchAll(BARE_CONST)) {
    decls.push({
      start: m.index,
      name: m[1]!,
      exported: false,
      functionShaped: FUNCTION_SHAPED_RHS.test(m[2] ?? ""),
    });
  }
  // `export { Foo, Bar as Baz }` re-exports: not a declaration themselves,
  // but still a real top-level statement — treated as a (name-less,
  // ineligible) boundary so trailing content after it never bleeds back
  // into whatever bare declaration preceded it.
  for (const m of clean.matchAll(EXPORT_BRACES)) {
    decls.push({ start: m.index, name: "", exported: false, functionShaped: false });
  }

  decls.sort((a, b) => a.start - b.start);
  return decls;
}

/** Local names surfaced via `export { Foo }` / `export { foo as Foo }` — the
 * LOCAL binding (before `as`) is what has to match a bare declaration; that's
 * also the name used as the JSX tag, which is what `MANAGED_COMPONENTS` keys
 * on. */
function reExportedNames(clean: string): Set<string> {
  const names = new Set<string>();
  for (const m of clean.matchAll(EXPORT_BRACES)) {
    for (const item of m[1]!.split(",")) {
      const local = item.split(/\s+as\s+/i)[0]!.trim();
      if (local) names.add(local);
    }
  }
  return names;
}

function excerpt(src: string, start: number, end: number): string {
  const snippet = src.slice(start, Math.min(end, start + 300)).trim();
  return snippet.length > 0 ? snippet : "(empty region)";
}

export function interactiveComponentNames(
  src: string,
  label = "<source>",
): string[] {
  const clean = stripComments(src);
  if (!/\bonClick=/.test(clean)) return [];

  const decls = collectDecls(clean);
  const reExported = reExportedNames(clean);
  const names: string[] = [];

  // Content before the first recognized declaration (or the whole file, if
  // none was recognized at all): nothing can own an onClick found here.
  const leadingEnd = decls.length > 0 ? decls[0]!.start : clean.length;
  if (/\bonClick=/.test(clean.slice(0, leadingEnd))) {
    throw new Error(
      `interactiveComponentNames: onClick= appears in ${label} before any ` +
        `recognized top-level declaration, so it can't be attributed to a ` +
        `component. Either the declaration form isn't handled by this scan, ` +
        `or the interactive markup needs to move inside a named export.\n\n` +
        excerpt(src, 0, leadingEnd),
    );
  }

  for (let i = 0; i < decls.length; i++) {
    const decl = decls[i]!;
    const end = decls[i + 1]?.start ?? clean.length;
    const region = clean.slice(decl.start, end);
    if (!/\bonClick=/.test(region)) continue;

    const eligible =
      decl.functionShaped && (decl.exported || reExported.has(decl.name));
    if (eligible) {
      names.push(decl.name);
      continue;
    }

    if (decl.functionShaped && !decl.exported) {
      // A bare, never-(re-)exported function/const whose own span carries a
      // real onClick: this could be a component someone forgot to export
      // (exactly the dead-letter risk this guard exists to catch), or it
      // could be dead code — we can't tell which from here, so fail loud
      // instead of silently reporting "all clear".
      throw new Error(
        `interactiveComponentNames: onClick= found in un-exported ` +
          `declaration "${decl.name}" in ${label}. It can't be registered ` +
          `as-is — export it (\`export function ${decl.name}\`) or ` +
          `re-export it (\`export { ${decl.name} }\`) so it can be added to ` +
          `MANAGED_COMPONENTS, or confirm it's dead code.\n\n` +
          excerpt(src, decl.start, end),
      );
    }
    // Not function-shaped: a string constant, a `defineChannelTool(...)`
    // call, etc. Definitively not a component — even if `onClick=` text
    // shows up somewhere inside its span — so it's left out, not flagged.
  }

  return names;
}
