import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Nothing inside a bounded publisher transaction may reach past the client it
 * was handed.
 *
 * `runBoundedMarketingTransaction` promises three things: a transaction that
 * cannot outlast 115 seconds, statements that cannot outlast 5 seconds, and at
 * most twelve of them. All three are properties of one connection, and a
 * callback that closes over the module-level `prisma` is on a *different*
 * connection: none of the three timeouts apply to it, the statement counter
 * never sees it, and -- the part that is not merely inaccurate -- its writes
 * can commit after the wrapper has rolled back, or after the run's deadline has
 * passed and the run has been recorded failed.
 *
 * No proxy can see that, because the escape does not go through the proxy. The
 * only place it can be caught is here, in the source, before the caller exists:
 * S2d1 ships the wrapper and S2d2 writes the first work function.
 *
 * `include` is a different matter and is *not* checked here. One Prisma call
 * can send more than one SQL statement, so the twelve is a count of
 * application calls rather than of SQL statements -- which is why the plan
 * calls the derived maximum an application figure and names
 * `transaction_timeout` as the bound that actually holds.
 */

const ROOT = resolve(import.meta.dirname, "..");
const ROOTS = ["app", "lib", "scripts"];
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];
const NAME = "runBoundedMarketingTransaction";
const CALL = NAME + "(";
/** Where it is defined, and the one place its name is not a call. */
const DEFINITION = "lib/marketingPublisherRun.ts";

const sourceFiles = () => {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (EXTENSIONS.some((extension) => entry.endsWith(extension))) found.push(path);
    }
  };
  for (const root of ROOTS) walk(join(ROOT, root));
  return found;
};

/**
 * The text of one call's arguments, from the open paren to its match.
 *
 * Written rather than regexed because a callback body contains every character
 * a regex would have to stop at. Strings, template literals and comments are
 * skipped so that a `)` inside one does not end the scan early -- the failure
 * mode of the naive version is to return a truncated body, which reads as
 * "nothing forbidden in here".
 */
const callArguments = (source, openIndex) => {
  let depth = 0;
  let index = openIndex;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === quote) break;
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
    index += 1;
  }
  throw new Error("unbalanced call arguments");
};

/** Everything after the first top-level comma: the work function. */
const workArgument = (argumentText) => {
  let depth = 0;
  for (let index = 0; index < argumentText.length; index += 1) {
    const char = argumentText[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) return argumentText.slice(index + 1);
  }
  return "";
};

const callSites = () => {
  const sites = [];
  for (const path of sourceFiles()) {
    const source = readFileSync(path, "utf8");
    if (!source.includes(CALL)) continue;
    let from = 0;
    while (true) {
      const at = source.indexOf(CALL, from);
      if (at === -1) break;
      const openIndex = at + CALL.length - 1;
      sites.push({
        file: relative(ROOT, path).split("\\").join("/"),
        work: workArgument(callArguments(source, openIndex)),
      });
      from = at + CALL.length;
    }
  }
  return sites;
};

/**
 * Two shapes this scan cannot follow, refused rather than resolved.
 *
 * Calls are found by their text, so an alias -- assign the function to a name
 * and call that -- is a call the scan never sees, and a call it never sees has
 * a body it never reads. Following an identifier across a module is a type
 * checker's job; refusing the indirection costs a caller nothing, because there
 * is no reason to alias it.
 *
 * Import declarations are removed first, since naming it in one is how a caller
 * gets at it. Nothing else is removed -- no export form in particular -- so a
 * re-export is refused too, which is the point: a second name for it is a
 * second name these checks cannot search for.
 */
const withoutImportDeclarations = (source) =>
  // Safe because an import declaration holds no ";" before its own, which is
  // what keeps this from eating the statement after it.
  source.replace(/^[ \t]*import\b[^;]*?;/gms, "");

test("the function is only ever called, never aliased or re-exported", () => {
  for (const path of sourceFiles()) {
    const file = relative(ROOT, path).split("\\").join("/");
    if (file === DEFINITION) continue;
    const source = withoutImportDeclarations(readFileSync(path, "utf8"));
    let from = 0;
    while (true) {
      const at = source.indexOf(NAME, from);
      if (at === -1) break;
      from = at + NAME.length;
      // A longer identifier that happens to contain the name is not the name.
      if (/[\w$]/.test(source[at - 1] ?? "")) continue;
      if (/[\w$]/.test(source[from] ?? "")) continue;
      assert.equal(
        source[from],
        "(",
        file +
          ": " +
          NAME +
          " is named without being called. Call it directly -- an alias or a re-export is a call the checks in this file cannot find, and the bound they enforce is why they exist.",
      );
    }
  }
});

