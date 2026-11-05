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
import { builtinModules, createRequire } from "node:module";
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
  // Prisma 7's returning variants.  was missing and
  // independent review named it: a real write that nothing counted.
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
  "executeRaw",
]);

/**
 * The raw-SQL methods. The tagged `$queryRaw` is allowed only as the tag of a
 * tagged template, in a file the allowlist names; the other three are never
 * allowed anywhere.
 *
 * Naming `$queryRaw` in any other position is refused rather than counted,
 * because a tag taken out of its call site is not a statement this check can
 * read the shape of: `const query = client.$queryRaw.bind(client)` followed
 * by a tagged `query` was past the count, the shape and the destructive-SQL
 * rules at once, which independent review found.
 */
const RAW_ALWAYS_REFUSED = new Set(["$executeRaw", "$executeRawUnsafe", "$queryRawUnsafe"]);
const RAW_TAG_ONLY = "$queryRaw";

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
      // The single config row, and the two operations that write it (§6: the
      // first write creates it, a transition updates it).
      delegateWrites: {
        "lib/trustSafetyActivationStore.ts": [
          "trustSafetyObserverConfig.create",
          "trustSafetyObserverConfig.update",
        ],
      },
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
    /^INSERT INTO "TrustSafetyObserverRun" \("id", "outcome", "observedAt", "recordedAt", "deadlineAt"\) VALUES \( \$\{\}, 'succeeded', \$\{\}::timestamptz, clock_timestamp\(\), clock_timestamp\(\)\) RETURNING "id"$/,
  ],
  "lib/trustSafetyTransaction.ts": [
    // The arming statement: the ops-observer function, read as a row.
    /^SELECT "serverVersion", "priorTxTimeoutMs", "txStart", "ttArmedMs", "ttArmed" FROM ops_observer_arm_timeouts\( \$\{\}::int, \$\{\}::int, \$\{\}::int, \$\{\}::int, \$\{\}::int, \$\{\}::timestamptz\)$/,
    // The deadline: transaction-local, from the database clock, pinned format.
    /^SELECT set_config\( \$\{\}, to_char\( clock_timestamp\(\) \+ make_interval\(secs => \$\{\}::double precision\), 'YYYY-MM-DD"T"HH24:MI:SS\.MSOF'\), true\) AS armed$/,
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
  const counts = { taggedQueryRaw: 0, delegateWrites: [], auditAppends: 0, fetchCalls: 0 };
  const valuePackages = new Set();
  const fail = (rule, detail) => failures.push({ file, rule, detail });
  const sourceFile = parse(file, source);

  /**
   * The audit writers' names in this file: the exported ones, plus whatever
   * local name an aliased import gave them.
   */
  const auditWriterNames = new Set(AUDIT_WRITERS);
  /**
   * The local names this file imported from `node:crypto` for a digest, which
   * is the only thing the write exclusion accepts.
   */
  const cryptoDigestNames = new Set();
  const collectAliases = (node) => {
    if (ts.isImportSpecifier(node)) {
      const imported = node.propertyName?.text ?? node.name.text;
      if (node.propertyName && AUDIT_WRITERS.has(node.propertyName.text)) {
        auditWriterNames.add(node.name.text);
      }
      const declaration = node.parent?.parent?.parent;
      const from =
        declaration && ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier)
          ? declaration.moduleSpecifier.text
          : null;
      if ((from === "node:crypto" || from === "crypto") && (imported === "createHash" || imported === "createHmac")) {
        cryptoDigestNames.add(node.name.text);
      }
    }
    ts.forEachChild(node, collectAliases);
  };
  ts.forEachChild(sourceFile, collectAliases);

  /**
   * The model a write is aimed at: the last property of the receiver, when the
   * receiver reduces to one.
   *
   * `client.trustSafetyObserverConfig.create(...)` gives
   * `trustSafetyObserverConfig`. Anything the check cannot reduce -- a
   * variable, a bracket, a destructured delegate -- gives `<unresolved>`,
   * which no allowlist entry names, so it fails.
   */
  const modelOf = (receiver) => {
    if (receiver === undefined) return "<unresolved>";
    if (ts.isPropertyAccessExpression(receiver)) return receiver.name.text;
    if (
      ts.isElementAccessExpression(receiver) &&
      (ts.isStringLiteral(receiver.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(receiver.argumentExpression))
    ) {
      return receiver.argumentExpression.text;
    }
    return "<unresolved>";
  };

  /**
   * Whether this receiver really is a digest, by walking it rather than
   * reading its text.
   *
   * The exclusion exists for `createHash("sha256").update(...)`, and a text
   * match on the receiver's span let `(client /* createHash( *\/).deleteMany()`
   * suppress the write count -- a parenthesised receiver's text includes its
   * comments, which independent review used. So the chain is walked and the
   * answer is whether a `createHash`/`createHmac` call is actually in it.
   */
  const isDigestReceiver = (receiver) => {
    for (let at = receiver; at !== undefined; ) {
      if (ts.isParenthesizedExpression(at)) {
        at = at.expression;
        continue;
      }
      if (ts.isCallExpression(at)) {
        const callee = at.expression;
        // The name has to be the one this file imported from `node:crypto`.
        // Any call named `createHash` counted before, so
        // `({ createHash: () => client.privacyRequest }).createHash("x")
        // .deleteMany({})` suppressed a real write -- independent review
        // found it. A plain identifier that the file imported is the only
        // form that excludes; a method call named `createHash` does not.
        if (ts.isIdentifier(callee) && cryptoDigestNames.has(callee.text)) return true;
        at = callee;
        continue;
      }
      if (ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at)) {
        at = at.expression;
        continue;
      }
      return false;
    }
    return false;
  };

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
          // The walk stops here, which is what "boundary" means -- but a
          // namespace or default import of one is refused for the same reason
          // (ㄱ-1) refuses one of a built-in: which export is used cannot be
          // seen, and `import * as audit` followed by
          // `audit["writeAdminAuditLog"](...)` was an audit write nothing
          // counted. Independent review found it.
          if (namespace || defaultImport) fail("boundary-namespace-import", specifier);
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

    // --- property names, however they are spelled ---------------------
    //
    // One judgement, reached from every syntax that names a property: a dot
    // access, a literal key in brackets, a destructuring key and a shorthand
    // destructuring binding. Five rounds of review each found one more
    // spelling of the same move -- `client.privacyRequest["deleteMany"]()`,
    // `const remove = …deleteMany`, `const { deleteMany } = …`,
    // `client["$executeRawUnsafe"](sql)`, a template-literal key -- so the
    // rule stopped being about calls and became about the name appearing.
    // Extracting a writing method counts as a write here, which is the
    // fail-closed direction and removes the class instead of its instances.
    //
    // The one exclusion is a digest's own `update`: the routes compare bearer
    // digests with `createHash("sha256").update(...)`, and that is not a write.
    const judgeProperty = (name, receiver, rule, accessNode) => {
      judgeName(name, rule);
      if (RAW_ALWAYS_REFUSED.has(name)) {
        fail(name === "$executeRaw" ? "raw-execute" : "raw-unsafe", name);
      }
      if (name === RAW_TAG_ONLY) {
        // Allowed only where it is the tag of a tagged template; the tagged
        // visitor then reads the statement's shape. Anywhere else -- bound,
        // destructured, passed on -- the shape is unreadable, so it is
        // refused rather than counted.
        const isTag =
          accessNode !== undefined &&
          accessNode.parent !== undefined &&
          ts.isTaggedTemplateExpression(accessNode.parent) &&
          accessNode.parent.tag === accessNode;
        if (!isTag) fail("raw-extracted", name);
      }
      if (WRITE_METHODS.has(name) && !isDigestReceiver(receiver)) {
        // **What** is written, not just how many times. Counting alone let
        // E3's two allowed config writes become `client.user.deleteMany(...)`
        // at the same count, which independent review found, and §5.6 allows
        // this closure one thing: the single config row. So the model is
        // resolved from the receiver and the pair is recorded; a receiver that
        // does not reduce to a model name records `<unresolved>`, which no
        // allowlist entry matches.
        counts.delegateWrites.push(`${modelOf(receiver)}.${name}`);
      }
    };

    if (ts.isPropertyAccessExpression(node)) {
      // The banned-name rules already judge a dot access through the
      // identifier visitor, so this one passes a rule it will not use.
      judgeProperty(node.name.text, node.expression, "property-name", node);
    }
    if (ts.isElementAccessExpression(node)) {
      const argument = node.argumentExpression;
      const literalName =
        ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)
          ? argument.text
          : null;
      if (literalName !== null) {
        judgeProperty(literalName, node.expression, "bracket-name", node);
      } else if (!ts.isNumericLiteral(argument)) {
        // Not reducible to a name: fail-closed, whatever it spells.
        fail("computed-access", argument.getText(sourceFile).slice(0, 40));
      }
    }
    if (ts.isBindingElement(node)) {
      // The object being destructured, for the digest exclusion.
      let receiver;
      for (let up = node.parent; up; up = up.parent) {
        if (ts.isVariableDeclaration(up) && up.initializer) {
          receiver = up.initializer;
          break;
        }
      }
      const key = node.propertyName ?? node.name;
      if (node.propertyName && ts.isComputedPropertyName(node.propertyName)) {
        fail("computed-binding", node.propertyName.getText(sourceFile).slice(0, 40));
      } else if (ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
        judgeProperty(key.text, receiver, "binding-name", node);
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
        // The template's own text carries its backticks; the shapes are
        // anchored to the whole statement, so they come off. Anchoring is the
        // point: a partial match let `WITH extra AS (INSERT INTO … RETURNING
        // …) SELECT …` keep the allowed shape as its tail and write a second
        // table in one valid statement, which independent review found.
        const statement = node.template
          .getText(sourceFile)
          .replace(/^`|`$/g, "")
          .replace(/\$\{[^}]*\}/g, "${}")
          .replace(/\s+/g, " ")
          .trim();
        const shapes = STATEMENT_SHAPES[file] ?? [];
        if (!shapes.some((shape) => shape.test(statement))) {
          fail("raw-shape", statement.slice(0, 60));
        }
        if (/\b(DELETE|DROP|TRUNCATE|ALTER|GRANT|CREATE|UPDATE)\b/i.test(statement)) {
          fail("raw-destructive", statement.slice(0, 60));
        }
      }
    }
    // The audit writers, counted the same way and for the same reason: by the
    // name appearing, with the import binding that brings it in excluded --
    // and under whatever local name it was imported as. `import {
    // writeAdminAuditLog as wal }` followed by `wal(...)` was an audit write
    // with a count of zero, which independent review called a blocker; it is
    // the same one-more-spelling class the property rules were unified to
    // close, so the local name is resolved to the imported one here.
    if (ts.isIdentifier(node) && auditWriterNames.has(node.text)) {
      const parent = node.parent;
      const isImportBinding = ts.isImportSpecifier(parent) || ts.isImportClause(parent);
      if (!isImportBinding) counts.auditAppends += 1;
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
      const value = result.counts[kind];
      if (Array.isArray(value) ? value.length > 0 : value > 0) totals[kind][file] = value;
    }
    for (const edge of result.edges) queue.push(edge);
    for (const specifier of result.valuePackages) packages.add(specifier);
  }

  // The allowlist, compared as a whole: a file that writes and is not named
  // fails, a named file that writes more than its number fails, and a named
  // file that writes something other than what it is named for fails too --
  // the delegate writes are compared as `model.operation` pairs, because a
  // count alone let the allowed pair be swapped for another table's delete.
  for (const kind of Object.keys(totals)) {
    const allowed = entry.allowed[kind] ?? {};
    for (const [file, observed] of Object.entries(totals[kind])) {
      const permitted = allowed[file] ?? (Array.isArray(observed) ? [] : 0);
      if (Array.isArray(observed)) {
        const remaining = [...(Array.isArray(permitted) ? permitted : [])];
        for (const pair of observed) {
          const at = remaining.indexOf(pair);
          if (at === -1) {
            failures.push({
              entry: entry.id,
              file,
              rule: `${kind}-not-allowed`,
              detail: `${pair} is not one of [${(Array.isArray(permitted) ? permitted : []).join(", ")}]`,
            });
          } else {
            remaining.splice(at, 1);
          }
        }
      } else if (observed > permitted) {
        failures.push({
          entry: entry.id,
          file,
          rule: `${kind}-not-allowed`,
          detail: `${observed} where ${permitted} are allowed`,
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

/**
 * Node's own module names, so a bare `require("net")` is judged as the
 * builtin it is rather than resolved as a dependency.
 */
const BUILTIN_MODULE_NAMES = new Set(builtinModules);

/**
 * (ㄱ-2)'s transmission names, judged over a walked package's text: these are
 * built files, and over-matching costs a review while under-matching costs
 * the rule.
 *
 * There is no list of forbidden modules beside this one any more. Which
 * built-in a package may reach is `ALLOWED_BUILTINS` -- the (ㄱ-1) allowlist,
 * applied in `judgeTarget` -- so a ban list would be a second answer to the
 * same question and the shorter of the two would quietly win.
 */
const EGRESS_NAMES = ["XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "getBuiltinModule"];

/**
 * One walked package file, judged (§5.6 (ㄷ)).
 *
 * (ㄷ) applies the egress rules to a package the closure loads, and it is
 * explicit about how: a **loader access** has to reduce statically to what it
 * loads. It reduces, that target is an edge; it does not, the package fails.
 * The five groups it names are implemented here by name and receiver, which
 * is the part a regular expression could not do -- independent review ran
 * `import("node:https").then((m) => m.get(url))` and
 * `process.mainModule["require"]("node:net").connect(...)` through the old
 * scan and both passed with nothing reported.
 *
 * The groups, as §5.6 names them (never by number: it says its own numbering
 * drifted from the list):
 *
 *   - receiver-independent names: `require`, `require.resolve`,
 *     `createRequire`, `getBuiltinModule`, `_load`;
 *   - names that are a loader access only on a `module` receiver: `require`,
 *     `constructor`, `parent`, `children`, `load`;
 *   - names that are a loader access only on a `process` receiver:
 *     `mainModule`, `binding`, `dlopen`;
 *   - any call one of whose **arguments** reduces to a loader value, whatever
 *     the receiver -- which is what catches
 *     `Function.prototype.call.call(require, null, "node:net")`;
 *   - `call`, `apply` and `bind` on a receiver that reduces to a loader value,
 *     in dot form or as a reducible string key, which §5.6 calls one place.
 *
 * A property name is read whether it is written as an identifier or as a
 * reducible string key. An unreducible key fails only under the receiver
 * condition the section gives -- `module`, `process`, `global`, `globalThis`
 * or a loader value -- because the wider rule would refuse `react`'s own
 * `config[propName]` and with it the panel E2 needs.
 */
const RECEIVER_FREE_LOADERS = new Set(["require", "createRequire", "getBuiltinModule", "_load"]);
const MODULE_RECEIVER_LOADERS = new Set(["require", "constructor", "parent", "children", "load"]);
const PROCESS_RECEIVER_LOADERS = new Set(["mainModule", "binding", "dlopen"]);
const LOADER_FORWARDERS = new Set(["call", "apply", "bind"]);
const UNREDUCIBLE_KEY_RECEIVERS = new Set(["module", "process", "global", "globalThis"]);

export const analysePackageFile = ({ specifier, file, source }) => {
  const failures = [];
  const edges = [];
  const where = `${specifier} -> ${relative(ROOT, file)}`;
  const fail = (rule, detail) => failures.push({ entry: "package", file: where, rule, detail });
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

  /** Local names that hold a loader value. */
  const loaderNames = new Set(["require"]);

  /** A string a key or specifier reduces to, or null. */
  const asString = (node) => {
    if (node === undefined) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node) && node.templateSpans.length === 0) return node.head.text;
    return null;
  };

  /** The property name a member read or binding key reduces to, or null. */
  const propertyName = (node) => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) return asString(node.argumentExpression);
    return null;
  };

  /** Whether this expression reduces to the named global or local. */
  const reducesTo = (node, name) => {
    if (node === undefined) return false;
    if (ts.isParenthesizedExpression(node)) return reducesTo(node.expression, name);
    if (ts.isIdentifier(node)) return node.text === name;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      // `globalThis.process` and `global.module` reduce to the same names.
      const key = propertyName(node);
      return key === name && (reducesTo(node.expression, "globalThis") || reducesTo(node.expression, "global"));
    }
    return false;
  };

  /** Whether this expression reduces to a loader value. */
  const isLoaderValue = (node) => {
    if (node === undefined) return false;
    if (ts.isParenthesizedExpression(node)) return isLoaderValue(node.expression);
    // `(0, require)("node:net")` and `c ? require : other` reduce to a loader
    // as surely as the name does, and neither was followed -- so the call was
    // judged as an ordinary one and its specifier never read. Independent
    // review found both. A conditional counts when **either** branch is a
    // loader: it may be one at runtime, which is the fail-closed reading.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return isLoaderValue(node.right);
    }
    if (ts.isConditionalExpression(node)) {
      return isLoaderValue(node.whenTrue) || isLoaderValue(node.whenFalse);
    }
    if (ts.isIdentifier(node)) return loaderNames.has(node.text);
    // What a loader call hands back is a loader too: `createRequire(...)`
    // returns one, and `require.bind(module)` returns one. Not following that
    // left `const load = require.bind(module); load("node:net")` untracked,
    // so the later call was not a loader call at all.
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const key = propertyName(callee) ?? (ts.isIdentifier(callee) ? callee.text : null);
      if (key === "createRequire") return true;
      if (key !== null && LOADER_FORWARDERS.has(key)) return isLoaderValue(callee.expression);
      return false;
    }
    const key = propertyName(node);
    if (key === null) return false;
    if (key === "resolve" && isLoaderValue(node.expression)) return true;
    if (RECEIVER_FREE_LOADERS.has(key)) return true;
    if (MODULE_RECEIVER_LOADERS.has(key) && reducesTo(node.expression, "module")) return true;
    if (PROCESS_RECEIVER_LOADERS.has(key) && reducesTo(node.expression, "process")) return true;
    if (LOADER_FORWARDERS.has(key) && isLoaderValue(node.expression)) return true;
    // A loader value reached through one of the module-receiver names, e.g.
    // `module.constructor._load` or `process.mainModule.require`.
    if (RECEIVER_FREE_LOADERS.has(key) && isLoaderValue(node.expression)) return true;
    return isLoaderValue(node.expression) && (MODULE_RECEIVER_LOADERS.has(key) || PROCESS_RECEIVER_LOADERS.has(key));
  };

  /**
   * Judge a call that a loader value takes part in -- as its callee or as any
   * argument.
   *
   * **The positional fold is gone, and three rounds of review are why.** It
   * tried to say which argument is the specifier after `call`, `apply` and
   * `bind` had been folded, and each round found one more shape where the
   * answer moved: the first reducible string read `Function.prototype.call
   * .call(require, "node:crypto", "node:net")` as the allowed module; judging
   * every reducible string let `require(target, "node:crypto")` hide an
   * unreducible specifier behind an irrelevant one; then
   * `Function.prototype.call.bind(require)("node:crypto", "node:net")` and a
   * loader-valued `thisArg` emptied the candidate list. Re-deriving
   * JavaScript's own folding here is the mistake, not any one of its versions.
   *
   * So the rule stops guessing which argument matters and judges the call:
   *
   *   - every argument that reduces to a string is judged as a specifier, so
   *     the real target is judged wherever in the call it sits;
   *   - if **any** argument does not reduce to a string, the call fails --
   *     §5.6's own answer for a loader whose target cannot be read.
   *
   * It refuses more than the fold did, and deliberately: a package that hands
   * a loader something this check cannot read is a package it cannot clear.
   *
   * **There is no exemption, and the one there was is why.** `createRequire`
   * was exempt because its argument is a base URL rather than a specifier --
   * true of the real function, not of the name. Independent review pointed
   * out that `const createRequire = require; createRequire("node:net")` then
   * skipped the specifier check entirely. Resolving the name to a real import
   * would close that, but it is unnecessary: a package that imports
   * `node:module` to get `createRequire` already fails, because (ㄱ-1) allows
   * no export of it. The exemption bought nothing a legitimate package needed
   * and cost a hole.
   */
  const judgeLoaderCall = (call, rule) => {
    // `new X()` carries no argument list at all when it is written without
    // parentheses, so the default keeps a `new require` from reading as a
    // call with no arguments and passing.
    for (const argument of call.arguments ?? []) {
      const text = asString(argument);
      if (text === null) {
        fail(rule, `${argument.getText(parsed).slice(0, 30)} does not reduce to a string`);
      } else {
        judgeTarget(text, rule);
      }
    }
  };

  /** Judge one resolved specifier: an allowed builtin, an edge, or a failure. */
  const judgeTarget = (target, rule) => {
    if (target === undefined) {
      fail(rule, "the specifier does not reduce to a string");
      return;
    }
    const normalised = target.startsWith("node:") ? target.split("/")[0] : `node:${target.split("/")[0]}`;
    if (ALLOWED_BUILTINS.has(normalised)) {
      // Allowed whole, or not: a loader call hides which export it takes, so
      // only a module that is allowed entirely can pass here.
      if (ALLOWED_BUILTINS.get(normalised) !== null) fail("package-builtin", normalised);
      return;
    }
    if (target.startsWith("node:") || BUILTIN_MODULE_NAMES.has(target.split("/")[0])) {
      fail("package-builtin", target);
      return;
    }
    const base = target.startsWith(".") ? resolvePath(dirname(file), target) : null;
    if (base === null) {
      try {
        edges.push(createRequire(file).resolve(target));
      } catch {
        // **A failure, not a dropped edge.** Code this check could not resolve
        // is code it did not judge, and passing on it means the boundary check
        // succeeded over a file it never read. §5.6 is the other way round --
        // a branch it cannot resolve or read is a failure -- and independent
        // review found all three places that swallowed one.
        fail("package-unresolved", target);
      }
      return;
    }
    for (const candidate of [
      base,
      `${base}.js`,
      `${base}.cjs`,
      `${base}.mjs`,
      join(base, "index.js"),
      join(base, "index.cjs"),
      join(base, "index.mjs"),
    ]) {
      try {
        readFileSync(candidate, "utf8");
        edges.push(candidate);
        return;
      } catch {
        // Not that spelling; try the next.
      }
    }
    // None of them: a relative target this check cannot find is a file it did
    // not judge.
    fail("package-unresolved", target);
  };

  // Local names that hold a loader value, collected before the walk so an
  // alias assigned above its use is still known.
  const collectLoaderNames = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      if (isLoaderValue(node.initializer)) loaderNames.add(node.name.text);
    }
    // An assignment, not only a declaration: `let r; r = require; r("node:net")`
    // left the alias untracked, so the call after it was judged as an ordinary
    // one. Independent review found it.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      isLoaderValue(node.right)
    ) {
      loaderNames.add(node.left.text);
    }
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const key = node.propertyName
        ? asString(node.propertyName) ?? (ts.isIdentifier(node.propertyName) ? node.propertyName.text : null)
        : node.name.text;
      if (key !== null && (RECEIVER_FREE_LOADERS.has(key) || LOADER_FORWARDERS.has(key))) {
        loaderNames.add(node.name.text);
      }
    }
    ts.forEachChild(node, collectLoaderNames);
  };
  // To a fixed point, not once in source order. An alias of an alias that is
  // assigned **later** in the file -- `let r; function run() { const load = r;
  // load("node:net"); } r = require;` -- was invisible, because `load` was
  // visited before `r` was known. Independent review found it. The set only
  // grows, so repeating until it stops terminates; the bound is there so a
  // pathological file cannot spin.
  for (let pass = 0; pass < 10; pass += 1) {
    const before = loaderNames.size;
    ts.forEachChild(parsed, collectLoaderNames);
    if (loaderNames.size === before) break;
  }

  const visit = (node) => {
    // A static import or re-export: an ordinary edge.
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const target = asString(node.moduleSpecifier);
      if (target !== null) judgeTarget(target, "package-loader-unreducible");
    }

    // A call or a `new`: evaluating `new require("node:https")` loads the
    // module just as a call does, and judging only calls let it past every
    // rule -- independent review found it.
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const args = node.arguments ?? [];
      // A dynamic import, which the old scan did not see at all.
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        judgeTarget(asString(args[0]) ?? undefined, "package-dynamic-import");
      } else if (isLoaderValue(node.expression)) {
        judgeLoaderCall(node, "package-loader-unreducible");
      } else if ([...args].some((argument) => isLoaderValue(argument))) {
        // The argument group: the loader is handed to something else, and the
        // specifier is still visible.
        judgeLoaderCall(node, "package-loader-forwarded");
      }
    }

    // An unreducible key, under the receiver condition §5.6 gives.
    if (ts.isElementAccessExpression(node) && asString(node.argumentExpression) === null) {
      const receiver = node.expression;
      const guarded =
        [...UNREDUCIBLE_KEY_RECEIVERS].some((name) => reducesTo(receiver, name)) || isLoaderValue(receiver);
      if (guarded) fail("package-loader-unreducible-key", node.argumentExpression.getText(parsed).slice(0, 40));
    }
    if (ts.isBindingElement(node) && node.propertyName && ts.isComputedPropertyName(node.propertyName)) {
      let receiver;
      for (let up = node.parent; up; up = up.parent) {
        if (ts.isVariableDeclaration(up) && up.initializer) {
          receiver = up.initializer;
          break;
        }
      }
      const guarded =
        [...UNREDUCIBLE_KEY_RECEIVERS].some((name) => reducesTo(receiver, name)) || isLoaderValue(receiver);
      if (guarded) fail("package-loader-unreducible-key", node.propertyName.getText(parsed).slice(0, 40));
    }

    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);

  return { failures, edges };
};

