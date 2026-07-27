/**
 * Source scan backing the `MANAGED_COMPONENTS` guard in `app/managed.test.ts`.
 *
 * A component whose buttons carry an `onClick` must be registered via
 * `createChannel({ components })`, or a click that arrives as a fresh delivery
 * can't be resolved and dead-letters. Deriving the expectation from the source
 * — rather than restating the list — is what makes a NEW interactive card fail
 * the suite instead of failing in production.
 *
 * Matches BOTH declaration styles used in this codebase: `export function Foo(`
 * and `export const Foo = …`. An onClick belongs to the declaration it appears
 * under, i.e. before the next top-level `export`.
 */
const TOP_LEVEL_EXPORT = /^export (?:function|const) (\w+)/gm;

export function interactiveComponentNames(src: string): string[] {
  if (!/\bonClick=/.test(src)) return [];
  const decls = [...src.matchAll(TOP_LEVEL_EXPORT)].map((m) => ({
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
