// What the admission decision is made of, as bytes.
//
// A post admitted as `autonomous_eligible` carries an `admissionCodeDigest`
// into its audit row, and dispatch compares that digest with the one the
// running deployment computes. A post admitted by one build of this code is
// not dispatched by another without being admitted again. That is the whole
// job of this file: say exactly which bytes count, and compute one number from
// them the same way every time.
//
// Roots and closure. The roots below are the modules that *decide*: the
// capability resolver, the Guard, the facts, and the store that writes the
// row. Everything they import locally is in scope too, because a rule is not
// less of a rule for living one import away -- so the closure is walked rather
// than listed by hand, and a listed file that stops being reachable is as much
// a drift as an unlisted one that is.
//
// Not in scope: anything from `node_modules`. A dependency bump is a different
// question with a different answer (the lockfile), and folding it in here
// would make every `npm install` an admission change.
//
// The closure is deliberately wider than "the rules". It currently reaches
// `lib/prisma.ts`, its connection helper, `lib/clientIp.ts` and
// `lib/deploymentEnvironment.ts` -- infrastructure that no decision turns on.
// They stay because the two errors are not the same size. Including a file
// that could not change a decision costs a re-admission: a scheduled post
// waits to be admitted again. Excluding one that could lets a changed rule
// dispatch a post admitted under the old one, quietly, with nobody in the
// loop -- which is the whole thing autonomy is fenced against.
//
// So the line is drawn by reachability, which is a fact, rather than by
// judgement about which bytes matter, which is an opinion that has to be
// right every time. Narrowing it later takes evidence that a module cannot
// reach the decision, not an impression that it looks unrelated.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const MARKETING_ADMISSION_CODE_SCHEMA_VERSION =
  "marketing-admission-code-manifest-v1";

/**
 * The modules that decide whether a post may be inserted as autonomously
 * scheduled.
 *
 * Adding a root is a deliberate widening of what counts as an admission
 * change. Removing one says a decision no longer depends on those bytes, which
 * is a claim about behaviour and belongs in a review.
 */
export const MARKETING_ADMISSION_CODE_ROOTS = Object.freeze([
  "lib/marketingAutomationAccess.ts",
  "lib/marketingGuardCore.ts",
  "lib/marketingFacts.ts",
  "lib/marketingStore.ts",
]);

const LOCAL_SPECIFIER = /^(\.{1,2}\/|@\/)/u;

/** Where a specifier written in `from` actually lives, or null if not local. */
const resolveLocal = (specifier, from, repositoryRoot) => {
  if (!LOCAL_SPECIFIER.test(specifier)) return null;
  const base = specifier.startsWith("@/")
    ? join(repositoryRoot, specifier.slice(2))
    : resolve(dirname(join(repositoryRoot, from)), specifier);
  for (const candidate of [
    // A specifier that already carries its extension, which `lib/prisma.ts`
    // does for its `.mjs` neighbour. Trying `foo.mjs.ts` first and calling
    // the miss "not in this repository" would have reported a file that is
    // plainly here.
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
    `${base}.mjs`,
    `${base}.js`,
  ]) {
    try {
      readFileSync(candidate);
      return relative(repositoryRoot, candidate).split(sep).join("/");
    } catch {
      // Not this one.
    }
  }
  // A local specifier that resolves to nothing is a fact about the tree, not
  // something to pass over: the caller decides what to do with it.
  return { unresolved: specifier };
};

/**
 * Every local specifier a source file names, however it names it.
 *
 * Read with a regular expression rather than a parser because this runs in the
 * generator and the check, and both have to agree exactly. Static imports,
 * re-exports and dynamic imports with a literal specifier are all ways a file
 * brings another file's bytes into the decision; a specifier built at run time
 * is not one this can follow, and the check reports it rather than ignoring it.
 */
export const localSpecifiers = (source) => {
  const found = new Set();
  const patterns = [
    /\bfrom\s+["'`]([^"'`]+)["'`]/gu,
    /\bimport\s+["'`]([^"'`]+)["'`]/gu,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gu,
    /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (LOCAL_SPECIFIER.test(match[1])) found.add(match[1]);
    }
  }
  return [...found];
};

/**
 * The closure of the roots, and anything that could not be resolved.
 *
 * Unresolved is returned rather than thrown: the check turns it into a
 * failure with the path in it, which is more use than a stack trace.
 */
export const marketingAdmissionCodeClosure = (repositoryRoot) => {
  const files = new Map();
  const unresolved = [];
  const queue = [...MARKETING_ADMISSION_CODE_ROOTS];

  while (queue.length > 0) {
    const path = queue.shift();
    if (files.has(path)) continue;
    let bytes;
    try {
      bytes = readFileSync(join(repositoryRoot, path));
    } catch {
      unresolved.push({ from: "(root)", specifier: path });
      continue;
    }
    files.set(path, bytes);
    for (const specifier of localSpecifiers(bytes.toString("utf8"))) {
      const found = resolveLocal(specifier, path, repositoryRoot);
      if (found === null) continue;
      if (typeof found === "object") {
        unresolved.push({ from: path, specifier: found.unresolved });
        continue;
      }
      if (!files.has(found)) queue.push(found);
    }
  }

  return {
    unresolved,
    files: [...files.entries()]
      .map(([path, bytes]) => ({
        path,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }))
      // Sorted by path so the digest is a property of the set, not of the
      // order a walk happened to take.
      .sort((left, right) => (left.path < right.path ? -1 : 1)),
  };
};

/**
 * One number over the whole set.
 *
 * The schema version is inside the digest so that changing what the digest
 * *means* changes the digest, rather than leaving two incomparable numbers
 * that look alike.
 */
export const marketingAdmissionCodeDigest = (files) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: MARKETING_ADMISSION_CODE_SCHEMA_VERSION,
        files: files.map((file) => [file.path, file.sha256]),
      }),
      "utf8"
    )
    .digest("hex");

export const MARKETING_ADMISSION_CODE_MANIFEST_PATH =
  "config/marketing-admission-code-manifest.json";