/**
 * Every file a package can be entered through, not the one `require.resolve`
 * picks.
 *
 * A package's `exports` map has a branch per condition -- `require`, `import`,
 * `react-server`, `browser`, `default` -- and resolving once judges one of
 * them. Independent review named the consequence: a package whose `require`
 * branch is clean and whose `import` or `react-server` branch calls `fetch`
 * passed. (ㄷ) is about what the closure loads, and which branch that is
 * depends on how the file importing it was itself loaded, so all of them are
 * walked.
 *
 * `main`, `module` and `browser` are read for the same reason, and so are the
 * subpath entries: every string in the map is an entry somebody can reach.
 * A package.json that cannot be read or parsed is a failure -- the alternative
 * is clearing a package whose entry points are unknown.
 */
export const packageEntryFiles = (specifier) => {
  const failures = [];
  const files = [];
  let resolved;
  try {
    resolved = require.resolve(specifier);
  } catch {
    failures.push({ entry: "package", file: specifier, rule: "package-unresolved", detail: "" });
    return { failures, files };
  }
  files.push(resolved);

  // The package root: the nearest directory above the resolved entry that has
  // a package.json with a name.
  let root = dirname(resolved);
  let manifest;
  for (let up = 0; up < 8; up += 1) {
    try {
      const read = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      if (typeof read.name === "string") {
        manifest = read;
        break;
      }
    } catch {
      // Not here; look one directory up.
    }
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  if (manifest === undefined) {
    failures.push({
      entry: "package",
      file: specifier,
      rule: "package-manifest-unreadable",
      detail: "no package.json above the resolved entry",
    });
    return { failures, files };
  }

  const strings = [];
  const collect = (value) => {
    if (typeof value === "string") {
      strings.push(value);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const inner of Object.values(value)) collect(inner);
  };
  collect(manifest.exports);
  collect(manifest.main);
  collect(manifest.module);
  collect(manifest.browser);

  for (const entry of strings) {
    if (!entry.startsWith(".")) continue;
    // §5.6's walk is over what a runtime loads, and §11-7 records the targets
    // it leaves out as a residual: declaration files, TypeScript sources and
    // JSON. `zod` points some entries at `src/*.ts`, which a bundler compiles
    // and Node never loads, so reading them would judge files the closure does
    // not run -- and their TypeScript-style `./x.js` specifiers do not resolve
    // as written either.
    if (/\.(d\.[cm]?ts|[cm]?tsx?|json)$/.test(entry)) continue;
    const base = resolvePath(root, entry);
    let found = false;
    for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, join(base, "index.js")]) {
      try {
        readFileSync(candidate, "utf8");
        files.push(candidate);
        found = true;
        break;
      } catch {
        // Not that spelling.
      }
    }
    // A wildcard entry (`./*.js`) names a pattern rather than a file, and
    // the files it covers are reached by the edges inside the package.
    if (!found && !entry.includes("*")) {
      failures.push({
        entry: "package",
        file: `${specifier} -> ${entry}`,
        rule: "package-unresolved",
        detail: "an entry point in package.json that does not resolve",
      });
    }
  }

  return { failures, files: [...new Set(files)] };
};

