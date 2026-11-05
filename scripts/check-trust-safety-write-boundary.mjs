#!/usr/bin/env node
// The §5.6 static check (docs/policy/trust-safety-compliance-agent.md).
//
// §5.6 says the write boundary is checked from the route inward, over the
// agent's own files -- everything an entry point reaches without passing one
// of the six approved shared modules -- and it names what each entry point may
// do. This is that check.
//
// **It parses rather than greps.** The rules are about syntax: a type-only
// import edge is not followed, a computed property access fails whatever it
// spells, and a class body's own `constructor` is the one exemption in a ban
// on that name. A regular expression over the text gets each of those wrong in
// a different direction, and the section's own history is five review rounds
// of exactly that. So the files are parsed with the TypeScript compiler's
// parser and the rules are asked of the tree.
//
// **The three entry points are files, and the second one needs saying.** E1
// and E3 are routes. E2 is "the section" -- its server component and the read
// behind it -- not the page that hosts it: the common Agent digest area is not
// this team's to own (§9), and walking from the page would pull every other
// agent's panel into this agent's files and refuse a correct implementation.
//
// Run it with `node scripts/check-trust-safety-write-boundary.mjs`. It prints
// one line per failure, with the file and the rule, and exits non-zero.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve as resolvePath } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = resolvePath(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

/** The six boundary modules (ㄴ). The walk stops at these. */
export const BOUNDARY_MODULES = new Set([
  "@/lib/prisma",
  "@/lib/adminAudit",
  "@/lib/auth",
  "next-auth/next",
  "@/lib/adminAuth",
  "@/lib/adminReauthentication",
]);

/** (ㄴ'): the eight outside specifiers, and the shape each is allowed in. */
export const ALLOWED_SPECIFIERS = new Map([
  ["server-only", { shape: "side-effect" }],
  ["@prisma/client", { shape: "type-only" }],
  ["next-auth/next", { shape: "named", names: ["getServerSession"] }],
  ["zod", { shape: "any" }],
  ["next-auth", { shape: "type-only" }],
  ["react", { shape: "any" }],
  ["next/link", { shape: "any" }],
  ["next/navigation", { shape: "any" }],
]);

/** (ㄱ-1): the built-in modules and the exports allowed from each. */
export const ALLOWED_BUILTINS = new Map([
  ["node:crypto", null],
  ["node:net", new Set(["isIP", "isIPv4", "isIPv6"])],
]);

/** (ㄱ-2): names that may not appear, with any receiver or none. */
export const BANNED_NAMES = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "sendBeacon",
  "getBuiltinModule",
  "Function",
  "eval",
  "constructor",
];

/** (ㄱ-2): reflection, banned in every use. */
export const BANNED_REFLECTION = ["Object", "Reflect", "Proxy", "WebAssembly", "__proto__"];

/** Global objects, allowed only as `process.env.<literal>`. */
export const BANNED_GLOBALS = ["globalThis", "global", "self", "window", "process"];

/**
 * The CommonJS loader names. §5.6 bans every appearance of these in these
 * files, in any form: the files are ESM, and a loader is how a built-in module
 * is reached without an import the check can see.
 */
export const BANNED_LOADER_NAMES = ["require", "module", "exports"];

/** Prisma delegate methods that write. */
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "executeRaw",
]);

/** The audit writers; calling one is a write wherever it happens. */
const AUDIT_WRITERS = new Set(["writeAdminAuditLog", "writeSystemAuditLog", "writeSystemAuditLogEntry"]);

/**
 * The three entry points and what each closure may do.
 *
 * `writes` is an allowlist keyed by file: anything not named here fails, which
 * is §5.6's reason for writing it this way round -- a ban list only ever holds
 * the shapes somebody has already been caught by.
 */
