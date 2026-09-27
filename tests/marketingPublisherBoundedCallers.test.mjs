import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import ts from "typescript";

/**
 * Work inside a bounded publisher transaction can reach no client but its own.
 *
 * `runBoundedMarketingTransaction` promises three things: a transaction that
 * cannot outlast 115 seconds, statements that cannot outlast 5 seconds, and at
 * most twelve of them. All three are properties of one connection. A callback
 * that reaches a different client is on a different connection: none of the
 * three applies to it, the statement counter never sees it, and -- the part that
 * is not merely inaccurate -- its writes can commit after this transaction rolls
 * back, or after the run's deadline has passed and the run has been recorded
 * failed. No proxy can catch that, because it does not go through the proxy.
 *
 * ## Two wrong versions, and why the third is shaped differently
 *
 * The first version searched the text for `runBoundedMarketingTransaction(` and
 * then for `prisma.` in the argument it found. The second parsed the file and
 * banned identifiers: the imported client under any name, the call's own first
 * argument, locals copied from either.
 *
 * Both were **denylists**, and independent review broke both -- the first with
 * an aliased import and `const db = prisma`, the second with `box.db`,
 * `this.prisma`, a namespace-called wrapper, a default parameter, `globalThis`,
 * an outside helper, `await import()`, and a `new PrismaClient()` built from a
 * dynamic import. Each round closed three shapes and five more appeared, which
 * is what a denylist over an unbounded space does.
 *
 * The question a denylist was trying to answer is "can this expression reach a
 * client", which is unbounded. The question this version asks is **"can this
 * module obtain a client at all"**, which is a decidable fact about a file's
 * import declarations. So:
 *
 * 1. The work is an inline function. A function passed by name keeps its body
 *    somewhere this file does not read.
 * 2. Inside the body, every free name must be on an **allowlist**: the
 *    callback's own parameters, anything declared inside the body, a standard
 *    global, or an import binding of this file whose module is *client-free*.
 *    Anything else is refused, including `this` and `globalThis`. `box.db`,
 *    `this.prisma` and a module-scope alias are all refused by the same rule,
 *    without the rule having heard of them -- they are simply not on the list.
 * 3. A module is client-free when it binds no Prisma client, constructs none,
 *    and loads none dynamically; and when every first-party module it imports is
 *    client-free too. The walk is transitive, so a helper that imports a helper
 *    that imports the client is refused at the top.
 *
 * What this gives up is convenience: the work may not reach for a module-scope
 * constant of the calling file, and must import it from a client-free module
 * instead. That is the price of the rule being an allowlist, and it is cheap --
 * the intended shape is a route that holds the client and one line of callback
 * forwarding `tx` into a module that cannot hold one.
 *
 * `include` is a separate matter and is not checked. One Prisma call can send
 * more than one SQL statement, so twelve is a count of application calls rather
 * than of SQL -- which is why the plan calls the derived maximum an application
 * figure and names `transaction_timeout` as the bound that holds.
 */

const ROOT = resolve(import.meta.dirname, "..");
const ROOTS = ["app", "lib", "scripts"];
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];
const WRAPPER = "runBoundedMarketingTransaction";
/** Where the wrapper lives, and the one file whose mention of it is not a call. */
const DEFINITION = "lib/marketingPublisherRun.ts";

/**
 * Names a body may use without importing them.
 *
 * Deliberately short. An unknown free name is refused rather than assumed
 * harmless, because "harmless" is the assumption both denylists were built on.
 */
const SAFE_GLOBALS = new Set([
  "Array", "BigInt", "Boolean", "Date", "Error", "Infinity", "JSON", "Map",
  "Math", "NaN", "Number", "Object", "Promise", "RegExp", "Set", "String",
  "Symbol", "TypeError", "URL", "WeakMap", "WeakSet", "console", "isNaN",
  "parseFloat", "parseInt", "structuredClone", "undefined",
]);

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

const parse = (path, source = readFileSync(path, "utf8")) =>
  ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);

