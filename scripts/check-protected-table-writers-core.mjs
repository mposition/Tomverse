/**
 * Which files may write the tables whose rows are evidence.
 *
 * docs/policy/marketing-automation.md §6: human and system actions are
 * recorded in the existing hash-chained audit log, the system writer shares
 * the administrator writer's lock and hash path, and "감사 테이블 직접 insert는
 * 금지다". The chain proves nothing about a row that reached the table some
 * other way -- an entry inserted beside the writer breaks verification for
 * everyone after it. This check refuses the direct writes it can read in
 * source; what it can and cannot promise is set out under "The guarantee"
 * below.
 *
 * The table list is a registry because the same rule is coming for the
 * marketing tables (one store module per S1c of the marketing plan); adding
 * a table is one row here.
 *
 * ## What is scanned
 *
 * Every tracked or new (not ignored) source file in the repository with a
 * JavaScript, TypeScript or SQL extension -- including the root server entry
 * points (`instrumentation.ts`, `proxy.ts`) and `.mts`/`.cts`/`.cjs`/`.jsx` --
 * minus the prefixes in EXCLUDED_PREFIXES, each with its reason. The file list
 * comes from git and the runner fails if git cannot produce it: a scan that
 * silently read nothing would pass.
 *
 * ## Rules
 *
 * 1. **delegate-write.** Outside a table's writer files, the Prisma delegate
 *    (`adminAuditLog`) may only be used for a read operation, and only as the
 *    object of an immediate member access. A write, a computed member, and any
 *    use that lets the delegate escape -- assigned, destructured from the client
 *    (`const { adminAuditLog: a } = prisma`), passed as an argument,
 *    parenthesised -- is a finding. An escaped delegate is not necessarily a
 *    write; it is a write this check can no longer see.
 *
 * 2. **delegate-name.** A string literal equal to a protected delegate name
 *    outside the writer is counted per file against DELEGATE_NAME_ALLOWLIST.
 *    That is how `prisma[name]` and `Reflect.get(prisma, name)` get their
 *    name, so a new occurrence has to be reviewed. Type positions (a union of
 *    record names) are not counted.
 *
 * 3. **dynamic-delegate.** A computed member with a non-literal key, either on
 *    a receiver named like a Prisma client (`prisma`, `tx`, `client`, `db`,
 *    ...) or immediately followed by a Prisma write operation
 *    (`x[key].create(`), and `Reflect.get` with a non-literal key on such a
 *    receiver. The name may have been assembled at runtime, so no literal
 *    rule can see it. None exist today; any new one fails.
 *
 * 4. **raw-sql.** For each file, every string and template literal fragment
 *    is joined; migration `.sql` files are read with real comments removed by
 *    a lexer that respects quotes, quoted identifiers and dollar quoting. The
 *    file is a finding when that text names a protected table *and* contains a
 *    write verb anywhere, in either order -- a statement split across a
 *    helper, a constant and a template is still one statement to the
 *    database. A false positive is allowlisted with its exact number of table
 *    mentions and write verbs, so adding a real statement to an allowlisted
 *    file changes a count and fails, and an entry that stops matching fails.
 *
 * 5. **runtime-sql.** The spellings listed here are inventoried per file
 *    with a reviewed count, failing in both directions:
 *    `$executeRawUnsafe` / `$queryRawUnsafe` reached as a member, a computed
 *    member, a destructured binding or a string naming the method;
 *    `Prisma.raw` / `Prisma["raw"]`; `$executeRaw` / `$queryRaw` called with
 *    anything but an inline `Prisma.sql` template; `$extends` (a client
 *    extension can add writes under any name); and imports of a database
 *    driver (`pg` and friends), which bypass Prisma entirely. A spelling that
 *    is not on this list is not inventoried.
 *
 * 6. **retention-setting.** The transaction-local setting that lets retention
 *    past the marketing tables' append-only history and content-purge rules is
 *    counted per file, by both spellings -- the string and the constant that
 *    holds it -- against RETENTION_SETTING_ALLOWLIST. Any module that can name
 *    it can turn retention mode on for its own transaction, and the triggers
 *    would then apply the retention rules to whatever that transaction was
 *    doing. This is not a privilege boundary (the application has one database
 *    role); it is what makes naming the setting a reviewed act rather than an
 *    import.
 *
 * ## What this check is for, and what remains outside it
 *
 * A text check over a general-purpose language cannot follow every alias: a
 * client renamed and then indexed with a key assembled at run time
 * (`const p = prisma; const d = p[key]; d.create()`) does not name the table,
 * the delegate or a client-like receiver anywhere. Chasing each such spelling
 * would never end, and it would still not be an authenticity control -- any
 * code in the application can call the writer itself with invented content.
 *
 * ## The guarantee, as decided (operator, 2026-09-17)
 *
 * Mistakes and ordinary code are stopped; deliberate evasion is detected and
 * reviewed, not made impossible. Concretely:
 *
 * - This check refuses the direct writes ordinary code contains and the
 *   evasions found in review so far, and keeps the runtime-SQL spellings
 *   listed in rule 5 on a reviewed inventory.
 * - For AdminAuditLog, 20260918090000_admin_audit_log_append_only refuses
 *   UPDATE and DELETE and makes every hashed INSERT take the chain lock and
 *   land strictly after the current head, however the row arrived.
 * - What remains possible for code that sets out to evade -- an aliased
 *   delegate reached with a runtime key, a runtime-SQL spelling not listed in
 *   rule 5, an unhashed insert, a head-linked insert with a forged HMAC,
 *   TRUNCATE, or disabling a trigger, all from the one database role the
 *   application uses -- is surfaced rather than prevented: the verifier fails
 *   a forged hash and counts unhashed rows dated after the first hashed one,
 *   and the code that did it is a review finding.
 * - Preventing those as well needs a separate non-owner runtime database role
 *   with direct DML, TRUNCATE and trigger changes revoked. That is a recorded
 *   follow-up, not part of this slice.
 *
 * A protected table added to this registry gets the same kind of trigger in
 * its own migration; the marketing tables' triggers are part of S1c.
 *
 * Tests are not scanned. Integration suites truncate and seed these tables by
 * design, and a fixture that had to go through the writer could only prove the
 * writer agrees with itself.
 */

import { createHash } from "node:crypto";

import ts from "typescript";

/**
 * Tables whose append-only claim a row trigger cannot defend on its own.
 *
 * The permission ledger and the consent ledger refuse UPDATE and DELETE by
 * trigger. TRUNCATE is neither: it fires no row trigger, and
 * `TRUNCATE ... CASCADE` on a table these point at reaches them through their
 * foreign keys. A BEFORE TRUNCATE trigger would close it and would also break
 * 84 of the 138 DB integration suites, which reset by truncating `User` and
 * `EmailDelivery`; revoking the privilege reaches every table in the schema
 * and belongs with whoever owns the database roles
 * (prisma/migrations/20260921170000_email_permission_ledger).
 *
 * What is closed here is the vector this repository controls.
 */
export const APPEND_ONLY_LEDGER_TABLES = [
  "EmailPermissionEvent",
  "EmailSendApproval",
  "EmailSendApprovalMember",
  "EmailSendApprovalRevocation",
  "EmailPermissionDecision",
  "EmailPermissionDecisionEvidence",
  "ConsentRecord",
];

/**
 * Every SQL TRUNCATE in scanned source, whatever it names.
 *
 * Categorical rather than a search for the seven table names, and that is the
 * point: `TRUNCATE "User" CASCADE` names none of them and empties four, and a
 * statement long enough to push its table list past any window would have
 * slipped a name-matching scan. No production code in this repository
 * truncates anything -- the scanned set excludes tests/ -- so "none at all" is
 * a rule that costs nothing and has no gap to reason about.
 *
 * Matches the SQL statement, not the CSS class: `TRUNCATE` followed by TABLE,
 * ONLY, or a quoted identifier. `className="truncate"` and "do not truncate
 * sentences" are neither.
 *
 * Case-insensitive. This repository writes SQL in upper case, so the first
 * version only matched that -- and `truncate table "User"` would have passed a
 * rule whose whole value is that it has no gap to reason about. The suffix is
 * what keeps the CSS class out, at either case.
 */
