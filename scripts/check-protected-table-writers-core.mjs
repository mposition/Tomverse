/**
 * Which files may write the tables whose rows are evidence.
 *
 * docs/policy/marketing-automation.md §6: human and system actions are
 * recorded in the existing hash-chained audit log, the system writer shares
 * the administrator writer's lock and hash path, and "감사 테이블 직접 insert는
 * 금지다". The chain proves nothing about a row that reached the table some
 * other way -- an entry inserted beside the writer either breaks verification
 * for everyone after it or, if the inserter holds the key, is indistinguishable
 * from a real one. So the writer has to be the only way in, and this check is
 * what makes that true rather than intended.
 *
 * The table list is a registry because the same rule is coming for the
 * marketing tables (one store module per S1c of the marketing plan); adding
 * a table is one row here.
 *
 * ## Three rules
 *
 * 1. **Delegate writes.** Outside a table's writer files, the Prisma delegate
 *    (`adminAuditLog`) may only be used for a read operation, and only as the
 *    object of an immediate member access. `.create`, `["update"]`, a computed
 *    member, and any use that lets the delegate escape -- assigned to a
 *    variable, destructured, passed as an argument, parenthesised -- are
 *    findings. An escaped delegate is not necessarily a write; it is a write
 *    this check can no longer see, which is the same thing to a reviewer.
 *
 * 2. **Raw SQL mentions.** For each file, every string and template literal
 *    fragment is joined, and the file is a finding when that text names a
 *    protected table *and* contains a write verb anywhere, in either order.
 *    Joining the whole file is deliberate: a statement split across a helper,
 *    a constant and a template is still one statement to the database, and a
 *    line window was shown to miss exactly that. The price is false positives
 *    in files that name the table in prose; those are listed by path with a
 *    reason, and an entry that stops matching is itself a finding so the list
 *    cannot quietly outlive its files. Migration `.sql` files are read the
 *    same way with comments removed.
 *
 * 3. **Unsafe raw inventory.** `$executeRawUnsafe`, `$queryRawUnsafe` and
 *    `Prisma.raw` take SQL assembled at runtime, which rule 2 cannot read. Every
 *    call anywhere in the scanned trees is counted per file and must equal the
 *    reviewed allowlist -- more is a new call nobody reviewed, fewer is an
 *    entry that no longer describes the file.
 *
 * ## What it does not see
 *
 * A delegate reached through a computed name on the client
 * (`prisma[modelName]`) when the name is not a literal. No such access exists
 * in the scanned trees today; if one is added, rule 1 reports the computed
 * member only when it follows the delegate, not when it produces it.
 *
 * Tests are not scanned. Integration suites truncate and seed these tables by
 * design, and a fixture that had to go through the writer could only prove the
 * writer agrees with itself.
 */

import ts from "typescript";

export const PROTECTED_TABLES = [
  {
    table: "AdminAuditLog",
    delegate: "adminAuditLog",
    writers: ["lib/adminAudit.ts"],
    contract: "docs/policy/marketing-automation.md §6",
  },
];

/** Prisma delegate operations that cannot change a row. */
export const READ_OPERATIONS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);

export const WRITE_VERB_PATTERN =
  /\b(insert|update|delete|merge|upsert|copy|truncate|alter)\b/;

export const SCANNED_DIRECTORIES = [
  "app",
  "components",
  "lib",
  "packages",
  "prisma",
  "scripts",
];

export const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".sql"]);

export const EXCLUDED_PREFIXES = [
  {
    prefix: "prisma/generated/",
    reason: "Generated Prisma client. Regenerated output, not a call site.",
  },
  {
    prefix: "prisma/migrations-archive/",
    reason:
      "Superseded migration history kept for reference. The live schema is built from prisma/migrations, which is scanned.",
  },
];

