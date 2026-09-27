import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";

/**
 * Nothing inside a bounded publisher transaction may reach past the client it
 * was handed.
 *
 * `runBoundedMarketingTransaction` promises three things: a transaction that
 * cannot outlast 115 seconds, statements that cannot outlast 5 seconds, and at
 * most twelve of them. All three are properties of one connection, and a
 * callback that reaches for a client other than its `tx` is on a *different*
 * connection: none of the three timeouts apply to it, the statement counter
 * never sees it, and -- the part that is not merely inaccurate -- its writes can
 * commit after this transaction rolls back, or after the run's deadline has
 * passed and the run has been recorded failed.
 *
 * No proxy can see that, because the escape does not go through the proxy. The
 * only place it can be caught is in the source, before the caller exists: S2d1
 * ships the wrapper and S2d2 writes the first work function.
 *
 * ## Why the parser and not a text search
 *
 * The first version searched for the text `runBoundedMarketingTransaction(` and
 * then for `prisma.` inside the argument it found. Independent review named two
 * pieces of ordinary TypeScript that walked straight past it, and both were
 * right:
 *
 *     import { runBoundedMarketingTransaction as bounded } from "...";
 *     await bounded(prisma, async () => { await prisma.marketingPost.update(...); });
 *
 * found no call sites at all, and
 *
 *     await runBoundedMarketingTransaction(prisma, async (tx) => {
 *       const db = prisma;
 *       await db.marketingPost.update(...);
 *     });
 *
 * found one whose body contained no `prisma.`. A gate that valid code passes is
 * not a gate, and it is worse than no gate, because it reads like one.
 *
 * So this resolves names rather than matching them. Each file is parsed and its
 * import declarations are read, which gives the *local* name the wrapper and the
 * Prisma client are bound to in that file, whatever they are spelled as.
 * `ts.createSourceFile` is the same tool
 * `scripts/check-protected-table-writers-core.mjs` and
 * `tests/marketingS2b1Store.test.mjs` already use here.
 *
 * ## What is checked, and what that leaves
 *
 * Per call:
 *
 * 1. The work argument is written inline. A function passed by name carries its
 *    body somewhere this file does not read.
 * 2. Inside that body, no identifier names a banned client: a Prisma client
 *    imported into this file under any name, the identifier passed as this
 *    call's own first argument, or a local initialised from either. Only the
 *    callback's own parameters are allowed.
 * 3. The body opens no transaction of its own.
 *
 * What per-file resolution cannot follow is a client laundered through a third
 * module. Rather than leave that as a sentence, a separate test asserts no
 * module under `lib/` re-exports a client, so the shape does not exist to be
 * imported.
 *
 * `include` is a different matter and is not checked. One Prisma call can send
 * more than one SQL statement, so the twelve is a count of application calls
 * rather than of SQL -- which is why the plan calls the derived maximum an
 * application figure and names `transaction_timeout` as the bound that holds.
 */

const ROOT = resolve(import.meta.dirname, "..");
const ROOTS = ["app", "lib", "scripts"];
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];
const WRAPPER = "runBoundedMarketingTransaction";
/** Where the wrapper lives, and the one file whose mention of it is not a call. */
const DEFINITION = "lib/marketingPublisherRun.ts";

const sourceFiles = () => {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      if (entry === "node_modules" || entry === ".next") continue;
      const path = join(directory, entry);
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

const repoPath = (path) => relative(ROOT, path).split("\\").join("/");

const parse = (path) =>
  ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);

const eachNode = (node, visit) => {
  visit(node);
  ts.forEachChild(node, (child) => eachNode(child, visit));
};

/**
 * The expression under any parentheses and type assertions.
 *
 * Without this a cast decides which rule fires: `(async (tx) => {...}) as never`
 * is not an arrow function, so the inline rule would refuse it and the rule that
 * actually reads the body would skip it. Unwrapping means a cast changes
 * nothing, in either direction.
 */
const unwrap = (node) => {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression;
  }
  return current;
};

