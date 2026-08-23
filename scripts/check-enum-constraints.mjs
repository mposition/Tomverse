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
  MessageArtifact_format_check: {
    owner: "list",
    module: "lib/generatedArtifactCore.ts",
    list: "SUPPORTED_ARTIFACT_FORMATS",
    reason:
      "The fifty-eight formats a generator actually exists for, built from the format table in lib/generatedArtifactFormats.ts (docs/policy/generated-artifacts.md). REFUSED_ARTIFACT_EXTENSIONS beside it is the opposite list -- extensions the product refuses outright -- and neither it nor any format without a generator may reach the constraint, because a row here claims a file the download route can serve.",
  },
  MessageArtifact_status_check: {
    owner: "list",
    module: "lib/generatedArtifactCore.ts",
    list: "PERSISTED_ARTIFACT_STATUSES",
    reason:
      "ready and failed. ARTIFACT_STATUSES beside it carries a third value, `blocked`, which is a live-stream state for a guest who has not signed in: there is no account to write a row under, so a third database value would be a status nothing could ever query for. The split is what keeps the constraint and the transport union from being forced to agree about a state only one of them has.",
  },
  MessageAttachment_kind_check: {
    owner: "list",
    module: "lib/messageAttachmentCore.ts",
    list: "MESSAGE_ATTACHMENT_KINDS",
    reason:
      "file and text -- how the request layer reads an uploaded file. The server derives it from the media type (messageAttachmentKindFor), so a third value would be a kind nothing knows how to read, and a request cannot introduce one because it never supplies the field.",
  },
  MessageAttachmentUpload_kind_check: {
    owner: "list",
    module: "lib/messageAttachmentCore.ts",
    list: "MESSAGE_ATTACHMENT_KINDS",
    reason:
      "The upload row's copy of the same two kinds, from the same list. The binding step copies the value straight across, so the two tables cannot be allowed to disagree about what a kind is -- which is why both constraints are held to one module's list rather than to each other.",
  },
  MessageAttachmentCleanup_reason_check: {
    owner: "list",
    module: "lib/messageAttachmentStorage.ts",
    list: "MESSAGE_ATTACHMENT_CLEANUP_REASONS",
    reason:
      "conversation_deleted, account_deleted, message_deleted, upload_abandoned. Each names a distinct path that enqueues an object, and the operator reading a stuck queue needs to know which one wrote the row -- a reason the application could write and the constraint refuses would fail the deletion transaction rather than the sweep.",
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
  AssistantProfileImport_mode_check: {
    owner: "list",
    module: "lib/assistantProfileImportCore.ts",
    list: "ASSISTANT_PROFILE_IMPORT_MODES",
    reason:
      "create or merge (docs/policy/assistant-package-import.md \u00a75). Not a label: it is the branch cancellation and expiry take, and the two branches differ by whether a profile is deleted. A third value would reach a sweep that has no case for it, which is the one place a wrong answer is unrecoverable.",
  },
  AssistantProfileImport_status_check: {
    owner: "list",
    module: "lib/assistantProfileImportCore.ts",
    list: "ASSISTANT_PROFILE_IMPORT_STATUSES",
    reason:
      "staging or published. The expiry sweeps filter on it, so a status they do not recognise is an import nothing ever collects -- and a published import collected as staging is a published profile deleted.",
  },
  AssistantKnowledgeUploadReservation_state_check: {
    owner: "list",
    module: "lib/assistantProfileImportCore.ts",
    list: "ASSISTANT_KNOWLEDGE_RESERVATION_STATES",
    reason:
      "pending or finalizing. Whether an upload key is currently claimed by a finalize in flight; the compare-and-set that takes a claim and the sweep that reclaims a stale one both read it.",
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
      "RoutingAttemptOutcome in lib/routingAttemptStore.ts. The union is deliberately one value shorter than the constraint: it types the *completion* input, so it carries the six terminal outcomes and not 'pending', which only createAttempt writes as the initial state. A union that also accepted 'pending' would let a caller complete an attempt into the state it started in. 'unknown_after_dispatch' is the sweep's, for an attempt whose process stopped after dispatching -- named for what is known rather than guessed at as a provider failure.",
  },
  RoutingAttempt_failureLayer_check: {
    owner: "type_only",
    reason:
      "RoutingFailureLayer in lib/routingAttemptStore.ts, eight values including 'none' and 'process'. Which layer refused or broke, which is what makes a failed attempt attributable rather than merely failed.",
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
  ChatAttemptUsage_outcome_check: {
    owner: "type_only",
    reason:
      "AttemptOutcome in lib/chatMultiAttemptSettlement.ts: completed, cancelled, failed, empty. Deliberately the same four words settleChatUsage already writes to ChatCreditReservation.outcome rather than a second vocabulary for the same fact -- two spellings of one outcome is how two reports about one turn disagree. A fifth, unknown_after_dispatch, is written only by the stale-attempt sweep and matches RoutingAttempt's own outcome for the same condition: a dispatch was recorded and the turn never came back to say how it ended.",
  },
  ChatAttemptUsage_usageSource_check: {
    owner: "type_only",
    reason:
      "How the token counts were arrived at: provider_usage_metadata, provider_response_cost, fallback_estimator, crash_reconciliation. Derived in lib/chatAttemptCostLedger.ts (attemptUsageSource) from AttemptUsage's own fields, except crash_reconciliation, which only lib/routingAttemptSweep.ts writes. A column rather than a note inside pricingSnapshot because the reports that read this ledger have to separate measured spend from estimated spend, and a provenance nobody can filter on is a provenance nobody uses.",
  },
  ChatAttemptUsage_costSource_check: {
    owner: "type_only",
    reason:
      "PricedAttempt.costSource in lib/chatMultiAttemptSettlement.ts holds two of these -- token_estimate and provider_response -- and the third, reserved_upper_bound, is the sweep's: an upper bound the attempt was authorized to spend, recorded because the call demonstrably happened and 0 would claim it did not.",
  },
  ChatAttemptUsageAdjustment_kind_check: {
    owner: "type_only",
    reason:
      "late_provider_actual, and only that today. Real usage arriving after a crash-reconciled estimate, appended rather than applied because the base row is immutable. A second kind would be a second reason a cost row can be wrong, and it should have to be named here before it can be written.",
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
  // --- email notifications -------------------------------------------------
  EmailPreference_purpose_check: {
    owner: "list",
    module: "lib/emailPreferenceCore.ts",
    list: "EMAIL_PURPOSES",
    reason:
      "The six things an account can receive (docs/policy/email-notifications.md \u00a711.2). The list is what the preference centre renders and what the standard lane gates on, so a purpose in the constraint the list has never heard of is mail nobody can switch off, and one in the list the constraint refuses is a preference row that cannot be written.",
  },
  EmailPreference_source_check: {
    owner: "database",
    reason:
      "Where a preference row came from: signup, preference_center, unsubscribe_link, admin, system_default. Written as literals at each write site in lib/emailPreferences.ts. It is audit provenance rather than a value anything branches on, which is why there is no runtime list to compare against -- and why a sixth value has to be argued for here before it can be written.",
  },
  ConsentRecord_action_check: {
    owner: "type_only",
    reason:
      "ConsentAction in lib/emailPreferenceCore.ts: granted, withdrawn, reconfirmed, confirmation_notice_sent, lapsed. The last two are the Korean confirmation duty and the optional lapse behind its own flag (\u00a75.5); they are separate values precisely because notifying is not expiring, and folding them together would make the history unable to answer which one happened.",
  },
  ConsentRecord_captured_via_check: {
    owner: "database",
    reason:
      "Which surface captured the consent, kept because the evidence a regulator asks for is where and how, not only when. Written as a literal by each surface; there is no runtime list.",
  },
  SuppressionEntry_scope_check: {
    owner: "database",
    reason:
      "global or purpose. Paired with SuppressionEntry_purpose_key_check, which is the constraint doing the real work: this one only bounds the vocabulary that one reasons over.",
  },
  SuppressionEntry_reason_check: {
    owner: "type_only",
    reason:
      "SuppressionReason in lib/emailSuppressionCore.ts. Not one flat 'blocked' state: hard_bounce stops every lane, complaint stops marketing only, and soft_bounce is the one reason an entry may expire (\u00a713.3). A value the code cannot name would be a block nobody can explain to the person it silences.",
  },
  SuppressionEntry_source_stream_check: {
    owner: "type_only",
    reason:
      "SendClassification narrowed to the two streams a provider event can be attributed to. Nullable, because a manual or privacy-request entry has no originating stream to name -- and inventing one would make the provenance columns a report that always has an answer and is sometimes wrong.",
  },
  EmailTemplate_classification_check: {
    owner: "type_only",
    reason:
      "EmailClassification in lib/emailTemplateDefinitions.ts: transactional, service, legal, marketing. It is the single input to whether an unsubscribe link is required, forbidden or free (EmailTemplate_unsubscribe_check), so widening it silently widens that decision.",
  },
  TemplateVersion_status_check: {
    owner: "database",
    reason:
      "draft, published, retired. Only lib/emailTemplateRegistry.ts writes them, as literals, and only 'published' is ever read back -- a version is looked up by content hash rather than by state.",
  },
  EmailPolicyVersion_status_check: {
    owner: "database",
    reason:
      "draft, active, superseded, with a partial unique index making at most one row active. Deliberately not a runtime list: nothing in the application may transition it, because activation is a human approval recorded in the registry (\u00a712.5). A list in the code would be the first step towards a code path that sets it.",
  },
  JurisdictionProfile_marketing_basis_check: {
    owner: "database",
    reason:
      "opt_in or opt_out, recorded as the jurisdiction states it even though C1 sends opt-in everywhere. The column exists so a later decision to follow a jurisdiction's own basis has the fact to hand; a third value would be a legal basis nobody has researched.",
  },
  EmailEvent_status_check: {
    owner: "database",
    reason:
      "pending, expanding, expanded, failed -- the fan-out lifecycle of one event into its delivery rows. Written as literals inside the transaction that claims the event.",
  },
  EmailEvent_audience_kind_check: {
    owner: "database",
    reason:
      "single_user, user_segment, all_users. Only the first is reachable today; the other two are named so the admin send path cannot invent a fourth shape of audience without saying so here.",
  },
  EmailDelivery_lane_check: {
    owner: "database",
    reason:
      "credential_sync or standard, the two lanes with opposite guarantees (\u00a79.4a). lib/credentialEmailLane.ts holds CREDENTIAL_LANE as a single constant and the standard lane defaults the column, so there is no list holding both; the constraint is what makes a third lane impossible to add by accident, and three of the constraints above are conditioned on this column's value.",
  },
  EmailDelivery_status_check: {
    owner: "database",
    reason:
      "The nine delivery states. failed and abandoned are deliberately different: failed is one attempt that did not land, abandoned is the queue giving up, and only the credential lane is forbidden the second (EmailDelivery_credential_not_abandoned_check). Written as literals by the two lanes and by the webhook processor.",
  },
  EmailDelivery_skip_reason_check: {
    owner: "database",
    reason:
      "Why a delivery was never attempted -- no_consent, suppressed_complaint, jurisdiction_unconfirmed and the rest. Nullable, so it is only present on a skipped row. It is the answer to \"why did this person not get it\", which is a question support has to be able to answer without reading the send code.",
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
