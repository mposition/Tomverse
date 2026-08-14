// Fails when a database CHECK constraint and the application list that governs
// the same column disagree.
//
// See scripts/check-enum-constraints-core.mjs for why, and for what "the
// effective constraint" means when migrations are append-only.
//
//   npm run check:enum-constraints

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditEnumConstraints,
  readEnumConstraints,
} from "./check-enum-constraints-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const migrationsDirectory = join(root, "prisma", "migrations");

/**
 * What owns each closed list, and why.
 *
 * Three kinds of entry, and the distinction is the point:
 *
 *   list        a runtime array in the application holds the same values, so
 *               the two are compared here on every run;
 *   type_only   TypeScript has the union but nothing carries it at runtime, so
 *               the compiler catches a bad literal in our code and nothing
 *               catches one that arrives as data. Recorded, not comparable;
 *   database    the constraint is the only closed list there is.
 *
 * The last two are not exemptions -- they are the finding. A column whose
 * states exist only as string literals scattered through the code is one typo
 * away from a write that Postgres refuses at runtime, and writing that down is
 * how it becomes a decision somebody can revisit rather than an omission.
 */
const REGISTRY = {
  ProductAnalyticsEvent_name_check: {
    owner: "list",
    module: "lib/productAnalyticsShared.ts",
    list: "PRODUCT_ANALYTICS_EVENT_NAMES",
    reason:
      "Eighty event names, recreated by a migration whenever one is added. Already covered by tests/productAnalyticsDatabaseConstraint.test.ts; covered again here so the whole set has one mechanism.",
  },
  ContextManifest_compactionReason_check: {
    owner: "list",
    module: "lib/routingManifestRetention.ts",
    list: "MANIFEST_COMPACTION_REASONS",
    reason:
      "aged, memory_deleted, memory_superseded. Account deletion is deliberately absent: it removes the row through the cascade rather than compacting it, so no compacted manifest can carry it, and a fourth value would be a report category that is always zero for a reason nobody could work out from the data.",
  },
  Conversation_selectionMode_check: {
    owner: "list",
    module: "lib/conversationSelectionMode.ts",
    list: "SELECTION_MODES",
    reason:
      "Manual or Auto, per conversation (routing policy \u00a75). The application reads an unrecognised stored value as manual, so a mode the constraint allows but the list does not know would silently route nobody rather than fail loudly \u2014 which is exactly the drift this check exists to catch.",
  },
  Conversation_memoryMode_check: {
    owner: "list",
    module: "lib/conversationMemoryMode.ts",
    list: "CONVERSATION_MEMORY_MODES",
    reason:
      "The per-conversation memory mode (import/memory policy §8.1). lib/memoryValidatorCore.ts holds a second copy of the same three values; both are compared against the constraint, so a drift in either is caught.",
  },
  MemoryValidator_conversationMemoryMode_copy: {
    owner: "list",
    module: "lib/memoryValidatorCore.ts",
    list: "CONVERSATION_MEMORY_MODES",
    reason:
      "The validator's own copy of the mode list, checked against the same constraint as the owning module's.",
    constraintAlias: "Conversation_memoryMode_check",
  },
  MemoryItem_kind_check: {
    owner: "list",
    module: "lib/memoryValidatorCore.ts",
    list: "MEMORY_KINDS",
    reason:
      "The nineteen memory kinds (§8.2). Built by spreading the factual and style lists, so a kind added to either has to reach the constraint too.",
  },
  MemoryItem_status_check: {
    owner: "list",
    module: "lib/memoryValidatorCore.ts",
    list: "MEMORY_STATUSES",
    reason:
      "The memory lifecycle, including the two source-suspension states the lock and delete paths write.",
  },
  MemoryItem_sensitivity_check: {
    owner: "list",
    module: "lib/memoryValidatorCore.ts",
    list: "MEMORY_SENSITIVITIES",
    reason: "Whether a memory is sensitive decides whether it can be injected at all.",
  },
  AssistantKnowledgeFile_processingStatus_allowed: {
    owner: "list",
    module: "lib/assistantKnowledgeLimits.ts",
    list: "KNOWLEDGE_PROCESSING_STATUSES",
    reason:
      "The knowledge processing lifecycle. The status decides two different things in two different places -- the worker claims 'pending', retrieval reads 'ready' -- so a value in one and not the other is a row invisible to both while looking fine in a list.",
  },
  AssistantKnowledgeCleanup_reason_allowed: {
    owner: "list",
    module: "lib/assistantKnowledgeLimits.ts",
    list: "KNOWLEDGE_CLEANUP_REASONS",
    reason:
      "Why a stored object is queued for deletion (import/memory policy §14.2). Deletion is DB-first and the tombstone is the audit trail, so the reason has to stay a closed vocabulary the code and the database agree on.",
  },
  MemoryExtractionRun_status_check: {
    owner: "list",
    module: "lib/memoryExtractionLaunch.ts",
    list: "MEMORY_EXTRACTION_RUN_STATUSES",
    reason: "The run lifecycle the dispatcher and the orphan sweep both transition.",
  },
  ProductAnalyticsEvent_language_check: {
    owner: "list",
    module: "lib/language.ts",
    list: "SUPPORTED_LANGUAGES",
    reason:
      "The seven shipped locales. Adding a locale without recreating this constraint would drop that locale's analytics on the floor at insert time.",
  },

  // --- the union exists, but only at compile time -------------------------
  AccountDataExportRequest_refusalReason_check: {
    owner: "type_only",
    reason:
      "ExportTicketRefusal in lib/accountDataExportTicketCore.ts: unknown_token, wrong_user, expired, already_used. `classifyExportTicketRefusal` returns the union, so our own code cannot write a fifth value, and nothing rejects one that arrives as data. Surfaced only once this check learned to read a nullable allowlist -- the column has carried the constraint since 2026-08-06.",
  },
  RoutingRun_switchReason_check: {
    owner: "type_only",
    reason:
      "temporary_hard_fallback, and deliberately nothing else (routing policy \u00a78). It is the one switch reason that earns the next turn's hysteresis bypass, so widening the list is widening that grant. `FallbackRecovery` in lib/routingFallbackPolicy.ts holds it as a literal type.",
  },
  Conversation_routerSwitchReason_check: {
    owner: "type_only",
    reason:
      "The same one value, carried on the conversation so the next turn can act on it. Kept as a separate constraint rather than shared because the two columns are cleared on different events: the run's is a record, the conversation's is state that a manual selection wipes.",
  },

  ProductAnalyticsEvent_plan_check: {
    owner: "type_only",
    reason:
      "Guest plus ModelTier ('Free' | 'Pro' | 'Max' in lib/models.ts). The union is a type, so the compiler rejects a bad literal in our own code and nothing rejects one that arrives as data.",
  },
  User_plan_check: {
    owner: "type_only",
    reason:
      "ModelTier again, without Guest: an account row always has a real plan, and a guest has no row to carry one.",
  },
  RoutingAttempt_plannerMode_check: {
    owner: "type_only",
    reason:
      "PlannerMode in lib/routingAttemptStore.ts, two values. Whether the attempt's prompt went through the planner, recorded per attempt because the answer can differ between the attempts of one run.",
  },
  RoutingAttempt_outcome_check: {
    owner: "type_only",
    reason:
      "RoutingAttemptOutcome in lib/routingAttemptStore.ts. The union is deliberately one value shorter than the constraint: it types the *completion* input, so it carries the five terminal outcomes and not 'pending', which only createAttempt writes as the initial state. A union that also accepted 'pending' would let a caller complete an attempt into the state it started in.",
  },
  RoutingAttempt_failureLayer_check: {
    owner: "type_only",
    reason:
      "RoutingFailureLayer in lib/routingAttemptStore.ts, seven values including 'none'. Which layer refused or broke, which is what makes a failed attempt attributable rather than merely failed.",
  },
  ContextManifest_state_check: {
    owner: "database",
    reason:
      "draft, finalized, not_dispatched. Written as bare literals in lib/routingAttemptStore.ts, where 'draft' also appears inside the compare-and-set predicate that makes finalization happen once; there is no runtime list and no union to compare against.",
  },
  MemoryExtractionCreditReservation_outcome_check: {
    owner: "database",
    reason:
      "completed, failed, cancelled. Written as bare literals at the settlement sites; lib/memoryExtractionMetricsCore.ts holds a same-valued set for its own rollup but does not own the column. Surfaced only once this check learned to read a nullable allowlist -- the column has carried the constraint since 2026-08-05.",
  },
  RoutingRun_fallbackState_check: {
    owner: "database",
    reason:
      "none, fallback_used, exhausted. Paired with RoutingRun_fallback_agreement_check, which is the constraint doing the real work -- this one only bounds the vocabulary that one reasons over.",
  },

  ProductAnalyticsEvent_source_check: {
    owner: "database",
    reason:
      "Whether an event was reported by the browser or by the server. Written as a literal at each emit site; the pair has no runtime list.",
  },

  // --- the constraint is the only closed list there is ---------------------
  ExternalImport_provider_check: {
    owner: "database",
    reason:
      "The two importable providers. They appear as bare string literals across the import adapters and as a zod enum in the analytics payload schema, with no shared runtime list to compare against.",
  },
  ExternalConversation_provider_check: {
    owner: "database",
    reason: "The same two providers, denormalised onto the conversation.",
  },
  ExternalImport_status_check: {
    owner: "database",
    reason:
      "Seven wizard states written as string literals through the import service. The database is the only place the set is written down.",
  },
  ExternalMessage_role_check: {
    owner: "database",
    reason:
      "An imported message is a user or an assistant turn; there is no third case and no runtime list.",
  },
  MemoryExtractionChunk_status_check: {
    owner: "database",
    reason:
      "The chunk lifecycle. Deliberately not the run lifecycle: a chunk is never cancelled on its own, so the two lists differ by one value and sharing them would widen this column.",
  },
  MemoryExtractionCreditReservation_status_check: {
    owner: "database",
    reason:
      "The reservation lifecycle, written by the credit paths as literals inside the transactions that move it.",
  },
  AccountDataExportRequest_status_check: {
    owner: "database",
    reason:
      "The download-ticket lifecycle. The three values are also the locale keys under accountDataExport.status, but that is a presentation mapping rather than a validation list.",
  },
  ImageCreditReservation_identitySource_check: {
    owner: "database",
    reason:
      "Whether the identity was recorded at the time or inferred by the v1 backfill. A closed pair that only the backfill migration and the reservation writer use.",
  },
  UserMemorySettings_defaultConversationMode_check: {
    owner: "database",
    reason:
      "The account default is 'on' or 'off' only -- 'inherit' would have nothing to inherit from, which is exactly why it is not the conversation-mode list.",
  },
};