export const SQL_TRUNCATE_PATTERN = /\bTRUNCATE\s+(?:TABLE\b|ONLY\b|")/gi;

export const findTruncateStatements = ({ sources }) => {
  const findings = [];
  for (const { path, text } of sources) {
    SQL_TRUNCATE_PATTERN.lastIndex = 0;
    let match;
    while ((match = SQL_TRUNCATE_PATTERN.exec(text)) !== null) {
      const line = text.slice(0, match.index).split("\n").length;
      findings.push({ path, line });
    }
  }
  return findings;
};

export const PROTECTED_TABLES = [
  {
    table: "AdminAuditLog",
    delegate: "adminAuditLog",
    writers: ["lib/adminAudit.ts"],
    contract: "docs/policy/marketing-automation.md §6",
  },
  {
    table: "MarketingChannel",
    delegate: "marketingChannel",
    writers: ["lib/marketingStore.ts"],
    contract: "docs/policy/marketing-automation.md §5",
  },
  {
    table: "MarketingPost",
    delegate: "marketingPost",
    writers: ["lib/marketingStore.ts"],
    contract: "docs/policy/marketing-automation.md §5",
  },
  {
    table: "MarketingReport",
    delegate: "marketingReport",
    writers: ["lib/marketingStore.ts"],
    contract: "docs/policy/marketing-automation.md §5",
  },
  {
    table: "AiVisibilityRun",
    delegate: "aiVisibilityRun",
    writers: ["lib/marketingStore.ts"],
    contract: "docs/policy/marketing-automation.md §5",
  },
  {
    table: "PromptRefinerShadowRun",
    delegate: "promptRefinerShadowRun",
    writers: ["lib/promptRefinerShadowRunStore.ts"],
    contract: "docs/policy/prompt-refiner-observability.md §12",
  },
  {
    table: "PromptRefinerShadowAttempt",
    delegate: "promptRefinerShadowAttempt",
    writers: ["lib/promptRefinerShadowRunStore.ts"],
    contract: "docs/policy/prompt-refiner-observability.md §12",
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

/** Prisma delegate operations that can. Used to recognise `x[key].create(`. */
export const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);

/** Receivers whose computed members are treated as model lookups. */
export const CLIENT_RECEIVER_PATTERN = /^(prisma|prismaClient|client|db|tx|trx|transaction)$/i;

export const WRITE_VERB_PATTERN =
  /\b(insert|update|delete|merge|upsert|copy|truncate|alter|drop|disable)\b/g;

export const SCANNED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".sql",
];

export const EXCLUDED_PREFIXES = [
  {
    prefix: "tests/",
    reason:
      "Test suites and fixtures seed and truncate these tables against disposable databases by design.",
  },
  {
    prefix: "prisma/generated/",
    reason: "Generated Prisma client. Regenerated output, not a call site.",
  },
  {
    prefix: "prisma/migrations-archive/",
    reason:
      "Superseded migration history kept for reference. The live schema is built from prisma/migrations, which is scanned.",
  },
  {
    prefix: "docs/",
    reason: "Documentation. Nothing here is imported or executed.",
  },
  {
    path: "scripts/check-protected-table-writers-core.mjs",
    reason:
      "This check. It names the tables, delegates, verbs and raw methods it forbids, and opens no database connection. An exact path, not a prefix, so a similarly named file is still scanned.",
  },
  {
    path: "scripts/check-protected-table-writers.mjs",
    reason: "The runner. Reads files and prints findings; opens no database connection.",
  },
  {
    prefix: "node_modules/",
    reason: "Dependencies, not repository code.",
  },
];

/** Non-type string literals equal to a protected delegate name, by file. */
export const DELEGATE_NAME_ALLOWLIST = [
  {
    path: "app/api/admin/search/route.ts",
    delegate: "adminAuditLog",
    count: 1,
    reason:
      "adminSearchWhere(\"adminAuditLog\", query) picks the searchable fields for a read that is itself a literal prisma.adminAuditLog.findMany.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    delegate: "adminAuditLog",
    count: 1,
    reason: "The data-domain registry's domain key. No client is indexed with it.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    delegate: "promptRefinerShadowRun",
    count: 1,
    reason: "The data-domain registry's domain key. No client is indexed with it.",
  },
];

/**
 * Files whose literals name a protected table beside a write verb and do not
 * write it. Counts are exact: a new statement in the file changes one of them.
 */
export const RAW_SQL_ALLOWLIST = [
  {
    path: "lib/marketingStore.ts",
    table: "MarketingChannel",
    tableMentions: 2,
    writeVerbs: 7,
    reason:
      "The sole marketing writer mutates through Prisma delegates. Its raw SQL is two constant SELECT ... FOR UPDATE statements that take the row locks the transitions are decided under; neither interpolates a table name.",
  },
  {
    path: "lib/marketingStore.ts",
    table: "MarketingPost",
    tableMentions: 7,
    writeVerbs: 7,
    reason:
      "Same module and the same two lock statements, plus the post lock the approval and publish transitions are decided under, and three constant SELECTs the autonomous insert makes: the template's FOR SHARE, and one statement each for the claims and the assets that decision relied on having been published. The last two are written out separately rather than as one statement with the column interpolated, because a runtime column name is what this rule exists to refuse. None interpolates a table name and every write is a delegate call.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 3,
    reason:
      "The data-domain registry names the model as prismaModel and in prose, and other domains' prose uses delete and update. No SQL is built from this file.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    table: "PromptRefinerShadowRun",
    tableMentions: 2,
    writeVerbs: 3,
    reason:
      "The data-domain registry names the content-free run model and describes retention and deletion. It builds no SQL and opens no database connection.",
  },
  {
    path: "lib/promptRefinerShadowRunStore.ts",
    table: "PromptRefinerShadowRun",
    tableMentions: 4,
    writeVerbs: 6,
    reason:
      "The sole run/attempt writer uses Prisma delegates for mutations. Its raw SQL is limited to constant SELECT ... FOR UPDATE statements used to enforce the documented lock order; it never interpolates a table name.",
  },
  {
    path: "lib/promptRefinerShadowRunStore.ts",
    table: "PromptRefinerShadowAttempt",
    tableMentions: 1,
    writeVerbs: 6,
    reason:
      "The same sole writer; the attempt table appears only in constant SELECT ... FOR UPDATE SQL while all mutations use the protected Prisma delegate.",
  },
  {
    path: "scripts/report-issue-backlog-core.mjs",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 1,
    reason:
      "Issue probe prose describing what the audit log records. A report; it opens no database connection for this text.",
  },
  {
    path: "prisma/migrations/00000000000000_baseline/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 7,
    writeVerbs: 94,
    reason:
      "The baseline migration creates every table, including this one and its constraints. Applied history; an edit to it changes a count.",
  },
  {
    path: "prisma/migrations/20260826070000_admin_audit_actor_not_a_foreign_key/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 1,
    writeVerbs: 2,
    reason:
      "Drops the actorUserId foreign key so ON DELETE SET NULL can no longer rewrite hashed rows. Applied history.",
  },
  {
    path: "prisma/migrations/20260918090000_admin_audit_log_append_only/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 6,
    writeVerbs: 4,
    reason:
      "The append-only and chain-head triggers themselves: they name UPDATE, DELETE and INSERT to refuse or constrain them, and write nothing.",
  },
  {
    path: "prisma/migrations/20260918130000_prompt_refiner_stage_admission/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 14,
    reason:
      "The stage-admission migration adds a restrictive foreign key to AdminAuditLog and reads the linked authorization row from its insert guard. Its write verbs create or constrain the Prompt Refiner stage and reservation tables; it never writes AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20260920120000_prompt_refiner_shadow_run_writer/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 6,
    writeVerbs: 22,
    reason:
      "The run-writer migration deliberately keeps audit IDs as plain immutable columns, then trigger-checks the linked human/system audit rows without giving a foreign key any path to rewrite the signed audit chain. It never writes AdminAuditLog; its write verbs create and constrain the content-free run, attempt and reservation tables.",
  },
  {
    path: "prisma/migrations/20260920120000_prompt_refiner_shadow_run_writer/migration.sql",
    table: "PromptRefinerShadowRun",
    tableMentions: 23,
    writeVerbs: 22,
    reason:
      "The migration creates the content-free run table and its fail-closed insert/update/delete triggers. Applied migration source is the reviewed schema boundary; an edit changes the exact counts.",
  },
  {
    path: "prisma/migrations/20260920120000_prompt_refiner_shadow_run_writer/migration.sql",
    table: "PromptRefinerShadowAttempt",
    tableMentions: 24,
    writeVerbs: 22,
    reason:
      "The migration creates the content-free attempt table and its immutable terminal trigger, and binds reservation consume to one intent. Applied migration source is the reviewed schema boundary; an edit changes the exact counts.",
  },
  {
    path: "prisma/migrations/20260920190000_prompt_refiner_shadow_execution_runner/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 4,
    writeVerbs: 9,
    reason:
      "The execution-runner migration replaces only the v3 run/attempt constraint and trigger functions. It reads the already-linked audit rows to enforce exact authorization and tokenizer provenance; it never writes AdminAuditLog and seeds no row.",
  },
  {
    path: "prisma/migrations/20260920190000_prompt_refiner_shadow_execution_runner/migration.sql",
    table: "PromptRefinerShadowRun",
    tableMentions: 11,
    writeVerbs: 9,
    reason:
      "The execution-runner migration fails closed on existing runs, then replaces the exact v3 contract and insert guard. Its ALTER/DROP vocabulary changes DDL only and the migration seeds no run.",
  },
  {
    path: "prisma/migrations/20260920190000_prompt_refiner_shadow_execution_runner/migration.sql",
    table: "PromptRefinerShadowAttempt",
    tableMentions: 7,
    writeVerbs: 9,
    reason:
      "The execution-runner migration fails closed on existing attempts, then replaces the exact v3 binding and insert guard for tokenizer facts. Its ALTER/DROP vocabulary changes DDL only and the migration seeds no attempt.",
  },
  {
    path: "prisma/migrations/20260921160000_amux_agent_review_approval/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 3,
    writeVerbs: 24,
    reason:
      "The AMUX approval migration creates only its proposal/decision ledger and reads AdminAuditLog through a restrictive foreign key and SELECT FOR KEY SHARE. It never writes AdminAuditLog; lib/adminAudit.ts remains its sole writer. Exact counts fail closed if this SQL changes.",
  },
  {
    path: "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 8,
    writeVerbs: 26,
    reason:
      "The confirmatory-shadow migration reads exact human/system audit rows from replacement guards and changes DDL only. It seeds no stage, reservation, run, attempt or audit row.",
  },
  {
    path: "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
    table: "PromptRefinerShadowRun",
    tableMentions: 18,
    writeVerbs: 26,
    reason:
      "The migration adds an evidence-spec binding and replaces fail-closed v4 constraints/triggers while preserving historical v3 rows. It contains no run DML and seeds no authority.",
  },
  {
    path: "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
    table: "PromptRefinerShadowAttempt",
    tableMentions: 14,
    writeVerbs: 26,
    reason:
      "The migration adds the content-free evidence column and binds terminal evidence to the existing audit transaction. It contains no attempt DML and seeds no evidence.",
  },
  {
    path: "scripts/report-unswept-tables-core.mjs",
    table: "MarketingReport",
    tableMentions: 1,
    writeVerbs: 4,
    reason:
      "The retention registry's prose: the Prompt Refiner stage entry contributes update/delete, and two other entries describe deletes. MarketingReport is named by an AI-visibility shape comparison. This is a report; it opens no database connection.",
  },
  {
    path: "prisma/migrations/20260918120000_marketing_automation_tables/migration.sql",
    table: "MarketingChannel",
    tableMentions: 48,
    writeVerbs: 67,
    reason:
      "The migration that creates the marketing tables and the triggers that bound them. It names UPDATE, DELETE and INSERT to constrain or refuse them; the only statements that write a row are the CREATE TABLE and CREATE INDEX statements themselves. Applied history, so an edit changes a count.",
  },
  {
    path: "prisma/migrations/20260918120000_marketing_automation_tables/migration.sql",
    table: "MarketingPost",
    tableMentions: 82,
    writeVerbs: 67,
    reason: "The same migration; see the MarketingChannel entry above.",
  },
  {
    path: "prisma/migrations/20260918120000_marketing_automation_tables/migration.sql",
    table: "MarketingReport",
    tableMentions: 11,
    writeVerbs: 67,
    reason: "The same migration; see the MarketingChannel entry above.",
  },
  {
    path: "prisma/migrations/20260918120000_marketing_automation_tables/migration.sql",
    table: "AiVisibilityRun",
    tableMentions: 14,
    writeVerbs: 67,
    reason: "The same migration; see the MarketingChannel entry above.",
  },
  {
    path: "prisma/migrations/20260921170000_marketing_post_facts_digest/migration.sql",
    table: "MarketingPost",
    tableMentions: 1,
    writeVerbs: 1,
    reason:
      "Adds the immutable record of the Guard resolver's full answer digest; DDL only and no row mutation.",
  },
  {
    path: "prisma/migrations/20260923140000_marketing_post_facts_digest_not_null/migration.sql",
    table: "MarketingPost",
    tableMentions: 3,
    writeVerbs: 2,
    reason:
      "Makes that digest NOT NULL. The table is named three times and none of them writes a row: a SELECT count(*) that refuses the migration while any row still has no digest, the ALTER TABLE that follows it, and the count in the error message. Both write verbs are that one statement's own ALTER TABLE and ALTER COLUMN -- this migration issues no UPDATE and no DELETE, because the disposition of a row with no digest is an operator's decision carried out separately.",
  },
];

/** Everything that runs SQL this check cannot read, by file, with its reviewed count. */
export const RUNTIME_SQL_ALLOWLIST = [
  {
    path: "prisma/migrations/20260921170000_email_permission_ledger/migration.sql",
    count: 10,
    reason:
      "Ten trigger bodies read a sibling ledger table with EXECUTE over a name built from TG_TABLE_SCHEMA -- the schema the trigger own table is in. The alternative was an unqualified name, which resolves against the session search path, where a temporary table of the same name answers for the real one and the seal, cohort and evidence checks read it instead. A hard-coded public. was wrong too: the runtime reads ?schema= from DATABASE_URL and sets a search_path with no public fallback (lib/postgresConnectionConfigCore.mjs). The schema is the trigger own, never input, and it is quoted with %I; every value is bound with USING.",
  },
  {
    path: "prisma/migrations/20260918090000_admin_audit_log_append_only/migration.sql",
    count: 1,
    reason:
      "The chain-head trigger reads the head with EXECUTE over TG_RELID::regclass -- the table the trigger is attached to -- so no search path or same-named temporary table can redirect the read. It builds no table name from input.",
  },
  {
    path: "prisma/migrations/20260918120000_marketing_automation_tables/migration.sql",
    count: 1,
    reason:
      "The post trigger reads its channel with EXECUTE over a name built from TG_TABLE_SCHEMA -- the schema its own table is in -- because an unqualified name resolves against the session search path, where a temporary table of the same name would answer for the real one. The schema is the trigger own schema, not input, not input, and it is quoted with %I.",
  },
  {
    path: "lib/prisma.ts",
    sha256: "c3245196e95f7c9198b0d6834f221969eeede43b9bf59bf01c8d77000056bedc",
    count: 2,
    reason:
      "The application's Prisma client, constructed over a pg Pool through @prisma/adapter-pg. It exports the client; it runs no SQL of its own. The pool is module-private and not exported (reviewed 2026-09-17).",
  },
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
    path: "lib/promptRefinerStageAdmission.ts",
    count: 1,
    reason:
      "LOCK TABLE \"ModelRegistryEntry\" IN SHARE MODE before validating the pinned model row; the SQL is a constant and names no protected table.",
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
  {
    path: "scripts/baseline-existing-database.mjs",
    sha256: "43acecfde4250aad7a230a2219cf58863858636105c0e9d115607f49f7ff3b31",
    count: 1,
    reason:
      "Pre-deploy migration-history reconciliation over pg: reads the schema and _prisma_migrations before prisma migrate resolve. Its SQL literals are in the file and name no protected table. Its queries read the catalogue and _prisma_migrations; the write is delegated to prisma migrate resolve (reviewed 2026-09-17).",
  },
  {
    path: "scripts/compare-schema-to-migrations.mjs",
    sha256: "6ce2acc68f9e326b47e57d3cba5bf3ced3a9e8700d8e12f71b0efa9412ac01b4",
    count: 1,
    reason: "Read-only catalogue comparison of a live schema against one built from migrations. Catalogue reads only (reviewed 2026-09-17).",
  },
  {
    path: "scripts/railway-restore-verify.mjs",
    sha256: "adc050618773cd7ba5833393e5891f3ce7288e6915df7586b0dfc931c4721108",
    count: 1,
    reason: "Read-only verification of an isolated restored database after a restore drill. Catalogue and row-count reads only (reviewed 2026-09-17).",
  },
  {
    path: "scripts/require-direct-database-url.mjs",
    sha256: "6b503d9306cb2d8644932f2fdb74f084f93b78578f10c573e9a9b24fdf933944",
    count: 1,
    reason: "Pre-migration connectivity and advisory-lock probe on the direct database URL. No table writes. Advisory lock try/unlock and lock-holder reads only (reviewed 2026-09-17).",
  },
];

const UNSAFE_RAW_MEMBERS = new Set(["$executeRawUnsafe", "$queryRawUnsafe"]);
const TAGGED_RAW_MEMBERS = new Set(["$executeRaw", "$queryRaw"]);

/**
 * Client members that run SQL or change what the client does, however they
 * are reached. A member access to a tagged raw method with an inline template
 * is the one allowed form; every other way of getting hold of one of these --
 * destructuring, a string key, Reflect.get -- is inventoried.
 */
const RUNTIME_SQL_MEMBERS = new Set([
  ...UNSAFE_RAW_MEMBERS,
  ...TAGGED_RAW_MEMBERS,
  "$extends",
  "$runCommandRaw",
  "$executeRawInternal",
  "_request",
  "_executeRequest",
]);

/** Database drivers that reach Postgres without Prisma. */
export const DATABASE_DRIVER_MODULES = new Set([
  "pg",
  "pg-pool",
  "postgres",
  "@prisma/adapter-pg",
  "@neondatabase/serverless",
  "@vercel/postgres",
  "mysql",
  "mysql2",
  "better-sqlite3",
  "knex",
  "kysely",
]);

const isDatabaseDriverModule = (specifier) =>
  DATABASE_DRIVER_MODULES.has(specifier) ||
  [...DATABASE_DRIVER_MODULES].some((name) => specifier.startsWith(`${name}/`)) ||
  specifier === "drizzle-orm" ||
  specifier.startsWith("drizzle-orm/");

export const isExcluded = (path) =>
  EXCLUDED_PREFIXES.some((entry) =>
    entry.path ? path === entry.path : path.startsWith(entry.prefix)
  );

/** The repository paths this check reads, from a list of candidate paths. */
export const selectScannedPaths = (paths) =>
  paths
    .map((path) => path.split("\\").join("/"))
    .filter((path) => SCANNED_EXTENSIONS.some((extension) => path.endsWith(extension)))
    .filter((path) => !isExcluded(path));

const scriptKindFor = (path) => {
  if (/\.(tsx)$/.test(path)) return ts.ScriptKind.TSX;
  if (/\.(ts|mts|cts)$/.test(path)) return ts.ScriptKind.TS;
  if (/\.(jsx)$/.test(path)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
};

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

const isMemberAccess = (node) =>
  ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);

/** The last identifier of a receiver expression: `this.prisma` -> `prisma`. */
const receiverName = (node) => {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  return null;
};

const isInTypePosition = (node) => {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isStatement(current) || ts.isExpression(current)) return false;
  }
  return false;
};