export const ENTRY_POINTS = [
  {
    id: "E1",
    files: ["app/api/internal/trust-safety/observe/route.ts"],
    allowed: {
      // The run row, as the one tagged `$queryRaw` §5.6 item 2 permits.
      taggedQueryRaw: { "lib/trustSafetyObserverRun.ts": 1, "lib/trustSafetyTransaction.ts": 2 },
      delegateWrites: {},
      auditAppends: {},
      // The dead-man ping, the one outgoing request (§5.6 item 4).
      fetchCalls: { "lib/trustSafetyObserverPing.ts": 1 },
    },
  },
  {
    id: "E2",
    files: ["components/admin/AdminTrustSafetyDigestPanel.tsx", "lib/trustSafetyDigestRead.ts"],
    // Zero writes: not a row, not an audit entry, not a request. The wrapper's
    // two setting statements are not a widening -- §5.6 item 3 counts the
    // statements that arm the timers and make the deadline separately from
    // writes, and allows them in the wrapper module, which the section's read
    // opens its bounded transactions through.
    allowed: { taggedQueryRaw: { "lib/trustSafetyTransaction.ts": 2 }, delegateWrites: {}, auditAppends: {}, fetchCalls: {} },
  },
  {
    id: "E3",
    files: ["app/api/admin/agents/trust-safety/activation/route.ts"],
    allowed: {
      taggedQueryRaw: { "lib/trustSafetyTransaction.ts": 2 },
      // The config row: one create, one update, one of which runs.
      delegateWrites: { "lib/trustSafetyActivationStore.ts": 2 },
      // And the audit append in the same transaction (§6).
      auditAppends: { "lib/trustSafetyActivationStore.ts": 1 },
      fetchCalls: {},
    },
  },
];

/**
 * The shape each allowed tagged statement must have, by file.
 *
 * §5.6 item 2 says the run row's exception is "the fixed statement shape", and
 * item 3 says the wrapper's setting statements are pinned by shape and number.
 * A count alone satisfies neither: these are the shapes.
 */
export const STATEMENT_SHAPES = {
  "lib/trustSafetyObserverRun.ts": [
    /INSERT INTO "TrustSafetyObserverRun" \("id", "outcome", "observedAt", "recordedAt", "deadlineAt"\)[\s\S]*RETURNING "id"/,
  ],
  "lib/trustSafetyTransaction.ts": [
    // The arming statement: the ops-observer function, read as a row.
    /SELECT "serverVersion", "priorTxTimeoutMs", "txStart", "ttArmedMs", "ttArmed" FROM ops_observer_arm_timeouts\(/,
    // The deadline: transaction-local, from the database clock, pinned format.
    /SELECT set_config\( \$\{\}, to_char\( clock_timestamp\(\) \+ make_interval\(secs => \$\{\}::double precision\), 'YYYY-MM-DD"T"HH24:MI:SS\.MSOF'\), true\) AS armed/,
  ],
};

/**
 * `lib/adminAudit.ts` is a boundary module, and §5.6 item 1 reads its own body
 * for one purpose: counting the statements the shared append sends, so a
 * change there fails this check before it changes what this agent is charged.
 */
export const AUDIT_WRITER_STATEMENTS = { executeRaw: 2, taggedQueryRaw: 1 };

const read = (file) => readFileSync(join(ROOT, file), "utf8");

const parse = (file, source) =>
  ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** `@/lib/x` and `./x` to a repository path, or null when it is outside. */
const toRepoPath = (specifier, fromFile, exists) => {
  let base = null;
  if (specifier.startsWith("@/")) base = specifier.slice(2);
  else if (specifier.startsWith(".")) base = relative(ROOT, resolvePath(dirname(join(ROOT, fromFile)), specifier)).split("\\").join("/");
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (exists(candidate)) return candidate;
  }
  return base;
};

const isTypeOnlyImport = (node) =>
  Boolean(node.importClause?.isTypeOnly) ||
  (Boolean(node.importClause?.namedBindings) &&
    ts.isNamedImports(node.importClause.namedBindings) &&
    node.importClause.namedBindings.elements.length > 0 &&
    node.importClause.namedBindings.elements.every((element) => element.isTypeOnly));