/** Walk, skipping type positions: an identifier in a type is not a value. */
const eachNode = (node, visit) => {
  visit(node);
  ts.forEachChild(node, (child) => {
    if (
      child.kind >= ts.SyntaxKind.FirstTypeNode &&
      child.kind <= ts.SyntaxKind.LastTypeNode
    ) {
      return;
    }
    eachNode(child, visit);
  });
};

const lineOf = (tree, node) =>
  tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;

/**
 * Whether a specifier names a module that hands out a Prisma client.
 *
 * The extension matters: this repository imports the client three ways, and
 * `../lib/prisma.ts` -- 22 files -- is one of them. A pattern that required the
 * specifier to end at `prisma` matched none of those files, which is the
 * round-two defect one level down.
 */
const isPrismaModule = (specifier) =>
  specifier === "@prisma/client" ||
  /(^|[./@~])lib\/prisma(\.(?:ts|tsx|js|mjs|cjs))?$/.test(specifier);

const isFirstParty = (specifier) =>
  specifier.startsWith("@/") || specifier.startsWith(".") || specifier.startsWith("~/");

/** A first-party specifier resolved to a file on disk, or null. */
const resolveSpecifier = (fromFile, specifier) => {
  const base = specifier.startsWith("@/") || specifier.startsWith("~/")
    ? join(ROOT, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    ...EXTENSIONS.map((extension) => base + extension),
    ...EXTENSIONS.map((extension) => join(base, "index" + extension)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
};

/** Every import declaration of a file, as `{specifier, locals, prisma}`. */
const imports = (tree) => {
  const found = [];
  eachNode(tree, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    const specifier = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
    const locals = new Set();
    const clause = node.importClause;
    if (clause) {
      if (clause.name) locals.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) locals.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) locals.add(element.name.text);
      }
    }
    // Which of those locals is a *client*, as opposed to the `Prisma`
    // namespace, an enum or a generated type. Getting this wrong in the
    // permissive direction hides a client; getting it wrong in the strict
    // direction bans a module full of types from the work body, and the first
    // version of this did the second thing to `export { Prisma }`.
    const clientLocals = new Set();
    if (isPrismaModule(specifier)) {
      const bindings = clause?.namedBindings;
      if (clause?.name) clientLocals.add(clause.name.text);
      if (bindings && ts.isNamespaceImport(bindings)) clientLocals.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          const imported = (element.propertyName ?? element.name).text;
          if (imported === "prisma" || imported === "PrismaClient") {
            clientLocals.add(element.name.text);
          }
        }
      }
    }
    found.push({
      specifier,
      locals,
      clientLocals,
      prisma: clientLocals.size > 0,
      typeOnly: Boolean(clause?.isTypeOnly),
    });
  });
  return found;
};

/**
 * Why this module can obtain a Prisma client, or null when it cannot.
 *
 * Transitive over first-party imports, and memoised. A cycle is treated as
 * client-free on the second visit: whatever a cycle can reach, some file in it
 * reaches directly, and that file answers for it.
 */
const clientReach = (() => {
  const cache = new Map();
  const visiting = new Set();
  return function reach(path) {
    if (cache.has(path)) return cache.get(path);
    if (visiting.has(path)) return null;
    visiting.add(path);
    let answer = null;
    const file = repoPath(path);
    const source = readFileSync(path, "utf8");
    const tree = parse(path, source);
    for (const entry of imports(tree)) {
      if (entry.prisma && !entry.typeOnly) {
        answer = `${file} imports a Prisma client from "${entry.specifier}"`;
        break;
      }
    }
    if (!answer) {
      eachNode(tree, (node) => {
        if (answer) return;
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "PrismaClient") {
          answer = `${file} constructs a PrismaClient`;
        }
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const dynamic =
            callee.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(callee) && callee.text === "require");
          const [first] = node.arguments;
          if (dynamic && first && ts.isStringLiteral(first) && isPrismaModule(first.text)) {
            answer = `${file} loads a Prisma client with ${callee.kind === ts.SyntaxKind.ImportKeyword ? "import()" : "require()"}`;
          }
        }
      });
    }
    if (!answer) {
      for (const entry of imports(tree)) {
        if (entry.typeOnly || !isFirstParty(entry.specifier)) continue;
        const target = resolveSpecifier(path, entry.specifier);
        if (!target) continue;
        const deeper = reach(target);
        if (deeper) {
          answer = `${file} imports "${entry.specifier}", and ${deeper}`;
          break;
        }
      }
    }
    visiting.delete(path);
    cache.set(path, answer);
    return answer;
  };
})();