const isReflectGet = (call) =>
  ts.isCallExpression(call) &&
  ts.isPropertyAccessExpression(call.expression) &&
  ts.isIdentifier(call.expression.expression) &&
  call.expression.expression.text === "Reflect" &&
  call.expression.name.text === "get";

const isInlinePrismaSql = (node) =>
  node !== undefined &&
  ts.isTaggedTemplateExpression(node) &&
  ts.isPropertyAccessExpression(node.tag) &&
  ts.isIdentifier(node.tag.expression) &&
  node.tag.expression.text === "Prisma" &&
  node.tag.name.text === "sql";

/**
 * Every function that can mint a Guard-trusted value, in one list.
 *
 * The computed-access rules were written for the template proof and the facts
 * seal was added beside them, so `g["sealMarketingFacts"]({})` reached a
 * function nothing counted -- the same bypass, one name along. A second seal
 * added later joins this list and gets every rule at once.
 */
export const PROTECTED_EXPORTS = Object.freeze([
  "sealMarketingTemplateProof",
  "sealMarketingFacts",
  "sealMarketingGuardContext",
]);

/** The module that declares it, matched on the specifier's last segment. */
const TEMPLATE_SEAL_MODULE = "marketingGuardCore";

/** The one file entitled to declare it. A second declaration is a second seal. */
const PROTECTED_EXPORTS_DECLARED_IN = "lib/marketingGuardCore.ts";