const migrations = readdirSync(migrationsDirectory)
  .sort()
  .flatMap((directory) => {
    try {
      return [
        {
          name: directory,
          sql: readFileSync(join(migrationsDirectory, directory, "migration.sql"), "utf8"),
        },
      ];
    } catch {
      return [];
    }
  });

const constraints = readEnumConstraints(migrations);

// Alias entries let a second copy of one list be checked against the same
// constraint. They are registry keys, not constraint names, so they are folded
// in here rather than confusing the "stale entry" rule.
const aliases = Object.entries(REGISTRY).filter(([, entry]) => entry.constraintAlias);
const registry = Object.fromEntries(
  Object.entries(REGISTRY).filter(([, entry]) => !entry.constraintAlias)
);

const modules = new Map();
const resolve = (entry) => {
  if (!modules.has(entry.module)) {
    modules.set(entry.module, null);
  }
  const loaded = modules.get(entry.module);
  return loaded?.[entry.list] ?? null;
};

for (const key of new Set(
  [...Object.values(registry), ...aliases.map(([, entry]) => entry)]
    .filter((entry) => entry.owner === "list")
    .map((entry) => entry.module)
)) {
  const imported = await import(`../${key}`);
  modules.set(key, imported);
}

const problems = auditEnumConstraints({ constraints, registry, resolve });

