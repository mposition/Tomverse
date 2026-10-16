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
  "AmuxV22TaskRecoveryInspectionRequest",
  "AmuxV22TaskRecoveryEvidence",
  "AmuxV22TaskRecoveryApproval",
  "AmuxV22TaskRecoveryRiskAcceptance",
  "AmuxV22ReadOnlyLaunchCheck",
  "AmuxV22ReadOnlyLaunchProof",
  "AmuxV22ApiModelAccessEvidence",
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
    table: "AmuxIdeaOperatingScopeSetting",
    delegate: "amuxIdeaOperatingScopeSetting",
    writers: ["lib/amux/ideaOperatingScopeStore.ts"],
    contract: "docs/policy/amux-intake.md v19",
  },
  {
    table: "AmuxIdeaAnalysisBudgetSetting",
    delegate: "amuxIdeaAnalysisBudgetSetting",
    writers: ["lib/amux/ideaAnalysisBudgetSettingStore.ts"],
    contract: "docs/policy/amux-intake.md v16",
  },
  {
    table: "AgentDigestItem",
    delegate: "agentDigestItem",
    writers: ["lib/agentDigestStore.ts"],
    contract: "docs/policy/qa-release-agent.md §4",
  },
  {
    table: "QaReleaseOperatorControl",
    delegate: "qaReleaseOperatorControl",
    writers: ["lib/qaReleaseOperatorControlStore.ts"],
    contract: "docs/policy/qa-release-agent.md §6",
  },
  {
    table: "QaReleaseMergeAttempt",
    delegate: "qaReleaseMergeAttempt",
    writers: ["lib/qaReleaseMergeLaneStore.ts", "lib/qaReleaseMergeLaneRelease.ts"],
    contract: "docs/policy/qa-release-agent.md §8",
  },
  {
    table: "QaReleaseMergeLaneLatch",
    delegate: "qaReleaseMergeLaneLatch",
    writers: ["lib/qaReleaseMergeLaneStore.ts", "lib/qaReleaseMergeLaneRelease.ts"],
    contract: "docs/policy/qa-release-agent.md §8",
  },
  {
    table: "AdminAuditLog",
    delegate: "adminAuditLog",
    writers: ["lib/adminAudit.ts"],
    contract: "docs/policy/marketing-automation.md §6",
  },
  {
    table: "PromptRefinerAutoBudgetWindow",
    delegate: "promptRefinerAutoBudgetWindow",
    writers: ["lib/promptRefinerAutoBudgetHold.ts"],
    contract: "docs/policy/prompt-refiner-vnext-full-auto-release-exception-v1.md",
  },
  {
    table: "PromptRefinerChatScope",
    delegate: "promptRefinerChatScope",
    writers: ["lib/promptRefinerChatExecutionStore.ts"],
    contract: "docs/ui-contracts/prompt-refiner-suggestion.md §2–3",
  },
  ...["PromptRefinerProductExecutionReceipt", "PromptRefinerProductExecutionContext", "PromptRefinerProductDispositionReceipt"].map(table => ({
    table,
    delegate: table[0].toLowerCase() + table.slice(1),
    writers: ["lib/promptRefinerProductReceiptStore.ts"],
    contract: "docs/ui-contracts/prompt-refiner-suggestion.md",
  })),
  {
    table: "PromptRefinerProductAttempt", delegate: "promptRefinerProductAttempt",
    writers: ["lib/promptRefinerChatExecutionStore.ts", "lib/promptRefinerProductReceiptStore.ts", "lib/chatDraftMessageConsume.ts"],
    contract: "docs/ui-contracts/prompt-refiner-suggestion.md",
  },
  {
    table: "PromptRefinerProductOperationalGuard", delegate: "promptRefinerProductOperationalGuard",
    writers: ["lib/promptRefinerProductOperationalGuard.ts"],
    contract: "docs/policy/chat-operator-controlled-availability-v3.md",
  },
  {
    table: "PromptRefinerChatSuggestion",
    delegate: "promptRefinerChatSuggestion",
    writers: ["lib/promptRefinerChatExecutionStore.ts"],
    contract: "docs/ui-contracts/prompt-refiner-suggestion.md §2–3",
  },
  {
    table: "PromptRefinerAutoBudgetHold",
    delegate: "promptRefinerAutoBudgetHold",
    writers: ["lib/promptRefinerAutoBudgetHold.ts"],
    contract: "docs/policy/prompt-refiner-vnext-full-auto-release-exception-v1.md",
  },
  {
    table: "MarketingLlmCall",
    delegate: "marketingLlmCall",
    writers: ["lib/marketingLlmBudgetStore.ts"],
    contract: "docs/policy/marketing-automation.md §5",
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
  {
    table: "ProductResearchObservation",
    delegate: "productResearchObservation",
    writers: ["lib/productResearchObservationStore.ts"],
    contract: "docs/policy/product-research-agent.md §4",
  },
  {
    table: "SupportTriageRun",
    delegate: "supportTriageRun",
    writers: ["lib/supportTriageRunStore.ts", "lib/supportTriageRetention.ts"],
    contract: "docs/policy/support-triage.md §4",
  },
  {
    table: "EngineeringAgentRun",
    delegate: "engineeringAgentRun",
    writers: ["lib/engineeringAgentStore.ts"],
    contract: "docs/policy/engineering-agent.md §11",
  },
  {
    table: "EngineeringAgentWorkItem",
    delegate: "engineeringAgentWorkItem",
    writers: ["lib/engineeringAgentStore.ts"],
    contract: "docs/policy/engineering-agent.md §11",
  },
  {
    table: "EngineeringAgentApproval",
    delegate: "engineeringAgentApproval",
    writers: ["lib/engineeringAgentStore.ts"],
    contract: "docs/policy/engineering-agent.md §11",
  },
  {
    table: "EngineeringAgentCapability",
    delegate: "engineeringAgentCapability",
    writers: ["lib/engineeringAgentStore.ts"],
    contract: "docs/policy/engineering-agent.md §11",
  },
  {
    table: "EngineeringAgentBinding",
    delegate: "engineeringAgentBinding",
    writers: ["lib/engineeringAgentStore.ts"],
    contract: "docs/policy/engineering-agent.md §11",
  },
  {
    table: "EngineeringAgentRegistration",
    delegate: "engineeringAgentRegistration",
    writers: ["lib/engineeringAgentStore.ts"],
    contract: "docs/policy/engineering-agent.md §11",
  },
  {
    table: "EngineeringAgentRequest",
    delegate: "engineeringAgentRequest",
    writers: ["lib/engineeringAgentStore.ts"],
    contract: "docs/policy/engineering-agent.md §11",
  },
  {
    table: "AmuxDecisionMakerSwitchEvent",
    delegate: "amuxDecisionMakerSwitchEvent",
    writers: ["lib/amux/decisionMakerSwitchStore.ts"],
    contract: "docs/policy/amux-decision-maker.md §10",
  },
  {
    table: "AmuxWorkerRegistryEvent",
    delegate: "amuxWorkerRegistryEvent",
    writers: ["lib/amux/workerRegistryStore.ts"],
    contract: "docs/policy/development-agent-orchestration.md 버전 31",
  },
  {
    table: "AmuxWorkerCapabilityEvent",
    delegate: "amuxWorkerCapabilityEvent",
    writers: ["lib/amux/workerCapabilityStore.ts"],
    contract: "docs/policy/development-agent-orchestration.md 버전 35",
  },
  {
    table: "AmuxCardDisplayKeyCounter",
    delegate: "amuxCardDisplayKeyCounter",
    writers: ["lib/amux/cardDisplayKeyAllocator.ts"],
    contract: "docs/policy/amux-card-display-key.md §3",
  },
  {
    table: "AmuxDecisionMakerRequest",
    delegate: "amuxDecisionMakerRequest",
    writers: ["lib/amux/decisionMakerRequestStore.ts"],
    contract: "docs/policy/amux-decision-maker.md §10",
  },
  {
    table: "AmuxDecisionMakerRequestEvent",
    delegate: "amuxDecisionMakerRequestEvent",
    writers: ["lib/amux/decisionMakerRequestStore.ts"],
    contract: "docs/policy/amux-decision-maker.md §10",
  },
  {
    table: "AmuxDecisionMakerBody",
    delegate: "amuxDecisionMakerBody",
    writers: ["lib/amux/decisionMakerBodyStore.ts"],
    contract: "docs/policy/amux-decision-maker.md §10",
  },
  {
    table: "AmuxDecisionMakerRetentionEvent",
    delegate: "amuxDecisionMakerRetentionEvent",
    writers: ["lib/amux/decisionMakerBodyStore.ts"],
    contract: "docs/policy/amux-decision-maker.md §10",
  },
  {
    table: "AmuxDecisionMakerDigestKeyEvent",
    delegate: "amuxDecisionMakerDigestKeyEvent",
    writers: ["lib/amux/decisionMakerBodyStore.ts"],
    contract: "docs/policy/amux-decision-maker.md §10",
  },
  {
    table: "AmuxDecisionMakerResultDetail",
    delegate: "amuxDecisionMakerResultDetail",
    writers: ["lib/amux/decisionMakerBodyStore.ts"],
    contract: "docs/policy/amux-decision-maker.md §10",
  },
  {
    table: "AmuxDecisionMakerJudgment",
    delegate: "amuxDecisionMakerJudgment",
    writers: ["lib/amux/decisionMakerJudgmentStore.ts"],
    contract: "docs/policy/amux-decision-maker.md §10",
  },
  {
    table: "AmuxDecisionMakerDeliveryEvent",
    delegate: "amuxDecisionMakerDeliveryEvent",
    writers: ["lib/amux/decisionMakerJudgmentStore.ts"],
    contract: "docs/policy/amux-decision-maker.md §10",
  },
  ...[
    "AmuxV22TaskRecoveryInspectionRequest",
    "AmuxV22TaskRecoveryEvidence",
    "AmuxV22TaskRecoveryApproval",
    "AmuxV22TaskRecoveryRiskAcceptance",
    "AmuxV22ReadOnlyLaunchCheck",
    "AmuxV22ReadOnlyLaunchProof",
  ].map((table) => ({
    table,
    delegate: table[0].toLowerCase() + table.slice(1),
    writers: ["lib/amux/v22TaskRecoveryService.ts"],
    contract: "docs/policy/development-agent-orchestration.md 버전 36-39",
  })),
  {
    table: "AmuxV22ApiModelAccessEvidence",
    delegate: "amuxV22ApiModelAccessEvidence",
    writers: ["lib/amux/v22ApiModelAccessService.ts"],
    contract: "docs/policy/development-agent-orchestration.md 버전 42",
  },
  {
    table: "AmuxCliUsageEvent",
    delegate: "amuxCliUsageEvent",
    writers: ["lib/amux/cliUsageLedgerStore.ts", "lib/amux/cliUsageRetention.ts"],
    contract: "docs/policy/development-agent-orchestration.md 버전 40",
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
    prefix: "vendor/amux/",
    extension: ".sql",
    reason:
      "The independent AMUX workspace uses local SQLite. Only its SQL is excluded; JS/TS files remain scanned for product database writes.",
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
    path: "lib/accountDataExportDomains.ts",
    delegate: "amuxIdeaOperatingScopeSetting",
    count: 1,
    reason: "Account export domain key only; no client is indexed and no database connection or writer exists in this metadata file.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    delegate: "amuxIdeaAnalysisBudgetSetting",
    count: 1,
    reason: "Account export domain key only; no client is indexed and no database connection or writer exists in this metadata file.",
  },
  ...["promptRefinerChatScope", "promptRefinerChatSuggestion", "promptRefinerProductAttempt"].map(delegate => ({
    path: "lib/accountDataExportDomains.ts", delegate, count: 1,
    reason: "Account export domain key only; it is never used to index a client.",
  })),
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
  {
    path: "lib/accountDataExportDomains.ts",
    delegate: "engineeringAgentApproval",
    count: 1,
    reason: "The data-domain registry's domain key. No client is indexed with it.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    delegate: "amuxDecisionMakerSwitchEvent",
    count: 1,
    reason: "The data-domain registry's domain key. No client is indexed with it.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    delegate: "amuxWorkerRegistryEvent",
    count: 1,
    reason: "The data-domain registry's domain key. No client is indexed with it.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    delegate: "amuxWorkerCapabilityEvent",
    count: 1,
    reason: "The data-domain registry's domain key. No client is indexed with it.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    delegate: "amuxDecisionMakerBody",
    count: 1,
    reason: "The data-domain registry's domain key. No client is indexed with it.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    delegate: "amuxDecisionMakerRetentionEvent",
    count: 1,
    reason: "The data-domain registry's domain key. No client is indexed with it.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    delegate: "amuxDecisionMakerJudgment",
    count: 1,
    reason: "The data-domain registry's domain key. No client is indexed with it.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    delegate: "amuxDecisionMakerDeliveryEvent",
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
    path: "prisma/migrations/20261016040000_amux_v19_session_submission/migration.sql",
    table: "AmuxIdeaOperatingScopeSetting",
    tableMentions: 3,
    writeVerbs: 9,
    reason:
      "The v19 session-submission migration adds one restrictive scope foreign key and its submission guard reads the referenced and latest immutable scope rows. It never writes an operating-scope row; the write verbs are DDL, trigger events and the guard's refused UPDATE path on AmuxIdeaSubmission.",
  },
  {
    path: "prisma/migrations/20261016040000_amux_v19_session_submission/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 9,
    reason:
      "The v19 session-submission migration adds one restrictive audit foreign key and its guard reads the same-transaction canonical system audit before accepting AmuxIdeaSubmission. It never writes AdminAuditLog; the write verbs are DDL, trigger events and the guarded submission update path.",
  },
  ...[
    "AmuxV22TaskRecoveryInspectionRequest",
    "AmuxV22TaskRecoveryApproval",
    "AmuxV22TaskRecoveryRiskAcceptance",
  ].map((table) => ({
    path: "lib/accountDataExportDomains.ts",
    table,
    tableMentions: 1,
    writeVerbs: 3,
    reason:
      "The data-domain registry names this operator recovery model as prismaModel only, and other domains' prose uses delete and update. It builds no SQL and opens no database connection.",
  })),
  {
    path: "lib/accountDataExportDomains.ts",
    table: "AmuxWorkerCapabilityEvent",
    tableMentions: 2,
    writeVerbs: 3,
    reason:
      "The data-domain registry names the worker capability model as its domain key and as prismaModel, and other domains' prose uses delete and update. It builds no SQL and opens no database connection.",
  },
  {
    path: "prisma/migrations/20261013100000_amux_worker_capability/migration.sql",
    table: "AmuxWorkerCapabilityEvent",
    tableMentions: 9,
    writeVerbs: 7,
    reason:
      "Creates the capability event table, its indexes, its foreign key to the audit log and the guard trigger that binds every tag and v22 role to the worker's current ceiling, binds an insert to its audit row and refuses every update and delete. It reads the worker's newest capability revision in the guard and writes no row.",
  },
  {
    path: "prisma/migrations/20261013100000_amux_worker_capability/migration.sql",
    table: "AmuxWorkerRegistryEvent",
    tableMentions: 1,
    writeVerbs: 7,
    reason:
      "The capability guard reads the worker's newest registry event (class, ceiling, desired state) after the registry's own advisory lock, to refuse a capability the ceiling or class does not allow. A SELECT in EXECUTE; nothing here writes a registry event.",
  },
  {
    path: "prisma/migrations/20261013100000_amux_worker_capability/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 7,
    reason:
      "The capability migration (orchestration policy version 35, section 2). Its two AdminAuditLog mentions are the restrictive foreign key from auditLogId and the one SELECT EXISTS read in the guard that refuses an event whose audit row of the same transaction, person and action is missing. It never writes AdminAuditLog; its write verbs are the ALTER TABLE adding the key with ON DELETE / ON UPDATE RESTRICT, the trigger events, the guard's TG_OP comparison and words of comments.",
  },
  {
    path: "lib/amux/workerCapabilityStore.ts",
    table: "AmuxWorkerCapabilityEvent",
    tableMentions: 4,
    writeVerbs: 2,
    reason:
      "The capability event table's single writer (orchestration policy version 35, section 2). Its raw SQL is two constant SELECTs (the newest capability of every worker, and one worker's newest revision), one constant INSERT ... RETURNING and one constant SELECT subquery (the newest capability of every worker as JSON) that the assignment catalog reader composes into its one statement (version 35, section 3); every value is a bound parameter. The second verb is the word in the error raised when the insert returns no row. It never updates or deletes an event, and it writes the audit log only through writeAdminAuditLog.",
  },
  {
    path: "lib/amux/cardDisplayKeyAllocator.ts",
    table: "AmuxCardDisplayKeyCounter",
    tableMentions: 2,
    writeVerbs: 2,
    reason:
      "The card number counter's single writer (docs/policy/amux-card-display-key.md §3). Its raw SQL is one constant INSERT ... ON CONFLICT DO UPDATE ... RETURNING whose only value, the prefix, is a bound parameter; the two table mentions are the INSERT target and the qualified column in the increment. Its other raw SQL is a read-only SELECT of taken Feature prefixes from AmuxPortfolioNode (docs/policy/amux-intake.md v17 item 3). It never deletes a counter.",
  },
  {
    path: "lib/amux/cardDisplayKeyBackfillService.ts",
    table: "AmuxCardDisplayKeyCounter",
    tableMentions: 1,
    writeVerbs: 2,
    reason:
      "The card number backfill (docs/policy/amux-card-display-key.md §5) names the counter's delegate once, in the Pick of the reader type, to read every counter with findMany for the plan. It writes counters only through allocateAmuxCardDisplayKey; its raw UPDATEs set AmuxPortfolioNode.displayPrefix and AmuxWorkItem.displayKey.",
  },
  {
    path: "prisma/migrations/20261014100000_amux_card_display_key/migration.sql",
    table: "AmuxCardDisplayKeyCounter",
    tableMentions: 3,
    writeVerbs: 20,
    reason:
      "The card number migration (docs/policy/amux-card-display-key.md S2). It creates the counter table and its two triggers, which refuse an insert not at 1, an update that does anything but add one, every delete and every truncate. Its write verbs are the trigger events, the guard's TG_OP comparisons, the column ALTER TABLEs, the issued-number ledger's trigger INSERT (into that ledger, not the counter), comments about INSERT ... ON CONFLICT and other words of comments; it writes no counter row.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    table: "AmuxWorkerRegistryEvent",
    tableMentions: 2,
    writeVerbs: 3,
    reason:
      "The data-domain registry names the worker registry model as its domain key and as prismaModel, and other domains' prose uses delete and update. It builds no SQL and opens no database connection.",
  },
  {
    path: "prisma/migrations/20261012100000_amux_worker_registry/migration.sql",
    table: "AmuxWorkerRegistryEvent",
    tableMentions: 9,
    writeVerbs: 23,
    reason:
      "Creates the registry event table, its indexes, its foreign key to the audit log and the guard trigger that holds the change rule, binds an insert to its audit row and refuses every update and delete. It names those verbs to constrain or refuse them, reads the worker's newest event in the guard, and writes no row.",
  },
  {
    path: "lib/amux/workerRegistryStore.ts",
    table: "AmuxWorkerRegistryEvent",
    tableMentions: 5,
    writeVerbs: 2,
    reason:
      "The registry event table's single writer (orchestration policy version 31, section 3). Its raw SQL is three constant SELECTs (the newest event of every worker, of one worker for its own writer, and of one worker for the capability store's writer, version 35), one constant INSERT ... RETURNING and one constant SELECT subquery (the newest event of every worker as JSON) that the assignment catalog reader composes into its one statement (version 35, section 3); every value is a bound parameter. The second verb is the word in the error raised when the insert returns no row. It never updates or deletes an event, and it writes the audit log only through writeAdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261012100000_amux_worker_registry/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 4,
    writeVerbs: 23,
    reason:
      "The worker registry migration (orchestration policy version 31, sections 3, 5 and 7). Its four AdminAuditLog mentions are the restrictive foreign keys from the registry event's, the trial evidence's and the latch event's auditLogId, and the one SELECT EXISTS read in the registry guard that refuses an event whose audit row of the same transaction, person and action is missing. It never writes AdminAuditLog; its write verbs are the ALTER TABLEs adding those keys with their ON DELETE / ON UPDATE RESTRICT, the four triggers' events, the guards' TG_OP comparison and words of comments.",
  },
  {
    path: "prisma/migrations/20261013200000_amux_v22_task_recovery/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 8,
    writeVerbs: 39,
    reason:
      "The v22 Task recovery migration has three restrictive audit foreign keys and five guard reads that bind the inspection, evidence, approval and assignment to their canonical audit rows. Its DDL and trigger verbs create or constrain recovery metadata only; it never inserts, updates or deletes AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261013200000_amux_v22_task_recovery/migration.sql",
    table: "AmuxV22TaskRecoveryInspectionRequest",
    tableMentions: 13,
    writeVerbs: 39,
    reason:
      "The v22 Task recovery migration creates and guards this append-only request ledger. The migration seeds no request; application inserts are confined to the protected writer and updates, deletes and truncates are refused by its trigger.",
  },
  {
    path: "prisma/migrations/20261013200000_amux_v22_task_recovery/migration.sql",
    table: "AmuxV22TaskRecoveryEvidence",
    tableMentions: 8,
    writeVerbs: 39,
    reason:
      "The v22 Task recovery migration creates and guards this append-only evidence ledger, including its database-clock trigger. The migration seeds no evidence; application inserts are confined to the protected writer and updates, deletes and truncates are refused by its trigger.",
  },
  {
    path: "prisma/migrations/20261013200000_amux_v22_task_recovery/migration.sql",
    table: "AmuxV22TaskRecoveryApproval",
    tableMentions: 10,
    writeVerbs: 39,
    reason:
      "The v22 Task recovery migration creates and guards this append-only one-attempt approval ledger and its assignment and attempt bindings. The migration seeds no approval; application inserts are confined to the protected writer and updates, deletes and truncates are refused by its trigger.",
  },
  {
    path: "prisma/migrations/20261013210000_amux_v22_legacy_safe_stop/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 3,
    writeVerbs: 19,
    reason:
      "The additive v37 safe-stop migration reads same-transaction human and controller audit rows in the request and evidence guards. Its DDL and trigger verbs extend recovery metadata and fence execution tables; it never writes AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261013210000_amux_v22_legacy_safe_stop/migration.sql",
    table: "AmuxV22TaskRecoveryInspectionRequest",
    tableMentions: 9,
    writeVerbs: 19,
    reason:
      "The additive v37 migration extends and reads the append-only request ledger to install a physical-worker safe-stop fence. It seeds and mutates no request row; the existing append-only trigger remains in force.",
  },
  {
    path: "prisma/migrations/20261013210000_amux_v22_legacy_safe_stop/migration.sql",
    table: "AmuxV22TaskRecoveryEvidence",
    tableMentions: 9,
    writeVerbs: 19,
    reason:
      "The additive v37 migration extends and reads the append-only evidence ledger to bind source evidence, durable stop journal and kernel process state. It seeds and mutates no evidence row; the existing append-only trigger remains in force.",
  },
  ...[
    ["AdminAuditLog", 9],
    ["AmuxV22TaskRecoveryInspectionRequest", 8],
    ["AmuxV22TaskRecoveryEvidence", 8],
    ["AmuxV22TaskRecoveryApproval", 7],
    ["AmuxV22TaskRecoveryRiskAcceptance", 14],
    ["AmuxV22ReadOnlyLaunchCheck", 11],
    ["AmuxV22ReadOnlyLaunchProof", 8],
  ].map(([table, tableMentions]) => ({
    path: "prisma/migrations/20261013220000_amux_v22_read_only_retry_risk/migration.sql",
    table,
    tableMentions,
    writeVerbs: 46,
    reason:
      "The additive v39 migration creates and guards the exact FIRST Task risk, launch-check and launch-proof ledgers, extends the existing request and approval bindings, and only reads linked recovery and audit rows. It seeds no authority or execution and never writes AdminAuditLog.",
  })),
  ...[
    ["AmuxV22TaskRecoveryApproval", 5],
    ["AmuxV22ReadOnlyLaunchCheck", 3],
    ["AmuxV22ReadOnlyLaunchProof", 2],
  ].map(([table, tableMentions]) => ({
    path: "prisma/migrations/20261013230000_amux_v22_read_only_retry_db_guards/migration.sql",
    table,
    tableMentions,
    writeVerbs: 4,
    reason:
      "The additive v39 follow-up installs four constraint triggers that re-read the immutable final consent, launch check and launch proof at the launch, approval, claim and start boundaries. It performs no row DML; the scanner's write verbs are the triggers' INSERT event declarations.",
  })),
  {
    path: "prisma/migrations/20261013260000_amux_v22_read_only_api_scope_guards/migration.sql",
    table: "AmuxV22ReadOnlyLaunchCheck",
    tableMentions: 1,
    writeVerbs: 4,
    reason:
      "The additive v40 migration replaces only the existing launch-check JSON scope constraint so it accepts the exact four-key API scope beside the unchanged CLI scope. It performs no row DML and the replacement remains fail-closed for null, malformed, extra-key, unknown-kind and cap-mismatch inputs.",
  },
  {
    path: "prisma/migrations/20261006130000_amux_cli_usage_event/migration.sql",
    table: "AmuxCliUsageEvent",
    tableMentions: 8,
    writeVerbs: 22,
    reason:
      "The original usage-ledger migration creates the table, its indexes and immutable 13-month retention guard. It is immutable history and contains no runtime writer.",
  },
  {
    path: "prisma/migrations/20261013270000_amux_native_api_usage_provenance/migration.sql",
    table: "AmuxCliUsageEvent",
    tableMentions: 1,
    writeVerbs: 3,
    reason:
      "The additive v40 migration replaces only the source and shape checks to add one honest complete native-API provenance branch. It changes no row and preserves both existing CLI branches.",
  },
  {
    path: "prisma/migrations/20261013280000_amux_native_api_first_task_scope/migration.sql",
    table: "AmuxCliUsageEvent",
    tableMentions: 1,
    writeVerbs: 2,
    reason:
      "The additive v40 follow-up replaces only the existing usage shape CHECK to limit native API rows to the approved FIRST Task, complete terminal receipt, uniform model, eight-turn and 3.40 USD caps. It changes no row and leaves both CLI branches unchanged.",
  },
  {
    path: "prisma/migrations/20261013290000_amux_v22_first_task_attempt_limit/migration.sql",
    table: "AmuxV22TaskRecoveryApproval",
    tableMentions: 3,
    writeVerbs: 1,
    reason:
      "The additive v41 migration replaces only the existing attempt-guard function so the exact FIRST Task's second attempt re-reads its immutable recovery approval. It performs no row DML; the scanner's one write verb is the function's FOR UPDATE lock clause.",
  },
  ...[
    ["AdminAuditLog", 3],
    ["AmuxV22TaskRecoveryApproval", 8],
    ["AmuxV22ReadOnlyLaunchCheck", 2],
    ["AmuxV22ReadOnlyLaunchProof", 7],
    ["AmuxV22ApiModelAccessEvidence", 17],
  ].map(([table, tableMentions]) => ({
    path: "prisma/migrations/20261013300000_amux_v22_api_model_access_evidence/migration.sql",
    table,
    tableMentions,
    writeVerbs: 19,
    reason:
      "The additive v42 migration creates and guards one content-free API authentication/model-access evidence row, extends the exact recovery approval binding and re-reads immutable launch, audit, claim and start evidence. It seeds no authority or provider result and never writes AdminAuditLog.",
  })),
  ...[
    ["AmuxV22TaskRecoveryApproval", 2],
    ["AmuxV22ReadOnlyLaunchProof", 2],
  ].map(([table, tableMentions]) => ({
    path: "prisma/migrations/20261013330000_amux_v22_api_launch_proof_deadline/migration.sql",
    table,
    tableMentions,
    writeVerbs: 2,
    reason:
      "The additive v42 follow-up adds one read-only trigger function that closes an API recovery's claim and start 90 seconds after its launch proof. It performs no row DML; the scanner's two write verbs are the BEFORE/AFTER INSERT trigger clauses.",
  })),
  {
    path: "prisma/migrations/20261014120000_amux_v22_prior_attempt_id_guard_correction/migration.sql",
    table: "AmuxV22TaskRecoveryApproval",
    tableMentions: 3,
    writeVerbs: 1,
    reason:
      "The v44 correction re-creates the attempt-guard function from migration 290 with only the FIRST Task's prior attempt ID corrected. It performs no row DML; the scanner's one write verb is the function's FOR UPDATE lock clause.",
  },
  ...[
    "AmuxV22ApiModelAccessEvidence",
    "AmuxV22ReadOnlyLaunchCheck",
    "AmuxV22TaskRecoveryApproval",
    "AmuxV22TaskRecoveryRiskAcceptance",
  ].map((table) => ({
    path: "prisma/migrations/20261014120100_amux_v22_prior_attempt_id_check_correction/migration.sql",
    table,
    tableMentions: 1,
    writeVerbs: 8,
    reason:
      "The v44 correction drops and re-adds four existing CHECKs with only the FIRST Task's prior attempt ID corrected. It performs no row DML; the scanner's write verbs are the ALTER TABLE DROP/ADD CONSTRAINT clauses.",
  })),
  ...[
    ["AdminAuditLog", 1],
    ["AmuxV22TaskRecoveryInspectionRequest", 3],
    ["AmuxV22TaskRecoveryEvidence", 2],
    ["AmuxV22TaskRecoveryRiskAcceptance", 2],
  ].map(([table, tableMentions]) => ({
    path: "prisma/migrations/20261014140000_amux_v22_legacy_safe_stop_live_runtime/migration.sql",
    table,
    tableMentions,
    writeVerbs: 1,
    reason:
      "The v46 migration re-creates the recovery request guard so a legacy safe stop binds the profile's live runtime. It performs no row DML and never writes AdminAuditLog; the scanner's one write verb is the guard's existing FOR UPDATE lock.",
  })),
  {
    path: "lib/amux/cliUsageLedgerStore.ts",
    table: "AmuxCliUsageEvent",
    tableMentions: 2,
    writeVerbs: 1,
    reason:
      "The sole guarded usage writer inserts one content-free row and appends its hash-chain system audit in the same transaction; duplicate invocation IDs are exact receipt-digest read-backs.",
  },
  {
    path: "lib/amux/cliUsageRetention.ts",
    table: "AmuxCliUsageEvent",
    tableMentions: 4,
    writeVerbs: 7,
    reason:
      "The existing reviewed retention writer aggregates eligible expired rows before deleting them under the database-enforced 13-month retention contract.",
  },
  {
    path: "lib/amux/v22WorkerClaimService.ts",
    table: "AmuxCliUsageEvent",
    tableMentions: 2,
    writeVerbs: 2,
    reason:
      "Claim eligibility only reads whether prior attempts have usage evidence; unrelated assignment writes in the same module trigger the conservative raw-SQL text inventory.",
  },
  {
    path: "lib/amux/v22TaskRecoveryService.ts",
    table: "AmuxV22TaskRecoveryInspectionRequest",
    tableMentions: 7,
    writeVerbs: 4,
    reason:
      "The sole recovery-ledger writer adds one fixed fresh-nonce resume GET read of the immutable inspection request. It adds no writer; the raw-SQL verbs remain the four reviewed SELECT FOR UPDATE locks (v46 adds the live-profile runtime lock) and all ledger mutations use protected Prisma delegates with same-transaction audit writes.",
  },
  {
    path: "lib/amux/v22TaskRecoveryService.ts",
    table: "AmuxV22TaskRecoveryEvidence",
    tableMentions: 5,
    writeVerbs: 4,
    reason:
      "The sole recovery-ledger writer adds one fixed fresh-nonce resume GET read of the immutable evidence receipt. It adds no writer; the raw-SQL verbs remain the four reviewed SELECT FOR UPDATE locks (v46 adds the live-profile runtime lock) and all ledger mutations use protected Prisma delegates with same-transaction audit writes.",
  },
  ...[
    ["AmuxV22TaskRecoveryApproval", 3],
    ["AmuxV22TaskRecoveryRiskAcceptance", 5],
    ["AmuxV22ReadOnlyLaunchCheck", 2],
    ["AmuxV22ReadOnlyLaunchProof", 1],
  ].map(([table, tableMentions]) => ({
    path: "lib/amux/v22TaskRecoveryService.ts",
    table,
    tableMentions,
    writeVerbs: 4,
    reason:
      "The sole recovery-ledger writer names this model in fixed canonical audit targets and read-back checks. Its raw-SQL write verbs are constant SELECT FOR UPDATE locks in the global-first Task, prior-attempt and physical-profile order; all recovery ledger mutations and their same-transaction audits use the protected Prisma delegates in this file.",
  })),
  {
    path: "lib/adminAuditSystemActors.ts",
    table: "AmuxV22TaskRecoveryEvidence",
    tableMentions: 2,
    writeVerbs: 2,
    reason:
      "The closed system-actor manifest names the recovery evidence target once for the unprivileged checker and once for the root controller beside prose about audit writes. It executes no SQL and cannot access a Prisma delegate; canonical audit mutation remains in lib/adminAudit.ts.",
  },
  {
    path: "lib/adminAuditSystemActors.ts",
    table: "AmuxV22ApiModelAccessEvidence",
    tableMentions: 1,
    writeVerbs: 2,
    reason:
      "The closed system-actor manifest names the v42 content-free access-evidence target. It executes no SQL; canonical audit mutation remains in lib/adminAudit.ts.",
  },
  ...["AmuxV22ReadOnlyLaunchCheck", "AmuxV22ReadOnlyLaunchProof"].map((table) => ({
    path: "lib/adminAuditSystemActors.ts",
    table,
    tableMentions: 1,
    writeVerbs: 2,
    reason:
      "The closed root-controller actor manifest names this v39 audit target once. It executes no SQL and cannot access a Prisma delegate; canonical audit mutation remains in lib/adminAudit.ts.",
  })),
  {
    path: "lib/accountDataExportDomains.ts",
    table: "AmuxIdeaAnalysisBudgetSetting",
    tableMentions: 2,
    writeVerbs: 3,
    reason: "Only the domain key and prismaModel name this setting; the three existing prose verbs belong to other descriptors. This metadata builds no SQL or database client. Exact counts still reject added literals or writes.",
  },
  {
    path: "prisma/migrations/20261016030000_amux_intake_operating_scope/migration.sql",
    table: "AmuxIdeaOperatingScopeSetting",
    tableMentions: 5,
    writeVerbs: 7,
    reason: "This migration creates the protected append-only operating scope and its audited version guard. No row is seeded.",
  },
  {
    path: "prisma/migrations/20261016030000_amux_intake_operating_scope/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 7,
    reason: "The operating scope migration adds an audit foreign key and reads same-transaction human approval evidence. Its DDL/trigger verbs affect only the scope setting; it never writes AdminAuditLog.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    table: "AmuxIdeaOperatingScopeSetting",
    tableMentions: 2,
    writeVerbs: 3,
    reason: "Only the domain key and prismaModel name this setting; the three existing prose verbs belong to other descriptors. This metadata builds no SQL or database client. Exact counts still reject added literals or writes.",
  },
  {
    path: "prisma/migrations/20261011070000_amux_v4_owner_monthly_budget/migration.sql",
    table: "AmuxIdeaAnalysisBudgetSetting",
    tableMentions: 6,
    writeVerbs: 13,
    reason: "This migration creates the protected append-only setting and its audited version/ledger consistency guards. No live setting or usage is seeded or changed.",
  },
  {
    path: "prisma/migrations/20261011070000_amux_v4_owner_monthly_budget/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 13,
    reason: "The setting migration adds an audit foreign key and reads same-transaction human approval evidence. Its DDL/trigger verbs affect only the budget setting and window; it never writes AdminAuditLog.",
  },
  {
    path: "lib/opsObserverDigest.ts",
    table: "AgentDigestItem",
    tableMentions: 2,
    writeVerbs: 1,
    reason:
      "The sre-ops digest intake reads AgentDigestItem in two plain SELECTs of its own rows: the item already kept for an owner date, so a retry answers that item instead of rebuilding it, and one item by id for the Admin screen the digest notice links to. Its one write verb is the INSERT of its own run guard row, the shared transaction's last write; the digest row itself is written only by lib/agentDigestStore.ts.",
  },
  {
    path: "lib/opsObserverStore.ts",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 16,
    reason:
      "The sre-ops store reads AdminAuditLog in two SELECTs -- the genesis approval row and the rows the transition ledger names -- to verify their HMACs for the trust check. Its sixteen write verbs are five SELECT ... FOR UPDATE locks (its own state row at the base, its own reservation in confirm, the head state row before a genesis is judged, its own closed reservations and its own deferred items a retention batch skips when held), two UPDATEs closing its own reservations (abandon in advance, the close in confirm), an UPDATE of its own state row, INSERTs of its own reservation, its items and the items the daily cap deferred, an INSERT into its own transition ledger, the owner genesis INSERTs of its own genesis and generation-0 state rows, and the retention DELETEs of its own closed reservations and deferred items past ninety days. It writes the audit table only through $appendSystemAudit (writeSystemAuditLogEntry) and $appendAdminAudit (writeAdminAuditLog), both in lib/adminAudit.ts.",
  },
  {
    path: "lib/promptRefinerVnextOneShotTerminalReceipt.ts",
    table: "AdminAuditLog",
    tableMentions: 1,
    writeVerbs: 1,
    reason:
      "The AdminAuditLog delegate only reads terminal and stop receipts. The one SQL write verb is FOR NO KEY UPDATE NOWAIT on PromptRefinerVnextOneShotStage, a row lock before writeSystemAuditLog appends the receipt through the sole audit writer. No statement here inserts, updates or deletes AdminAuditLog.",
  },
  {
    path: "lib/engineeringAgentStore.ts",
    table: "EngineeringAgentRegistration",
    tableMentions: 3,
    writeVerbs: 17,
    reason:
      "The table's own writer module. Its one raw statement naming the table is readEngineeringAgentRegistrationCounts: a constant SELECT of three count(*) subqueries that repeats the registration trigger's cap counts, so a full cap is refused by name under the registration lock before the insert meets the trigger. Every write to the table is a Prisma delegate call; the seventeen write verbs are the advisory-lock and FOR UPDATE SELECTs and the module's prose, including the read-only v22 run lock.",
  },
  {
    path: "lib/marketingStore.ts",
    table: "MarketingChannel",
    tableMentions: 3,
    writeVerbs: 13,
    reason:
      "The sole marketing writer mutates through Prisma delegates. Its raw SQL is two constant SELECT ... FOR UPDATE statements that take the row locks the transitions are decided under; neither interpolates a table name. The eighth write verb is the UPDATE in the claim path's own prose, describing what a claim does not do. S2d2 adds the ninth, in the dispatch path's prose: the sentence saying an account can be paused underneath a claim between the claim and the call, which is why the dispatch re-runs the whole resolver rather than trusting the claim's answer. S2d2 also adds the third mention and the tenth verb in the unknown-outcome path: the prose naming the UPDATE that stops an autonomous account, which is a delegate call setting status and pauseReasonCode only -- the trigger writes pausedFromMode and pausedAt from the transition, because a field a caller could set is a field a caller could set wrongly. The eleventh and twelfth verbs belong to the unknown-outcome pause prose and to the polling writers naming the channel they read for their audit entries; no writer here touches MarketingChannel except that one delegate update, which sets status and pauseReasonCode and leaves pausedFromMode and pausedAt to the trigger. S2f adds the thirteenth verb, the FOR UPDATE of the production webhook apply post lock (see the MarketingPost entry); MarketingChannel is not touched by it.",
  },
  {
    path: "lib/marketingStore.ts",
    table: "MarketingPost",
    tableMentions: 24,
    writeVerbs: 13,
    reason:
      "Same module and the same two lock statements, plus the post lock the approval and publish transitions are decided under, and three constant SELECTs the autonomous insert makes: the template's FOR SHARE, and one statement each for the claims and the assets that decision relied on having been published. S2c adds two more reads and their prose: the due-row SELECT ... FOR UPDATE SKIP LOCKED that picks one post to claim, and the SELECT count(*) that counts the account's used day and week slots while the channel row is held. Both are constant statements; every write in this module is still a delegate call, and a claim writes only slotDate, claimToken and leaseUntil. S2d2 adds two more mentions and one more verb, all in the dispatch path: a constant SELECT ... FOR UPDATE that re-reads the claim, the lease, the history version and the attempt count immediately before the vendor call, and the prose naming the UPDATE that transition is -- which is a delegate call, like every other write here. The dispatch writes only status, providerRequestKey and publishAttempt, and it writes them once. S2d2 polling adds four more mentions and two more verbs across its three lookup writers: two constant SELECT ... FOR UPDATE statements that re-read the status and the history version under lock, and the prose naming the UPDATEs that the verified and platform-removed transitions are. Both are delegate calls, both leave history untouched, and the removal writes its evidence into the audit entry rather than onto the row. The three outcome writers add two more mentions and one more verb: a constant SELECT ... FOR UPDATE that re-reads the status, the request key, the attempt and the history under lock, and the prose naming the single UPDATE all three share. That UPDATE is a delegate call bound by the request key rather than by a live claim, because a lease can expire after a call has begun and the answer still has to be recordable. S2f production webhook apply adds three mentions and one verb: one constant SELECT ... FOR UPDATE that locks the post the event names by provider post id and channel, and the two audit targetType names of its applied and refused entries. Its one write is a delegate updateMany bound by id, status and history version that appends a webhook_event entry and may move a live post to removed_by_platform. The decision-refusal writer adds one more mention, its audit targetType name; it reads and writes no post. S3h1 adds the twenty-fourth mention: the retention writer's table union and target type, which name the table a deleted row came from for its audit entry; the delete itself is the delegate's deleteMany by id.",
  },
  {
    path: "lib/marketingStore.ts",
    table: "MarketingReport",
    tableMentions: 3,
    writeVerbs: 13,
    reason:
      "S3h1's retention writer names the table three times -- its table union, the branch that picks the report delegate and the delete branch -- to record which table a deleted row came from in its audit entry. Every write to the table is a Prisma delegate call (insertMarketingReport's create, the retention deleteMany by id); the write verbs counted beside it are the module's prose and the other tables' statements, the same thirteen as the entries above.",
  },
  {
    path: "lib/marketingStore.ts",
    table: "AiVisibilityRun",
    tableMentions: 3,
    writeVerbs: 13,
    reason:
      "Same as the MarketingReport entry: the retention writer's table union and its two branches name the table so a deleted measurement's audit entry says where it came from. The writes are the delegate's create (insertAiVisibilityRun) and the retention deleteMany by id.",
  },
  {
    path: "lib/amux/intakeRegistration.ts",
    table: "AdminAuditLog",
    tableMentions: 1,
    writeVerbs: 2,
    reason:
      "The unclear-commit read-back selects the audit row that writeAdminAuditLog already wrote. The two INSERT statements write AmuxIntakeDraft and AmuxIntakeApproval only. This file never writes AdminAuditLog.",
  },
  {
    path: "lib/amux/localIntakeRegistration.ts",
    table: "AdminAuditLog",
    tableMentions: 1,
    writeVerbs: 2,
    reason:
      "The local-intake read-back selects the audit row that writeAdminAuditLog already wrote. The two INSERT statements write AmuxLocalIntakeNormalized and AmuxLocalIntakeApproval only. This file never writes AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261012170000_amux_verified_no_commit_halt_auto_clear/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 4,
    writeVerbs: 10,
    reason:
      "The version 33 migration replaces the halt guard and reads four audit rows through constant dynamic SELECT EXISTS statements: halt opening, human clear, no-commit resolution evidence and automatic clear evidence. Its DDL and one UPDATE backfill only add and constrain halt clear evidence; it never inserts, updates or deletes AdminAuditLog.",
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
    path: "lib/accountDataExportDomains.ts",
    table: "EngineeringAgentApproval",
    tableMentions: 2,
    writeVerbs: 3,
    reason:
      "The data-domain registry names the decision model as prismaModel and in its exclusion reason. It builds no SQL and opens no database connection.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    table: "AmuxDecisionMakerSwitchEvent",
    tableMentions: 2,
    writeVerbs: 3,
    reason:
      "The data-domain registry names the Decision Maker switch model as its domain key and as prismaModel, and other domains' prose uses delete and update. It builds no SQL and opens no database connection.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    table: "AmuxDecisionMakerBody",
    tableMentions: 2,
    writeVerbs: 3,
    reason:
      "The data-domain registry names the Decision Maker body model as prismaModel and in its exclusion reason (an operational record, not in a per-account export), and other domains' prose uses delete and update. It builds no SQL and opens no database connection.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    table: "AmuxDecisionMakerRetentionEvent",
    tableMentions: 2,
    writeVerbs: 3,
    reason:
      "The data-domain registry names the Decision Maker retention event model as prismaModel and in its exclusion reason, and other domains' prose uses delete and update. It builds no SQL and opens no database connection.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    table: "AmuxDecisionMakerJudgment",
    tableMentions: 2,
    writeVerbs: 3,
    reason:
      "The data-domain registry names the Decision Maker judgment model as prismaModel and in its exclusion reason (operator evidence, not in a per-account export), and other domains' prose uses delete and update. It builds no SQL and opens no database connection.",
  },
  {
    path: "lib/accountDataExportDomains.ts",
    table: "AmuxDecisionMakerDeliveryEvent",
    tableMentions: 2,
    writeVerbs: 3,
    reason:
      "The data-domain registry names the Decision Maker delivery event model as prismaModel and in its exclusion reason, and other domains' prose uses delete and update. It builds no SQL and opens no database connection.",
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
    path: "lib/agentDigestStore.ts",
    table: "AgentDigestItem",
    tableMentions: 7,
    writeVerbs: 4,
    reason:
      "The table's sole writer. Its raw SQL is the two retention batches (docs/policy/billing-finance-ops.md §1.4): a constant UPDATE that sets an expired body to NULL and a constant DELETE of rows past the meta retention, each bounded and audited, and each also refused by the table's own update and delete triggers outside those conditions. No table name is interpolated.",
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
    path: "prisma/migrations/20261005100000_amux_v4_derivation_groups/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 33,
    reason:
      "The derivation group has a restrictive audit foreign key and its insert guard SELECTs the exact owner audit row under a share lock. Every write verb in this migration creates or constrains derivation tables; none inserts, updates or deletes AdminAuditLog. The canonical audit is written by lib/adminAudit.ts in the same transaction.",
  },
  {
    path: "prisma/migrations/20261005110000_amux_v4_portfolio_scoring/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 4,
    writeVerbs: 35,
    reason:
      "The portfolio assessment and score tables each have a restrictive AdminAuditLog foreign key and an INSERT guard that SELECTs the exact actor, action, target and chain hash under a share lock. The migration writes only its new tables and triggers; it never inserts, updates or deletes AdminAuditLog. Both application writers call writeAdminAuditLog in the same transaction.",
  },
  {
    path: "prisma/migrations/20261006100000_amux_v22_auto_promotion/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 5,
    writeVerbs: 32,
    reason:
      "The v22 evidence tables hold restrictive audit foreign keys and the receipt guard reads the exact canonical system audit row and its hash before accepting a Task pointer. The migration does not insert, update or delete AdminAuditLog; the application writes it through lib/adminAudit.ts in the promotion transaction.",
  },
  {
    path: "prisma/migrations/20261006110000_amux_v22_worker_assignment/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 8,
    writeVerbs: 32,
    reason:
      "The A13 lane and assignment tables hold restrictive audit foreign keys. Deferred guards only read the canonical human or system audit row and its hash before accepting a lane or worker pointer. This migration never inserts, updates or deletes AdminAuditLog; its only audit writers use lib/adminAudit.ts in the same transaction.",
  },
  {
    path: "prisma/migrations/20261003000000_agent_digest_item/migration.sql",
    table: "AgentDigestItem",
    tableMentions: 12,
    writeVerbs: 4,
    reason:
      "Creates the shared digest table and the triggers that constrain its insert, update and delete. It names those verbs to refuse or constrain them and writes no row.",
  },
  {
    path: "lib/qaReleaseMergeLaneRelease.ts",
    table: "QaReleaseMergeAttempt",
    tableMentions: 2,
    writeVerbs: 4,
    reason: "A person's latch release (docs/policy/qa-release-agent.md version 4, section 8 item 5; section 10's fourth transaction), the other writer of both merge-lane tables, kept apart from the service's writer so no module writes both a system and an administrator audit row. Its raw SQL reads the newest latch event with two constant subqueries, makes one conditional UPDATE of the attempt bound to the id and state the screen showed, and one constant INSERT of the release event; every value is a bound parameter.",
  },
  {
    path: "lib/qaReleaseMergeLaneRelease.ts",
    table: "QaReleaseMergeLaneLatch",
    tableMentions: 4,
    writeVerbs: 4,
    reason: "A person's latch release (docs/policy/qa-release-agent.md version 4, section 8 item 5; section 10's fourth transaction), the other writer of both merge-lane tables, kept apart from the service's writer so no module writes both a system and an administrator audit row. Its raw SQL reads the newest latch event with two constant subqueries, makes one conditional UPDATE of the attempt bound to the id and state the screen showed, and one constant INSERT of the release event; every value is a bound parameter.",
  },
  {
    path: "lib/qaReleaseMergeLaneStore.ts",
    table: "QaReleaseOperatorControl",
    tableMentions: 3,
    writeVerbs: 14,
    reason: "The merge lane's single writer (docs/policy/qa-release-agent.md version 4, section 10). Its raw SQL is the issue, consume and result-report transactions counted statement by statement: in issue and consume, one constant SELECT that reads the newest operator control revision and switch and the newest latch event in one snapshot (issue adds whether an attempt is open; consume adds the attempt row itself, locked FOR UPDATE); issue's one constant INSERT ... RETURNING of the attempt row, so the trigger-set expiry comes back in the same statement; consume's one conditional UPDATE of that row from issued to consumed; and the report's one constant WITH statement that reads the newest revision, locks the attempt and makes the conditional move, then one constant INSERT ... SELECT of the next latch event; and the round-start state read, one constant SELECT of the newest latch event and the open attempt with no write. A person's latch release is the other writer, lib/qaReleaseMergeLaneRelease.ts. No table name is interpolated; every value is a bound parameter. It reads QaReleaseOperatorControl and never writes it.",
  },
  {
    path: "lib/qaReleaseMergeLaneStore.ts",
    table: "QaReleaseMergeAttempt",
    tableMentions: 10,
    writeVerbs: 14,
    reason: "The merge lane's single writer (docs/policy/qa-release-agent.md version 4, section 10). Its raw SQL is the issue, consume and result-report transactions counted statement by statement: in issue and consume, one constant SELECT that reads the newest operator control revision and switch and the newest latch event in one snapshot (issue adds whether an attempt is open; consume adds the attempt row itself, locked FOR UPDATE); issue's one constant INSERT ... RETURNING of the attempt row, so the trigger-set expiry comes back in the same statement; consume's one conditional UPDATE of that row from issued to consumed; and the report's one constant WITH statement that reads the newest revision, locks the attempt and makes the conditional move, then one constant INSERT ... SELECT of the next latch event; and the round-start state read, one constant SELECT of the newest latch event and the open attempt with no write. A person's latch release is the other writer, lib/qaReleaseMergeLaneRelease.ts. No table name is interpolated; every value is a bound parameter.",
  },
  {
    path: "lib/qaReleaseMergeLaneStore.ts",
    table: "QaReleaseMergeLaneLatch",
    tableMentions: 5,
    writeVerbs: 14,
    reason: "The merge lane's single writer (docs/policy/qa-release-agent.md version 4, section 10). Its raw SQL is the issue, consume and result-report transactions counted statement by statement: in issue and consume, one constant SELECT that reads the newest operator control revision and switch and the newest latch event in one snapshot (issue adds whether an attempt is open; consume adds the attempt row itself, locked FOR UPDATE); issue's one constant INSERT ... RETURNING of the attempt row, so the trigger-set expiry comes back in the same statement; consume's one conditional UPDATE of that row from issued to consumed; and the report's one constant WITH statement that reads the newest revision, locks the attempt and makes the conditional move, then one constant INSERT ... SELECT of the next latch event; and the round-start state read, one constant SELECT of the newest latch event and the open attempt with no write. A person's latch release is the other writer, lib/qaReleaseMergeLaneRelease.ts. No table name is interpolated; every value is a bound parameter. It reads the newest latch event in issue and consume, and appends one in the report through the INSERT ... SELECT above.",
  },
  {
    path: "prisma/migrations/20261004010000_qa_release_merge_attempt/migration.sql",
    table: "QaReleaseMergeAttempt",
    tableMentions: 19,
    writeVerbs: 13,
    reason:
      "Creates the attempt table, its partial unique index and the triggers that constrain its insert and update and refuse delete and truncate. It names those verbs to refuse or constrain them and writes no row.",
  },
  {
    path: "prisma/migrations/20261004020000_qa_release_merge_lane_latch/migration.sql",
    table: "QaReleaseMergeAttempt",
    tableMentions: 2,
    writeVerbs: 9,
    reason:
      "The latch table's foreign key names the attempt an event concerns, and its insert trigger accepts an audit row that targets that attempt. It writes no attempt row; its write verbs constrain or refuse the latch table.",
  },
  {
    path: "prisma/migrations/20261004020000_qa_release_merge_lane_latch/migration.sql",
    table: "QaReleaseMergeLaneLatch",
    tableMentions: 12,
    writeVerbs: 9,
    reason:
      "Creates the latch table and the triggers that constrain its insert and refuse update, delete and truncate. It names those verbs to refuse or constrain them and writes no row.",
  },
  {
    path: "prisma/migrations/20261004020000_qa_release_merge_lane_latch/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 1,
    writeVerbs: 9,
    reason:
      "The latch insert trigger reads the audit row this transaction wrote (id, target, actor, xmin) to bind each latch event to it. It never writes AdminAuditLog; its write verbs refuse or constrain the latch table.",
  },
  {
    path: "prisma/migrations/20261004010000_qa_release_merge_attempt/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 1,
    writeVerbs: 13,
    reason:
      "The attempt table's triggers read the audit row this transaction wrote (id, target, actor, xmin) to bind every attempt write to it. It never writes AdminAuditLog; its write verbs refuse or constrain the attempt table.",
  },
  {
    path: "prisma/migrations/20261004010000_qa_release_merge_attempt/migration.sql",
    table: "QaReleaseOperatorControl",
    tableMentions: 1,
    writeVerbs: 13,
    reason:
      "Creates the merge-lane attempt table, whose foreign key names the operator control revision it was issued under. It names write verbs to refuse or constrain them on the attempt table and writes no control row.",
  },
  {
    path: "prisma/migrations/20261004000000_agent_digest_billing_finance_ops/migration.sql",
    table: "AgentDigestItem",
    tableMentions: 6,
    writeVerbs: 8,
    reason:
      "Widens the shared digest table's agentKey and kind CHECKs and its insert trigger's retention CASE for billing-finance-ops (docs/policy/billing-finance-ops.md §7 W1a). The only row it writes is the agent's AppSetting switch; it writes no AgentDigestItem row.",
  },
  {
    path: "prisma/migrations/20261008010000_agent_digest_sre_ops/migration.sql",
    table: "AgentDigestItem",
    tableMentions: 6,
    writeVerbs: 7,
    reason:
      "Widens the shared digest table's agentKey and kind CHECKs and its insert trigger's retention CASE for sre-ops (docs/policy/sre-ops.md §1 item 3, §10). It writes no row of any table.",
  },
  {
    path: "scripts/check-enum-constraints.mjs",
    table: "AgentDigestItem",
    tableMentions: 1,
    writeVerbs: 20,
    reason:
      "The enum-constraint registry names the AgentDigestItem agent-key CHECK; the write verbs belong to other entries' reasons. A static check; it opens no database connection.",
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
    path: "prisma/migrations/20261004030000_ops_observer_transition/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 1,
    writeVerbs: 13,
    reason:
      "The sre-ops transition ledger migration keeps the audit entry id as a plain column (no foreign key; AdminAuditLog is append-only already) and reads the linked audit row (hash, action, target, actor, metadata generation and key stamp, and whether this transaction wrote it) under a key-share lock in the ledger's insert guard. Its write verbs create or guard the ledger table, including a statement-level TRUNCATE guard; it never writes AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261002093000_prompt_refiner_vnext_one_shot_slots/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 16,
    reason:
      "The dark vNext one-shot migration keeps immutable audit IDs as plain columns and trigger-checks both linked audit rows under key-share locks. Its write verbs create or guard the new stage and slot tables, including two statement-level TRUNCATE guards; it never writes AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261005140000_prompt_refiner_one_shot_unrun_replacement/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 12,
    reason:
      "The one-shot replacement migration reads the existing supersession audit row under a key-share lock in two guards. Its DDL and trigger write verbs constrain only the one-shot stage table; it never writes AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261005210000_prompt_refiner_one_shot_run_approved_recovery/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 3,
    writeVerbs: 9,
    reason:
      "The B06 recovery migration reads linked supersession audits and counts forbidden historical audits in stage guards. It changes only the one-shot stage constraint and guard functions; it never writes AdminAuditLog.",
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
    path: "prisma/migrations/20260927130000_prompt_refiner_shadow_stage_successor_v3/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 6,
    writeVerbs: 22,
    reason:
      "The stage-successor migration reads exact human/system audit rows from replacement guards and changes DDL only. It preserves the failed v2 approval as immutable audit evidence and seeds no stage, reservation, run, attempt or audit row.",
  },
  {
    path: "prisma/migrations/20260927130000_prompt_refiner_shadow_stage_successor_v3/migration.sql",
    table: "PromptRefinerShadowRun",
    tableMentions: 10,
    writeVerbs: 22,
    reason:
      "The migration admits the successor v5 run contract while preserving historical v3/v4 rows. It contains no run DML and seeds no authority.",
  },
  {
    path: "prisma/migrations/20260927130000_prompt_refiner_shadow_stage_successor_v3/migration.sql",
    table: "PromptRefinerShadowAttempt",
    tableMentions: 6,
    writeVerbs: 22,
    reason:
      "The migration admits v5 attempt bindings while preserving historical v3/v4 attempts. It contains no attempt DML and seeds no evidence.",
  },
  {
    path: "prisma/migrations/20260928130000_prompt_refiner_confirmatory_successor_v4/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 6,
    writeVerbs: 22,
    reason:
      "The confirmatory-successor migration reads exact human/system audit rows from replacement guards and changes validation DDL only. It preserves all legacy approvals and seeds no stage, reservation, run, attempt or audit row.",
  },
  {
    path: "prisma/migrations/20260928130000_prompt_refiner_confirmatory_successor_v4/migration.sql",
    table: "PromptRefinerShadowRun",
    tableMentions: 10,
    writeVerbs: 22,
    reason:
      "The migration admits only the new v6 run contract while delegating legacy v3/v4/v5 validation. It contains no run DML and seeds no authority.",
  },
  {
    path: "prisma/migrations/20260928130000_prompt_refiner_confirmatory_successor_v4/migration.sql",
    table: "PromptRefinerShadowAttempt",
    tableMentions: 6,
    writeVerbs: 22,
    reason:
      "The migration admits v6 attempt bindings while preserving historical v3/v4/v5 attempts. It contains no attempt DML and seeds no evidence.",
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
  {
    path: "prisma/migrations/20260923160000_marketing_post_claim_pair_check/migration.sql",
    table: "MarketingPost",
    tableMentions: 1,
    writeVerbs: 1,
    reason:
      "Adds a CHECK that a claim token and its lease are set together or not at all. The one write verb is that statement's own ALTER TABLE; DDL only and no row mutation.",
  },
  {
    path: "lib/engineeringAgentStore.ts",
    table: "EngineeringAgentWorkItem",
    tableMentions: 7,
    writeVerbs: 17,
    reason:
      "The sole engineering agent writer mutates through Prisma delegates. Its raw SQL is constant SELECT ... FOR UPDATE statements that take the row locks each transition is decided under, in the cross lock order (run, work item, capability, binding), a SELECT ... FOR UPDATE SKIP LOCKED that picks the publisher's next item, a read-only count of the owner queues as the run trigger counts them, a read of active runs whose AMUX attempt ended, a SELECT ... FOR UPDATE SKIP LOCKED of lapsed claims, a transaction advisory lock for halts, the AMUX attempt and card rows a state mismatch concerns, locked FOR UPDATE in AMUX's order (attempt, card, delivery) before the audit chain, the mismatch's run locked before its work item, plus a SELECT of the database clock; none interpolates a table name, every value is a bound parameter.",
  },
  {
    path: "lib/engineeringAgentStore.ts",
    table: "EngineeringAgentCapability",
    tableMentions: 5,
    writeVerbs: 17,
    reason:
      "The sole engineering agent writer mutates through Prisma delegates. Its raw SQL is constant SELECT ... FOR UPDATE statements that take the row locks each transition is decided under, in the cross lock order (run, work item, capability, binding), a SELECT ... FOR UPDATE SKIP LOCKED that picks the publisher's next item, a read-only count of the owner queues as the run trigger counts them, a read of active runs whose AMUX attempt ended, a SELECT ... FOR UPDATE SKIP LOCKED of lapsed claims, a transaction advisory lock for halts, the AMUX attempt and card rows a state mismatch concerns, locked FOR UPDATE in AMUX's order (attempt, card, delivery) before the audit chain, the mismatch's run locked before its work item, plus a SELECT of the database clock; none interpolates a table name, every value is a bound parameter.",
  },
  {
    path: "lib/engineeringAgentStore.ts",
    table: "EngineeringAgentBinding",
    tableMentions: 2,
    writeVerbs: 17,
    reason:
      "The sole engineering agent writer mutates through Prisma delegates. Its raw SQL is constant SELECT ... FOR UPDATE statements that take the row locks each transition is decided under, in the cross lock order (run, work item, capability, binding), a SELECT ... FOR UPDATE SKIP LOCKED that picks the publisher's next item, a read-only count of the owner queues as the run trigger counts them, a read of active runs whose AMUX attempt ended, a SELECT ... FOR UPDATE SKIP LOCKED of lapsed claims, a transaction advisory lock for halts, the AMUX attempt and card rows a state mismatch concerns, locked FOR UPDATE in AMUX's order (attempt, card, delivery) before the audit chain, the mismatch's run locked before its work item, plus a SELECT of the database clock; none interpolates a table name, every value is a bound parameter.",
  },
  {
    path: "lib/engineeringAgentStore.ts",
    table: "EngineeringAgentRun",
    tableMentions: 6,
    writeVerbs: 17,
    reason:
      "The sole engineering agent writer mutates through Prisma delegates. Its raw SQL is constant SELECT ... FOR UPDATE statements that take the row locks each transition is decided under, including a read-only v22 run lock after its AMUX attempt and card, in the cross lock order (run, work item, capability, binding), a SELECT ... FOR UPDATE SKIP LOCKED that picks the publisher's next item, a read-only count of the owner queues as the run trigger counts them, a read of active runs whose AMUX attempt ended, a SELECT ... FOR UPDATE SKIP LOCKED of lapsed claims, a transaction advisory lock for halts, the AMUX attempt and card rows a state mismatch concerns, locked FOR UPDATE in AMUX's order (attempt, card, delivery) before the audit chain, the mismatch's run locked before its work item, plus a SELECT of the database clock; none interpolates a table name, every value is a bound parameter.",
  },
  {
    path: "lib/supportTriageWorker.ts",
    table: "SupportTriageRun",
    tableMentions: 1,
    writeVerbs: 17,
    reason:
      "SupportTriageRun appears once, as the audit entry's targetType string, never in SQL; the run row is written only through lib/supportTriageRunStore.ts. The write verbs are the worker's SupportTriageSuggestion statements: reclaim and retry_exhausted UPDATEs, supersede UPDATE, pending INSERT, claim UPDATE and ready UPDATE; its group statements: SupportTriageGroup INSERT, SupportTriageGroupMember INSERT and DELETE, the lost group's invalidating UPDATE, the joined group's key UPDATE, the undone join's member DELETE, and the SupportTriageGroupSignal DELETE and INSERT; plus the words in comments describing them. None names a protected table.",
  },
  {
    path: "lib/supportTriageRetention.ts",
    table: "SupportTriageRun",
    tableMentions: 3,
    writeVerbs: 1,
    reason:
      "The retention step is a named SupportTriageRun writer, and its run-row delete goes through the Prisma delegate. Its SQL literals only read SupportTriageRun (the window read and the overdue count). The one write verb is the UPDATE that moves open SupportTriageSuggestion rows of closed reports to invalidated; it names no protected table.",
  },
  {
    path: "lib/supportTriageDeletionManifest.ts",
    table: "SupportTriageRun",
    tableMentions: 1,
    writeVerbs: 5,
    reason:
      "Pure data: the deletion manifest names SupportTriageRun as a model it classifies, and delete appears only as account-deletion action names (delete, delete_parent_record) and in comments about them. It holds no SQL, no client and no write; lib/supportTriageRunStore.ts is the writer.",
  },
  {
    path: "prisma/migrations/20261003120000_support_triage_run/migration.sql",
    table: "SupportTriageRun",
    tableMentions: 12,
    writeVerbs: 4,
    reason:
      "The migration creates SupportTriageRun, its CHECK constraints and its insert, update and delete triggers (database-owned deadline, daily cap, late-success downgrade, 30-day delete boundary); it seeds no row. Applied migration source is the reviewed schema boundary; an edit changes the exact counts.",
  },
  {
    path: "prisma/migrations/20261002150000_product_research_observation/migration.sql",
    table: "ProductResearchObservation",
    tableMentions: 9,
    writeVerbs: 8,
    reason:
      "The migration creates ProductResearchObservation, its CHECK constraints and its one guard trigger -- insert-only, inside the slot window, deletable only past the retention period; it seeds no row. Applied migration source is the reviewed schema boundary; an edit changes the exact counts.",
  },
  {
    path: "prisma/migrations/20260928120000_engineering_agent_state/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 1,
    writeVerbs: 76,
    reason:
      "The engineering agent state migration adds a restrictive foreign key from the T2 decision table to AdminAuditLog. It never writes AdminAuditLog; its write verbs create and constrain the seven engineering tables and their triggers.",
  },
  {
    path: "prisma/migrations/20260928120000_engineering_agent_state/migration.sql",
    table: "EngineeringAgentRun",
    tableMentions: 30,
    writeVerbs: 76,
    reason:
      "The migration creates EngineeringAgentRun and its fail-closed insert, update and delete triggers; it seeds no row. Applied migration source is the reviewed schema boundary; an edit changes the exact counts.",
  },
  {
    path: "prisma/migrations/20261007010000_engineering_agent_private_result/migration.sql",
    table: "EngineeringAgentRun",
    tableMentions: 1,
    writeVerbs: 2,
    reason:
      "This migration only replaces the closed EngineeringAgentRun outcome CHECK to admit private_result. It does not write rows or change guard triggers; the exact SQL counts remain pinned.",
  },
  {
    path: "prisma/migrations/20260928120000_engineering_agent_state/migration.sql",
    table: "EngineeringAgentWorkItem",
    tableMentions: 48,
    writeVerbs: 76,
    reason:
      "The migration creates EngineeringAgentWorkItem and its fail-closed insert, update and delete triggers; it seeds no row. Applied migration source is the reviewed schema boundary; an edit changes the exact counts.",
  },
  {
    path: "prisma/migrations/20260928120000_engineering_agent_state/migration.sql",
    table: "EngineeringAgentApproval",
    tableMentions: 11,
    writeVerbs: 76,
    reason:
      "The migration creates EngineeringAgentApproval and its fail-closed insert, update and delete triggers; it seeds no row. Applied migration source is the reviewed schema boundary; an edit changes the exact counts.",
  },
  {
    path: "prisma/migrations/20260928120000_engineering_agent_state/migration.sql",
    table: "EngineeringAgentCapability",
    tableMentions: 17,
    writeVerbs: 76,
    reason:
      "The migration creates EngineeringAgentCapability and its fail-closed insert, update and delete triggers; it seeds no row. Applied migration source is the reviewed schema boundary; an edit changes the exact counts.",
  },
  {
    path: "prisma/migrations/20260928120000_engineering_agent_state/migration.sql",
    table: "EngineeringAgentBinding",
    tableMentions: 26,
    writeVerbs: 76,
    reason:
      "The migration creates EngineeringAgentBinding and its fail-closed insert, update and delete triggers; it seeds no row. Applied migration source is the reviewed schema boundary; an edit changes the exact counts.",
  },
  {
    path: "prisma/migrations/20260928120000_engineering_agent_state/migration.sql",
    table: "EngineeringAgentRegistration",
    tableMentions: 21,
    writeVerbs: 76,
    reason:
      "The migration creates EngineeringAgentRegistration and its fail-closed insert, update and delete triggers; it seeds no row. Applied migration source is the reviewed schema boundary; an edit changes the exact counts.",
  },
  {
    path: "prisma/migrations/20260928120000_engineering_agent_state/migration.sql",
    table: "EngineeringAgentRequest",
    tableMentions: 11,
    writeVerbs: 76,
    reason:
      "The migration creates EngineeringAgentRequest and its fail-closed insert, update and delete triggers; it seeds no row. Applied migration source is the reviewed schema boundary; an edit changes the exact counts.",
  },
  {
    path: "prisma/migrations/20260930120000_amux_orchestrator_halt/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 3,
    writeVerbs: 20,
    reason:
      "The orchestrator halt migration (orchestration policy version 20) creates AmuxOrchestratorWrite, AmuxOrchestratorWriteReceipt and AmuxOrchestratorHalt and their guard triggers; it seeds no row. Its three AdminAuditLog mentions are SELECT EXISTS reads in those guards, which refuse a resolution, a halt or a clear whose audit row is missing. It never writes AdminAuditLog; its write verbs are the three tables' own DDL and the trigger events. Applied migration source is the reviewed schema boundary; an edit changes the exact counts.",
  },
  {
    path: "prisma/migrations/20261008030000_amux_decision_maker_switch/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 3,
    writeVerbs: 8,
    reason:
      "The Decision Maker switch migration (docs/policy/amux-decision-maker.md §8, §10). Its three AdminAuditLog mentions are the restrictive foreign key from auditLogId and the two SELECT EXISTS reads in the switch event guard, one for a person's event and one for a latch, which refuse an event whose audit row of the same transaction, actor and action is missing. It never writes AdminAuditLog; its write verbs are the ALTER TABLE adding that key with its ON DELETE / ON UPDATE RESTRICT, the trigger events, and one word of a comment inside the function body.",
  },
  {
    path: "prisma/migrations/20261008030000_amux_decision_maker_switch/migration.sql",
    table: "AmuxDecisionMakerSwitchEvent",
    tableMentions: 9,
    writeVerbs: 8,
    reason:
      "Creates the switch event table, its indexes, its foreign key to the audit log and the guard trigger that binds an insert to its audit row and refuses every update and delete. It names those verbs to constrain or refuse them, reads the scope's newest event in the guard, and writes no row.",
  },
  {
    path: "lib/amux/decisionMakerSwitchStore.ts",
    table: "AmuxDecisionMakerSwitchEvent",
    tableMentions: 4,
    writeVerbs: 3,
    reason:
      "The switch event table's single writer (docs/policy/amux-decision-maker.md §10). Its raw SQL is two constant SELECTs (the newest event of every scope, and of one scope) and two constant INSERT ... RETURNING statements, a person's event and a latch; every value is a bound parameter. The third verb is the word in the error raised when an insert returns no row. It never updates or deletes an event, and it writes the audit log only through writeAdminAuditLog and, for a latch, lib/amux/decisionMakerSwitchSystemAudit.ts.",
  },
  {
    path: "prisma/migrations/20261008090000_amux_decision_maker_switch_serialization/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 2,
    reason:
      "Replaces the Decision Maker switch event guard's body with the same body plus a READ COMMITTED check (docs/policy/amux-decision-maker.md §8). Its two AdminAuditLog mentions are the guard's two SELECT EXISTS reads, unchanged from 20261008030000. It never writes AdminAuditLog; its two verbs are the 'INSERT' the guard compares TG_OP with and one word of a comment inside the function body.",
  },
  {
    path: "prisma/migrations/20261008090000_amux_decision_maker_switch_serialization/migration.sql",
    table: "AmuxDecisionMakerSwitchEvent",
    tableMentions: 3,
    writeVerbs: 2,
    reason:
      "The same function body: it names the switch event table to read the scope's newest event after the scope lock and as the audit row's target type, and refuses every update and delete. It creates nothing and writes no row.",
  },
  {
    path: "prisma/migrations/20261008090100_amux_decision_maker_request_ledger/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 4,
    writeVerbs: 18,
    reason:
      "The Decision Maker request ledger migration (docs/policy/amux-decision-maker.md §10). Its four AdminAuditLog mentions are the two restrictive foreign keys from the request's and the event's auditLogId and the two SELECT EXISTS reads in their guards, which refuse a row whose router or instance audit of the same transaction is missing. It never writes AdminAuditLog; its write verbs are the ALTER TABLE statements adding foreign keys with their ON DELETE / ON UPDATE RESTRICT, the trigger events, the 'INSERT' the guards compare TG_OP with, and words of comments inside the function bodies.",
  },
  {
    path: "prisma/migrations/20261008090100_amux_decision_maker_request_ledger/migration.sql",
    table: "AmuxDecisionMakerRequest",
    tableMentions: 10,
    writeVerbs: 18,
    reason:
      "Creates the request table, its CHECKs, indexes and foreign keys, and the guard that binds an insert to the router's audit row and refuses every update and delete. The event guard and the deferred commit check read the request row; nothing here writes one.",
  },
  {
    path: "prisma/migrations/20261008090100_amux_decision_maker_request_ledger/migration.sql",
    table: "AmuxDecisionMakerRequestEvent",
    tableMentions: 17,
    writeVerbs: 18,
    reason:
      "Creates the request event table, its CHECKs, its partial unique indexes and foreign keys, the guard that holds the transition graph and refuses every update and delete, and the deferred constraint trigger that refuses a late COMMIT. The guard and the commit check read the request's events; nothing here writes one.",
  },
  {
    path: "prisma/migrations/20261008090100_amux_decision_maker_request_ledger/migration.sql",
    table: "AmuxDecisionMakerSwitchEvent",
    tableMentions: 2,
    writeVerbs: 18,
    reason:
      "The request guard and the event guard read the switch store's newest kill switch and instance events, under the switch gate taken shared, to refuse a DM routing, a transmission intent or a proposal the switches do not allow (docs/policy/amux-decision-maker.md §6, §8). Both are SELECTs in EXECUTE; nothing here writes a switch event, and the write verbs are the ledger tables' own DDL and trigger events.",
  },
  {
    path: "lib/amux/decisionMakerRequestStore.ts",
    table: "AmuxDecisionMakerRequest",
    tableMentions: 8,
    writeVerbs: 4,
    reason:
      "The request ledger's single writer (docs/policy/amux-decision-maker.md §10). Its raw SQL names the request table in seven constant SELECTs (the throughput count, the request state, the request already recorded for a card revision, -- since S1d, 2026-10-08 -- the open requests created in a key period, read for a digest key's destruction, -- since S1e -- each instance's proposals for section 4's report, -- since S1g, 2026-10-12 -- the stale-close candidates the retention sweep reads, and -- since S2, 2026-10-13 -- Admin's newest requests) and one constant INSERT ... RETURNING; every value is a bound parameter. The other verbs are the event INSERT and the word in the two errors raised when an insert returns no row. It never updates or deletes a request, and it writes the audit log only through lib/amux/decisionMakerRequestSystemAudit.ts.",
  },
  {
    path: "lib/amux/decisionMakerRequestStore.ts",
    table: "AmuxDecisionMakerRequestEvent",
    tableMentions: 6,
    writeVerbs: 4,
    reason:
      "The same module names the event table in the request state read, in the open-request count's NOT EXISTS over closing events (S1d, 2026-10-08; a judgment's closing kinds since S1e), in the stale-close candidates' NOT EXISTS over the same closing kinds (S1g, 2026-10-12), in the proposal timeline of section 4's report (S1e), in the events of Admin's newest requests (S2, 2026-10-13), and in its one constant INSERT ... RETURNING of an event; every value is a bound parameter. It never updates or deletes an event; a judgment's closing event is written by the judgment table's trigger.",
  },
  {
    path: "lib/amux/decisionMakerBodyStore.ts",
    table: "AmuxDecisionMakerBody",
    tableMentions: 13,
    writeVerbs: 11,
    reason:
      "The Decision Maker body store's single writer (docs/policy/amux-decision-maker.md §10). Its raw SQL names the body table in five constant SELECTs (a request's retention read, its bodies, a key period's state, the purge candidates, and -- since S1g, 2026-10-12 -- whether a key period still has a body, in the key registry the retention sweep reads), two constant DELETE ... RETURNING statements (the expiry purge of a request's bodies and the privacy erase of named fields, each under its audit of the same transaction, which the trigger requires) and, in the one statement that records an accepted result's detail, a constant INSERT ... SELECT FROM unnest(...) RETURNING of a DM output's bodies, written only with the detail; since S1e it also reads a proposal's body digests for a person's judgment and writes an edited answer in one constant INSERT ... SELECT ... WHERE the registry holds the key, RETURNING its digest, under the judgment's audit; since 2026-10-09 the routing composition writes a new DM request's card text in one constant INSERT ... SELECT ... WHERE the registry holds the key, RETURNING its digest, under the route audit the routing wrote in the same transaction, and a constant SELECT reads that card text back for Admin; every value is a bound parameter. The other verbs are the retention and key event INSERTs and the word in the errors raised when an insert returns no row or rows change under the lock. It never updates a body, and it writes the audit log only through writeAdminAuditLog and lib/amux/decisionMakerBodySystemAudit.ts.",
  },
  {
    path: "lib/amux/decisionMakerBodyStore.ts",
    table: "AmuxDecisionMakerRetentionEvent",
    tableMentions: 7,
    writeVerbs: 11,
    reason:
      "The same module names the retention event table in its constant SELECTs (a request's retention and hold counts, a key period's open holds, the purge candidates) and in one constant INSERT ... RETURNING of a person's hold_set or hold_release; every value is a bound parameter. retention_set is written by the closing trigger, never here. It never updates or deletes a retention event.",
  },
  {
    path: "lib/amux/decisionMakerBodyStore.ts",
    table: "AmuxDecisionMakerDigestKeyEvent",
    tableMentions: 12,
    writeVerbs: 11,
    reason:
      "The same module names the digest-key registry in a key period's state read (its rotation's key check value and whether its destruction is recorded), in the whole registry the retention sweep reads (S1g, 2026-10-12: each period, rotated, destroyed), in the two EXISTS conditions under which a result's detail is written (the key it was digested under is registered and its period not destroyed), the same two under which an edited answer is written and the registry entry a judgment's proposal read returns (S1e), the same two under which a routing's card text is written (2026-10-09), and in two constant INSERT ... RETURNING statements, a rotation and a destruction; every value is a bound parameter. It never updates or deletes a registry event, and never writes a key.",
  },
  {
    path: "lib/amux/decisionMakerBodyStore.ts",
    table: "AmuxDecisionMakerResultDetail",
    tableMentions: 4,
    writeVerbs: 11,
    reason:
      "The same module writes a terminal result's structured detail in one constant data-modifying statement, INSERT ... SELECT ... WHERE the registry holds the key, with the bodies in a second CTE that inserts only beside it, and reads it in three constant SELECTs, the second the proposal a person's judgment checks (S1e) and the third the output kind and irreversible flag of Admin's newest requests (S2, 2026-10-13); every value is a bound parameter. It never updates or deletes a detail.",
  },
  {
    path: "prisma/migrations/20261008120000_amux_decision_maker_body_store/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 12,
    writeVerbs: 46,
    reason:
      "The Decision Maker body store migration (docs/policy/amux-decision-maker.md §10). Its AdminAuditLog mentions are the four restrictive foreign keys from the body, retention event, key event and result detail auditLogId and the guards' SELECT EXISTS reads (and two joins) that refuse a row without its audit of the same transaction: the key event's router audit, the body's route, result or edit_confirm audit, the delete's body_purge or body_erase audit, and the retention event's legal_hold or closing audit. It never writes AdminAuditLog; its write verbs are the ALTER TABLE statements adding foreign keys with their ON DELETE / ON UPDATE RESTRICT, the trigger events, the guards' TG_OP comparisons, the closing trigger's INSERT into the retention event table, and words of comments inside the function bodies.",
  },
  {
    path: "prisma/migrations/20261008120000_amux_decision_maker_body_store/migration.sql",
    table: "AmuxDecisionMakerRequest",
    tableMentions: 12,
    writeVerbs: 46,
    reason:
      "The body, retention and result detail tables reference the request with a restrictive foreign key, and the guards and the closing trigger read the request row (its route, instance, creation clock and route audit) and, for a key's destruction, count the open requests of a key period. Nothing here writes a request.",
  },
  {
    path: "prisma/migrations/20261008120000_amux_decision_maker_body_store/migration.sql",
    table: "AmuxDecisionMakerRequestEvent",
    tableMentions: 9,
    writeVerbs: 46,
    reason:
      "One AFTER INSERT trigger on the request event table: when the ledger records a closing event (assign_discarded, stale_close), the same statement writes the request's retention_set into the retention event table. The result detail references its result event with a restrictive foreign key, and the guards read the event table to find a request's closing event, its result of a given kind and its closing event's own audit. Nothing here writes, updates or deletes a request event.",
  },
  {
    path: "prisma/migrations/20261008120000_amux_decision_maker_body_store/migration.sql",
    table: "AmuxDecisionMakerBody",
    tableMentions: 9,
    writeVerbs: 46,
    reason:
      "Creates the body table, its CHECKs, indexes and foreign keys, and the guard that refuses every update and allows an insert or a delete only under its rules. The key event guard counts a period's bodies; nothing here writes a body.",
  },
  {
    path: "prisma/migrations/20261008120000_amux_decision_maker_body_store/migration.sql",
    table: "AmuxDecisionMakerRetentionEvent",
    tableMentions: 14,
    writeVerbs: 46,
    reason:
      "Creates the retention event table, its CHECKs, its partial unique index and foreign keys, and its guard, which refuses every update and delete; the closing trigger's one constant INSERT ... SELECT writes a closing request's retention_set (the guard computes its retentionUntil). The body and key event guards read the retention events for open holds.",
  },
  {
    path: "prisma/migrations/20261008120000_amux_decision_maker_body_store/migration.sql",
    table: "AmuxDecisionMakerDigestKeyEvent",
    tableMentions: 11,
    writeVerbs: 46,
    reason:
      "Creates the key registry table, its CHECKs, partial unique indexes and foreign key, and its guard, which refuses every update and delete. The body and result detail guards read a period's registry; nothing here writes a registry event.",
  },
  {
    path: "prisma/migrations/20261008120000_amux_decision_maker_body_store/migration.sql",
    table: "AmuxDecisionMakerResultDetail",
    tableMentions: 8,
    writeVerbs: 46,
    reason:
      "Creates the result detail table, its CHECKs (the shape per result kind, the option id grammar), its unique indexes and foreign keys, and its guard, which refuses every update and delete and binds an insert to the request's own result event of the same transaction and a registered, undestroyed key. Nothing here writes a detail.",
  },
  {
    path: "lib/amux/decisionMakerJudgmentStore.ts",
    table: "AmuxDecisionMakerJudgment",
    tableMentions: 5,
    writeVerbs: 5,
    reason:
      "The Decision Maker judgment and delivery store's single writer (docs/policy/amux-decision-maker.md §10). Its raw SQL names the judgment table in one constant INSERT ... RETURNING of a person's judgment, whose trigger writes the request's closing event, and in four constant SELECTs (a request's judgment, the judgment kind beside a request's delivery events, section 4's per-instance tally, and -- since S2, 2026-10-13 -- the declaration accuracy of Admin's newest requests); every value is a bound parameter. The other verbs are the delivery INSERTs and the word in the errors raised when an insert returns no row. It never updates or deletes a judgment, and it writes the audit log only through writeAdminAuditLog and lib/amux/decisionMakerJudgmentSystemAudit.ts.",
  },
  {
    path: "lib/amux/decisionMakerJudgmentStore.ts",
    table: "AmuxDecisionMakerDeliveryEvent",
    tableMentions: 4,
    writeVerbs: 5,
    reason:
      "The same module names the delivery event table in its two constant delivery reads (a request's, and -- since S2, 2026-10-13 -- those of Admin's newest requests) and in two constant INSERT ... RETURNING statements, the system's decision, receipt or unknown outcome and a person's resolution; every value is a bound parameter. It never updates or deletes a delivery event.",
  },
  {
    path: "prisma/migrations/20261009130000_product_research_failed_row_has_no_commits/migration.sql",
    table: "ProductResearchObservation",
    tableMentions: 1,
    writeVerbs: 2,
    reason:
      "One ALTER TABLE that drops and re-adds the table's outcome shape CHECK, so the failed branch requires developSha and mainSha to be null as it already requires the payload columns to be. The two write verbs the pattern counts are that statement's ALTER and DROP -- it does not count ADD -- and the statement writes no row, reads no row and changes no column. The table's rows are still written only by lib/productResearchObservationStore.ts (docs/policy/product-research-agent.md §4), which this constrains rather than bypasses.",
  },
  {
    path: "prisma/migrations/20261008130000_amux_decision_maker_stale_close_hours/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 1,
    writeVerbs: 1,
    reason:
      "Replaces the Decision Maker request event guard's body with the same body and a stale close counted in 720 hours instead of 30 days (docs/policy/amux-decision-maker.md §10). Its one AdminAuditLog mention is the guard's SELECT EXISTS read, unchanged from 20261008090100. It never writes AdminAuditLog; its verb is the 'INSERT' the guard compares TG_OP with.",
  },
  {
    path: "prisma/migrations/20261008130000_amux_decision_maker_stale_close_hours/migration.sql",
    table: "AmuxDecisionMakerSwitchEvent",
    tableMentions: 1,
    writeVerbs: 1,
    reason:
      "The same function body reads the newest kill switch and instance events under the shared switch gate, unchanged from 20261008090100. It writes no switch event.",
  },
  {
    path: "prisma/migrations/20261008130000_amux_decision_maker_stale_close_hours/migration.sql",
    table: "AmuxDecisionMakerRequest",
    tableMentions: 1,
    writeVerbs: 1,
    reason:
      "The same function body reads the request row, unchanged from 20261008090100. It writes no request.",
  },
  {
    path: "prisma/migrations/20261008130000_amux_decision_maker_stale_close_hours/migration.sql",
    table: "AmuxDecisionMakerRequestEvent",
    tableMentions: 2,
    writeVerbs: 1,
    reason:
      "The same function body reads the request's events after the per-request lock and names the event table as the audit row's target type, unchanged from 20261008090100. It creates nothing and writes no event.",
  },
  {
    path: "prisma/migrations/20261008130100_amux_decision_maker_judgment_delivery/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 15,
    writeVerbs: 40,
    reason:
      "The Decision Maker judgment and delivery migration (docs/policy/amux-decision-maker.md §10). Its AdminAuditLog mentions are the restrictive foreign keys from the judgment's and the delivery event's auditLogId and the guards' SELECT EXISTS reads and joins that refuse a row without its audit of the same transaction -- the judgment's person, the delivery's router or person, the replaced event guard's judgment and system audits, the replaced body guard's route, result, edit_confirm, purge and erase audits, and the replaced retention guard's closing audits. It never writes AdminAuditLog; its write verbs are the DDL (tables, constraints, indexes, triggers) with their ON DELETE / ON UPDATE RESTRICT, the trigger events, the guards' TG_OP comparisons, the closing trigger's INSERT of a judgment's closing event, and words of comments inside the function bodies.",
  },
  {
    path: "prisma/migrations/20261008130100_amux_decision_maker_judgment_delivery/migration.sql",
    table: "AmuxDecisionMakerSwitchEvent",
    tableMentions: 3,
    writeVerbs: 40,
    reason:
      "The judgment guard and the delivery guard read the newest kill switch event under the shared switch gate to refuse a confirmation and a delivery decision while it is on, and the replaced event guard keeps its S1c reads. All are SELECTs in EXECUTE; nothing here writes a switch event.",
  },
  {
    path: "prisma/migrations/20261008130100_amux_decision_maker_judgment_delivery/migration.sql",
    table: "AmuxDecisionMakerRequest",
    tableMentions: 14,
    writeVerbs: 40,
    reason:
      "The judgment and delivery tables reference the request with a restrictive foreign key; the judgment guard and the replaced guards read the request row; the replaced judgment audit check names the request as the audit target type. Nothing here writes a request.",
  },
  {
    path: "prisma/migrations/20261008130100_amux_decision_maker_judgment_delivery/migration.sql",
    table: "AmuxDecisionMakerRequestEvent",
    tableMentions: 16,
    writeVerbs: 40,
    reason:
      "Replaces the request event table's kind and instance/kind CHECKs and its one-closing partial unique index with a judgment's three closing kinds, recreates the S1d closing trigger with them, replaces the event guard, and adds the judgment's AFTER INSERT trigger whose one constant INSERT writes the request's closing event of the judgment's kind, which the replaced guard then checks. The judgment references its result event with a restrictive foreign key. Nothing here updates or deletes an event.",
  },
  {
    path: "prisma/migrations/20261008130100_amux_decision_maker_judgment_delivery/migration.sql",
    table: "AmuxDecisionMakerBody",
    tableMentions: 3,
    writeVerbs: 40,
    reason:
      "The replaced body guard (a judgment closes a request for a body; an operator answer takes the switch gate first) and the judgment guard's read of a request's body digests. Nothing here writes a body.",
  },
  {
    path: "prisma/migrations/20261008130100_amux_decision_maker_judgment_delivery/migration.sql",
    table: "AmuxDecisionMakerRetentionEvent",
    tableMentions: 4,
    writeVerbs: 40,
    reason:
      "The replaced retention guard, which accepts a retention_set named by a judgment's closing event and its person's audit, and the replaced key guard's open-hold read. Nothing here writes a retention event; the S1d closing trigger does, unchanged.",
  },
  {
    path: "prisma/migrations/20261008130100_amux_decision_maker_judgment_delivery/migration.sql",
    table: "AmuxDecisionMakerDigestKeyEvent",
    tableMentions: 3,
    writeVerbs: 40,
    reason:
      "The replaced key guard and the replaced body guard read the period's registry, unchanged but for a judgment's closing kinds. Nothing here writes a registry event.",
  },
  {
    path: "prisma/migrations/20261008130100_amux_decision_maker_judgment_delivery/migration.sql",
    table: "AmuxDecisionMakerResultDetail",
    tableMentions: 1,
    writeVerbs: 40,
    reason:
      "The judgment guard reads the proposal's S1d detail. Nothing here writes a detail.",
  },
  {
    path: "prisma/migrations/20261008130100_amux_decision_maker_judgment_delivery/migration.sql",
    table: "AmuxDecisionMakerJudgment",
    tableMentions: 12,
    writeVerbs: 40,
    reason:
      "Creates the judgment table, its CHECKs (kind, instance, accuracy, shown snapshot state and option id, digests, mismatched items, the shape per kind), its unique indexes and foreign keys, its guard, which refuses every update and delete, and its AFTER INSERT trigger that closes the request. The replaced event guard and the delivery guard read a request's judgment. Nothing here writes a judgment.",
  },
  {
    path: "prisma/migrations/20261008130100_amux_decision_maker_judgment_delivery/migration.sql",
    table: "AmuxDecisionMakerDeliveryEvent",
    tableMentions: 13,
    writeVerbs: 40,
    reason:
      "Creates the delivery event table, its CHECKs, its partial unique indexes (one decision, one outcome, one resolution per request) and foreign keys, and its guard, which refuses every update and delete and holds the delivery graph. Nothing here writes a delivery event.",
  },
  {
    path: "prisma/migrations/20261003010000_qa_release_operator_control/migration.sql",
    table: "QaReleaseOperatorControl",
    tableMentions: 11,
    writeVerbs: 4,
    reason:
      "Creates the QA-release operator control table and the triggers that number its revisions, bind each to a same-transaction audit row and refuse every update, delete and truncate. It names those verbs to refuse or constrain them and writes no row.",
  },
  {
    path: "prisma/migrations/20261003010000_qa_release_operator_control/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 1,
    writeVerbs: 4,
    reason:
      "The operator control insert trigger reads AdminAuditLog once, as SELECT EXISTS, to refuse a revision whose same-transaction audit row by a person is missing. It never writes AdminAuditLog; the write verbs are the control table's own trigger events.",
  },
  {
    path: "prisma/migrations/20261001102600_amux_v4_unit_decisions/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 5,
    writeVerbs: 36,
    reason:
      "The v4 decision migration references four immutable audit IDs through restrictive foreign keys and reads one linked row with SELECT FOR SHARE in its decision guard. Its DDL and trigger write verbs affect AmuxIdeaUnitDecision and related v4 tables only; it neither inserts nor updates or deletes AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261001111800_amux_v4_frontier_model_catalog/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 5,
    writeVerbs: 12,
    reason:
      "The Frontier catalog migration adds two restrictive audit foreign keys, declares an audit row type, and reads the approval and revocation audit rows with two SELECT statements in its guard. The write verbs create and constrain AmuxIdeaFrontierModelApproval only; no statement writes AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261002100000_amux_v4_source_plan_revision/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 1,
    writeVerbs: 32,
    reason:
      "The initial source-plan migration adds one restrictive foreign key from creationAuditLogId to the existing audit row. Its write verbs create and constrain AmuxIdeaSourcePlanRevision and AmuxIdeaAnalysisChunk only; it never writes AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261003120000_amux_v4_analysis_price_versions/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 14,
    reason:
      "The analysis price-version migration adds two restrictive foreign keys to existing approval and revocation audit rows. Its write verbs create and constrain AmuxIdeaAnalysisPriceVersion and add a provenance column to AmuxIdeaAnalysisBudgetHold; it neither writes nor seeds AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261004190000_amux_v4_content_key_retirement/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 10,
    reason:
      "The AMUX content-key retirement migration adds only two restrictive foreign keys to already-written purge and key-deletion audit rows. Its DDL and guard write verbs affect AmuxIdeaContentKeyRetirement alone; it never inserts, updates, or deletes AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261004190100_amux_v4_retention_hold/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 3,
    writeVerbs: 13,
    reason:
      "The AMUX retention-hold migration has three restrictive foreign keys to separately written owner approval/release and system notice audit rows. Its DDL and trigger constrain only AmuxIdeaRetentionHold; it does not write AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261006151000_prompt_refiner_one_shot_terminal_recovery/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 5,
    writeVerbs: 10,
    reason:
      "The v4 one-shot recovery migration reads linked historical audit rows and counts forbidden audit actions in schema-qualified SELECTs. Its DDL replaces stage guards and creates a v4 guard; it never inserts, updates, or deletes AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261005040000_amux_v4_registration_consistency/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 3,
    reason:
      "The v4 registration consistency triggers read two already-written canonical audit rows at COMMIT. Their write verbs define guards for AmuxIdeaUnitDecision and AmuxWorkItem; they never write AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261005050000_amux_v4_task_cost_catalog_approval/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 3,
    writeVerbs: 6,
    reason:
      "The Task price-catalog migration reads approval and revocation audit rows in its immutable catalog guard. Its write verbs create and protect AmuxV4TaskCostCatalogApproval only; it never writes AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261005060000_amux_v4_rejection_consistency/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 2,
    reason:
      "The deferred rejection guard reads the already-written canonical consume audit and checks the matching rejected draft at COMMIT. Its trigger creation writes no AdminAuditLog rows.",
  },
  {
    path: "prisma/migrations/20261005070000_amux_v4_node_link_consistency/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 2,
    reason:
      "The deferred node-link guard reads a prior canonical human consume audit and checks its approved draft and v4 target. It creates no AdminAuditLog rows.",
  },
  {
    path: "prisma/migrations/20261005080000_amux_v4_card_link_consistency/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 2,
    reason:
      "The deferred card-link guard only reads the canonical human consume audit and checks the approved draft and target card. It creates no AdminAuditLog rows.",
  },
  {
    path: "prisma/migrations/20261006160000_prompt_refiner_one_shot_post_unknown_v5/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 4,
    writeVerbs: 6,
    reason:
      "The v5 one-shot guard reads three immutable audit relationships: the v4 terminal count, the single linked recovery approval, and its signed predecessor stop. Its DDL changes only the one-shot stage ID constraint and creates guards on the stage and slot tables; it never inserts, updates, or deletes AdminAuditLog.",
  },
  {
    path: "lib/marketingLlmBudgetStore.ts",
    table: "MarketingLlmCall",
    tableMentions: 16,
    writeVerbs: 7,
    reason:
      "The sole registered writer of the marketing LLM cost ledger: it inserts a reservation and moves a call to dispatched or to its one close (including the 15-minute expiry), each after the generator's audit row in the same transaction. The database triggers own every transition rule and timestamp; the other mentions are the reads that lock the month and the row.",
  },
  {
    path: "lib/adminAuditSystemActors.ts",
    table: "MarketingLlmCall",
    tableMentions: 1,
    writeVerbs: 2,
    reason: "The marketing generator actor's exact audit target literal only; this module runs no SQL.",
  },
  {
    path: "prisma/migrations/20261016120000_marketing_llm_call_ledger/migration.sql",
    table: "MarketingLlmCall",
    tableMentions: 18,
    writeVerbs: 13,
    reason:
      "The migration that creates the marketing LLM cost ledger and the triggers that bound it. It names INSERT, UPDATE, DELETE and TRUNCATE to constrain or refuse them; it writes no row. Applied history, so an edit changes a count.",
  },
  {
    path: "prisma/migrations/20261016120000_marketing_llm_call_ledger/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 3,
    writeVerbs: 13,
    reason:
      "The marketing LLM cost ledger migration creates its own table, constraints and guards. All three AdminAuditLog mentions are restrictive foreign keys from the ledger's audit columns to the existing audit writer; no audit row is inserted, updated or deleted here. The write verbs are the ledger's own CREATE statements and the triggers that refuse or constrain writes.",
  },
  {
    path: "prisma/migrations/20261009044000_prompt_refiner_auto_budget_hold/migration.sql",
    table: "AdminAuditLog",
    tableMentions: 2,
    writeVerbs: 12,
    reason:
      "The product Auto budget migration only creates its own windows/holds, constraints, and delete guards. Both AdminAuditLog mentions are restrictive foreign-key references to the existing sole audit writer; no audit row is inserted, updated, or deleted here.",
  },
  {
    path: "lib/adminAuditSystemActors.ts",
    table: "PromptRefinerAutoBudgetHold",
    tableMentions: 1,
    writeVerbs: 2,
    reason:
      "This names the exact target in the system-actor permission predicate; it runs no SQL and grants only the budget reservation audit action.",
  },
  {
    path: "lib/promptRefinerAutoBudgetHold.ts",
    table: "PromptRefinerAutoBudgetHold",
    tableMentions: 15,
    writeVerbs: 7,
    reason:
      "The sole registered budget writer reserves, records one dispatch intent, settles verified usage, retains adapter-reported unknowns, closes an exception only from its own committed-dispatch capability, or releases a proven undispatched hold through branded transition authority. Database triggers update both windows; canonical audit shares each transaction.",
  },
  {
    path: "prisma/migrations/20261009044000_prompt_refiner_auto_budget_hold/migration.sql",
    table: "PromptRefinerAutoBudgetWindow",
    tableMentions: 5,
    writeVerbs: 12,
    reason:
      "The additive migration creates only this new budget window and its bounded-update/delete/truncate guards. It seeds no window row; exact counts require new review for changed DDL.",
  },
  {
    path: "prisma/migrations/20261009044000_prompt_refiner_auto_budget_hold/migration.sql",
    table: "PromptRefinerAutoBudgetHold",
    tableMentions: 13,
    writeVerbs: 12,
    reason:
      "The additive migration creates only this new content-free hold and its immutable/delete/truncate guards. It seeds no hold row; exact counts require new review for changed DDL.",
  },
  ...["PromptRefinerChatScope", "PromptRefinerChatSuggestion"].map((table, index) => ({
    path: "lib/promptRefinerChatExecutionStore.ts", table, tableMentions: [5, 11][index], writeVerbs: 12,
    reason: "The sole default-off Chat binding writer adds one read-only preview lookup per table before its separately revalidated atomic consume boundary; it still only advances epochs, holds validated snapshots, consumes or purges bodies, and records canonical audit in the same transaction.",
  })),
  ...["PromptRefinerChatScope", "PromptRefinerChatSuggestion"].map((table, index) => ({
    path: "prisma/migrations/20261009140000_prompt_refiner_chat_execution/migration.sql", table,
    tableMentions: [5, 7][index], writeVerbs: 18,
    reason: "Additive binding DDL and scope/draft invalidation guards. No seed, activation, audit-table write or provider permission.",
  })),
  ...["PromptRefinerChatScope", "PromptRefinerChatSuggestion"].map(table => ({
    path: "lib/adminAuditSystemActors.ts", table, tableMentions: 1, writeVerbs: 2,
    reason: "Exact audit target allowlist literals only; this module executes no SQL.",
  })),
  ...["PromptRefinerChatScope", "PromptRefinerChatSuggestion", "PromptRefinerProductAttempt"].map(table => ({
    path: "lib/accountDataExportDomains.ts", table, tableMentions: 2, writeVerbs: 3,
    reason: "Pure export declarations and withheld-reason prose. No database client or SQL execution.",
  })),
  ...["AdminAuditLog", "PromptRefinerAutoBudgetWindow", "PromptRefinerAutoBudgetHold"].map((table, index) => ({
    path: "prisma/migrations/20261010110000_prompt_refiner_auto_budget_settlement/migration.sql", table,
    tableMentions: [2, 12, 19][index], writeVerbs: 32,
    reason: "Additive budget transition constraints and guards; audit mentions are restrictive references to canonical receipts. Only hold transitions update the paired Brisbane windows; no audit-table writes or seeded activation.",
  })),
  ...["PromptRefinerProductExecutionReceipt", "PromptRefinerProductExecutionContext", "PromptRefinerProductDispositionReceipt"].map((table, index) => ({
    path: "lib/promptRefinerProductReceiptStore.ts", table,
    tableMentions: [2, 1, 2][index], writeVerbs: 4,
    reason: "The sole closed receipt writer inserts validated content-free execution/mode/disposition facts and canonical system audit in the caller's transaction. No user text, files or prompt digests are stored.",
  })),
  ...["PromptRefinerProductExecutionReceipt", "PromptRefinerProductDispositionReceipt", "PromptRefinerProductAttempt"].map(table => ({
    path: "lib/adminAuditSystemActors.ts", table, tableMentions: 1, writeVerbs: 2,
    reason: "Exact system audit action/target literals only; this module runs no SQL and cannot authorize a human approval.",
  })),
  {
    path: "lib/promptRefinerChatExecutionStore.ts", table: "PromptRefinerProductExecutionReceipt",
    tableMentions: 2, writeVerbs: 12,
    reason: "One locked read of the execution receipt identifies the disposition binding; writes remain delegated to the sole product receipt writer in the same consume transaction.",
  },
  {
    path: "lib/promptRefinerChatExecutionStore.ts", table: "PromptRefinerProductAttempt",
    tableMentions: 6, writeVerbs: 12,
    reason: "Claims one immutable draft/scope/mode key before paid admission and binds a held suggestion in the same canonical-audit transaction. Concurrent copies only read the prior claim.",
  },
  {
    path: "lib/promptRefinerProductReceiptStore.ts", table: "PromptRefinerProductAttempt",
    tableMentions: 2, writeVerbs: 4,
    reason: "One bounded preparing-to-terminal/unknown transition accompanies its content-free execution receipt and canonical audit. It never reopens or retries an attempt.",
  },
  ...["PromptRefinerChatScope", "PromptRefinerProductExecutionReceipt", "PromptRefinerProductExecutionContext", "PromptRefinerProductDispositionReceipt", "PromptRefinerProductAttempt", "PromptRefinerChatSuggestion"].map((table, index) => ({
    path: "prisma/migrations/20261010100000_prompt_refiner_product_receipts/migration.sql", table,
    tableMentions: [3, 9, 3, 5, 4, 4][index], writeVerbs: 29,
    reason: "Additive private draft-attempt binding and immutable content-free receipt DDL, exact foreign keys, row and truncate guards. Reads of scopes/suggestions constrain ownership; no seeded activation or audit-table write.",
  })),
  ...["PromptRefinerProductExecutionReceipt", "PromptRefinerProductAttempt", "PromptRefinerChatSuggestion"].map((table, index) => ({
    path: "prisma/migrations/20261010124000_prompt_refiner_product_receipt_binding/migration.sql", table,
    tableMentions: [1, 2, 2][index], writeVerbs: 1,
    reason: "Additive INSERT-time receipt binding guard. It locks and compares an existing attempt and, for success, its exact suggestion; it adds no lifetime foreign key, seed, provider authority or audit-table write.",
  })),
  ...["PromptRefinerProductAttempt", "PromptRefinerChatSuggestion"].map((table, index) => ({
    path: "lib/chatDraftMessageConsume.ts", table,
    tableMentions: [3, 1][index], writeVerbs: 2,
    reason: "The locked authored-Message save transaction binds a held attempt to its exact draft id/revision before consuming that draft. Suggestion access is read-only; the sole attempt update and canonical audit are atomic with Message persistence, and cannot dispatch a provider.",
  })),
  ...["AdminAuditLog", "PromptRefinerProductExecutionReceipt", "PromptRefinerProductExecutionContext", "PromptRefinerProductDispositionReceipt", "PromptRefinerProductAttempt", "PromptRefinerProductOperationalGuard", "PromptRefinerAutoBudgetHold"].map((table, index) => ({
    path: "lib/promptRefinerProductOperationalGuard.ts", table,
    tableMentions: [5, 5, 2, 4, 4, 6, 2][index], writeVerbs: 3,
    reason: "The sole operational guard writer reads the current writer-supplied receipt, bounded latest-100 execution/disposition facts, generation-wide unknown/expired-attempt probes, and the audit to deduplicate each operational reason per Owner generation. The v3 operator decision removes the automatic pause UPDATE: only initialization and generation-bound human resume write the guard. All audit writes use the canonical writer in the same transaction. It never changes provider accounting or receipt history.",
  })),
  ...["AdminAuditLog", "PromptRefinerProductOperationalGuard"].map((table, index) => ({
    path: "prisma/migrations/20261010120000_prompt_refiner_product_operational_guard/migration.sql", table,
    tableMentions: [1, 3][index], writeVerbs: 8,
    reason: "The additive migration creates the content-free Auto latch and its transition/delete/truncate guards. Its audit mention is a restrictive foreign key; it never writes the audit table.",
  })),
  {
    path: "lib/adminAuditSystemActors.ts", table: "PromptRefinerProductOperationalGuard",
    tableMentions: 1, writeVerbs: 2,
    reason: "The closed system-actor predicate names only the automatic pause audit target. It performs no SQL and grants no human resume authority.",
  },
  {
    path: "lib/promptRefinerProductReceiptStore.ts", table: "PromptRefinerProductOperationalGuard",
    tableMentions: 1, writeVerbs: 4,
    reason: "The receipt transaction invokes the sole operational guard writer after recording the immutable receipt and canonical audit. It never writes the latch directly.",
  },
  {
    path: "lib/promptRefinerChatExecutionStore.ts", table: "PromptRefinerProductOperationalGuard",
    tableMentions: 1, writeVerbs: 12,
    reason: "Auto consume reads the operational latch after acquiring the canonical audit lock in the existing conversation-to-audit order. The store writes only its held suggestion and disposition; no direct latch mutation or resume is possible.",
  },
  {
    path: "scripts/check-enum-constraints.mjs", table: "PromptRefinerProductOperationalGuard",
    tableMentions: 2, writeVerbs: 20,
    reason: "Two closed constraint-registry identifiers link the latch state and reason checks to their runtime lists. This checker reads source and migration SQL, holds no database client and executes no SQL.",
  },
];

/** Everything that runs SQL this check cannot read, by file, with its reviewed count. */
export const RUNTIME_SQL_ALLOWLIST = [
  {
    path: "prisma/migrations/20261016120000_marketing_llm_call_ledger/migration.sql",
    count: 1,
    reason:
      "One read in the marketing LLM cost ledger's truncate guard: SELECT EXISTS over the trigger's own table, named from TG_TABLE_SCHEMA and TG_TABLE_NAME and quoted with %I, because the function pins search_path to pg_catalog, pg_temp and an empty temporary table of the same name must not answer for the ledger. Nothing in it is input; it reads and never writes.",
  },
  {
    path: "prisma/migrations/20261013100000_amux_worker_capability/migration.sql",
    count: 3,
    reason:
      "Three reads in the capability event guard, all with EXECUTE over a name built from TG_TABLE_SCHEMA and a constant table name, because the function pins search_path to pg_catalog, pg_temp: the worker's newest registry event, its newest capability revision, and one SELECT EXISTS on AdminAuditLog for the person's audit row of the same transaction. The schema is the trigger's own, never input, quoted with %I; every value is bound with USING. They read and never write.",
  },
  {
    path: "prisma/migrations/20261012170000_amux_verified_no_commit_halt_auto_clear/migration.sql",
    count: 6,
    reason:
      "Six constant reads in the version 33 halt guard use the trigger's own schema quoted with %I: the opening audit, the human-clear audit, the admitted write FOR SHARE, the receipt existence check, the no-commit resolution audit and the automatic-clear audit. Every variable value is bound with USING, search_path is pinned to pg_catalog and pg_temp, and none of the dynamic statements writes any table.",
  },
  {
    path: "prisma/migrations/20261005010000_support_triage_decision_record/migration.sql",
    count: 8,
    reason:
      "Triggers on SupportTriageDecisionRecord and its links, each over names built from TG_TABLE_SCHEMA quoted with %I with every value bound by USING: at commit, whether a record that still exists has a link; a link's report message FOR SHARE (no link to a deleted account's report); the record FOR UPDATE and then, as a separate statement, its link count (the fifty cap); and, after a link is deleted, a DELETE of its own record by id, so no record outlives any of its links. The functions pin search_path to pg_catalog, pg_temp. The one write deletes the record the deleted link pointed at and nothing else. The other three uses are support_triage_group_member_guard() replaced unchanged except that it now requires READ COMMITTED: the report FOR SHARE, the group FOR UPDATE, then its member count.",
  },
  {
    path: "scripts/ops-observer/statement-ceiling-core.mjs",
    count: 2,
    reason:
      "The two uses are tx.$queryRaw(...args) and tx.$executeRaw(...args) inside the sre-ops statement ceiling's facade: they forward the callback's own call to the transaction client it was given, after rawCallIsSingleStatement() has required a tagged template with no ';' in its text and no interpolated Prisma.raw/sql fragment, and after the statement is counted. The module builds no SQL and names no table; what runs is the caller's template, and the callers are ops-observer store code under docs/policy/sre-ops.md §6. Every other client method, every delegate and every nested function refuses.",
  },
  {
    path: "prisma/migrations/20261004020000_support_triage_group/migration.sql",
    count: 5,
    reason:
      "Five reads in the SupportTriageGroup, SupportTriageGroupMember and SupportTriageGroupSignal guard triggers, each over names built from TG_TABLE_SCHEMA quoted with %I with every value bound by USING: whether an ending group still has signals; a member's report message FOR SHARE (no membership for a deleted account's report); the group FOR UPDATE and then, as a separate statement with a fresh snapshot, its member count (the fifty cap); and a signal's group state FOR SHARE (no signal on a terminal group). The functions pin search_path to pg_catalog, pg_temp. They read and lock; they never write.",
  },
  {
    path: "prisma/migrations/20261004010000_support_triage_suggestion/migration.sql",
    count: 1,
    reason:
      "One read in the SupportTriageSuggestion guard trigger: the report's message, FOR SHARE, over a name built from TG_TABLE_SCHEMA quoted with %I, with the report id bound by USING. It refuses a suggestion for a deleted account's report and holds the report so an account deletion cannot slip in between. The function pins search_path to pg_catalog, pg_temp. It reads and never writes.",
  },
  {
    path: "prisma/migrations/20261003120000_support_triage_run/migration.sql",
    count: 1,
    reason:
      "One count in the SupportTriageRun insert trigger, over a name built from TG_TABLE_SCHEMA quoted with %I, with kind and the UTC day bounds bound by USING. It runs after the trigger takes a transaction advisory lock on (kind, UTC day), so two inserts at the cap are serialised. The function pins search_path to pg_catalog, pg_temp. It reads its own table and never writes a protected one.",
  },
  {
    path: "prisma/migrations/20261002093000_prompt_refiner_vnext_one_shot_slots/migration.sql",
    count: 5,
    reason:
      "Five dynamic SELECTs in the one-shot stage and slot guards use the trigger's own schema quoted with %I and bind IDs with USING: two AdminAuditLog reads use FOR KEY SHARE, two stage-status reads use FOR SHARE, and one slot count in the deferred constraint trigger has no lock clause. The functions pin search_path to pg_catalog, pg_temp; none of these reads writes AdminAuditLog.",
  },
  {
    path: "prisma/migrations/20261005140000_prompt_refiner_one_shot_unrun_replacement/migration.sql",
    count: 5,
    reason:
      "Five dynamic SELECTs in the one-shot replacement guards use the trigger's own schema quoted with %I: two lock and read AdminAuditLog, one locks the historical stage, and two count the historical slots and replacement stage. The functions pin search_path to pg_catalog, pg_temp; each statement only reads and every variable ID is bound with USING.",
  },
  {
    path: "prisma/migrations/20261005210000_prompt_refiner_one_shot_run_approved_recovery/migration.sql",
    count: 8,
    reason:
      "Eight dynamic SELECTs in the B06 recovery guards use TG_TABLE_SCHEMA quoted with %I: two linked AdminAuditLog reads, one forbidden-audit count, two stage locks, two historical-slot counts, and one deferred replacement count. IDs are fixed or bound with USING, search_path is pinned to pg_catalog and pg_temp, and none writes a protected table.",
  },
  {
    path: "prisma/migrations/20261006151000_prompt_refiner_one_shot_terminal_recovery/migration.sql",
    count: 12,
    reason:
      "Twelve dynamic SELECTs in the v4 recovery guards read fixed historical stages, slots and audit rows through TG_TABLE_SCHEMA quoted with %I. The linked audit IDs are bound with USING; the functions pin search_path to pg_catalog and pg_temp. All statements only read or lock, and none writes a protected table.",
  },
  {
    path: "prisma/migrations/20261006160000_prompt_refiner_one_shot_post_unknown_v5/migration.sql",
    count: 6,
    reason:
      "Six dynamic SELECTs in the v5 stage guard lock or read the fixed v4 stage, count its slots and terminal/recovery audits, and read the linked recovery and stop audit rows. Each uses TG_TABLE_SCHEMA quoted with %I, the variable stop ID is bound with USING, and search_path is pinned to pg_catalog and pg_temp. None writes a protected table.",
  },
  {
    path: "prisma/migrations/20261007180000_amux_v4_prless_review_evidence/migration.sql",
    count: 3,
    reason:
      "Three dynamic SELECTs in the v4 PR-less review guard read the fixed task, latest retained result, and attempt. The trigger's own schema is quoted with %I, IDs are bound with USING, and search_path is pinned to pg_catalog and pg_temp. None writes a protected table.",
  },
  {
    path: "prisma/migrations/20260928210000_email_delivery_display_contract/migration.sql",
    count: 1,
    reason:
      "One read, FOR SHARE, with EXECUTE over a name built from TG_TABLE_SCHEMA -- for the reason the permission ledger gives: an unqualified name resolves through the session search path and a hard-coded public. is wrong under ?schema=. The trigger reads the delivery a replacement claims to supersede, to hold it to having been skipped as display_contract_changed: a replacement exists because its predecessor contract moved, and any other reason on a superseded row would mean a message was re-enqueued for a reason that does not produce one. The schema is the trigger own, never input, quoted with %I, and the id is bound with USING. It reads and never writes.",
  },
  {
    path: "prisma/migrations/20261004030000_ops_observer_transition/migration.sql",
    count: 9,
    reason:
      "Nine uses in the sre-ops transition ledger guard, all with EXECUTE because the function pins search_path to pg_catalog, pg_temp, where an unqualified name would not resolve, and a hard-coded public. is wrong under ?schema=: on delete it locks its genesis FOR SHARE and reads whether it was superseded, and its verified checkpoint with whether the ledger row at that checkpoint exists; on insert it locks its genesis FOR SHARE and reads whether it was superseded, reads its state row FOR SHARE (generation, key stamp, whether this transaction wrote it), reads whether the previous generation's row exists, reads the linked AdminAuditLog row FOR KEY SHARE (hash, action, target, actor, metadata generation and key stamp, whether this transaction wrote it), and calls the deadline claim function. The schema is the trigger own, never input, quoted with %I (the ledger's own name via TG_TABLE_NAME); every value is bound with USING. They read, lock and never write.",
  },
  {
    path: "prisma/migrations/20261009120000_ops_observer_deferred_item/migration.sql",
    count: 3,
    reason:
      "Three uses in the sre-ops deferred item guard, all with EXECUTE because the function pins search_path to pg_catalog, pg_temp, where an unqualified name would not resolve, and a hard-coded public. is wrong under ?schema=: the deadline claim on the inserted row, the genesis mode read FOR SHARE, and whether a later genesis supersedes it -- the reservation guard's own three. The schema is the trigger's own, never input, quoted with %I, and every value is bound with USING. It reads and never writes.",
  },
  {
    path: "prisma/migrations/20261008020000_ops_observer_run_guard/migration.sql",
    count: 1,
    reason:
      "One use in the sre-ops run guard trigger, with EXECUTE because the function pins search_path to pg_catalog, pg_temp, where an unqualified name would not resolve, and a hard-coded public. is wrong under ?schema=: it calls the deadline claim function on the inserted row's deadline. The schema is the trigger own, never input, quoted with %I, and the deadline is bound with USING. It reads and never writes.",
  },
  {
    path: "prisma/migrations/20261005030000_ops_observer_retention_deadline/migration.sql",
    count: 1,
    reason:
      "One use in the sre-ops retention deadline trigger, with EXECUTE because the function pins search_path to pg_catalog, pg_temp, where an unqualified name would not resolve, and a hard-coded public. is wrong under ?schema=: it calls the deadline claim function on the deadline the retention batch named for its transaction. The schema is the trigger own, never input, quoted with %I, and the deadline is bound with USING. It reads and never writes.",
  },
  {
    path: "prisma/migrations/20261003090000_ops_observer_delivery/migration.sql",
    count: 4,
    reason:
      "Four uses in the sre-ops reservation guards, all with EXECUTE because every function pins search_path to pg_catalog, pg_temp, where an unqualified name would not resolve, and a hard-coded public. is wrong under ?schema=: the reservation guard calls the deadline claim function in its own schema, locks its genesis FOR SHARE and reads whether it was superseded; the item guard locks its reservation FOR SHARE and reads its status, mode and whether this transaction wrote it. The schema is the trigger own, never input, quoted with %I; every value is bound with USING. They read, lock and never write.",
  },
  {
    path: "prisma/migrations/20261003070000_ops_observer_genesis_state/migration.sql",
    count: 5,
    reason:
      "Five uses in the sre-ops guard triggers, all with EXECUTE because every function pins search_path to pg_catalog, pg_temp, where an unqualified name would not resolve, and a hard-coded public. is wrong under ?schema=: the genesis guard reads the chain head of its own table (TG_TABLE_SCHEMA and TG_TABLE_NAME) FOR UPDATE and calls the deadline claim function in its own schema; the state guard locks its own genesis FOR SHARE, reads whether that genesis has been superseded, and calls the same claim function. The schema is the trigger own, never input, quoted with %I; every value is bound with USING. They read, lock and never write.",
  },
  {
    path: "prisma/migrations/20260929200000_amux_commit_deadline_check/migration.sql",
    count: 1,
    reason:
      "The AMUX commit deadline trigger deletes its own AmuxCommitDeadline row during COMMIT with EXECUTE over TG_TABLE_SCHEMA and TG_TABLE_NAME -- the table the trigger is attached to -- because the function pins search_path to pg_catalog, pg_temp, where an unqualified name would not resolve, and a hard-coded public. is wrong under ?schema=. Both names are the trigger's own, never input, quoted with %I; the transaction id is bound with USING. It touches no protected table.",
  },
  {
    path: "prisma/migrations/20261014100000_amux_card_display_key/migration.sql",
    count: 1,
    reason:
      "The card number issue trigger records a card's first number in AmuxCardDisplayKeyIssued with EXECUTE over TG_TABLE_SCHEMA and that constant table name, because the function pins search_path to pg_catalog, pg_temp, where an unqualified name would not resolve, and a hard-coded public. is wrong under ?schema=. The schema is the trigger's own, never input, quoted with %I; both values are bound with USING. It writes only that append-only ledger and touches no protected table.",
  },
  {
    path: "prisma/migrations/20260930120000_amux_orchestrator_halt/migration.sql",
    count: 7,
    reason:
      "Seven reads in the three orchestrator halt guard triggers, all with EXECUTE over a name built from TG_TABLE_SCHEMA and a constant table name, because every function pins search_path to pg_catalog, pg_temp, where an unqualified name would not resolve, and a hard-coded public. is wrong under ?schema=. They read AmuxOrchestratorWriteReceipt, AmuxOrchestratorWrite (once FOR SHARE), AmuxOrchestratorHalt and AdminAuditLog, each as SELECT or SELECT EXISTS. The schema is the trigger's own, never input, quoted with %I; every value is bound with USING. They read and never write.",
  },
  {
    path: "prisma/migrations/20261008030000_amux_decision_maker_switch/migration.sql",
    count: 3,
    reason:
      "Three reads in the Decision Maker switch event guard, all with EXECUTE over a name built from TG_TABLE_SCHEMA and a constant table name, because the function pins search_path to pg_catalog, pg_temp: the newest event of the inserted event's scope, read after a transaction advisory lock on that scope, and one SELECT EXISTS on AdminAuditLog for a person's event or for a latch. The schema is the trigger's own, never input, quoted with %I; every value is bound with USING. They read and never write.",
  },
  {
    path: "prisma/migrations/20261012100000_amux_worker_registry/migration.sql",
    count: 2,
    reason:
      "Two reads in the worker registry event guard, both with EXECUTE over a name built from TG_TABLE_SCHEMA and a constant table name, because the function pins search_path to pg_catalog, pg_temp: the inserted worker's newest event, read after a transaction advisory lock on that worker, and one SELECT EXISTS on AdminAuditLog for the person's audit row of the same transaction. The schema is the trigger's own, never input, quoted with %I; every value is bound with USING. They read and never write.",
  },
  {
    path: "prisma/migrations/20261008090000_amux_decision_maker_switch_serialization/migration.sql",
    count: 3,
    reason:
      "The same three reads of the Decision Maker switch event guard, in its replaced body with the READ COMMITTED check and the exclusive switch gate: EXECUTE over a name built from TG_TABLE_SCHEMA and a constant table name, values bound with USING. They read and never write.",
  },
  {
    path: "prisma/migrations/20261008120000_amux_decision_maker_body_store/migration.sql",
    count: 23,
    reason:
      "Twenty-three statements in the Decision Maker body store's functions, all EXECUTE over a name built from TG_TABLE_SCHEMA and a constant table name, because every function pins search_path to pg_catalog, pg_temp. Twenty-two read: the key event guard's period events, bodies, open holds, open requests and router audit (5); the body guard's delete-time holds and retention, purge audit and erase audit (3) and insert-time request row, closing events, period registry, request byte total and, by field, one of three audit reads (7); the retention guard's request row, event aggregate, closing event with its audit, and legal_hold audit (4); the result detail guard's request row, result event and period registry (3). One writes: the closing trigger's INSERT ... SELECT of a closing request's retention_set, whose guard then checks it. The schema is the trigger's own, never input, quoted with %I; every value is bound with USING.",
  },
  {
    path: "prisma/migrations/20261008130000_amux_decision_maker_stale_close_hours/migration.sql",
    count: 4,
    reason:
      "The four reads of the Decision Maker request event guard, unchanged from 20261008090100 but for the 720-hour stale close: EXECUTE over a name built from TG_TABLE_SCHEMA and a constant table name, because the function pins search_path to pg_catalog, pg_temp -- the request row, the aggregate of its events after the per-request lock, the newest kill switch and instance events under the shared switch gate, and one SELECT EXISTS on AdminAuditLog. The schema is the trigger's own, quoted with %I; every value is bound with USING. They read and never write.",
  },
  {
    path: "prisma/migrations/20261008130100_amux_decision_maker_judgment_delivery/migration.sql",
    count: 36,
    reason:
      "Thirty-six statements in the judgment and delivery migration's functions, all EXECUTE over a name built from TG_TABLE_SCHEMA and a constant table name, because every function pins search_path to pg_catalog, pg_temp. Thirty-five read: the replaced event guard's request row, event aggregate and switch events, the audit read for a judgment's closing event and the audit read for a system event (5); the replaced body guard's three delete-time and seven insert-time reads, as in S1d (10); the replaced retention guard's four (4) and key guard's five (5), as in S1d; the judgment guard's request row, event aggregate, result detail, kill switch, bodies and person's audit (6); and the delivery guard's judgment, delivery aggregate and kill switch, the audit read for a person's resolution and the audit read for the router's events (5). One writes: the judgment's AFTER INSERT trigger inserts the request's closing event, whose guard then checks it. The schema is the trigger's own, never input, quoted with %I; every value is bound with USING.",
  },
  {
    path: "prisma/migrations/20261008090100_amux_decision_maker_request_ledger/migration.sql",
    count: 8,
    reason:
      "Eight reads in the Decision Maker request ledger's functions, all with EXECUTE over a name built from TG_TABLE_SCHEMA and a constant table name, because every function pins search_path to pg_catalog, pg_temp: the request guard's newest kill switch and instance events (under the shared switch gate, for a dm_proposal row) and its SELECT EXISTS on AdminAuditLog; the event guard's read of the request row, its aggregate of the request's events after the per-request advisory lock, its newest kill switch and instance events (under the shared switch gate), and its SELECT EXISTS on AdminAuditLog; and the commit check's read of the assignment deadline or the result deadline. The schema is the trigger's own, never input, quoted with %I; every value is bound with USING. They read and never write.",
  },
  {
    path: "prisma/migrations/20261004020000_qa_release_merge_lane_latch/migration.sql",
    count: 2,
    reason:
      "Two reads in the latch insert trigger, both EXECUTE over a name built from TG_TABLE_SCHEMA and a constant table name, because the function pins search_path to pg_catalog, pg_temp. One reads the newest QaReleaseMergeLaneLatch event, the other checks the AdminAuditLog row with SELECT EXISTS. The schema is the trigger's own, quoted with %I, and every value is bound with USING. They read and never write.",
  },
  {
    path: "prisma/migrations/20261004010000_qa_release_merge_attempt/migration.sql",
    count: 4,
    reason:
      "Four EXECUTE calls, all over a name built from TG_TABLE_SCHEMA and a constant name, because every function pins search_path to pg_catalog, pg_temp. One, in the audit helper, checks the AdminAuditLog row this transaction wrote with SELECT EXISTS; three, in the attempt insert and update triggers, call that helper schema-qualified. The schema is the trigger's own, quoted with %I, and every value is bound with USING. They read and never write.",
  },
  {
    path: "prisma/migrations/20261003010000_qa_release_operator_control/migration.sql",
    count: 2,
    reason:
      "Two reads in the operator control insert trigger, both EXECUTE over a name built from TG_TABLE_SCHEMA and a constant table name, because the function pins search_path to pg_catalog, pg_temp. One reads the newest QaReleaseOperatorControl revision, the other checks the AdminAuditLog row with SELECT EXISTS. The schema is the trigger's own, quoted with %I, and every value is bound with USING. They read and never write.",
  },
  {
    path: "prisma/migrations/20260928120000_engineering_agent_state/migration.sql",
    count: 21,
    reason:
      "The engineering agent triggers read their sibling tables, AMUX and AppSetting's mode row, all with EXECUTE over a name built from TG_TABLE_SCHEMA, for the reason the permission ledger gives: an unqualified name resolves through the session search path, where a temporary table of the same name answers for the real one, and a hard-coded public. is wrong under ?schema=. Every function pins search_path to pg_catalog, pg_temp. The schema is the trigger's own, never input, quoted with %I; every value is bound with USING. They read and never write.",
  },
  {
    path: "prisma/migrations/20260928100000_release_notes_rule_obligation/migration.sql",
    count: 3,
    reason:
      "Three reads, all FOR SHARE, all with EXECUTE over a name built from TG_TABLE_SCHEMA -- for the reason the permission ledger gives: an unqualified name resolves through the session search path and a hard-coded public. is wrong under ?schema=. The waiver-scope trigger reads the approval it is about to be pointed at and the country rule whose scope that approval has to name; the country-rule trigger reads the waived duty states hanging off a rule whose scope is being moved. The schema is each trigger own, never input, quoted with %I, and every id is bound with USING. They read and never write.",
  },
  {
    path: "prisma/migrations/20260923400000_release_notes_country_rule/migration.sql",
    count: 2,
    reason:
      "The country-rule guard trigger reads its policy version FOR SHARE twice -- the old row's and the new row's -- with EXECUTE over a name built from TG_TABLE_SCHEMA, for the reason the permission ledger gives: an unqualified name resolves through the session search path and a hard-coded public. is wrong under ?schema=. The schema is the trigger own, never input, quoted with %I; every value is bound with USING. It reads and never writes. A third use read this table for a clashing rule version until the content moved to a row whose columns cannot change, which needs no comparison at all.",
  },
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
    sha256: "9baae0af58f21d2abfa8d95af49a84e793969b3ee9f679c2add623c96d3c0cf6",
    count: 2,
    reason:
      "The application's Prisma client, constructed over a pg Pool through @prisma/adapter-pg. It exports the client; it runs no SQL of its own. The pool is module-private and not exported (reviewed 2026-09-17). prismaPoolUsage() returns only the pool's totalCount, idleCount and waitingCount for AMUX busy diagnostics; it runs no SQL and does not expose the pool (reviewed 2026-09-30).",
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
    path: "scripts/amux-v4-activation-preflight.mjs",
    sha256: "f2a9503f7add087b0b077185aa9561ec43428fdae8f65ced13da2630291599b5",
    count: 1,
    reason:
      "AMUX v4 activation diagnostic: one pg import; a fixed allowlist of ciphertext/key columns yields counts only inside BEGIN REPEATABLE READ READ ONLY with statement and idle-transaction timeouts. No audit, model call, switch or body write. The S3 operation is a read-only version-listing probe in an unused namespace, not key deletion evidence. Fingerprint is bound to the complete reviewed script.",
  },
  {
    path: "scripts/baseline-existing-database.mjs",
    sha256: "d6221d28efaf5d8a47e79d0587a56b8e093863937c460ea94b8692fa339bfca2",
    count: 1,
    reason:
      "Pre-deploy migration-history reconciliation over pg: reads the schema and _prisma_migrations before prisma migrate resolve. Its SQL literals name no protected table. Existing relation and function probes remain fixed parameterized catalogue reads inside BEGIN READ ONLY and ROLLBACK. The CHECK-replacement path accepts only the four exact table/constraint names extracted from unchanged original migration SQL and bound to that SQL's canonical-LF SHA-256; it runs only a fixed parameterized pg_catalog.pg_get_constraintdef(c.oid, false) query inside BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY and ROLLBACK. A missing constraint, changed or new definition, unknown answer, or partial set refuses, and the sidecar supplies no SQL. This adds no protected-table or audit write; the only write remains delegated to prisma migrate resolve for baseline history.",
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
    entry.path ? path === entry.path : path.startsWith(entry.prefix) && (!entry.extension || path.endsWith(entry.extension))
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
    path: "prisma/migrations/20261016120000_marketing_llm_call_ledger/migration.sql",
    count: 1,
    reason:
      "The marketing LLM cost ledger's delete guard reads the setting to refuse any deletion that is not retention's. Reading it is the check; setting it is what this rule is about.",
  },
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
  {
    path: "lib/marketingStore.ts",
    count: 2,
    reason:
      "S3h1's retention writer, purgeExpiredMarketingRows: the import of the constant and the one transaction-local set_config that turns retention on for its own delete batch. The triggers still apply the age, legal-hold and shape rules to every row it asks about; this is the reviewed place that asks.",
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