const namedImportNames = (node) => {
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return [];
  return bindings.elements.map((element) => element.propertyName?.text ?? element.name.text);
};

/**
 * Analyse one file: the rules that are about its own text, and the edges to
 * follow. Returns `{ failures, edges, counts }`.
 */
export const analyseFile = ({ file, source, exists }) => {
  const failures = [];
  const edges = [];
  const counts = { taggedQueryRaw: 0, delegateWrites: 0, auditAppends: 0, fetchCalls: 0 };
  const valuePackages = new Set();
  const fail = (rule, detail) => failures.push({ file, rule, detail });
  const sourceFile = parse(file, source);

  /**
   * Judge one name that was written as a string rather than an identifier.
   *
   * The banned-name rules are about names, not about the syntax that spells
   * them: a key in brackets or in a destructuring pattern is the same name as
   * a property access, and §5.6 says to judge it as one once it reduces.
   */
  const judgeName = (name, rule) => {
    if (BANNED_NAMES.includes(name) || BANNED_REFLECTION.includes(name) || BANNED_GLOBALS.includes(name)) {
      fail(rule, name);
    }
  };

  /**
   * Judge one module edge and record it.
   *
   * Imports and value re-exports are the same edge -- both load the file at
   * runtime -- so both come through here, which is how the rules stay one set
   * rather than two that drift.
   */
  const judgeSpecifier = ({ specifier, typeOnly, namespace, defaultImport, names }) => {
      if (specifier.startsWith("node:") || ALLOWED_BUILTINS.has(`node:${specifier}`)) {
        const normalised = specifier.startsWith("node:") ? specifier.split("/")[0] : `node:${specifier}`;
        if (!ALLOWED_BUILTINS.has(normalised)) {
          fail("builtin-not-allowed", specifier);
        } else {
          if (namespace || defaultImport) fail("builtin-namespace-import", specifier);
          const allowedExports = ALLOWED_BUILTINS.get(normalised);
          if (allowedExports) {
            for (const name of names) {
              if (!allowedExports.has(name)) fail("builtin-export-not-allowed", `${specifier}:${name}`);
            }
          }
        }
      } else {
        const repoPath = toRepoPath(specifier, file, exists);
        if (repoPath === null) {
          const allowed = ALLOWED_SPECIFIERS.get(specifier);
          if (!allowed) {
            fail("specifier-not-allowed", specifier);
          } else if (allowed.shape === "type-only" && !typeOnly) {
            fail("specifier-must-be-type-only", specifier);
          } else if (allowed.shape === "named") {
            for (const name of names) {
              if (!allowed.names.includes(name)) fail("specifier-export-not-allowed", `${specifier}:${name}`);
            }
            if (namespace || defaultImport) fail("specifier-namespace-import", specifier);
          }
          // (ㄷ) walks into a package the closure loads at runtime. A type-only
          // import is erased, so its package is never loaded and never walked.
          //
          // A boundary module is not walked even when it is also an outside
          // specifier, and `next-auth/next` is exactly that -- it is in both
          // lists so the specifier check passes while the walk still stops.
          // §5.6: what a boundary module uses is not judged here, and the
          // first run of this check reported `fetch` and `sendBeacon` in
          // next-auth's own logger, which is the case that sentence is about.
          if (allowed && !typeOnly && !BOUNDARY_MODULES.has(specifier)) {
            valuePackages.add(specifier);
          }
        } else if (BOUNDARY_MODULES.has(specifier)) {
          // The walk stops here, which is what "boundary" means.
        } else if (!typeOnly) {
          edges.push(repoPath);
        }
      }
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      judgeSpecifier({
        specifier: node.moduleSpecifier.text,
        typeOnly: isTypeOnlyImport(node),
        namespace: Boolean(
          node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings),
        ),
        defaultImport: Boolean(node.importClause?.name),
        names: namedImportNames(node),
      });
    }

    // A value re-export is an edge too, and missing it was the second hole
    // independent review found: `export { send } from "./egress"` runs that
    // file without ever importing it, so its requests and writes were
    // outside this check. `export type { ... } from` is erased, like a type
    // import, and is not followed.
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const typeOnly = Boolean(node.isTypeOnly) ||
        (Boolean(node.exportClause) && ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((element) => element.isTypeOnly));
      const names = node.exportClause && ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text)
        : [];
      // `export *` and `export * as x` carry no names, and passing them as a
      // named re-export let `export * from "node:net"` through with an empty
      // list -- a module whose allowlist is three string tests. Independent
      // review found it. They are namespace forms, and the rules already
      // refuse those: which export is used cannot be seen.
      const starExport = !node.exportClause || ts.isNamespaceExport(node.exportClause);
      judgeSpecifier({ specifier, typeOnly, namespace: starExport, defaultImport: false, names });
    }

    // A dynamic import or a `require` is an edge this check cannot follow.
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) fail("dynamic-import", "");
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") fail("require", "");
    }

    // --- (ㄱ-2) names --------------------------------------------------
    if (ts.isIdentifier(node)) {
      const name = node.text;
      const parent = node.parent;
      const isPropertyName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      const isDeclarationName =
        (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) &&
        parent.name === node;
      const isImportBinding = ts.isImportSpecifier(parent) || ts.isImportClause(parent);

      if (BANNED_REFLECTION.includes(name) && !isDeclarationName) {
        fail("reflection-name", name);
      }
      if (BANNED_NAMES.includes(name) && !isDeclarationName && !isImportBinding) {
        // A class body's own constructor declaration is the one exemption.
        const isClassConstructor =
          name === "constructor" && ts.isConstructorDeclaration(parent);
        if (!isClassConstructor) {
          if (name === "fetch" && ts.isCallExpression(parent) && parent.expression === node) {
            counts.fetchCalls += 1;
          } else {
            fail("banned-name", name);
          }
        }
      }
      if (BANNED_GLOBALS.includes(name) && !isPropertyName && !isDeclarationName) {
        // `process.env.<literal>` and nothing else.
        const envAccess =
          name === "process" &&
          ts.isPropertyAccessExpression(parent) &&
          parent.name.text === "env" &&
          ts.isPropertyAccessExpression(parent.parent) &&
          ts.isIdentifier(parent.parent.name);
        if (!envAccess) fail("global-object", name);
      }
      // §5.6 bans `require`, `require.resolve`, `module` and `exports` in
      // these files in **every** appearance, and the check only refused a
      // direct `require(...)` call: `const load = require; load("node:net")`
      // and `module.require("node:net")` were neither an import edge nor a
      // banned call. Independent review found both.
      if (BANNED_LOADER_NAMES.includes(name) && !isDeclarationName) {
        fail("loader-name", name);
      }
    }

    // --- computed access ----------------------------------------------
    if (ts.isElementAccessExpression(node)) {
      const argument = node.argumentExpression;
      const literal =
        ts.isStringLiteral(argument) || ts.isNumericLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument);
      if (!literal) {
        fail("computed-access", argument.getText(sourceFile).slice(0, 40));
      } else if (ts.isNumericLiteral(argument)) {
        // An index, not a name.
      } else {
        // §5.6: a key that reduces to a literal is judged **by that name**,
        // and allowing it without judging was the hole independent review
        // found -- `(() => {})["constructor"]("return globalThis.fetch")()`
        // reaches `Function` without naming it anywhere this check looked.
        judgeName(argument.text, "bracket-name");
      }
    }
    if (ts.isBindingElement(node) && node.propertyName) {
      if (ts.isComputedPropertyName(node.propertyName)) {
        fail("computed-binding", node.propertyName.getText(sourceFile).slice(0, 40));
      } else if (ts.isStringLiteral(node.propertyName)) {
        // The same rule for the destructuring form: `const { "constructor": f }`.
        judgeName(node.propertyName.text, "binding-name");
      }
    }

    // --- writes and raw SQL -------------------------------------------
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag;
      const name = ts.isPropertyAccessExpression(tag) ? tag.name.text : null;
      const text = tag.getText(sourceFile);
      if (text.includes("$queryRawUnsafe") || text.includes("$executeRawUnsafe")) {
        fail("raw-unsafe", text.slice(-30));
      } else if (text.includes("$executeRaw")) {
        fail("raw-execute", text.slice(-30));
      } else if (text.includes("$queryRaw") || name === "$queryRaw") {
        counts.taggedQueryRaw += 1;
        // §5.6 fixes the **shape** as well as the number, and counting alone
        // does not: swapping the run row's INSERT for a DELETE on another
        // table, or the wrapper's `set_config` for a write, leaves the count
        // unchanged. Independent review found exactly that, so each allowed
        // statement has to match one of the shapes named for its file, and a
        // statement that matches none fails however few there are.
        // Substitutions are normalised to `${}`: the shape is the SQL and
        // where the parameters sit, not what the variables holding them are
        // called.
        const statement = node.template
          .getText(sourceFile)
          .replace(/\$\{[^}]*\}/g, "${}")
          .replace(/\s+/g, " ");
        const shapes = STATEMENT_SHAPES[file] ?? [];
        if (!shapes.some((shape) => shape.test(statement))) {
          fail("raw-shape", statement.slice(0, 60));
        }
        if (/\b(DELETE|DROP|TRUNCATE|ALTER|GRANT|CREATE|UPDATE)\b/i.test(statement)) {
          fail("raw-destructive", statement.slice(0, 60));
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (method === "$queryRawUnsafe" || method === "$executeRawUnsafe") fail("raw-unsafe", method);
        if (method === "$executeRaw") fail("raw-execute", method);
        // Any receiver, not just a delegate chain. Requiring the chain let a
        // delegate held in a variable write unseen -- `const requests =
        // prisma.privacyRequest; requests.deleteMany({})` -- which
        // independent review found, and a read-only entry point deleting rows
        // is the case §5.6's zero allowance exists for.
        //
        // The one shape excluded is a digest's own `update`, which is not a
        // write and is why the first version of this rule looked at the
        // receiver at all. Anything else counts, so a false positive forces a
        // file into the allowlist rather than slipping past it.
        if (WRITE_METHODS.has(method)) {
          const receiver = callee.expression.getText(sourceFile);
          if (!/\b(createHash|createHmac)\s*\(/.test(receiver)) counts.delegateWrites += 1;
        }
      }
      if (ts.isIdentifier(callee) && AUDIT_WRITERS.has(callee.text)) counts.auditAppends += 1;
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return { failures, edges, counts, valuePackages: [...valuePackages] };
};