/** Every call to the wrapper, by named or namespace import, across the tree. */
const callSites = () => {
  const sites = [];
  for (const path of sourceFiles()) {
    const file = repoPath(path);
    if (file === DEFINITION) continue;
    const source = readFileSync(path, "utf8");
    if (!source.includes(WRAPPER)) continue;
    const tree = parse(path, source);
    const named = new Set();
    const namespaces = new Set();
    for (const entry of imports(tree)) {
      if (entry.typeOnly) continue;
      if (!ts.isStringLiteral) continue;
      const wrapperModule = /(^|[./@~])lib\/marketingPublisherRun(\.(?:ts|tsx|js|mjs|cjs))?$/.test(entry.specifier);
      if (!wrapperModule) continue;
      const declaration = imports(tree).find((candidate) => candidate === entry);
      void declaration;
      for (const local of entry.locals) {
        // A namespace or default binding is reached as `ns.runBounded…`; a named
        // binding is the call itself, under whatever it was renamed to.
        namespaces.add(local);
        named.add(local);
      }
    }
    // Named bindings that are specifically this function, so `bounded(...)` is
    // recognised and an unrelated named import is not.
    const wrapperNames = new Set();
    eachNode(tree, (node) => {
      if (!ts.isImportDeclaration(node)) return;
      const bindings = node.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) return;
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === WRAPPER) {
          wrapperNames.add(element.name.text);
        }
      }
    });
    eachNode(tree, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression;
      const isNamed = ts.isIdentifier(callee) && wrapperNames.has(callee.text);
      const isNamespaced =
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === WRAPPER &&
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text);
      if (!isNamed && !isNamespaced) return;
      sites.push({
        file,
        path,
        tree,
        work: unwrap(node.arguments[1]),
        line: lineOf(tree, node),
      });
    });
  }
  return sites;
};

/** The expression under any parentheses or type assertion. */
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

/** Every name a body declares or receives, including in nested scopes. */
const declaredNames = (work) => {
  const names = new Set();
  const add = (name) => {
    if (!name) return;
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) add(element.name);
      }
    }
  };
  for (const parameter of work.parameters) add(parameter.name);
  eachNode(work, (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) {
      add(node.name);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      add(node.name);
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) add(node.variableDeclaration.name);
  });
  return names;
};

/**
 * Free names used in a body, each with the line it appears on.
 *
 * The parameter list is walked as well as the body, because a default value is
 * evaluated in the enclosing scope and is not part of the body:
 * `async (tx, db = prisma) => ...` reaches the client without the body naming
 * it, and the first version of this walked only `work.body`.
 */
const freeNames = (tree, work) => {
  const declared = declaredNames(work);
  const used = [];
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      used.push({ name: "this", line: lineOf(tree, node) });
      return;
    }
    if (!ts.isIdentifier(node)) return;
    const parent = node.parent;
    // A property name, a property-assignment key, a label, a shorthand key.
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return;
    if (ts.isMethodDeclaration(parent) && parent.name === node) return;
    if (ts.isPropertyDeclaration(parent) && parent.name === node) return;
    if (ts.isBindingElement(parent) && parent.propertyName === node) return;
    if (declared.has(node.text)) return;
    used.push({ name: node.text, line: lineOf(tree, node) });
  };
  eachNode(work.body ?? work, visit);
  for (const parameter of work.parameters) {
    if (parameter.initializer) eachNode(parameter.initializer, visit);
  }
  return used;
};

