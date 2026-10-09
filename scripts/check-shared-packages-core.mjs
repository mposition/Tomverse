/**
 * Finding the TypeScript compiler, and what to say when it is not there.
 *
 * PACKAGE-01's second property is that each shared package type-checks under
 * its own tsconfig. That is only evidence if the compiler actually ran, and the
 * two decisions involved -- where the compiler is, and what a missing one means
 * -- are the ones that got this wrong once already:
 *
 * The checker spawned a literal `<root>/node_modules/typescript/bin/tsc`. That
 * path exists only when the checkout installed its own dependencies; a git
 * worktree installs nothing and Node resolves up to the parent checkout, which
 * is how every other script here reaches `tsx`. The spawn failed, its loader
 * stack trace was interpolated into the package's problem text, and a missing
 * compiler was reported as a package that does not type-check -- the one
 * conclusion the evidence did not support, printed next to a metric line
 * reading 0.
 *
 * Both decisions live here, taking their inputs as arguments, because the
 * runner cannot be made to lose its own compiler: relocating it to a tree
 * without `typescript` also loses `eslint`, which it imports at load. A pure
 * function is the only place the not-found branch can be exercised at all.
 */

/**
 * The compiler's path, or `null` when this checkout cannot resolve it.
 *
 * `resolve` is the resolver to ask -- `createRequire(import.meta.url).resolve`
 * in the runner, a stub in the tests. Resolution failure is the answer, not an
 * error: the caller turns it into a problem that names the remedy.
 */
export const resolveCompiler = (resolve) => {
  try {
    return resolve(COMPILER_SPECIFIER);
  } catch {
    return null;
  }
};

/** What the checker asks for. A specifier, never a path. */
export const COMPILER_SPECIFIER = "typescript/bin/tsc";

/**
 * The problem text for a checkout that cannot resolve the compiler.
 *
 * It says the check could not run, rather than letting `packageCount` packages
 * each look like a boundary failure, and it names `npm ci` so the reader is not
 * left deducing the remedy from a resolver error.
 */
export const missingCompilerProblem = (packageCount) =>
  `${COMPILER_SPECIFIER} is not resolvable from this checkout, so nothing ` +
  `type-checked the ${packageCount} package(s) with TypeScript sources. Run ` +
  "`npm ci`. This is the check being unable to run, not a boundary failure.";