/**
 * The work is written where it is passed.
 *
 * Passing a named function leaves the body in another place, where it may use
 * the module-level client while this scan reads the work as the letters of its
 * name. Refused for the same reason.
 */
test("the work is an inline function, not a name", () => {
  for (const site of callSites()) {
    const work = site.work.trim();
    assert.ok(
      work.includes("=>") || /^(async\s+)?function\b/.test(work),
      site.file +
        ": the work passed to runBoundedMarketingTransaction must be written inline. A function passed by name carries its body somewhere these checks cannot read it, and its body is the thing that has to be free of the module-level client.",
    );
  }
});

test("no bounded publisher transaction reaches the module-level client", () => {
  for (const site of callSites()) {
    assert.equal(
      /(^|[^.\w])prisma\s*\./.test(site.work),
      false,
      `${site.file}: work passed to runBoundedMarketingTransaction uses the module-level \`prisma\`. It must use only the client it is given: the module-level one is a different connection, so the transaction timeout, the statement timeout and the statement budget do not apply to it, and its writes can commit after this transaction rolls back or after the run's deadline.`,
    );
  }
});

test("no bounded publisher transaction opens a transaction of its own", () => {
  for (const site of callSites()) {
    assert.equal(
      site.work.includes("$transaction"),
      false,
      `${site.file}: work passed to runBoundedMarketingTransaction opens its own transaction. The proxy refuses this at runtime; it is refused here too so the second one is never written.`,
    );
  }
});

test("the scanner finds a planted call and reads its whole body", () => {
  // Without this the two tests above pass on a file list they never built and
  // a body they read as empty -- the shape that has already produced three
  // green gates over a dead path in this feature.
  const planted = `
    await runBoundedMarketingTransaction(prisma, async (tx) => {
      const text = "a ) and a } inside a string";
      // a ) in a comment
      await tx.marketingPost.findMany({ where: { id: text } });
      await prisma.marketingPost.update({ where: { id: "x" }, data: {} });
    });
  `;
  const openIndex = planted.indexOf(CALL) + CALL.length - 1;
  const work = workArgument(callArguments(planted, openIndex));
  assert.match(work, /prisma\.marketingPost\.update/);
  assert.equal(/(^|[^.\w])prisma\s*\./.test(work), true);
  // `tx.` must not be mistaken for the module-level client.
  const clean = workArgument(
    callArguments(
      `runBoundedMarketingTransaction(prisma, async (tx) => { await tx.marketingPost.findMany({}); });`,
      `runBoundedMarketingTransaction(`.length - 1,
    ),
  );
  assert.equal(/(^|[^.\w])prisma\s*\./.test(clean), false);
});

test("the two indirections are refused, and an import is not", () => {
  // Both rules pass trivially today, because S2d2 writes the first caller. What
  // is proved here is that they refuse, which is the part a tree with no
  // callers cannot show.
  const byName = workArgument(
    callArguments("runBoundedMarketingTransaction(prisma, publishBatch);", CALL.length - 1),
  ).trim();
  assert.equal(byName.includes("=>"), false);
  assert.equal(/^(async\s+)?function\b/.test(byName), false);

  const inline = workArgument(
    callArguments("runBoundedMarketingTransaction(prisma, async (tx) => { await tx.a.b(); });", CALL.length - 1),
  ).trim();
  assert.equal(inline.includes("=>"), true);

  // An import naming it is how a caller reaches it, and is removed before the
  // alias rule looks.
  assert.equal(
    withoutImportDeclarations(
      'import { runBoundedMarketingTransaction } from "@/lib/marketingPublisherRun";\nconst x = 1;',
    ).trim(),
    "const x = 1;",
  );
  // A multi-line named import is the same declaration and is removed too.
  assert.equal(
    withoutImportDeclarations(
      'import {\n  runBoundedMarketingTransaction,\n} from "@/lib/marketingPublisherRun";\nconst x = 1;',
    ).trim(),
    "const x = 1;",
  );
  // An alias survives it, which is what makes the rule above able to fail.
  assert.match(
    withoutImportDeclarations("const run = runBoundedMarketingTransaction;"),
    /const run = runBoundedMarketingTransaction;/,
  );
  // And a re-export survives it, because a second name is a second search.
  assert.match(
    withoutImportDeclarations("export { runBoundedMarketingTransaction };"),
    /export \{ runBoundedMarketingTransaction \};/,
  );
  // The statement after an import is not eaten.
  assert.match(
    withoutImportDeclarations('import x from "y";\nconst after = runBoundedMarketingTransaction;'),
    /const after = runBoundedMarketingTransaction;/,
  );
});