/**
 * Dynamic module loads in a body, as `{name, line}`.
 *
 * Its own rule because the allowlist cannot see it: `import` is a keyword, not a
 * free name, and the binding it produces is a local. Refused for anything at all
 * rather than only for a Prisma module -- a body that loads a module at runtime
 * can load one that reaches a client, and there is no reason to load a module
 * inside a transaction with a five-second statement ceiling.
 */
const dynamicLoads = (tree, work) => {
  const found = [];
  eachNode(work.body ?? work, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (callee.kind === ts.SyntaxKind.ImportKeyword) {
      found.push({ name: "import", line: lineOf(tree, node) });
    }
    if (ts.isIdentifier(callee) && callee.text === "require") {
      found.push({ name: "require", line: lineOf(tree, node) });
    }
  });
  return found;
};

/** The names a calling file imports from modules that cannot reach a client. */
const clientFreeImports = (path, tree) => {
  const allowed = new Set();
  for (const entry of imports(tree)) {
    if (entry.typeOnly) {
      for (const local of entry.locals) allowed.add(local);
      continue;
    }
    if (entry.prisma) continue;
    if (!isFirstParty(entry.specifier)) {
      // A third-party module cannot be handed this repository's client, and the
      // wrapper's own module is where the wrapper comes from.
      for (const local of entry.locals) allowed.add(local);
      continue;
    }
    const target = resolveSpecifier(path, entry.specifier);
    if (!target) continue;
    if (clientReach(target)) continue;
    for (const local of entry.locals) allowed.add(local);
  }
  return allowed;
};

test("the work is an inline function, not a name", () => {
  for (const site of callSites()) {
    assert.ok(
      site.work && (ts.isArrowFunction(site.work) || ts.isFunctionExpression(site.work)),
      `${site.file}:${site.line}: the work passed to ${WRAPPER} must be written inline. A function passed by name keeps its body somewhere these checks do not read, and its body is what has to be unable to reach another client.`,
    );
  }
});

test("a bounded transaction's body uses only names that cannot be a client", () => {
  // Collected rather than failed on the first, so an author fixing this sees
  // every name at once instead of one per run.
  const problems = [];
  for (const site of callSites()) {
    const work = site.work;
    if (!work || !(ts.isArrowFunction(work) || ts.isFunctionExpression(work))) continue;
    const allowed = clientFreeImports(site.path, site.tree);
    for (const use of freeNames(site.tree, work)) {
      if (SAFE_GLOBALS.has(use.name) || allowed.has(use.name)) continue;
      problems.push(
        `${site.file}:${use.line}: "${use.name}" is not a name the work passed to ${WRAPPER} may use. Allowed: the callback's own parameters and locals, a standard global, or an import from a module that cannot obtain a Prisma client. Anything else may be a client on another connection, where this transaction's timeouts and statement budget do not apply and whose writes can commit after it rolls back.`,
      );
    }
  }
  assert.deepEqual(problems, []);
});