const isPrismaModule = (specifier) =>
  specifier === "@prisma/client" || /(^|[./@])lib\/prisma$/.test(specifier);

/**
 * The local names a file binds the wrapper and a Prisma client to.
 *
 * Read from the import declarations, so `as bounded` and `as db` are the names
 * that come back -- which is the whole reason this is a parse and not a search.
 * A default or namespace import of a Prisma module counts as a client binding
 * too: a namespace object's `.prisma` is the same client by another route.
 */
const localBindings = (tree) => {
  const wrapper = new Set();
  const clients = new Set();
  eachNode(tree, (node) => {
    if (!ts.isImportDeclaration(node) || !node.importClause) return;
    const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
    const fromPrisma = isPrismaModule(specifier);
    const { name, namedBindings } = node.importClause;
    if (name && fromPrisma) clients.add(name.text);
    if (namedBindings && ts.isNamespaceImport(namedBindings) && fromPrisma) {
      clients.add(namedBindings.name.text);
    }
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        const local = element.name.text;
        if (imported === WRAPPER) wrapper.add(local);
        if (fromPrisma && (imported === "prisma" || imported === "PrismaClient")) {
          clients.add(local);
        }
      }
    }
  });
  return { wrapper, clients };
};

const lineOf = (tree, node) =>
  tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;

/** Every call to the wrapper, under whatever local name, across the tree. */
const callSites = () => {
  const sites = [];
  for (const path of sourceFiles()) {
    const file = repoPath(path);
    if (file === DEFINITION) continue;
    const source = readFileSync(path, "utf8");
    if (!source.includes(WRAPPER)) continue;
    const tree = parse(path);
    const { wrapper, clients } = localBindings(tree);
    if (wrapper.size === 0) continue;
    eachNode(tree, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      if (!ts.isIdentifier(callee) || !wrapper.has(callee.text)) return;
      const [first, second] = node.arguments;
      const banned = new Set(clients);
      // The client this call passes in is outside the transaction just as much
      // as an imported one: using it inside the callback issues statements on
      // the connection the wrapper is not bounding.
      if (first && ts.isIdentifier(first)) banned.add(first.text);
      sites.push({ file, tree, work: unwrap(second), banned, line: lineOf(tree, node) });
    });
  }
  return sites;
};

/** The names a callback may use for its client: its own parameters. */
const parameterNames = (work) =>
  new Set(
    work.parameters
      .map((parameter) => (ts.isIdentifier(parameter.name) ? parameter.name.text : null))
      .filter((name) => name !== null),
  );

/**
 * Locals inside a body that are a second name for a banned client.
 *
 * One level, which is the level the review's example used: `const db = prisma`.
 * Destructuring a client is caught as a use of the banned name in the
 * initialiser, so it needs no rule of its own.
 */
const aliasedLocals = (body, banned) => {
  const aliases = new Set();
  eachNode(body, (node) => {
    if (!ts.isVariableDeclaration(node) || !node.initializer) return;
    if (!ts.isIdentifier(node.name) || !ts.isIdentifier(node.initializer)) return;
    if (banned.has(node.initializer.text)) aliases.add(node.name.text);
  });
  return aliases;
};

/** Identifiers in a body that name one of `banned`, as `{name, line}`. */
const bannedUses = (tree, work, banned) => {
  const allowed = parameterNames(work);
  const all = new Set([...banned, ...aliasedLocals(work.body, banned)]);
  const uses = [];
  eachNode(work.body, (node) => {
    if (!ts.isIdentifier(node)) return;
    // Declaring the alias is not a use of it.
    if (ts.isVariableDeclaration(node.parent) && node.parent.name === node) return;
    // A property that happens to be called `prisma` is not the client.
    if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return;
    if (allowed.has(node.text)) return;
    if (all.has(node.text)) uses.push({ name: node.text, line: lineOf(tree, node) });
  });
  return uses;
};

test("the work is an inline function, not a name", () => {
  for (const site of callSites()) {
    assert.ok(
      site.work && (ts.isArrowFunction(site.work) || ts.isFunctionExpression(site.work)),
      `${site.file}:${site.line}: the work passed to ${WRAPPER} must be written inline. A function passed by name carries its body somewhere these checks cannot read it, and its body is the thing that has to be free of every client but its own.`,
    );
  }
});