const checkPackages = (specifiers) => {
  const failures = [];
  for (const specifier of specifiers) {
    if (specifier === "server-only") continue;
    const entries = packageEntryFiles(specifier);
    failures.push(...entries.failures);
    if (entries.files.length === 0) continue;
    const seen = new Set();
    const queue = [...entries.files];
    while (queue.length > 0) {
      // `>=`, so the budget is the number of files read rather than one more
      // than it: the check fired after reading 1,501.
      if (seen.size >= PACKAGE_FILE_BUDGET) {
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
        // A file the walk reached and could not read is a file it did not
        // judge, so it is a failure rather than a skip.
        failures.push({
          entry: "package",
          file: `${specifier} -> ${relative(ROOT, file)}`,
          rule: "package-unreadable",
          detail: "",
        });
        continue;
      }
      // The egress names, over text: these are built files, and over-matching
      // costs a review while under-matching costs the rule (§5.6 (A)).
      for (const name of EGRESS_NAMES) {
        if (new RegExp(String.raw`\b${name}\b`).test(source)) {
          failures.push({ entry: "package", file: `${specifier} -> ${relative(ROOT, file)}`, rule: "package-egress-name", detail: name });
        }
      }
      if (/\bfetch\s*\(/.test(source)) {
        failures.push({ entry: "package", file: `${specifier} -> ${relative(ROOT, file)}`, rule: "package-egress-name", detail: "fetch" });
      }

      // The loader rules and the edges, parsed rather than matched.
      const judged = analysePackageFile({ specifier, file, source });
      failures.push(...judged.failures);
      for (const edge of judged.edges) queue.push(edge);
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