test("a bounded transaction's body loads no module at runtime", () => {
  const problems = [];
  for (const site of callSites()) {
    const work = site.work;
    if (!work || !(ts.isArrowFunction(work) || ts.isFunctionExpression(work))) continue;
    for (const load of dynamicLoads(site.tree, work)) {
      problems.push(
        `${site.file}:${load.line}: the work passed to ${WRAPPER} uses ${load.name}() to load a module at runtime. A module loaded here can hand back a client on another connection, and the allowlist cannot see it -- the binding it produces is an ordinary local. Import what the body needs at the top of the file, from a module that cannot obtain a client.`,
      );
    }
  }
  assert.deepEqual(problems, []);
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

/* -------------------------------------------------------------------------- */
/* The rules above are dormant until S2d2 writes the first caller, so what     */
/* follows proves each one refuses, and that the intended shape is accepted.   */
/* -------------------------------------------------------------------------- */

test("the specifier pattern matches every form this repository uses", () => {
  // `../lib/prisma.ts` is used by 22 files and the previous pattern matched none
  // of them, so those files bound no client as far as the check could tell.
  for (const specifier of ["@/lib/prisma", "@prisma/client", "../lib/prisma.ts", "./lib/prisma", "~/lib/prisma.js"]) {
    assert.equal(isPrismaModule(specifier), true, specifier);
  }
  for (const specifier of ["@auth/prisma-adapter", "@/lib/marketingStore", "@/lib/prismaHelpers"]) {
    assert.equal(isPrismaModule(specifier), false, specifier);
  }
});

test("a module that imports the client transitively is not client-free", () => {
  // The real tree answers this: lib/marketingStore.ts imports the client, and
  // anything importing it is therefore able to reach one.
  const store = join(ROOT, "lib", "marketingStore.ts");
  assert.ok(existsSync(store));
  assert.match(String(clientReach(store)), /Prisma client/);
  // And a module that holds no client and imports none stays client-free.
  const core = join(ROOT, "lib", "marketingPublisherRunCore.ts");
  assert.equal(clientReach(core), null);
});

const probeSite = (source) => {
  const tree = parse(join(ROOT, "lib", "probe.ts"), source);
  const wrapperNames = new Set();
  const namespaces = new Set();
  for (const entry of imports(tree)) {
    if (/marketingPublisherRun$/.test(entry.specifier)) {
      for (const local of entry.locals) namespaces.add(local);
    }
  }
  eachNode(tree, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) return;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === WRAPPER) wrapperNames.add(element.name.text);
    }
  });
  let work = null;
  eachNode(tree, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const isNamed = ts.isIdentifier(callee) && wrapperNames.has(callee.text);
    const isNamespaced =
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === WRAPPER &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text);
    if (isNamed || isNamespaced) work = unwrap(node.arguments[1]);
  });
  const path = join(ROOT, "lib", "probe.ts");
  const allowed = clientFreeImports(path, tree);
  const usable = work && (ts.isArrowFunction(work) || ts.isFunctionExpression(work));
  const offending = usable
    ? [
        ...freeNames(tree, work).filter(
          (use) => !SAFE_GLOBALS.has(use.name) && !allowed.has(use.name),
        ),
        ...dynamicLoads(tree, work),
      ]
    : [];
  return { tree, work, allowed, offending: offending.map((use) => use.name) };
};

const HEAD =
  'import { runBoundedMarketingTransaction } from "@/lib/marketingPublisherRun";\n' +
  'import { prisma } from "@/lib/prisma";\n';

test("the shapes review found are each refused", () => {
  // Every one of these is valid TypeScript that the denylist versions accepted.
  const cases = [
    ["the imported client", HEAD + "export const a = () => runBoundedMarketingTransaction(prisma, async (tx) => { await prisma.x.y(); return tx; });\n", ["prisma"]],
    ["a module-scope copy", HEAD + "const box = { db: prisma };\nexport const a = () => runBoundedMarketingTransaction(box.db, async (tx) => { await box.db.x.y(); return tx; });\n", ["box"]],
    ["a client on this", HEAD + "export class A { db = prisma; a() { return runBoundedMarketingTransaction(this.db, async (tx) => { await this.db.x.y(); return tx; }); } }\n", ["this"]],
    ["a default parameter", HEAD + "export const a = () => runBoundedMarketingTransaction(prisma, async (tx, db = prisma) => { await db.x.y(); return tx; });\n", ["prisma"]],
    ["globalThis", HEAD + "export const a = () => runBoundedMarketingTransaction(prisma, async (tx) => { await globalThis.db.x.y(); return tx; });\n", ["globalThis"]],
    ["an outside helper", HEAD + "const helper = async () => prisma.x.y();\nexport const a = () => runBoundedMarketingTransaction(prisma, async (tx) => { await helper(); return tx; });\n", ["helper"]],
    ["a dynamic import", HEAD + 'export const a = () => runBoundedMarketingTransaction(prisma, async (tx) => { const m = await import("@/lib/prisma"); await m.prisma.x.y(); return tx; });\n', ["import"]],
    ["a multi-level alias", HEAD + "const one = prisma;\nconst two = one;\nexport const a = () => runBoundedMarketingTransaction(prisma, async (tx) => { await two.x.y(); return tx; });\n", ["two"]],
  ];
  for (const [what, source, expected] of cases) {
    const { offending } = probeSite(source);
    for (const name of expected) {
      assert.ok(
        offending.includes(name),
        `${what}: expected "${name}" to be refused, got ${JSON.stringify(offending)}`,
      );
    }
  }
});