test("no bounded publisher transaction reaches a client other than its own", () => {
  for (const site of callSites()) {
    const work = site.work;
    if (!work || !(ts.isArrowFunction(work) || ts.isFunctionExpression(work))) continue;
    for (const use of bannedUses(site.tree, work, site.banned)) {
      assert.fail(
        `${site.file}:${use.line}: "${use.name}" inside the work passed to ${WRAPPER} is a client other than the one the transaction bounds. Use only the client the callback is given: another client is another connection, so the transaction timeout, the statement timeout and the statement budget do not apply to it, and its writes can commit after this transaction rolls back or after the run's deadline.`,
      );
    }
  }
});

test("no bounded publisher transaction opens a transaction of its own", () => {
  for (const site of callSites()) {
    if (!site.work) continue;
    eachNode(site.work, (node) => {
      assert.ok(
        !(ts.isIdentifier(node) && node.text === "$transaction"),
        `${site.file}:${lineOf(site.tree, node)}: work passed to ${WRAPPER} opens its own transaction. The proxy refuses this at runtime; it is refused here too so the second one is never written.`,
      );
    });
  }
});

test("no module re-exports a Prisma client under another name", () => {
  // This is what makes the per-file resolution above sufficient. A module whose
  // job is to hand out the client under a new name would let a caller import
  // that name instead, and the import walk would not recognise it. Rather than
  // follow such a module, this asserts none exists.
  const offenders = [];
  for (const path of sourceFiles()) {
    const file = repoPath(path);
    if (file === "lib/prisma.ts" || !file.startsWith("lib/")) continue;
    const source = readFileSync(path, "utf8");
    if (!source.includes("prisma")) continue;
    const tree = parse(path);
    const { clients } = localBindings(tree);
    if (clients.size === 0) continue;
    eachNode(tree, (node) => {
      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const local = (element.propertyName ?? element.name).text;
          if (clients.has(local)) offenders.push(`${file}: export { ${local} }`);
        }
      }
      if (
        ts.isVariableStatement(node) &&
        node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        for (const declaration of node.declarationList.declarations) {
          const initializer = declaration.initializer;
          if (initializer && ts.isIdentifier(initializer) && clients.has(initializer.text)) {
            offenders.push(`${file}: export const ${declaration.name.getText(tree)}`);
          }
        }
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "a module that re-exports the Prisma client gives it a second name, and a second name is one the per-file import walk in this file cannot recognise",
  );
});

/* -------------------------------------------------------------------------- */
/* The checks above pass trivially until S2d2 writes the first caller, so what */
/* follows proves they refuse -- on the exact two shapes review found, plus the */
/* ordinary shape they must not refuse.                                        */
/* -------------------------------------------------------------------------- */

const probe = (source) => {
  const tree = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true);
  const { wrapper, clients } = localBindings(tree);
  const sites = [];
  eachNode(tree, (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isIdentifier(node.expression) || !wrapper.has(node.expression.text)) return;
    const [first, second] = node.arguments;
    const banned = new Set(clients);
    if (first && ts.isIdentifier(first)) banned.add(first.text);
    sites.push({ tree, work: unwrap(second), banned });
  });
  return { tree, wrapper, clients, sites };
};

const IMPORTS =
  'import { runBoundedMarketingTransaction } from "@/lib/marketingPublisherRun";\n' +
  'import { prisma } from "@/lib/prisma";\n';

test("an aliased import is still found as a call", () => {
  // The bypass the text search missed completely: no occurrence of the original
  // name at the call, so zero call sites and every other rule vacuous.
  const { wrapper, clients, sites } = probe(
    'import { runBoundedMarketingTransaction as bounded } from "@/lib/marketingPublisherRun";\n' +
      'import { prisma as db } from "@/lib/prisma";\n' +
      "export const go = () => bounded(db, async (tx) => { await db.a.b(); });\n",
  );
  assert.deepEqual([...wrapper], ["bounded"]);
  assert.deepEqual([...clients], ["db"]);
  assert.equal(sites.length, 1);
  const uses = bannedUses(sites[0].tree, sites[0].work, sites[0].banned);
  assert.deepEqual(
    uses.map((use) => use.name),
    ["db"],
    "the aliased client is the client",
  );
});