/** Walk one entry point's closure and judge it. */
const checkEntryPoint = (entry, { load, exists }) => {
  const failures = [];
  const seen = new Set();
  const totals = { taggedQueryRaw: {}, delegateWrites: {}, auditAppends: {}, fetchCalls: {} };
  const packages = new Set();
  const queue = [...entry.files];

  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try {
      source = load(file);
    } catch {
      failures.push({ entry: entry.id, file, rule: "unreadable", detail: "" });
      continue;
    }
    const result = analyseFile({ file, source, exists });
    for (const failure of result.failures) failures.push({ entry: entry.id, ...failure });
    for (const kind of Object.keys(totals)) {
      if (result.counts[kind] > 0) totals[kind][file] = result.counts[kind];
    }
    for (const edge of result.edges) queue.push(edge);
    for (const specifier of result.valuePackages) packages.add(specifier);
  }

  // The allowlist, compared as a whole: a file that writes and is not named
  // fails, and a named file that writes more than its number fails too.
  for (const kind of Object.keys(totals)) {
    const allowed = entry.allowed[kind] ?? {};
    for (const [file, count] of Object.entries(totals[kind])) {
      const permitted = allowed[file] ?? 0;
      if (count > permitted) {
        failures.push({
          entry: entry.id,
          file,
          rule: `${kind}-not-allowed`,
          detail: `${count} where ${permitted} are allowed`,
        });
      }
    }
  }

  return { failures, files: [...seen].sort(), packages: [...packages].sort() };
};