test("a namespace-called wrapper is still a call site", () => {
  const { work, offending } = probeSite(
    'import * as run from "@/lib/marketingPublisherRun";\n' +
      'import { prisma } from "@/lib/prisma";\n' +
      "export const a = () => run.runBoundedMarketingTransaction(prisma, async (tx) => { await prisma.x.y(); return tx; });\n",
  );
  assert.ok(work && ts.isArrowFunction(work), "the call must be found");
  assert.ok(offending.includes("prisma"));
});

test("an aliased import is still a call site", () => {
  const { work, offending } = probeSite(
    'import { runBoundedMarketingTransaction as bounded } from "@/lib/marketingPublisherRun";\n' +
      'import { prisma as db } from "@/lib/prisma";\n' +
      "export const a = () => bounded(db, async (tx) => { await db.x.y(); return tx; });\n",
  );
  assert.ok(work && ts.isArrowFunction(work));
  assert.ok(offending.includes("db"));
});

test("work passed by name is refused", () => {
  const { work } = probeSite(
    HEAD + "export const a = () => runBoundedMarketingTransaction(prisma, publishBatch);\n",
  );
  assert.equal(work && ts.isArrowFunction(work), false);
});

test("the intended shape is accepted", () => {
  // A route that holds the client, one line of callback forwarding `tx` into a
  // module that cannot hold one. `marketingPublisherRunCore` is client-free, as
  // the transitive test above establishes against the real tree.
  const { offending } = probeSite(
    HEAD +
      'import { marketingPublisherHasRoomForBatch } from "@/lib/marketingPublisherRunCore";\n' +
      "export const a = () =>\n" +
      "  runBoundedMarketingTransaction(prisma, async (tx) => {\n" +
      '    const text = "a ) and a } inside a string";\n' +
      "    // a ) in a comment\n" +
      "    if (!marketingPublisherHasRoomForBatch(0, 0)) return null;\n" +
      "    const rows = await tx.marketingPost.findMany({ where: { id: text } });\n" +
      "    return JSON.stringify({ count: rows.length, at: Date.now() });\n" +
      "  });\n",
  );
  assert.deepEqual(offending, []);
});

test("an import from a module that can reach a client is refused", () => {
  // `marketingStore` imports the client, so a helper from it is a way to reach
  // one even though the body never names the client.
  const { offending } = probeSite(
    HEAD +
      'import { runMarketingTransaction } from "@/lib/marketingStore";\n' +
      "export const a = () => runBoundedMarketingTransaction(prisma, async (tx) => { await runMarketingTransaction(); return tx; });\n",
  );
  assert.ok(offending.includes("runMarketingTransaction"));
});

test("no module re-exports a Prisma client under another name", () => {
  // Not needed for soundness any more -- the transitive walk answers for a
  // laundering module -- but a module whose job is to hand out the client under
  // a new name makes every import of it client-reaching, which is a surprise
  // worth refusing at the source.
  const offenders = [];
  for (const path of sourceFiles()) {
    const file = repoPath(path);
    if (file === "lib/prisma.ts" || !file.startsWith("lib/")) continue;
    const source = readFileSync(path, "utf8");
    if (!source.includes("prisma")) continue;
    const tree = parse(path, source);
    const clients = new Set();
    for (const entry of imports(tree)) {
      if (entry.typeOnly) continue;
      for (const local of entry.clientLocals) clients.add(local);
    }
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
  assert.deepEqual(offenders, []);
});