test("a local copy of the client is refused", () => {
  // The second bypass: a direct call whose body never spells `prisma.`.
  const { sites } = probe(
    IMPORTS +
      "export const go = () =>\n" +
      "  runBoundedMarketingTransaction(prisma, async (tx) => {\n" +
      "    const db = prisma;\n" +
      "    await db.marketingPost.update({ where: { id: 1 }, data: {} });\n" +
      "  });\n",
  );
  assert.equal(sites.length, 1);
  assert.deepEqual(
    bannedUses(sites[0].tree, sites[0].work, sites[0].banned).map((use) => use.name),
    ["prisma", "db"],
    "both the initialiser and the copy are uses",
  );
});

test("the client the call passes in is refused inside the callback", () => {
  // A module that receives its client as a parameter rather than importing one
  // still must not use that client inside the transaction.
  const { sites } = probe(
    'import { runBoundedMarketingTransaction } from "@/lib/marketingPublisherRun";\n' +
      "export const go = (client) =>\n" +
      "  runBoundedMarketingTransaction(client, async (tx) => { await client.a.b(); });\n",
  );
  assert.equal(sites.length, 1);
  assert.deepEqual(
    bannedUses(sites[0].tree, sites[0].work, sites[0].banned).map((use) => use.name),
    ["client"],
  );
});

test("work passed by name is refused", () => {
  const { sites } = probe(
    IMPORTS + "export const go = () => runBoundedMarketingTransaction(prisma, publishBatch);\n",
  );
  assert.equal(sites.length, 1);
  assert.equal(ts.isArrowFunction(sites[0].work), false);
  assert.equal(ts.isFunctionExpression(sites[0].work), false);
});

test("the ordinary shape is accepted, brackets and comments and all", () => {
  // The rules must not refuse the code S2d2 is meant to write, and the body has
  // to be read whole -- a string holding ")" and "}" and a comment holding ")"
  // are what ended the text scan's predecessor early.
  const { sites } = probe(
    IMPORTS +
      "export const go = () =>\n" +
      "  runBoundedMarketingTransaction(prisma, async (tx) => {\n" +
      '    const text = "a ) and a } inside a string";\n' +
      "    // a ) in a comment\n" +
      "    await tx.marketingPost.findMany({ where: { id: text } });\n" +
      "    await tx.marketingChannel.update({ where: { id: text }, data: {} });\n" +
      "    return JSON.stringify({ text });\n" +
      "  });\n",
  );
  assert.equal(sites.length, 1);
  assert.ok(ts.isArrowFunction(sites[0].work));
  assert.deepEqual(parameterNames(sites[0].work), new Set(["tx"]));
  assert.deepEqual(bannedUses(sites[0].tree, sites[0].work, sites[0].banned), []);
});

test("a property named prisma on something else is not the client", () => {
  const { sites } = probe(
    IMPORTS +
      "export const go = (config) =>\n" +
      "  runBoundedMarketingTransaction(prisma, async (tx) => { await tx.a.b(config.prisma); });\n",
  );
  assert.deepEqual(bannedUses(sites[0].tree, sites[0].work, sites[0].banned), []);
});

test("a namespace or default import of a Prisma module counts as a client", () => {
  const namespace = probe('import * as db from "@/lib/prisma";\n');
  assert.deepEqual([...namespace.clients], ["db"]);
  const fallback = probe('import client from "@prisma/client";\n');
  assert.deepEqual([...fallback.clients], ["client"]);
  // A module that is not a Prisma module does not bind one.
  const unrelated = probe('import { prisma } from "@/lib/marketingStore";\n');
  assert.deepEqual([...unrelated.clients], []);
});