for (const [key, entry] of aliases) {
  const constraint = constraints.find(
    (candidate) => candidate.constraint === entry.constraintAlias
  );
  if (!constraint) {
    problems.push({
      kind: "stale_entry",
      constraint: key,
      message: `${key} aliases ${entry.constraintAlias}, which no longer exists.`,
    });
    continue;
  }
  const codeValues = resolve(entry);
  if (!codeValues) {
    problems.push({
      kind: "missing_list",
      constraint: key,
      message: `${key} names ${entry.list} in ${entry.module}, which does not exist.`,
    });
    continue;
  }
  const database = [...constraint.values].sort().join("|");
  const code = [...codeValues].sort().join("|");
  if (database !== code) {
    problems.push({
      kind: "mismatch",
      constraint: key,
      message: `${entry.module}'s ${entry.list} disagrees with ${entry.constraintAlias}.`,
    });
  }
}

if (problems.length > 0) {
  console.error(
    `\n${problems.length} enum constraint problem(s):\n` +
      problems.map((problem) => `  - ${problem.message}`).join("\n") +
      "\n\nA constraint the application does not know about answers 500 where it\n" +
      "should answer 400. Compare the list in scripts/check-enum-constraints.mjs\n" +
      "against the migration that last recreated the constraint, and register a\n" +
      "new constraint with a reason rather than leaving it undecided.\n"
  );
  process.exit(1);
}

const counts = Object.values(registry).reduce((totals, entry) => {
  totals[entry.owner] = (totals[entry.owner] || 0) + 1;
  return totals;
}, {});

console.log(
  `Enum constraint check passed: ${constraints.length} closed list(s) in the schema — ` +
    `${counts.list || 0} compared against an application list, ` +
    `${counts.type_only || 0} held only as a TypeScript union, ` +
    `${counts.database || 0} written down only in the database.`
);