/**
 * (ㄷ): walk into the packages the closure imports as values, for egress only.
 *
 * (ㄴ') alone leaves a path where an allowed package reaches the network with
 * an API (ㄱ) does not name, so the section walks in -- but applies only the
 * egress rules, not the whole of (ㄱ). The walk follows relative edges from
 * the package's entry rather than reading the whole package: a package ships
 * code for runtimes nobody here loads, and judging files that are never
 * reached would refuse a package for something that cannot run.
 *
 * Text, not a parse. These are built files, and over-matching costs a review
 * while under-matching costs the rule. A budget bounds the walk and
 * **exhausting it fails**: a package too large to judge is not a package this
 * check can clear.
 */
const PACKAGE_FILE_BUDGET = 1_500;

const EGRESS_NAMES = ["XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "getBuiltinModule"];
const EGRESS_MODULES = ["node:net", "node:tls", "node:dgram", "node:dns", "node:http", "node:https", "node:http2", "node:child_process", "node:worker_threads", "node:cluster", "node:module", "node:vm"];

const checkPackages = (specifiers) => {
  const failures = [];
  for (const specifier of specifiers) {
    if (specifier === "server-only") continue;
    let entryFile;
    try {
      entryFile = require.resolve(specifier);
    } catch {
      failures.push({ entry: "package", file: specifier, rule: "package-unresolved", detail: "" });
      continue;
    }
    const seen = new Set();
    const queue = [entryFile];
    while (queue.length > 0) {
      if (seen.size > PACKAGE_FILE_BUDGET) {
        failures.push({
          entry: "package",
          file: specifier,
          rule: "package-scan-budget",
          detail: `more than ${PACKAGE_FILE_BUDGET} files reachable from its entry`,
        });
        break;
      }
      const file = queue.shift();
      if (seen.has(file)) continue;
      seen.add(file);
      let source;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const name of EGRESS_NAMES) {
        if (new RegExp(`\\b${name}\\b`).test(source)) {
          failures.push({ entry: "package", file: `${specifier} -> ${relative(ROOT, file)}`, rule: "package-egress-name", detail: name });
        }
      }
      if (/\bfetch\s*\(/.test(source)) {
        failures.push({ entry: "package", file: `${specifier} -> ${relative(ROOT, file)}`, rule: "package-egress-name", detail: "fetch" });
      }
      for (const builtin of EGRESS_MODULES) {
        const bare = builtin.slice("node:".length);
        if (new RegExp(`require\\(["'](?:node:)?${bare}["']\\)|from\\s+["'](?:node:)?${bare}["']`).test(source)) {
          failures.push({ entry: "package", file: `${specifier} -> ${relative(ROOT, file)}`, rule: "package-builtin", detail: builtin });
        }
      }
      // A loader call whose argument does not reduce to a string literal is a
      // failure, not an edge to skip. §5.6 is fail-closed about this, and
      // independent review named the forms that get past a path-based walk:
      // `require.call(module, "node:net")`, `const load = require; load(...)`.
      // Neither is an edge this walk can follow, so the package is refused
      // rather than cleared.
      for (const loader of source.matchAll(/\brequire(?:\.(\w+))?\s*\(([^)]{0,80})/g)) {
        const [, member, argument] = loader;
        // The captured window stops at the closing paren, so the literal may
        // end the window as well as be followed by one.
        const literalFirst = /^\s*["'][^"']+["']\s*(?:[),]|$)/.test(argument);
        if (member && member !== "resolve") {
          failures.push({
            entry: "package",
            file: `${specifier} -> ${relative(ROOT, file)}`,
            rule: "package-loader-indirect",
            detail: `require.${member}`,
          });
        } else if (!literalFirst) {
          failures.push({
            entry: "package",
            file: `${specifier} -> ${relative(ROOT, file)}`,
            rule: "package-loader-unreducible",
            detail: argument.trim().slice(0, 40),
          });
        }
      }
      if (/(?:^|[^.\w])require\s*[;,)=]/.test(source)) {
        failures.push({
          entry: "package",
          file: `${specifier} -> ${relative(ROOT, file)}`,
          rule: "package-loader-aliased",
          detail: "require used as a value",
        });
      }

      // Edges: relative paths, and the packages this one depends on -- a
      // dependency is how an allowed package reaches code the walk would
      // otherwise never see.
      for (const match of source.matchAll(/(?:require\(|from\s*)["']([^"']+)["']/g)) {
        const target = match[1];
        if (target.startsWith("node:")) continue;
        const candidates = target.startsWith(".")
          ? [resolvePath(dirname(file), target)]
          : [];
        if (candidates.length === 0) {
          // A bare specifier: resolve it from this file's directory, so the
          // walk crosses into the dependency rather than stopping at it.
          try {
            queue.push(createRequire(file).resolve(target));
          } catch {
            // A dependency that does not resolve from here cannot be loaded
            // from here either.
          }
          continue;
        }
        for (const base of candidates) {
          for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, join(base, "index.js")]) {
            try {
              readFileSync(candidate, "utf8");
              queue.push(candidate);
              break;
            } catch {
              // Not that spelling; try the next.
            }
          }
        }
      }
    }
  }
  return failures;
};