const specifierEndsWithSealModule = (specifier) =>
  specifier.replace(/[.][cm]?[jt]sx?$/, "").split("/").pop() ===
  TEMPLATE_SEAL_MODULE;

/**
 * What a reference to the seal function is doing.
 *
 * Counting the name is not counting the call. The review put an alias in an
 * allowed file -- `export const mint = sealMarketingTemplateProof` -- and
 * called `mint()` from somewhere else, and the count rule saw two mentions in
 * the file it expected two mentions in and nothing anywhere else. So each
 * reference is classified, and everything that is not a declaration, an import
 * under the same name, or a direct call is an escape: the value has left,
 * and where it goes is no longer visible to a rule that reads one file.
 */
const classifySealReference = (node) => {
  const parent = node.parent;
  if (!parent) return "escape";

  if (
    (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) &&
    parent.name === node
  ) {
    return "declaration";
  }

  if (ts.isImportSpecifier(parent)) {
    // `import { seal as mint }` renames it, and the rest of the file then
    // calls a name this check is not looking for.
    const renamed =
      parent.propertyName !== undefined && parent.name.text !== node.text;
    return renamed ? "escape" : "import";
  }

  // `export { seal }` and `export { seal as mint }` both hand it on.
  if (ts.isExportSpecifier(parent)) return "escape";

  if (ts.isCallExpression(parent) && parent.expression === node) return "call";

  return "escape";
};

/**
 * Whether a module specifier names the module that declares the seal.
 *
 * Any import of it other than a named one under the same name puts the
 * function behind an object, and a rule that reads identifiers cannot follow
 * it there: `import * as guard` then `guard["sealMarketingTemplateProof"]({})`
 * is a call this check saw nothing of at all.
 */
const importsSealModule = (specifier) =>
  specifierEndsWithSealModule(specifier);