/** Files that name a protected table beside a write verb and do not write it. */
export const RAW_SQL_ALLOWLIST = [
  {
    path: "lib/accountDataExportDomains.ts",
    table: "AdminAuditLog",
    reason:
      "The data-domain declaration names the model as prismaModel, and unrelated domains' prose says 'deleted with the account'. No SQL is built from this file.",
  },
  {
    path: "scripts/report-issue-backlog-core.mjs",
    table: "AdminAuditLog",
    reason:
      "Issue probe prose describing what the audit log records. A report; it opens no database connection for this text.",
  },
  {
    path: "prisma/migrations/00000000000000_baseline/migration.sql",
    table: "AdminAuditLog",
    reason: "The baseline creates the table and its constraints. Applied history.",
  },
  {
    path: "prisma/migrations/20260826070000_admin_audit_actor_not_a_foreign_key/migration.sql",
    table: "AdminAuditLog",
    reason:
      "Drops the actorUserId foreign key so ON DELETE SET NULL can no longer rewrite hashed rows. Applied history.",
  },
  {
    path: "scripts/check-protected-table-writers-core.mjs",
    table: "AdminAuditLog",
    reason: "This file. A check for a forbidden write has to name the table and the verbs.",
  },
];

/** Every call that runs SQL assembled at runtime, by file, with its reviewed count. */
export const UNSAFE_RAW_ALLOWLIST = [
  {
    path: "lib/accountDataAnonymisation.ts",
    count: 2,
    reason:
      "Account deletion. Table and column names come from the ACCOUNT_ANONYMISATIONS and SUBJECT_TARGET_DELETIONS literals and pass an identifier check; values are bound. Neither list names a protected table (pinned in tests/protectedTableWriters.test.mjs).",
  },
  {
    path: "lib/emailProviderEvents.ts",
    count: 1,
    reason:
      "SET LOCAL statement_timeout with a number computed from the request budget. No table.",
  },
  {
    path: "lib/promptRefinerReservationAuthority.ts",
    count: 1,
    reason: "LOCK TABLE \"ModelRegistryEntry\" IN SHARE MODE, a constant string.",
  },
  {
    path: "scripts/audit-image-backfill.mjs",
    count: 7,
    reason:
      "Read-only image backfill audit: SELECT counts over image tables and a to_regclass existence probe on constant table names.",
  },
  {
    path: "scripts/measure-continuation-source-search.mjs",
    count: 2,
    reason:
      "Local search benchmark: ANALYZE and EXPLAIN on ExternalMessage against a seeded database.",
  },
];

const UNSAFE_RAW_MEMBERS = new Set(["$executeRawUnsafe", "$queryRawUnsafe"]);

export const isExcluded = (path) =>
  EXCLUDED_PREFIXES.some((entry) => path.startsWith(entry.prefix));

const scriptKindFor = (path) =>
  path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : path.endsWith(".ts")
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;

const lineOf = (sourceFile, node) =>
  sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

/** The name a member access uses, when it is written literally. */
const memberName = (node) => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
};

/**
 * Walks one source file once and returns what all three rules need: delegate
 * uses, the joined literal text, and the unsafe raw calls.
 */