/** The shared audit writer's own statement count (§5.6 item 1). */
const checkAuditWriter = ({ load }) => {
  const failures = [];
  const source = load("lib/adminAudit.ts");
  const executeRaw = (source.match(/\$executeRaw/g) ?? []).length;
  const queryRaw = (source.match(/\$queryRaw/g) ?? []).length;
  if (executeRaw !== AUDIT_WRITER_STATEMENTS.executeRaw) {
    failures.push({
      entry: "boundary",
      file: "lib/adminAudit.ts",
      rule: "audit-writer-statements",
      detail: `${executeRaw} advisory-lock statements where ${AUDIT_WRITER_STATEMENTS.executeRaw} are pinned`,
    });
  }
  if (queryRaw !== AUDIT_WRITER_STATEMENTS.taggedQueryRaw) {
    failures.push({
      entry: "boundary",
      file: "lib/adminAudit.ts",
      rule: "audit-writer-statements",
      detail: `${queryRaw} tagged statements where ${AUDIT_WRITER_STATEMENTS.taggedQueryRaw} is pinned`,
    });
  }
  return failures;
};

/**
 * Run the whole check.
 *
 * `load` and `exists` are injectable so a test can overlay one changed file
 * and prove a rule fires; by default they read the repository.
 */
export const checkTrustSafetyWriteBoundary = ({
  load = read,
  exists = (file) => {
    try {
      read(file);
      return true;
    } catch {
      return false;
    }
  },
} = {}) => {
  const failures = [];
  const closure = {};
  const valuePackages = new Set();
  for (const entry of ENTRY_POINTS) {
    const result = checkEntryPoint(entry, { load, exists });
    failures.push(...result.failures);
    closure[entry.id] = result.files;
    for (const specifier of result.packages) valuePackages.add(specifier);
  }
  failures.push(...checkAuditWriter({ load }));
  failures.push(...checkPackages([...valuePackages].sort()));
  return { failures, closure, packages: [...valuePackages].sort() };
};

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-trust-safety-write-boundary.mjs")) {
  const { failures, closure } = checkTrustSafetyWriteBoundary();
  for (const [entry, files] of Object.entries(closure)) {
    console.log(`${entry}: ${files.length} own files`);
  }
  if (failures.length > 0) {
    console.error("\nTrust-safety write boundary check failed (docs/policy/trust-safety-compliance-agent.md §5.6):\n");
    for (const failure of failures) {
      console.error(`  ${failure.entry} ${failure.file}  ${failure.rule}${failure.detail ? ` ${failure.detail}` : ""}`);
    }
    process.exit(1);
  }
  console.log("trust_safety_write_boundary=pass");
}
