import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";

/**
 * Every operator script whose imports reach a `server-only` module must run
 * under `--conditions=react-server`.
 *
 * `server-only` is a package with two export conditions: under `react-server`
 * it is an empty module, and under anything else it throws "This module cannot
 * be imported from a Client Component module." Next.js sets that condition;
 * a bare `node --import tsx scripts/x.mjs` does not. So a script that imports
 * `lib/billingConfig.ts` or `lib/stripePromotionProvisioning.ts` dies on its
 * first line with a message about Client Components, which is not a hint that
 * a node flag is missing.
 *
 * `npm run billing:reconcile-promotion` shipped that way and had never run:
 * the failure only appears when somebody actually invokes it, which for an
 * incident tool is the worst possible moment to discover it. Nothing else
 * catches this -- the script has no test, and a lint rule sees a valid import.
 *
 * The detection here is deliberately precise rather than a substring search.
 * Several modules say "no `server-only`" in a header comment describing why
 * they are dependency-free, and flagging those would make this test fail for
 * scripts that are correct. Only a real `import "server-only";` statement
 * counts, `import type` lines are skipped because types are erased before the
 * module is ever loaded, and the walk is transitive because the offending
 * import is usually two or three modules down.
 */

const SERVER_ONLY_IMPORT = /^\s*import\s+["']server-only["']\s*;?\s*$/m;
const RELATIVE_IMPORT =
  /from\s+["'](\.\.?\/[^"']+)["']|import\s*\(\s*["'](\.\.?\/[^"']+)["']/g;
const TYPE_ONLY_IMPORT = /import\s+type\s/;
/** `node <flags> scripts/<name>.mjs`, ignoring anything after a shell operator. */
const NODE_SCRIPT = /node\s[^&|]*?(scripts\/[\w.-]+\.mjs)/;

const relativeImports = (path) => {
  const found = new Set();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    // A type-only import is erased by the transpiler, so it can never trigger
    // the runtime throw this test exists to prevent.
    if (TYPE_ONLY_IMPORT.test(line)) continue;
    for (const match of line.matchAll(RELATIVE_IMPORT)) {
      const specifier = match[1] || match[2];
      found.add(normalize(join(dirname(path), specifier)));
    }
  }
  return found;
};

const reachesServerOnly = (path, seen = new Set()) => {
  if (seen.has(path) || !existsSync(path)) return false;
  seen.add(path);
  if (SERVER_ONLY_IMPORT.test(readFileSync(path, "utf8"))) return true;
  for (const dependency of relativeImports(path)) {
    if (reachesServerOnly(dependency, seen)) return true;
  }
  return false;
};

const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;

test("a script that reaches server-only runs under the react-server condition", () => {
  const missing = [];
  for (const [name, command] of Object.entries(scripts)) {
    const entryPoint = NODE_SCRIPT.exec(command)?.[1];
    if (!entryPoint || !existsSync(entryPoint)) continue;
    if (!reachesServerOnly(entryPoint)) continue;
    if (!command.includes("--conditions=react-server")) {
      missing.push(`${name}: ${command}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `these scripts import a server-only module and will throw on their first line:\n  ${missing.join(
      "\n  "
    )}\nAdd --conditions=react-server to the node invocation.`
  );
});

test("the detector finds the imports it is meant to find", () => {
  // Guards the guard. A regex that silently stopped matching would make the
  // test above pass by checking nothing at all, which is the failure mode of
  // every static check that nobody asserts against a known case.
  assert.equal(
    reachesServerOnly("scripts/reconcile-promotion.mjs"),
    true,
    "reconcile-promotion imports lib/billingConfig.ts, which is server-only"
  );
  assert.equal(
    reachesServerOnly("scripts/check-image-executor-budget.mjs"),
    false,
    "imageGenerationStateCore only mentions server-only in a comment"
  );
  assert.ok(
    scripts["billing:reconcile-promotion"].includes("--conditions=react-server")
  );
});