/**
 * Walks one source file once and returns what the rules need.
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
  const delegateNameLiterals = [];
  const dynamicDelegateUses = [];
  const literals = [];
  const runtimeSql = [];
  const protectedCalls = [];
  const protectedEscapes = [];
  // `const p = "@/lib/marketingGuardCore"` and `const k = "seal..."`, so a
  // module path or a property name stored in a variable is still the thing it
  // spells. The review wrote the call as `const g = await import(p); g[k]({})`
  // and every rule below read an identifier where it wanted a literal.
  const constantStrings = new Map();
  // Identifiers bound to a module loaded at run time, whatever specifier was
  // used. A computed key on one of these whose value this pass cannot work out
  // is refused rather than passed over: that is the shape the seal is reached
  // through, and "cannot tell" is not "safe".
  const runtimeModuleBindings = new Map();

  /**
   * Whether a specifier could name the module that declares the seal.
   *
   * A readable one is compared outright. An unreadable one is possible unless
   * its head pins a directory the seal does not live in.
   */
  /** The call under any number of `await`s and parentheses, or null. */
  const runtimeLoadCall = (node) => {
    let value = node;
    while (
      value &&
      (ts.isAwaitExpression(value) || ts.isParenthesizedExpression(value))
    ) {
      value = value.expression;
    }
    if (!value || !ts.isCallExpression(value)) return null;
    const loads =
      value.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(value.expression) && value.expression.text === "require");
    return loads ? value : null;
  };

  const couldBeSealModule = (node) => {
    const whole = literalTextOf(node);
    if (whole !== null) return specifierEndsWithSealModule(whole);
    // A hole can contain anything, including `../lib/marketingGuardCore`, so
    // the text in front of it fixes nothing: `@/locales/${segment}` reaches
    // this module when `segment` climbs out of the directory. The previous
    // version read the prefix as a fence and it is not one.
    //
    // So every unreadable specifier is possible, and the two files that
    // legitimately load a module by name are named below instead. A guess
    // about a path is not a permission.
    return true;
  };

  /**
   * The string a node spells, folding what can be folded.
   *
   * Concatenation and template literals are folded, so `"@/lib/" +
   * "marketingGuardCore"` and `` `${"sealMarketing"}TemplateProof` `` are the
   * strings they build. The fifth review's bypass was a constant alias; the
   * sixth's was a `+` between two halves of the same name.
   */
  const literalTextOf = (node) => {
    if (!node) return null;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) return constantStrings.get(node.text) ?? null;
    if (ts.isParenthesizedExpression(node)) return literalTextOf(node.expression);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = literalTextOf(node.left);
      const right = literalTextOf(node.right);
      return left === null || right === null ? null : left + right;
    }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const value = literalTextOf(span.expression);
        if (value === null) return null;
        text += value + span.literal.text;
      }
      return text;
    }
    return null;
  };
  let importsDriver = false;

  const addRuntimeSql = (kind, node) =>
    runtimeSql.push({ kind, line: lineOf(sourceFile, node) });

  const collectConstants = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      importsSealModule(node.moduleSpecifier.text) &&
      node.importClause?.namedBindings &&
      ts.isNamespaceImport(node.importClause.namedBindings)
    ) {
      runtimeModuleBindings.set(node.importClause.namedBindings.name.text, true);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      literalTextOf(node.initializer) !== null
    ) {
      // A name bound twice is a name whose value this pass cannot state, so it
      // is dropped rather than guessed at.
      constantStrings.set(
        node.name.text,
        constantStrings.has(node.name.text)
          ? null
          : literalTextOf(node.initializer),
      );
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      let value = node.initializer;
      while (ts.isAwaitExpression(value) || ts.isParenthesizedExpression(value)) {
        value = value.expression;
      }
      const call = runtimeLoadCall(node.initializer);
      if (call) {
        // `true` means "this could be the seal module": either the specifier
        // says so, or nothing in it says otherwise.
        runtimeModuleBindings.set(
          node.name.text,
          couldBeSealModule(call.arguments[0]),
        );
      } else if (
        ts.isIdentifier(node.initializer) &&
        runtimeModuleBindings.get(node.initializer.text) === true
      ) {
        // `const other = g` passes the module on under a second name, and the
        // review reached the seal through `const { [k]: mint } = g`.
        runtimeModuleBindings.set(node.name.text, true);
      }
    }
    ts.forEachChild(node, collectConstants);
  };
  // Two passes: constants first, so a `const` declared below its use is still
  // resolvable, then the same walk again now that the map is complete.
  collectConstants(sourceFile);
  collectConstants(sourceFile);

  const isPossibleModuleNamespace = (node) => {
    let value = node;
    while (value && (ts.isAwaitExpression(value) || ts.isParenthesizedExpression(value))) {
      value = value.expression;
    }
    if (!value) return false;
    if (ts.isIdentifier(value)) {
      return runtimeModuleBindings.get(value.text) === true;
    }
    const call = runtimeLoadCall(value);
    return !!call && couldBeSealModule(call.arguments[0]);
  };

  const visit = (node) => {
    if (ts.isIdentifier(node) && PROTECTED_EXPORTS.includes(node.text)) {
      const role = classifySealReference(node);
      const line = lineOf(sourceFile, node);
      if (role === "call") protectedCalls.push({ name: node.text, line });
      if (role === "escape") {
        protectedEscapes.push({ line, detail: `${node.text} used as a value` });
      }
      if (role === "declaration" && path !== PROTECTED_EXPORTS_DECLARED_IN) {
        protectedEscapes.push({ line, detail: `${node.text} declared here too` });
      }
    }

    // A computed key: `guard["sealMarketingTemplateProof"]({})`. The name is a
    // string here, not an identifier, so the classification above never sees
    // it -- and the review called the function through exactly this.
    if (ts.isElementAccessExpression(node)) {
      const key = literalTextOf(node.argumentExpression);
      if (PROTECTED_EXPORTS.includes(key)) {
        protectedEscapes.push({
          line: lineOf(sourceFile, node),
          detail: `${key} reached by a computed key`,
        });
      } else if (
        key === null &&
        ts.isIdentifier(node.expression) &&
        runtimeModuleBindings.get(node.expression.text) === true &&
        !TEMPLATE_SEAL_DYNAMIC_KEY_ALLOWLIST.includes(path)
      ) {
        // A key this pass cannot work out, on a module whose specifier it
        // cannot work out either. Both halves unknown is the shape the seal is
        // reached through, and "cannot tell" is not "safe". A load whose
        // specifier *is* readable and is not this module cannot hold the seal,
        // so the locale loaders next door are left alone.
        protectedEscapes.push({
          line: lineOf(sourceFile, node),
          detail: "a computed key on a module whose specifier is not readable",
        });
      }
    }

    if (isReflectGet(node)) {
      const key = literalTextOf(node.arguments[1]);
      if (PROTECTED_EXPORTS.includes(key)) {
        protectedEscapes.push({
          line: lineOf(sourceFile, node),
          detail: `${key} reached through Reflect.get`,
        });
      }
    }

    // A module namespace can yield a protected export without a member access:
    // descriptors expose `.value`, while enumeration hands every export to the
    // caller. If the namespace might be the Guard module, an unreadable key is
    // not evidence that the protected functions stayed hidden.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.arguments.length > 0 &&
      ts.isIdentifier(node.expression.expression) &&
      ((node.expression.expression.text === "Object" &&
        [
          "assign",
          "entries",
          "getOwnPropertyDescriptor",
          "getOwnPropertyDescriptors",
          "getOwnPropertyNames",
          "getOwnPropertySymbols",
          "keys",
          "values",
        ].includes(node.expression.name.text)) ||
        (node.expression.expression.text === "Reflect" &&
          ["getOwnPropertyDescriptor", "ownKeys"].includes(
            node.expression.name.text,
          ))) &&
      node.arguments.some((argument) => isPossibleModuleNamespace(argument)) &&
      !TEMPLATE_SEAL_DYNAMIC_KEY_ALLOWLIST.includes(path)
    ) {
      protectedEscapes.push({
        line: lineOf(sourceFile, node),
        detail: `${node.expression.getText(sourceFile)} inspects a possible Guard module namespace`,
      });
    }

    if (
      ts.isForInStatement(node) &&
      isPossibleModuleNamespace(node.expression) &&
      !TEMPLATE_SEAL_DYNAMIC_KEY_ALLOWLIST.includes(path)
    ) {
      protectedEscapes.push({
        line: lineOf(sourceFile, node),
        detail: "enumerates a possible Guard module namespace",
      });
    }

    if (
      ts.isSpreadAssignment(node) &&
      isPossibleModuleNamespace(node.expression) &&
      !TEMPLATE_SEAL_DYNAMIC_KEY_ALLOWLIST.includes(path)
    ) {
      protectedEscapes.push({
        line: lineOf(sourceFile, node),
        detail: "spreads a possible Guard module namespace",
      });
    }

    // The whole module bound to a name, however it is written. After this the
    // seal is a property of an object and no identifier rule can follow it.
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      importsSealModule(node.moduleSpecifier.text) &&
      node.importClause &&
      !node.importClause.isTypeOnly &&
      (node.importClause.name ||
        (node.importClause.namedBindings &&
          ts.isNamespaceImport(node.importClause.namedBindings)))
    ) {
      protectedEscapes.push({
        line: lineOf(sourceFile, node),
        detail: `binds all of ${node.moduleSpecifier.text} to a name`,
      });
    }

    // `require("...")` and `import("...")` do the same thing at run time.
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const specifier = literalTextOf(node.arguments[0]);
      if (specifier === null) {
        // A specifier nobody can read. Refused where the result is then read
        // by a computed key, which the rule above catches; noted here so the
        // two halves of the same bypass are visible together.
      } else if (importsSealModule(specifier)) {
        protectedEscapes.push({
          line: lineOf(sourceFile, node),
          detail: `loads ${specifier} at run time`,
        });
      }
    }

    // `const { [k]: mint } = await import(p)` -- the same reach as `g[k]`, one
    // syntax further along. The binding pattern is where the name is, and the
    // rule above was watching the variable a module was assigned to.
    //
    // Three shapes, all of which the review reached the sealer through: the
    // declaration, the assignment form `({ [k]: mint } = await import(p))`,
    // and a rest binding, which hands on every export at once including the
    // one this rule exists for.
    const bindingIsSealModule = (initializer) => {
      const call = runtimeLoadCall(initializer);
      if (call) return couldBeSealModule(call.arguments[0]);
      return (
        !!initializer &&
        ts.isIdentifier(initializer) &&
        runtimeModuleBindings.get(initializer.text) === true
      );
    };

    const refuseBindingPattern = (elements, initializer, isObjectLiteral) => {
      if (!bindingIsSealModule(initializer)) return;
      if (TEMPLATE_SEAL_DYNAMIC_KEY_ALLOWLIST.includes(path)) return;

      for (const element of elements) {
        if (isObjectLiteral) {
          if (ts.isSpreadAssignment(element)) {
            protectedEscapes.push({
              line: lineOf(sourceFile, element),
              detail: "a rest binding of a module loaded at run time",
            });
            continue;
          }
          if (!ts.isPropertyAssignment(element)) continue;
          if (!ts.isComputedPropertyName(element.name)) continue;
          const key = literalTextOf(element.name.expression);
          if (PROTECTED_EXPORTS.includes(key) || key === null) {
            protectedEscapes.push({
              line: lineOf(sourceFile, element),
              detail: "a computed binding from a module loaded at run time",
            });
          }
          continue;
        }

        if (element.dotDotDotToken) {
          protectedEscapes.push({
            line: lineOf(sourceFile, element),
            detail: "a rest binding of a module loaded at run time",
          });
          continue;
        }
        const name = element.propertyName;
        if (!name || !ts.isComputedPropertyName(name)) continue;
        const key = literalTextOf(name.expression);
        if (PROTECTED_EXPORTS.includes(key) || key === null) {
          protectedEscapes.push({
            line: lineOf(sourceFile, element),
            detail: "a computed binding from a module loaded at run time",
          });
        }
      }
    };

    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer
    ) {
      refuseBindingPattern(node.name.elements, node.initializer, false);
    }

    // `({ [k]: mint } = await import(p))` -- an assignment rather than a
    // declaration, which the declaration rule never looked at.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      let target = node.left;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      if (ts.isObjectLiteralExpression(target)) {
        refuseBindingPattern(target.properties, node.right, true);
      }
    }

    // `export *` and `export * as guard` re-export every protected function
    // without ever writing its name down. The latter has an exportClause -- a
    // NamespaceExport -- so checking only for a missing clause lets it escape.
    if (
      ts.isExportDeclaration(node) &&
      (!node.exportClause || ts.isNamespaceExport(node.exportClause)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      specifierEndsWithSealModule(node.moduleSpecifier.text)
    ) {
      protectedEscapes.push({
        line: lineOf(sourceFile, node),
        detail: `re-exports everything from ${node.moduleSpecifier.text}`,
      });
    }

    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      literals.push(node.text);
      if (ts.isStringLiteralLike(node) && !isInTypePosition(node)) {
        if (delegates.has(node.text)) {
          delegateNameLiterals.push({ delegate: node.text, line: lineOf(sourceFile, node) });
        }
        if (RUNTIME_SQL_MEMBERS.has(node.text)) addRuntimeSql(`"${node.text}"`, node);
      }
    }

    if (isMemberAccess(node)) {
      const name = memberName(node);
      const parent = node.parent;

      if (name && delegates.has(name)) {
        let operation;
        if (isMemberAccess(parent) && parent.expression === node) {
          operation = memberName(parent) ?? "<computed member>";
        } else {
          operation = `<escaped: ${ts.SyntaxKind[parent.kind]}>`;
        }
        delegateUses.push({ delegate: name, operation, line: lineOf(sourceFile, node) });
      }

      if (name && UNSAFE_RAW_MEMBERS.has(name)) addRuntimeSql(name, node);
      if (name && RUNTIME_SQL_MEMBERS.has(name) && !UNSAFE_RAW_MEMBERS.has(name) && !TAGGED_RAW_MEMBERS.has(name)) {
        addRuntimeSql(name, node);
      }
      if (
        name === "raw" &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Prisma"
      ) {
        addRuntimeSql("Prisma.raw", node);
      }
      if (name && TAGGED_RAW_MEMBERS.has(name)) {
        const isTag = ts.isTaggedTemplateExpression(parent) && parent.tag === node;
        const isInlineCall =
          ts.isCallExpression(parent) &&
          parent.expression === node &&
          isInlinePrismaSql(parent.arguments[0]);
        if (!isTag && !isInlineCall) addRuntimeSql(`${name}(non-inline)`, node);
      }

      if (ts.isElementAccessExpression(node) && !ts.isStringLiteralLike(node.argumentExpression)) {
        const onClient = CLIENT_RECEIVER_PATTERN.test(receiverName(node.expression) ?? "");
        const followedByWrite =
          isMemberAccess(parent) &&
          parent.expression === node &&
          WRITE_OPERATIONS.has(memberName(parent) ?? "");
        if (onClient || followedByWrite) {
          dynamicDelegateUses.push({
            detail: onClient ? "computed member on a client" : "computed member before a write operation",
            line: lineOf(sourceFile, node),
          });
        }
      }
    }

    if (isReflectGet(node)) {
      const [target, key] = node.arguments;
      if (
        target &&
        key &&
        !ts.isStringLiteralLike(key) &&
        CLIENT_RECEIVER_PATTERN.test(receiverName(target) ?? "")
      ) {
        dynamicDelegateUses.push({ detail: "Reflect.get on a client", line: lineOf(sourceFile, node) });
      }
    }

    // Destructuring, both the declaration form (`const { a } = x`) and the
    // assignment form (`({ a } = x)`), reads a member by name exactly as a
    // property access does.
    const destructured = (property, source, at) => {
      const name =
        property && (ts.isIdentifier(property) || ts.isStringLiteralLike(property))
          ? property.text
          : null;
      if (name && delegates.has(name)) {
        delegateUses.push({
          delegate: name,
          operation: "<destructured from its client>",
          line: lineOf(sourceFile, at),
        });
      }
      if (name && RUNTIME_SQL_MEMBERS.has(name)) addRuntimeSql(`destructured ${name}`, at);
      if (name === "raw" && source && receiverName(source) === "Prisma") {
        addRuntimeSql("destructured Prisma.raw", at);
      }
      if (
        property &&
        ts.isComputedPropertyName(property) &&
        source &&
        CLIENT_RECEIVER_PATTERN.test(receiverName(source) ?? "")
      ) {
        dynamicDelegateUses.push({
          detail: "computed destructuring key on a client",
          line: lineOf(sourceFile, at),
        });
      }
    };

    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const holder = node.parent.parent;
      const source =
        holder && (ts.isVariableDeclaration(holder) || ts.isParameter(holder))
          ? holder.initializer
          : undefined;
      destructured(node.propertyName ?? node.name, source, node);
    }

    if (ts.isObjectLiteralExpression(node)) {
      let target = node;
      while (ts.isParenthesizedExpression(target.parent)) target = target.parent;
      const assignment = target.parent;
      if (
        assignment &&
        ts.isBinaryExpression(assignment) &&
        assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        assignment.left === target
      ) {
        for (const property of node.properties) {
          if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
            destructured(property.name, assignment.right, property);
          }
        }
      }
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause &&
        (clause.isTypeOnly ||
          (!clause.name &&
            clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)));
      if (!typeOnly && isDatabaseDriverModule(node.moduleSpecifier.text)) {
        importsDriver = true;
        addRuntimeSql(`import ${node.moduleSpecifier.text}`, node);
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      isDatabaseDriverModule(node.arguments[0].text)
    ) {
      importsDriver = true;
      addRuntimeSql(`import ${node.arguments[0].text}`, node);
    }

    if (isReflectGet(node)) {
      const [, key] = node.arguments;
      if (key && ts.isStringLiteralLike(key) && RUNTIME_SQL_MEMBERS.has(key.text)) {
        // Counted once here as well as by the literal rule: Reflect.get with a
        // literal method name is the form a reviewer most needs to see.
        addRuntimeSql(`Reflect.get ${key.text}`, node);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    delegateUses,
    delegateNameLiterals,
    dynamicDelegateUses,
    literalText: literals.join("\n"),
    runtimeSql,
    protectedCalls,
    protectedEscapes,
    importsDriver,
  };
};