export const analyseSource = (path, text) => {
  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(path)
  );
  const delegates = new Set(PROTECTED_TABLES.map((entry) => entry.delegate));
  const delegateUses = [];
  const literals = [];
  const unsafeRawCalls = [];

  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      literals.push(node.text);
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = memberName(node);

      if (name && delegates.has(name)) {
        const parent = node.parent;
        let operation;
        if (
          (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
          parent.expression === node
        ) {
          operation = memberName(parent) ?? "<computed member>";
        } else {
          operation = `<escaped: ${ts.SyntaxKind[parent.kind]}>`;
        }
        delegateUses.push({ delegate: name, operation, line: lineOf(sourceFile, node) });
      }

      if (name && UNSAFE_RAW_MEMBERS.has(name)) {
        unsafeRawCalls.push({ call: name, line: lineOf(sourceFile, node) });
      } else if (
        name === "raw" &&
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Prisma"
      ) {
        unsafeRawCalls.push({ call: "Prisma.raw", line: lineOf(sourceFile, node) });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { delegateUses, literalText: literals.join("\n"), unsafeRawCalls };
};

/** SQL text with comments removed, for migration files. */
export const sqlWithoutComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/** Protected tables that the text names beside a write verb. */
export const rawSqlTableHits = (text) => {
  const normalised = text.toLowerCase().replace(/["`]/g, "");
  if (!WRITE_VERB_PATTERN.test(normalised)) return [];
  return PROTECTED_TABLES.filter((entry) =>
    new RegExp(`\\b${entry.table.toLowerCase()}\\b`).test(normalised)
  ).map((entry) => entry.table);
};

export const checkProtectedTableWriters = ({ sources }) => {
  const findings = [];
  const rawSqlHits = new Set();
  const unsafeCounts = new Map();

  for (const { path, text } of sources) {
    if (isExcluded(path)) continue;

    if (path.endsWith(".sql")) {
      for (const table of rawSqlTableHits(sqlWithoutComments(text))) {
        rawSqlHits.add(`${path}\u0000${table}`);
      }
      continue;
    }

    const { delegateUses, literalText, unsafeRawCalls } = analyseSource(path, text);

    for (const use of delegateUses) {
      const protectedTable = PROTECTED_TABLES.find((entry) => entry.delegate === use.delegate);
      if (protectedTable.writers.includes(path)) continue;
      if (READ_OPERATIONS.has(use.operation)) continue;
      findings.push({
        rule: "delegate-write",
        path,
        line: use.line,
        table: protectedTable.table,
        detail: `${use.delegate}.${use.operation}`,
      });
    }

    for (const table of rawSqlTableHits(literalText)) {
      rawSqlHits.add(`${path}\u0000${table}`);
    }

    if (unsafeRawCalls.length > 0) unsafeCounts.set(path, unsafeRawCalls);
  }

  const allowedRaw = new Set(
    RAW_SQL_ALLOWLIST.map((entry) => `${entry.path}\u0000${entry.table}`)
  );
  for (const key of rawSqlHits) {
    if (allowedRaw.has(key)) continue;
    const [path, table] = key.split("\u0000");
    findings.push({
      rule: "raw-sql",
      path,
      table,
      detail: `string literals name ${table} beside a write verb`,
    });
  }
  const scannedPaths = new Set(sources.map((source) => source.path));
  for (const entry of RAW_SQL_ALLOWLIST) {
    if (rawSqlHits.has(`${entry.path}\u0000${entry.table}`)) continue;
    findings.push({
      rule: "stale-allowlist",
      path: entry.path,
      table: entry.table,
      detail: scannedPaths.has(entry.path)
        ? "raw SQL allowlist entry no longer matches this file; remove it"
        : "raw SQL allowlist entry names a file that was not scanned; remove or correct it",
    });
  }

  const allowedUnsafe = new Map(UNSAFE_RAW_ALLOWLIST.map((entry) => [entry.path, entry]));
  for (const [path, calls] of unsafeCounts) {
    const expected = allowedUnsafe.get(path)?.count ?? 0;
    if (calls.length === expected) continue;
    findings.push({
      rule: "unsafe-raw",
      path,
      line: calls[0].line,
      detail: `${calls.length} runtime-SQL call(s), allowlist says ${expected}: ${calls
        .map((call) => `${call.call}@${call.line}`)
        .join(", ")}`,
    });
  }
  for (const entry of UNSAFE_RAW_ALLOWLIST) {
    if (unsafeCounts.has(entry.path)) continue;
    findings.push({
      rule: "unsafe-raw",
      path: entry.path,
      detail: `allowlist says ${entry.count} runtime-SQL call(s), found 0; remove the entry`,
    });
  }

  return findings;
};

export const describeFindings = (findings) =>
  [
    `${findings.length} protected-table writer finding(s).`,
    "",
    ...findings.map(
      (finding) =>
        `  [${finding.rule}] ${finding.path}${finding.line ? `:${finding.line}` : ""}  ${finding.detail}`
    ),
    "",
    "Protected tables are written only by their writer module:",
    ...PROTECTED_TABLES.map(
      (entry) => `  ${entry.table}: ${entry.writers.join(", ")} (${entry.contract})`
    ),
    "",
    "For the audit log, record an administrator action with writeAdminAuditLog and a",
    "system action with writeSystemAuditLog, in the transaction of the change.",
    "A false positive is listed in scripts/check-protected-table-writers-core.mjs with",
    "its reason; a new runtime-SQL call is added to UNSAFE_RAW_ALLOWLIST with its count",
    "and why its SQL cannot reach a protected table.",
  ].join("\n");