/**
 * SQL with its comments removed and everything else kept.
 *
 * `--` and `/* ... *\/` start a comment only outside a string literal, a quoted
 * identifier and a dollar-quoted body; block comments nest, as in PostgreSQL.
 * Keeping string contents is deliberate: a write verb inside a function body
 * is still a write.
 */
export const sqlWithoutComments = (text) => {
  let output = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "-" && next === "-") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      let depth = 1;
      index += 2;
      while (index < text.length && depth > 0) {
        if (text[index] === "/" && text[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (text[index] === "*" && text[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      output += " ";
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      // E'...' strings take backslash escapes, so `E'\''` does not end at the
      // second quote. An E that is the tail of an identifier is not a prefix.
      const previous = text[index - 1] ?? "";
      const escapeString =
        quote === "'" &&
        (previous === "E" || previous === "e") &&
        !/[A-Za-z0-9_$]/.test(text[index - 2] ?? "");
      output += char;
      index += 1;
      while (index < text.length) {
        output += text[index];
        if (escapeString && text[index] === "\\" && index + 1 < text.length) {
          output += text[index + 1];
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          if (text[index + 1] === quote) {
            output += text[index + 1];
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === "$") {
      // A dollar-quote tag is empty or an identifier (letters, digits after the
      // first character, underscores). `$1` is a parameter, not a tag.
      const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(text.slice(index));
      if (tag) {
        const close = text.indexOf(tag[0], index + tag[0].length);
        const end = close === -1 ? text.length : close + tag[0].length;
        output += text.slice(index, end);
        index = end;
        continue;
      }
    }
    output += char;
    index += 1;
  }
  return output;
};

const normaliseSqlText = (text) => text.toLowerCase().split('"').join("").split("`").join("");

/** Per protected table: how often the text names it, and how many write verbs it holds. */
export const rawSqlTableHits = (text) => {
  const normalised = normaliseSqlText(text);
  const writeVerbs = (normalised.match(WRITE_VERB_PATTERN) ?? []).length;
  if (writeVerbs === 0) return [];
  return PROTECTED_TABLES.map((entry) => ({
    table: entry.table,
    tableMentions: (
      normalised.match(new RegExp(`\\b${entry.table.toLowerCase()}\\b`, "g")) ?? []
    ).length,
    writeVerbs,
  })).filter((hit) => hit.tableMentions > 0);
};

const keyOf = (...parts) => parts.join(" :: ");

/** Content fingerprint that ignores line-ending differences between checkouts. */
export const sourceFingerprint = (text) =>
  createHash("sha256").update(text.split("\r\n").join("\n")).digest("hex");

/**
 * The transaction-local setting that lets retention past the append-only
 * history trigger and the content purge refusal.
 *
 * The application uses one database role, so setting it is not a privilege
 * anybody has to be granted -- which is exactly why naming it has to be a
 * reviewed act. A module that can reach the name can turn retention mode on for
 * its own transaction, and the triggers would then apply the retention rules to
 * whatever it was doing. Both spellings are counted: the string itself, and the
 * constant that holds it, because passing the constant to `set_config()` needs
 * no literal anywhere.
 *
 * The retention module that will legitimately set it is S3; until it exists the
 * only entries here are the declaration and the migration that reads it.
 */
export const RETENTION_SETTING_TOKENS = [
  "tomverse.marketing_retention_compaction",
  "MARKETING_RETENTION_SETTING",
];

/**
 * 7. **guard-seal.** Each name in `PROTECTED_EXPORTS` mints a value the Guard
 * trusts: an approved template, resolved facts, or server-resolved context. A
 * `WeakSet` proves where an object came from and says nothing about who called
 * the exported function, so every protected name uses the same syntax rules
 * and exact call-site allowlist.
 *
 * **Calls, classified from the syntax tree -- not mentions.** The first
 * version counted the name as a string, and the review walked through it: put
 * `export const mint = sealMarketingTemplateProof` in an allowed file, call
 * `mint()` from anywhere, and every count still matched. So each reference is
 * one of four things. A declaration, in the one file entitled to declare it.
 * An import under the same name. A direct call, which is what the allowlist
 * counts. And anything else -- an alias, a re-export, a namespace call, a
 * renamed import, `export *` from the declaring module -- is an escape, which
 * is a finding whatever the allowlist says, because after it the value is
 * somewhere this rule cannot see.
 */
/**
 * Files that may read a property of a module they loaded by a computed name.
 *
 * The rule above refuses that shape, because both halves being unknown is how
 * the seal is reached. These two build a locale table: they import
 * `../locales/<name>.ts` and read the bundle out of it by the same name. They
 * are in `scripts/`, they are not the product, and neither has a line that
 * could reach a database. Named here rather than inferred from the shape of
 * their specifier, which is what a reviewer showed is not a fence.
 */
export const TEMPLATE_SEAL_DYNAMIC_KEY_ALLOWLIST = Object.freeze([
  "scripts/check-locale-translation.mjs",
  "scripts/check-starter-catalog.mjs",
]);

/**
 * Who may say that a fact was resolved.
 *
 * The Guard reads `known`, `featurePublic` and the rest out of this bundle and
 * decides on them, so minting one is deciding what is true. The registries are
 * read by one file, and that file is the only one that may seal.
 */
export const PROTECTED_EXPORT_ALLOWLIST = [
  {
    name: "sealMarketingFacts",
    path: "lib/marketingFactResolution.ts",
    count: 1,
    reason:
      "The resolver that asks the registries, which is the only code entitled to say what they answered.",
  },
  {
    name: "sealMarketingTemplateProof",
    path: "lib/marketingTemplates.ts",
    count: 1,
    reason:
      "The loader that walks the approval chain, which is the only code entitled to say a template stood.",
  },
  {
    name: "sealMarketingGuardContext",
    path: "lib/marketingGuardContext.ts",
    count: 1,
    reason:
      "The server-only resolver that owns the S1 fail-closed alert and category answers.",
  },
];

// Tests are outside this check's scan, so the suite that proves the autonomous
// path is reachable does not need an entry -- and could not be given one. What
// the rule governs is the production surface, where an unlisted call site is
// a publication nobody approved.

export const RETENTION_SETTING_ALLOWLIST = [
  {
    path: "lib/marketingAutomationSchema.ts",
    count: 2,
    reason:
      "Where the constant is declared: the exported name and its value. Declaring it is not setting it.",
  },
  {
    path: "prisma/migrations/20260918120000_marketing_automation_tables/migration.sql",
    count: 4,
    reason:
      "The triggers that read the setting to decide whether retention is running. Reading it is the check; setting it is what this rule is about.",
  },
];

const retentionSettingMentions = (text) =>
  RETENTION_SETTING_TOKENS.reduce(
    (total, token) => total + text.split(token).length - 1,
    0
  );

export const checkProtectedTableWriters = ({ sources }) => {
  const findings = [];
  const retentionSettingByPath = new Map();
  const protectedCallsByKey = new Map();
  const rawSqlHits = new Map();
  const runtimeSqlByPath = new Map();
  const delegateNamesByPath = new Map();
  const driverFingerprints = new Map();

  for (const { path, text } of sources) {
    if (isExcluded(path)) continue;

    const retentionMentions = retentionSettingMentions(text);
    if (retentionMentions > 0) retentionSettingByPath.set(path, retentionMentions);

    if (path.endsWith(".sql")) {
      const sql = sqlWithoutComments(text);
      for (const hit of rawSqlTableHits(sql)) {
        rawSqlHits.set(keyOf(path, hit.table), { path, ...hit });
      }
      // EXECUTE runs a statement assembled at run time, whose table name no
      // text rule can see: inventoried like runtime SQL in code. EXECUTE
      // FUNCTION / PROCEDURE in a trigger definition names a fixed function and
      // is not counted.
      const executes = sql.toLowerCase().match(/\bexecute\b(?!\s+(?:function|procedure)\b)/g) ?? [];
      if (executes.length > 0) {
        runtimeSqlByPath.set(
          path,
          executes.map(() => ({ kind: "EXECUTE", line: 0 }))
        );
      }
      continue;
    }

    const analysis = analyseSource(path, text);
    const writerOf = (delegate) =>
      PROTECTED_TABLES.find((entry) => entry.delegate === delegate);

    for (const use of analysis.delegateUses) {
      const protectedTable = writerOf(use.delegate);
      if (protectedTable.writers.includes(path)) continue;
      if (READ_OPERATIONS.has(use.operation)) continue;
      findings.push({
        rule: "delegate-write",
        path,
        line: use.line,
        detail: `${protectedTable.table}: ${use.delegate}.${use.operation}`,
      });
    }

    for (const literal of analysis.delegateNameLiterals) {
      if (writerOf(literal.delegate).writers.includes(path)) continue;
      const key = keyOf(path, literal.delegate);
      delegateNamesByPath.set(key, [...(delegateNamesByPath.get(key) ?? []), literal.line]);
    }

    for (const use of analysis.dynamicDelegateUses) {
      findings.push({ rule: "dynamic-delegate", path, line: use.line, detail: use.detail });
    }

    for (const hit of rawSqlTableHits(analysis.literalText)) {
      rawSqlHits.set(keyOf(path, hit.table), { path, ...hit });
    }

    for (const call of analysis.protectedCalls) {
      const key = keyOf(path, call.name);
      protectedCallsByKey.set(key, (protectedCallsByKey.get(key) ?? 0) + 1);
    }
    for (const escape of analysis.protectedEscapes) {
      findings.push({
        rule: "guard-seal",
        path,
        line: escape.line,
        detail: escape.detail,
      });
    }

    if (analysis.runtimeSql.length > 0) runtimeSqlByPath.set(path, analysis.runtimeSql);
    if (analysis.importsDriver) driverFingerprints.set(path, sourceFingerprint(text));
  }

  const scannedPaths = new Set(sources.map((source) => source.path));
  const missingNote = (path) => (scannedPaths.has(path) ? "" : " (file was not scanned)");

  const allowedNames = new Map(
    DELEGATE_NAME_ALLOWLIST.map((entry) => [keyOf(entry.path, entry.delegate), entry])
  );
  for (const [key, lines] of delegateNamesByPath) {
    const expected = allowedNames.get(key)?.count ?? 0;
    if (lines.length === expected) continue;
    const [path, delegate] = key.split(" :: ");
    findings.push({
      rule: "delegate-name",
      path,
      line: lines[0],
      detail: `${lines.length} literal(s) naming ${delegate}, allowlist says ${expected} (lines ${lines.join(", ")})`,
    });
  }
  for (const [key, entry] of allowedNames) {
    if (delegateNamesByPath.has(key)) continue;
    findings.push({
      rule: "delegate-name",
      path: entry.path,
      detail: `allowlist says ${entry.count} literal(s) naming ${entry.delegate}, found 0${missingNote(entry.path)}; remove the entry`,
    });
  }

  const allowedRaw = new Map(
    RAW_SQL_ALLOWLIST.map((entry) => [keyOf(entry.path, entry.table), entry])
  );
  for (const [key, hit] of rawSqlHits) {
    const entry = allowedRaw.get(key);
    if (
      entry &&
      entry.tableMentions === hit.tableMentions &&
      entry.writeVerbs === hit.writeVerbs
    ) {
      continue;
    }
    findings.push({
      rule: "raw-sql",
      path: hit.path,
      detail: entry
        ? `${hit.table}: ${hit.tableMentions} mention(s) and ${hit.writeVerbs} write verb(s), allowlist says ${entry.tableMentions} and ${entry.writeVerbs}`
        : `literals name ${hit.table} (${hit.tableMentions}) beside ${hit.writeVerbs} write verb(s)`,
    });
  }
  for (const [key, entry] of allowedRaw) {
    if (rawSqlHits.has(key)) continue;
    findings.push({
      rule: "raw-sql",
      path: entry.path,
      detail: `allowlist entry for ${entry.table} no longer matches${missingNote(entry.path)}; remove it`,
    });
  }

  const allowedRuntime = new Map(RUNTIME_SQL_ALLOWLIST.map((entry) => [entry.path, entry]));
  for (const [path, uses] of runtimeSqlByPath) {
    const expected = allowedRuntime.get(path)?.count ?? 0;
    if (uses.length === expected) continue;
    findings.push({
      rule: "runtime-sql",
      path,
      line: uses[0].line,
      detail: `${uses.length} use(s), allowlist says ${expected}: ${uses
        .map((use) => `${use.kind}@${use.line}`)
        .join(", ")}`,
    });
  }
  // A database driver reaches the database without Prisma, and what such a
  // file does with it is ordinary code no rule here reads. So a driver file is
  // pinned by content: any edit fails until the fingerprint is re-reviewed.
  for (const [path, fingerprint] of driverFingerprints) {
    const entry = allowedRuntime.get(path);
    if (entry?.sha256 === fingerprint) continue;
    findings.push({
      rule: "runtime-sql",
      path,
      detail: entry?.sha256
        ? `imports a database driver and changed since review: sha256 ${fingerprint}, allowlist says ${entry.sha256}`
        : `imports a database driver; the allowlist entry needs sha256 ${fingerprint} after review`,
    });
  }

  const allowedRetention = new Map(
    RETENTION_SETTING_ALLOWLIST.map((entry) => [entry.path, entry])
  );
  for (const [path, mentions] of retentionSettingByPath) {
    const expected = allowedRetention.get(path)?.count ?? 0;
    if (mentions === expected) continue;
    findings.push({
      rule: "retention-setting",
      path,
      detail: `names the retention setting ${mentions} time(s), allowlist says ${expected}`,
    });
  }
  for (const entry of RETENTION_SETTING_ALLOWLIST) {
    if (retentionSettingByPath.has(entry.path)) continue;
    findings.push({
      rule: "retention-setting",
      path: entry.path,
      detail: `allowlist says ${entry.count} mention(s), found 0${missingNote(entry.path)}; remove the entry`,
    });
  }

  const allowedProtectedExport = new Map(
    PROTECTED_EXPORT_ALLOWLIST.map((entry) => [keyOf(entry.path, entry.name), entry])
  );
  for (const [key, calls] of protectedCallsByKey) {
    const entry = allowedProtectedExport.get(key);
    const [path, name] = key.split(" :: ");
    const expected = entry?.count ?? 0;
    if (calls === expected) continue;
    findings.push({
      rule: "guard-seal",
      path,
      detail: `calls ${name} ${calls} time(s), allowlist says ${expected}`,
    });
  }
  for (const entry of PROTECTED_EXPORT_ALLOWLIST) {
    if (protectedCallsByKey.has(keyOf(entry.path, entry.name))) continue;
    findings.push({
      rule: "guard-seal",
      path: entry.path,
      detail: `allowlist says ${entry.count} ${entry.name} call(s), found 0${missingNote(entry.path)}; remove the entry`,
    });
  }

  for (const entry of RUNTIME_SQL_ALLOWLIST) {
    if (runtimeSqlByPath.has(entry.path)) continue;
    findings.push({
      rule: "runtime-sql",
      path: entry.path,
      detail: `allowlist says ${entry.count} use(s), found 0${missingNote(entry.path)}; remove the entry`,
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
    "Protected tables have one writer module each:",
    ...PROTECTED_TABLES.map(
      (entry) => `  ${entry.table}: ${entry.writers.join(", ")} (${entry.contract})`
    ),
    "",
    "For the audit log, record an administrator action with writeAdminAuditLog and a",
    "system action with writeSystemAuditLog, in the transaction of the change.",
    "This check refuses the direct writes it can read; it does not by itself prove",
    "no other write exists (see \"The guarantee\" in this file).",
    "A reviewed exception goes in scripts/check-protected-table-writers-core.mjs with",
    "its exact count and the reason it cannot reach a protected table.",
  ].join("\n");
