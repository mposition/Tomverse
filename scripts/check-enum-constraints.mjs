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
  ProviderModelDocEvidence_status_check: {
    owner: "list",
    module: "lib/providerModelDocsCore.ts",
    list: "PROVIDER_MODEL_DOC_EVIDENCE_STATUSES",
    reason:
      "How a documentation read ended: parsed, not_found (the page or the table row is not there), fetch_failed, parse_failed (the document's structure moved). The adoption draft reads only 'parsed', so a status the list does not know would be evidence silently ignored rather than a write refused.",
  },
  ModelRegistryEntry_webSearchOverride_check: {
    owner: "list",
    module: "lib/webSearchOverride.ts",
    list: "WEB_SEARCH_OVERRIDES",
    reason:
      "An administrator's per-model web search route: off or the application-managed backend. NULL follows the code. There is no value for a provider's native tool on purpose -- its cost ceiling is verified per model in lib/webSearchCapability.ts, not chosen in a form.",
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
  RoutingRun_product_key_check: {
    owner: "list",
    module: "lib/conversationProduct.ts",
    list: "CONVERSATION_PRODUCT_KEYS",
    reason:
      "The same three products as Conversation.productKey, snapshotted at execution time (decision record v1.2 \u00a75). Deliberately the same list rather than a second one: a run's product is copied from the conversation's, so two lists that could drift would let a run claim a product no conversation can hold. Also NULL-permitting, because rows written before the column existed had no product recorded and a guessed value would be an attribution nobody made.",
  },
  Conversation_product_key_check: {
    owner: "list",
    module: "lib/conversationProduct.ts",
    list: "CONVERSATION_PRODUCT_KEYS",
    reason:
      "chat, review, studio -- which Tomverse product a conversation belongs to (product boundary decision record v1.2, decision 2). The brand axis has a fourth product, `code`, deliberately absent: Tomverse Code writes no Conversation rows, so admitting it would make a row with no execution surface a legal value. It joins both the list and the constraint on the day Code starts writing conversations, which is why the two are compared here rather than left to agree by memory.",
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
    reason:
      "Whether a memory is sensitive decides whether it can be injected at all.",
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
    reason:
      "The run lifecycle the dispatcher and the orphan sweep both transition.",
  },
  ProductAnalyticsEvent_language_check: {
    owner: "list",
    module: "lib/language.ts",
    list: "SUPPORTED_LANGUAGES",
    reason:
      "The seven shipped locales. Adding a locale without recreating this constraint would drop that locale's analytics on the floor at insert time.",
  },
  ChatResponseAttempt_status_check: {
    owner: "list",
    module: "lib/chatResponseAttemptCore.ts",
    list: "CHAT_RESPONSE_ATTEMPT_STATUSES",
    reason:
      "The claimed/streaming/terminal lifecycle used by claim, checkpoint and terminal CAS. A database-only state would evade the terminal immutability checks, while a code-only state would turn a controlled recovery transition into a write-time 500.",
  },
  ChatResponseAttempt_finish_reason_check: {
    owner: "list",
    module: "lib/chatResponseAttemptCore.ts",
    list: "CHAT_RESPONSE_ATTEMPT_FINISH_REASONS",
    reason:
      "Public-safe terminal classifications only. Raw provider finish text is never stored; this list is shared by runtime parsing, public recovery output and the filtered account export.",
  },
  ChatResponseAttempt_failure_code_check: {
    owner: "list",
    module: "lib/chatResponseAttemptCore.ts",
    list: "CHAT_RESPONSE_ATTEMPT_FAILURE_CODES",
    reason:
      "A deliberately coarse public-safe failure vocabulary. It prevents provider messages, exception text, credentials or request fragments from entering durable recovery state and later leaving through GET or account export.",
  },
  PromptRefinerShadowRun_status_check: {
    owner: "list",
    module: "lib/promptRefinerShadowRunContract.ts",
    list: "PROMPT_REFINER_SHADOW_RUN_STATUSES",
    reason:
      "The durable shadow run lifecycle. The owner-only writer, terminal counter transition and outcome-unknown latch branch on this shared list; a database-only status would evade those fail-closed transitions, while a code-only status would turn an admitted run update into a write-time 500.",
  },
  PromptRefinerShadowAttempt_status_check: {
    owner: "list",
    module: "lib/promptRefinerShadowRunContract.ts",
    list: "PROMPT_REFINER_SHADOW_ATTEMPT_STATUSES",
    reason:
      "The durable attempt lifecycle deliberately has only dispatch intent and terminal receipt. The terminal writer and stale-intent sweep both use this list, so drift would either strand an attempt outside recovery or let an unknown state bypass terminal immutability.",
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
  AvailabilityObservation_source_check: {
    owner: "list",
    module: "lib/availabilityObservation.ts",
    list: "AVAILABILITY_OBSERVATION_SOURCES",
    reason:
      "real_traffic, synthetic_probe, operator_verification -- kept apart for the reason ProviderHealthState already keeps them apart in separate columns: an operator proving the API answers is not the same claim as real user traffic being served, and a synthetic probe is neither. Folding them would let a passing probe cover for traffic that is failing.",
  },
  AvailabilityObservation_outcome_check: {
    owner: "list",
    module: "lib/availabilityObservation.ts",
    list: "AVAILABILITY_OBSERVATION_OUTCOMES",
    reason:
      "succeeded or failed. Two values because a rollup divides one by the total; a third would need every consumer to decide which side it counted on, and they would not all decide the same way.",
  },
  DeploymentPriceSnapshot_knowledge_check: {
    owner: "list",
    module: "lib/routingHeldDecisions.ts",
    list: "DEPLOYMENT_PRICE_KNOWLEDGE",
    reason:
      "unknown, estimate, verified. Unknown is a missing amount, not zero. Estimate and verified are stated prices with a source and an effective time. A fourth value would be a price the record-only rule has not decided how to store, and the amount check beside this list would not know which side it was on. Routing and billing do not read the row.",
  },
  DeploymentPriceSnapshot_rate_kind_check: {
    owner: "list",
    module: "lib/routingHeldDecisions.ts",
    list: "DEPLOYMENT_PRICE_RATE_KINDS",
    reason:
      "input, output, cache_read, cache_write. The same four rates lib/modelPricing.ts already prices per million tokens. One amount without a kind cannot say which of those rates it is, and a fifth kind would be a rate the record has no column for. The unit check beside this list fixes the scale at per million tokens.",
  },
  PinnedDeploymentExperimentHold_status_check: {
    owner: "list",
    module: "lib/pinnedDeploymentExecution.ts",
    list: "PINNED_EXPERIMENT_HOLD_STATUSES",
    reason:
      "held, settled, released, occupied. Released is only a call that was confirmed not to have started. Occupied keeps the reservation when the cost is unknown after dispatch. Settled is a measured cost. A fifth value would be a close this ledger has not decided how to apply to the ceiling.",
  },
  AvailabilityRollupApplication_grain_check: {
    owner: "list",
    module: "lib/availabilityObservation.ts",
    list: "AVAILABILITY_ROLLUP_GRAINS",
    reason:
      "deployment, endpoint, provider -- the same grains an observation can be rolled up to. One list, so a rollup application cannot name a grain the observation module does not. Applying the provider grain does not record that the deployment grain was applied.",
  },
  AvailabilityObservation_errorClass_check: {
    owner: "list",
    module: "lib/availabilityObservation.ts",
    list: "AVAILABILITY_FAILURE_CLASSES",
    reason:
      "A subset of ROUTING_ATTEMPT_ERROR_CLASSES, sharing its spelling so an attempt and an observation cannot call a rate limit different things, but not its membership. The first draft admitted the whole vocabulary, which would have counted a rate limit, an empty answer, a client disconnect and our own process stopping as the provider being unavailable -- RoutingAttempt draws those lines with failureLayer and an observation has no layer, so the line is which classes may appear at all. A rate limit counted here would undo QuotaCapacityState in the summary it feeds. Nullable because a success has nothing to classify.",
  },
  RoutingRun_allocationMode_check: {
    owner: "list",
    module: "lib/routingAllocation.ts",
    list: "ROUTING_ALLOCATION_MODES",
    reason:
      "deterministic or explore_bounded, nullable because a run written before an allocator existed genuinely recorded neither and a default of deterministic would read as 'we took the top candidate' on runs where nobody chose. A separate column from RoutingRun.mode, which answers whether the decision was acted on rather than how the candidate was picked: a combined value like shadow_explore has to be pulled apart again by every reader, and the first to get it wrong reports exploration rate over the wrong denominator. A third constraint, RoutingRun_allocation_axis_check, binds this to the seed grain and is not a closed list.",
  },
  RoutingRun_allocationSeedGrain_check: {
    owner: "list",
    module: "lib/routingAllocation.ts",
    list: "ROUTING_ALLOCATION_SEED_GRAINS",
    reason:
      "request or session. The ADR's own first risk is that a per-request seed breaks cache affinity: a conversation that re-rolls every turn never returns to the placement holding its prefix, and the saving disappears with nothing reporting a failure. Recorded beside the mode so that DeploymentCacheAffinity (where turns landed) and this (what the allocator was seeded on) can together say whether affinity was broken on purpose. An exploration must name its grain; a deterministic allocation rolled nothing and names none.",
  },
  ModelDeployment_promptCacheSupport_check: {
    owner: "list",
    module: "lib/deploymentCacheAffinity.ts",
    list: "PROMPT_CACHE_SUPPORT_STATES",
    reason:
      "unproven is the default and a third answer, not a synonym for either of the others: a deployment nobody has checked is not no-cache, which would write off a saving nobody measured, and it is not a cache either. verified_absent is a finding. The last two split on who sends what -- a provider caching a repeated prefix on its own, versus one where the request must carry a marker and the write costs a premium -- because a ranking that could not tell them apart would be assuming a marker either is or is not needed. These values do not decide whether a request carries a marker; that is lib/anthropicPromptCaching.ts, which gates on provider identity.",
  },
  RoutingCandidateVerdict_verdict_check: {
    owner: "list",
    module: "lib/routingCandidateVerdict.ts",
    list: "ROUTING_CANDIDATE_VERDICTS",
    reason:
      "eligible or rejected. An earlier draft of this table held only rejections, which left it unable to say why a model that passed every filter still lost -- the question the table exists for. A nullable reason carries both, bound to the verdict by its own CHECK so the two cannot disagree.",
  },
  RoutingCandidateVerdict_reason_check: {
    owner: "list",
    module: "lib/routerCandidates.ts",
    list: "CANDIDATE_REJECTIONS",
    reason:
      "The eleven reasons the candidate filter can give, the same list the filter itself emits. A reason the list does not know would be a refusal nobody could interpret, and the column is nullable because an eligible candidate has no reason to give.",
  },
  QuotaScope_scopeKind_check: {
    owner: "list",
    module: "lib/deploymentIdentity.ts",
    list: "QUOTA_SCOPE_KINDS",
    reason:
      "What a capacity limit is counted against: credential, endpoint_credential, deployment_credential, account, provider. The first design was one `(scopeKind, scopeId)` pair of strings, and an independent review rejected it because nothing would stop a scope id matching no row -- a limit counted against nothing is indistinguishable from no limit until somebody spends against it. So each kind names its own typed columns behind a foreign key, and `QuotaScope_shape_check` says which ones the kind requires and which it forbids. 'account' rather than 'workspace' because BYOK ownership is the account and no workspace entity exists to point at.",
  },
  CredentialBinding_billingOwner_check: {
    owner: "list",
    module: "lib/deploymentIdentity.ts",
    list: "CREDENTIAL_BILLING_OWNERS",
    reason:
      "tomverse or account. It decides which budget a call draws down, and they are separate namespaces on purpose: an account's own spend must not consume an allowance Tomverse funded. Two further CHECKs bind the funding columns to it, because without them 'who is paying for this call' has two possible answers and the settlement takes whichever column happens to be set.",
  },
  CredentialBinding_status_check: {
    owner: "list",
    module: "lib/deploymentIdentity.ts",
    list: "CREDENTIAL_BINDING_STATUSES",
    reason:
      "disabled, active, revoked. 'revoked' is separate from 'disabled' because they are different facts -- one was switched off and can be switched back on, the other was withdrawn and the secret behind it should be assumed gone. Collapsing them would leave an operator reading a withdrawn credential as merely paused. Nothing in the database prevents a revoked row being set active again -- the values are a vocabulary, not a state machine -- so whatever ends up writing this has to hold that rule itself.",
  },
  ProviderEndpoint_residencyClass_check: {
    owner: "list",
    module: "lib/deploymentIdentity.ts",
    list: "ENDPOINT_RESIDENCY_CLASSES",
    reason:
      "proven and unproven, and deliberately no third value for 'probably'. The question this answers is binary -- may a residency-constrained request be served from here -- and a middle value would be read as a yes by whoever needed one. 'unproven' is the honest default rather than a gap: it says nobody has read a contract naming a recipient entity and a processing region, which is where every provider stands until the contract review lands.",
  },
  RoutingIdentityManifestEntry_versionPinStrength_check: {
    owner: "list",
    module: "lib/deploymentIdentity.ts",
    list: "VERSION_PIN_STRENGTHS",
    reason:
      "The same three values as ModelDeployment_versionPinStrength_check. A published entry copies the pin, and a copy that allowed a fourth spelling would be a publication the live row could not have.",
  },
  ModelDeployment_versionPinStrength_check: {
    owner: "list",
    module: "lib/deploymentIdentity.ts",
    list: "VERSION_PIN_STRENGTHS",
    reason:
      "strong, weak, alias_only. strong is an immutable revision and versionMayDrift() refuses to widen it even when allowVersionDrift is set. weak and alias_only may move only when that flag is also true. The column default is strong, so a row that predates the column cannot drift by omission. The same list is on RoutingIdentityManifestEntry, because a publication that stored a different vocabulary would be a second answer to what the pin was.",
  },
  ModelDeployment_qualityGateStatus_check: {
    owner: "list",
    module: "lib/deploymentIdentity.ts",
    list: "DEPLOYMENT_QUALITY_GATE_STATUSES",
    reason:
      "pending, passed, failed, stale -- per deployment rather than per equivalence class, because no provider in the pool has been shown to attest the immutable artifact that would let one placement's quality evidence stand for another's. 'stale' is its own value rather than a flavour of 'failed': evidence that expired is not evidence the model got worse, and collapsing them would make an expiry read as a regression.",
  },
  RoutingAttempt_errorClass_check: {
    owner: "list",
    module: "lib/routingAttemptStore.ts",
    list: "ROUTING_ATTEMPT_ERROR_CLASSES",
    reason:
      "Why an attempt ended, as a fixed identifier. Bare TEXT until now -- five strings written by four call sites, with nothing stopping a sixth, because nothing branches on it and an operator-facing field no code reads has no other guard than a constraint. The provider_* half mirrors ProviderFailureCategory in lib/providerErrorClassification.ts, which the routing layer computed and then dropped: telling a rate limit apart from an outage is a later change and cannot be made from records that never kept the difference. 'provider_pre_token_failure' is in the list although nothing writes it any more, because rows already carry it and a constraint that refuses its own history can never be validated.",
  },
  RoutingAttempt_failureLayer_check: {
    owner: "type_only",
    reason:
      "RoutingFailureLayer in lib/routingAttemptStore.ts. Which layer refused or broke, which is what makes a failed attempt attributable rather than merely failed. Three of the values exist to keep something out of provider health rather than to describe a provider: 'process' is this host stopping, 'storage' is an object store that no longer holds what the turn needed, and 'model_output' is the provider answering with nothing usable -- the call succeeded, so counting it as an outage would make a quality problem look like one.",
  },
  ModelMigrationRecord_field_check: {
    owner: "database",
    reason:
      "user_settings_default_model, new_conversation_model_ids, conversation_selected_models, app_setting_guest_default. Written as literals by the approved retirement reconciliation, which is the only writer; the completion notice reads them back to say which setting moved, so a fifth value would be a change nobody is told about.",
  },
  ModelLifecycleWorkItem_status_check: {
    owner: "list",
    module: "lib/modelLifecycleWorkItemCore.ts",
    list: "WORK_ITEM_STATUSES",
    reason:
      "The eleven states of the model lifecycle queue. The transition rules read the same array, so a state added to one and not the other is a transition the machine allows and the database refuses.",
  },
  ModelLifecycleWorkItem_action_check: {
    owner: "list",
    module: "lib/modelLifecycleWorkItemCore.ts",
    list: "WORK_ITEM_ACTIONS",
    reason:
      "add, upgrade, replace, retire, monitor, no_action. Part of the item's unique key with provider and apiModel, so a value the application does not know about is a duplicate nobody can see.",
  },
  ModelLifecycleWorkItem_severity_check: {
    owner: "list",
    module: "lib/modelLifecycleWorkItemCore.ts",
    list: "WORK_ITEM_SEVERITIES",
    reason:
      "critical, high, normal. Orders the daily report's action section; an unknown value would sort somewhere arbitrary.",
  },
  MobileDevice_platform_check: {
    owner: "list",
    module: "lib/mobileAuthContract.ts",
    list: "MOBILE_DEVICE_PLATFORMS",
    reason:
      "ios or android, and nothing finer (mobile auth design D16). The coarseness is the privacy decision rather than an omission -- a device list rich enough to be useful is also a hardware and location history for whoever takes the account over -- so a third value arriving as data would be a fingerprint the design refused, not a new platform.",
  },
  MobileDevice_revokedReason_check: {
    owner: "list",
    module: "lib/mobileAuthContract.ts",
    list: "MOBILE_DEVICE_REVOKED_REASONS",
    reason:
      "user_revoked, and deliberately nothing else. Account deletion is the other way a device stops being usable and is absent on purpose: it takes the row with it through the cascade, so a value for it would be one nothing could ever write and a state nobody could query for.",
  },
  MobileTokenFamily_revokedReason_check: {
    owner: "list",
    module: "lib/mobileAuthContract.ts",
    list: "MOBILE_FAMILY_REVOKED_REASONS",
    reason:
      "logout, device_revoked, reuse_detected, account_deleted -- section 6.2 of the mobile auth design verbatim. reuse_detected is the one that matters most: it is written in the transaction that destroys a family after a replayed refresh token, and the sweep that reports on replays reads it, so a reason it does not recognise is an attack nobody counts.",
  },
  MobileAuthEvent_event_check: {
    owner: "list",
    module: "lib/mobileAuthContract.ts",
    list: "MOBILE_AUTH_EVENT_NAMES",
    reason:
      "The eight events the mobile auth subsystem writes (D15). Deliberately finer than MOBILE_AUTH_ERROR_CODES beside it, which the client sees: every refusal reason answers with one message and is told apart only here, so the two lists are not derived from each other and a value added to the codes must not be added here by reflex.",
  },

  ModelLifecycleWorkItem_confidence_check: {
    owner: "list",
    module: "lib/modelLifecycleWorkItemCore.ts",
    list: "WORK_ITEM_CONFIDENCES",
    reason:
      "high, medium, low, describing the automatic recommendation rather than the decision. Nullable: an item nobody has suggested anything about has no confidence to report.",
  },
  ModelLifecycleWorkItem_decision_check: {
    owner: "list",
    module: "lib/modelLifecycleWorkItemCore.ts",
    list: "WORK_ITEM_DECISIONS",
    reason:
      "approve, reject, defer. Paired with ModelLifecycleWorkItem_decision_reason_check, which refuses a decision with no reason and no timestamp, and with the approved_needs_decision check.",
  },
  ModelLifecycleWorkItemEvent_toStatus_check: {
    owner: "list",
    module: "lib/modelLifecycleWorkItemCore.ts",
    list: "WORK_ITEM_STATUSES",
    reason:
      "The same eleven states, on the append-only history. Recorded separately from the item's own column because the history outlives the state it describes.",
  },
  ModelLifecycleWorkItemEvent_decision_check: {
    owner: "list",
    module: "lib/modelLifecycleWorkItemCore.ts",
    list: "WORK_ITEM_EVENT_DECISIONS",
    reason:
      "adopt, exclude, reopen -- the operator decisions the discovery queue records on its history. Null on every step between decisions. Paired with ModelLifecycleWorkItemEvent_decision_shape_check, which refuses an exclusion without a reason code and a reopen without a written reason.",
  },
  ModelLifecycleWorkItemEvent_reasonCode_check: {
    owner: "list",
    module: "lib/modelLifecycleWorkItemCore.ts",
    list: "WORK_ITEM_EXCLUSION_REASONS",
    reason:
      "The six exclusion reasons an operator picks from. A value the panel does not know would be an exclusion nobody can read back or count.",
  },
  ModelLifecycleWorkItemEvent_fromStatus_check: {
    owner: "list",
    module: "lib/modelLifecycleWorkItemCore.ts",
    list: "WORK_ITEM_STATUSES",
    reason:
      "The same eleven states. Nullable for exactly one row per item -- the creation event, which comes from nowhere.",
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
  ConversationContinuationBridge_provider_check: {
    owner: "list",
    module: "lib/externalImportProviders.ts",
    list: "EXTERNAL_IMPORT_PROVIDERS",
    reason:
      "The provider a continuation's source came from, kept on the bridge so the screen can still name it after the source is deleted. Compared against the canonical list rather than recorded as database-only: the bridge is written from that module's type, so a provider added to the list and not to this constraint would fail the write.",
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
      "The chunk lifecycle. Deliberately not the run lifecycle: a chunk is never cancelled on its own, and `skipped` — finished without calling the provider — has no run-level counterpart, so sharing the lists would widen this column.",
  },
  MemoryExtractionCreditReservation_status_check: {
    owner: "database",
    reason:
      "The reservation lifecycle, written by the credit paths as literals inside the transactions that move it.",
  },
  PromptRefinerReservationStage_id_check: {
    owner: "list",
    module: "lib/promptRefinerReservationCore.ts",
    list: "PROMPT_REFINER_RESERVATION_STAGE_IDS",
    reason:
      "The append-only stage identities preserve the completed v1 authority while admitting the separately approved v2 contract. The active writer still selects only PROMPT_REFINER_RESERVATION_STAGE_ID.",
  },
  PromptRefinerReservationStage_status_check: {
    owner: "list",
    module: "lib/promptRefinerReservationCore.ts",
    list: "PROMPT_REFINER_RESERVATION_STAGE_STATUSES",
    reason:
      "The separately approved shadow stage is either open for exact reservations or permanently closed. The authority validates the same list before every state transition.",
  },
  PromptRefinerReservation_status_check: {
    owner: "list",
    module: "lib/promptRefinerReservationCore.ts",
    list: "PROMPT_REFINER_RESERVATION_STATUSES",
    reason:
      "The one-way reservation lifecycle. Terminal rows remain tombstones and the server-only authority branches on these exact values.",
  },
  PromptRefinerVnextOneShotStage_id_check: {
    owner: "database",
    reason:
      "The one-shot stage has exactly two immutable identities: the audited original v1 and its single approved unrun replacement v2. Admission, run approval, and readback use pinned literals rather than a runtime list; a future identity requires a separate policy and migration.",
  },
  PromptRefinerVnextOneShotStage_status_check: {
    owner: "database",
    reason:
      "The dark one-shot stage has no active writer. The database permits staged, separately run-approved, then permanently closed; any future admission must match this closed vocabulary.",
  },
  PromptRefinerVnextOneShotSlot_status_check: {
    owner: "database",
    reason:
      "The dark 80-slot reservation has no active writer. The database permits only reserved to consumed, with a permanent consumed tombstone and no replacement.",
  },
  PromptRefinerAutoBudgetWindow_period_check: {
    owner: "database",
    reason:
      "The default-off product Auto budget books exactly the Brisbane day and month windows. An unknown period cannot acquire a bounded reservation or authorize a provider call.",
  },
  PromptRefinerProductOperationalGuard_state_check: {
    owner: "list",
    module: "lib/promptRefinerProductOperationalGuard.ts",
    list: "PROMPT_REFINER_PRODUCT_AUTO_GUARD_STATES",
    reason:
      "The durable product Auto operational latch is either active or paused. Runtime admission and exact owner resume share this list with the database so no unhandled state can authorize execution.",
  },
  PromptRefinerProductOperationalGuard_reason_check: {
    owner: "list",
    module: "lib/promptRefinerProductOperationalGuard.ts",
    list: "PROMPT_REFINER_PRODUCT_AUTO_STOP_REASONS",
    reason:
      "The five approved Auto stop causes are content-free operational classifications. The pause writer and strict owner resume route validate this same list before a durable transition.",
  },
  // --- AMUX development-agent orchestration ------------------------------
  AmuxIdeaFrontierModelApproval_provider_check: {
    owner: "database",
    reason:
      "AMUX v4 analysis currently admits only OpenAI and Anthropic for operator-approved Frontier models. A future provider needs a policy and migration change; no live model writer is enabled here.",
  },
  AmuxIdeaFrontierModelApproval_status_check: {
    owner: "database",
    reason:
      "The dark Frontier approval row has a one-way approved-to-revoked lifecycle. Reapproval creates a new version and a distinct human audit event.",
  },
  AmuxIdeaSubmission_state_check: {
    owner: "database",
    reason:
      "AMUX v4 idea analysis storage is a closed lifecycle. This schema-only migration does not enable a writer; the future intake service must validate exactly these states before activation.",
  },
  AmuxIdeaSourcePlanRevision_state_check: {
    owner: "database",
    reason:
      "The dark v4 source-plan revision has a closed prepared/active/terminal lifecycle. A future single writer must own matching runtime validation before activation.",
  },
  AmuxIdeaSourceScopeApproval_status_check: {
    owner: "database",
    reason:
      "An owner-approved GitHub read scope is consumed once, expires, is revoked, or needs outcome read-back. No collector is enabled by the schema migration.",
  },
  AmuxIdeaTransferPreview_state_check: {
    owner: "database",
    reason:
      "The v4 model-transfer preview has one confirmed or in-flight attempt per idea chunk; outcome_unknown remains occupied until read-back and owner resolution.",
  },
  AmuxIdeaAnalysisBudgetHold_mode_check: {
    owner: "database",
    reason:
      "The dark v4 analysis hold distinguishes subscription CLI API-conversion estimates from actual API-mode costs. No reservation writer is enabled by the schema migration.",
  },
  AmuxIdeaAnalysisBudgetHold_provider_check: {
    owner: "database",
    reason:
      "Only the currently approved OpenAI and Anthropic analysis providers may appear in the dark hold ledger. A later provider needs a policy and migration change.",
  },
  AmuxIdeaAnalysisBudgetHold_status_check: {
    owner: "database",
    reason:
      "The dark hold lifecycle preserves outcome_unknown as occupied and distinguishes an owner-consumed worst-case reserve from a verified non-start release. The future single writer must validate the same states.",
  },
  AmuxIdeaAnalysisPriceVersion_provider_check: {
    owner: "database",
    reason:
      "Only OpenAI and Anthropic may have owner-approved AMUX v4 analysis prices; adding a provider requires an explicit policy and migration change.",
  },
  AmuxIdeaAnalysisPriceVersion_mode_check: {
    owner: "database",
    reason:
      "Each approved analysis price is tied to subscription CLI or API mode so estimates and actual API costs cannot be silently interchanged.",
  },
  AmuxIdeaAnalysisChunk_state_check: {
    owner: "database",
    reason:
      "One bounded v4 analysis chunk records a normalized draft or an explicit terminal/unknown state. It cannot become a runnable AMUX Task without later owner approval.",
  },
  AmuxIdeaDraftUnit_kind_check: {
    owner: "database",
    reason:
      "The dark v4 proposal-unit schema accepts only node, card, or evidence. No non-synthetic unit writer is enabled; the future strict package parser must use the same closed vocabulary before activation.",
  },
  AmuxIdeaDraftUnit_state_check: {
    owner: "type_only",
    reason:
      "DraftUnitRetentionState in lib/amux/ideaRetentionCore.ts has proposed, approved, rejected, and expired. The read-only cleanup planner knows these four states, but no runtime writer list or live transition route exists yet.",
  },
  AmuxIdeaContentKeyRetirement_purpose_check: {
    owner: "database",
    reason:
      "Only the four per-unit AMUX analysis bodies with approved retention clocks can enter the external key-retirement ledger. Other content categories require their own deletion contract before admission.",
  },
  AmuxIdeaRetentionHold_reason_check: {
    owner: "database",
    reason:
      "AMUX idea-wide retention holds record a constrained reason category rather than free-text personal data in the seven-year approval audit.",
  },
  AmuxIdeaUnitDecision_action_check: {
    owner: "database",
    reason:
      "The dark AMUX v4 owner-decision ledger has a closed action vocabulary. No live decision writer or registration route is enabled by this migration.",
  },
  AmuxIdeaUnitDecision_state_check: {
    owner: "database",
    reason:
      "The dark AMUX v4 owner-decision ledger has one prepared state and terminal states; unresolved outcomes freeze the prepared row until owner read-back.",
  },
  AmuxPortfolioNode_level_check: {
    owner: "database",
    reason:
      "The non-runnable v4 hierarchy has exactly Initiative, Epic and Feature levels. No live hierarchy writer is enabled by the schema migration.",
  },
  AmuxPortfolioNode_state_check: {
    owner: "database",
    reason:
      "An owner-approved v4 hierarchy node remains active or is archived. This is not the AMUX work-item execution status.",
  },
  AmuxPortfolioAssessment_uncertainty_check: {
    owner: "database",
    reason:
      "Owner-confirmed portfolio evidence has exactly low, medium or high uncertainty; the score uses the worst uncertainty across the hierarchy.",
  },
  AmuxPortfolioAssessment_reasonCode_check: {
    owner: "database",
    reason:
      "The append-only portfolio assessment records why the operator entered a new evidence version or override; it never edits a prior score.",
  },
  AmuxWorkItem_status_check: {
    owner: "database",
    reason:
      "The durable board lifecycle: backlog, todo, doing, review, done, blocked, cancelled. Backlog is catalog-only and cannot be dispatched; the scheduler and execution boundary still select only literal todo. A separately approved promotion, not this schema migration, may move a card from backlog to todo. The database remains the complete closed vocabulary.",
  },
  AmuxV22LaneDecision_lane_check: {
    owner: "list",
    module: "lib/amux/v22WorkerClaimCore.ts",
    list: "AMUX_V22_CLAIM_LANES",
    reason:
      "The owner-declared normal, parallel and SEV1 worker-assignment lanes are a closed v22 capacity contract. A fourth value must update the guard and owner route together.",
  },
  AmuxWorkItem_kind_check: {
    owner: "database",
    reason:
      "The ten imported board categories. No Tomverse route creates or edits an AMUX work item yet, and task classification used for worker routing is a separate JSON contract, so the database is currently the only complete closed list for this stored field.",
  },
  AmuxWorkItem_priority_check: {
    owner: "database",
    reason:
      "The persisted p0 through p3 board priority. It is read by the deterministic scheduler but has no Tomverse mutation surface or shared runtime list; the database remains the authority until that surface is introduced.",
  },
  AmuxWorkerRuntime_status_check: {
    owner: "type_only",
    reason:
      "AmuxWorkerRuntimeStatus in lib/amux/workerRuntime.ts carries starting, idle, busy, error and stopped. The authenticated heartbeat route validates the same five values with zod, but neither copy is an exported runtime array the audit can compare mechanically.",
  },
  AmuxIncidentTransition_from_state_check: {
    owner: "list",
    module: "lib/amux/incidentCore.ts",
    list: "AMUX_INCIDENT_STATES",
    reason:
      "The prior state on each append-only AMUX incident transition uses the same normal/frozen vocabulary as the current AppSetting authority.",
  },
  AmuxIncidentTransition_to_state_check: {
    owner: "list",
    module: "lib/amux/incidentCore.ts",
    list: "AMUX_INCIDENT_STATES",
    reason:
      "The next state on each append-only AMUX incident transition uses the same normal/frozen vocabulary as the current AppSetting authority.",
  },
  AmuxResourcePolicy_scope_check: {
    owner: "database",
    reason:
      "Planning policy is scoped only to a project or team. The admin mutation surface validates the same pair, while the database remains the durable authority for stored rows.",
  },
  AmuxWorkItem_due_precision_check: {
    owner: "type_only",
    reason:
      "The canonical deadline parser emits date or instant precision; the stored value preserves which interpretation produced dueAt.",
  },
  AmuxWorkItem_due_source_check: {
    owner: "type_only",
    reason:
      "The canonical deadline stores whether an explicit classification field, title marker or description marker supplied the accepted instant.",
  },
  AmuxWorkItem_due_parse_state_check: {
    owner: "type_only",
    reason:
      "Deadline intake distinguishes absent, valid, invalid and ambiguous input so malformed scheduling data cannot silently become no deadline.",
  },
  AmuxCostLedgerEntry_scope_check: {
    owner: "database",
    reason:
      "Each append-only cost entry charges exactly one configured project or team resource, using the same durable scope vocabulary as policy rows, or an approved adapter agent's own scope, which no admission sum reads.",
  },
  AmuxCostLedgerEntry_kind_check: {
    owner: "database",
    reason:
      "Cost evidence records the conservative execution reservation, an optional provider-confirmed settlement delta and an adapter agent's own model spend as separate append-only facts.",
  },
  AmuxQuotaObservation_source_check: {
    owner: "type_only",
    reason:
      "Quota confidence weights provider API and wrapper observations differently; an unknown source must not inherit a made-up reliability.",
  },
  AmuxHumanEscalation_status_check: {
    owner: "database",
    reason:
      "A human escalation is open, acknowledged or resolved. Lifecycle columns and the partial unique index make unresolved ownership visible and singular per task.",
  },
  AmuxReviewProposal_outcome_check: {
    owner: "type_only",
    reason:
      "The server creates only approve, retry or block task-review proposals through AmuxReviewOutcome in lib/amux/reviewApprovalCore.ts. The database also binds each value to an exact source and target status; no client-supplied outcome can widen that transition set.",
  },
  AmuxReviewDecision_outcome_check: {
    owner: "type_only",
    reason:
      "A decision copies the proposal's closed AmuxReviewOutcome union and the database verifies that match before appending the immutable ledger row. This is a one-person task-review record, not AdminActionApproval or permission for an external action.",
  },
  AmuxExecutionAttempt_outcome_check: {
    owner: "type_only",
    reason:
      "AmuxExecutionOutcome in lib/amux/execution.ts types the worker-supplied succeeded, failed and blocked outcomes. The fourth database value, expired, is deliberately excluded from that input union and is written only by the lease-expiry recovery path.",
  },
  AmuxExecutionAttempt_to_status_check: {
    owner: "type_only",
    reason:
      "AmuxExecutionToStatus in lib/amux/execution.ts types the four worker settlement destinations. Cancelled is a board lifecycle state rather than a worker-supplied settlement result, so it remains in the durable constraint but outside the route's union and zod input.",
  },
  AmuxBoardImportApproval_status_check: {
    owner: "list",
    module: "lib/amux/boardImportCore.ts",
    list: "BOARD_IMPORT_APPROVAL_STATUSES",
    reason:
      "The catalog-import approval lifecycle: prepared, approved, rejected, expired, consumed. Cards are written only on the approved-to-consumed transition, and a conflict or exclude burns the approval id as rejected. The same list is what the service compares before every state change.",
  },
  AmuxReconciliationRun_status_check: {
    owner: "list",
    module: "lib/amux/boardReconciliationCore.ts",
    list: "AMUX_RECONCILIATION_RUN_STATUSES",
    reason:
      "prepared, approved, applying, consumed, rejected, outcome_unknown. A run records one pinned source comparison. Item drift is not inferred from the run manifest digest, and the shipped apply latch stays off.",
  },
  AmuxWorkItemSourceRevision_state_check: {
    owner: "list",
    module: "lib/amux/boardReconciliationCore.ts",
    list: "AMUX_SOURCE_REVISION_STATES",
    reason:
      "observed, accepted, rejected. Rows are append-only. accepted is the only state a card pointer may reference, and the original import is backfilled as accepted without rewriting source columns.",
  },
  AmuxBoardPromotionApproval_status_check: {
    owner: "list",
    module: "lib/amux/boardPromotionCore.ts",
    list: "BOARD_PROMOTION_APPROVAL_STATUSES",
    reason:
      "The manual promotion approval lifecycle: prepared, approved, rejected, expired, consumed. A card leaves backlog only on the approved-to-consumed transition, and that transition stays behind the shipped-off code latch. The service compares this same list before every state change.",
  },
  AmuxRecommendationCapacity_id_check: {
    owner: "list",
    module: "lib/amux/recommendationPoolCore.ts",
    list: "RECOMMENDATION_CAPACITY_IDS",
    reason:
      "The recommendation ceiling is one row, id queue. Version 11 writes that row only from an owner request that names the limit. A missing, inactive, or null-limit row means capacity is unconfigured.",
  },
  AmuxRecommendationSnapshot_status_check: {
    owner: "list",
    module: "lib/amux/recommendationPoolCore.ts",
    list: "RECOMMENDATION_SNAPSHOT_STATUSES",
    reason:
      "A recommendation snapshot is prepared, or outcome_unknown after a lost response. It is not a card status.",
  },
  AmuxRecommendationSnapshot_worker_capacity_check: {
    owner: "list",
    module: "lib/amux/recommendationPoolCore.ts",
    list: "RECOMMENDATION_CLOSED_CAPACITIES",
    reason:
      "Version 7 records per-worker capacity as closed. The value does not grant a runnable slot.",
  },
  AmuxRecommendationSnapshot_classification_capacity_check: {
    owner: "list",
    module: "lib/amux/recommendationPoolCore.ts",
    list: "RECOMMENDATION_CLOSED_CAPACITIES",
    reason:
      "Version 7 records per-classification capacity as closed. The value does not grant a runnable slot.",
  },
  AmuxRecommendationSnapshotItem_disposition_check: {
    owner: "list",
    module: "lib/amux/recommendationPoolCore.ts",
    list: "RECOMMENDATION_DISPOSITIONS",
    reason:
      "A snapshot row is included or excluded. Neither value is an AmuxWorkItem status.",
  },
  AmuxRecommendationSnapshotItem_exclusion_code_check: {
    owner: "list",
    module: "lib/amux/recommendationPoolCore.ts",
    list: "RECOMMENDATION_EXCLUSION_CODES",
    reason:
      "Excluded recommendation rows use the closed reason list from orchestration policy version 7. Included rows store null.",
  },
  AmuxRecommendationDecision_decision_check: {
    owner: "list",
    module: "lib/amux/recommendationPoolCore.ts",
    list: "RECOMMENDATION_DECISIONS",
    reason:
      "A human recommendation decision is approve, hold, reject, or the expired record written by that same request.",
  },
  AmuxRecommendationDecision_status_check: {
    owner: "list",
    module: "lib/amux/recommendationPoolCore.ts",
    list: "RECOMMENDATION_DECISION_STATUSES",
    reason:
      "The stored result of one recommendation decision. consumed is the only status that accompanies a backlog to todo write.",
  },
  AmuxRecommendationDecision_reason_code_check: {
    owner: "list",
    module: "lib/amux/recommendationPoolCore.ts",
    list: "RECOMMENDATION_REASON_CODES",
    reason:
      "Hold and reject store one of these codes. There is no free-text reason. Approve and expiry leave the column null.",
  },
  AmuxRecommendationAutoGrant_status_check: {
    owner: "list",
    module: "lib/amux/autoPromotionCore.ts",
    list: "AUTO_GRANT_STATUSES",
    reason:
      "active, consumed, expired. A grant is a human pre-approval and is not a card status. Version 8's public route does not insert one.",
  },
  AmuxRecommendationAutoConsumption_status_check: {
    owner: "list",
    module: "lib/amux/autoPromotionCore.ts",
    list: "AUTO_CONSUMPTION_STATUSES",
    reason:
      "consumed or outcome_unknown. consumed is the only status that accompanies one backlog to todo write. Version 9 turns the code latch on. The write still needs the env value exactly enabled plus the version 8 graduation, capacity, cost, and halt checks.",
  },
  AmuxRecommendationAutoHalt_reason_check: {
    owner: "list",
    module: "lib/amux/autoPromotionCore.ts",
    list: "AUTO_HALT_REASONS",
    reason:
      "critical_violation or outcome_unknown_burst. An open halt has no resume writer in version 8.",
  },
  AmuxRecommendationAutoHalt_violation_code_check: {
    owner: "list",
    module: "lib/amux/autoPromotionCore.ts",
    list: "AUTO_CRITICAL_CODES",
    reason:
      "The closed critical-violation codes. Ordinary refusals such as graduation_unmet are not in this list. Null is the outcome-unknown burst.",
  },
  QaReleaseMergeAttempt_state_check: {
    owner: "list",
    module: "lib/qaReleaseMergeAttemptCore.ts",
    list: "QA_RELEASE_MERGE_ATTEMPT_STATES",
    reason:
      "The merge lane attempt's lifecycle (docs/policy/qa-release-agent.md version 4, section 8 item 5): issued, consumed, awaiting_deploy, closed. The migration's trigger enforces the core's transition table; tests/integration/qa-release-merge-attempt.db.test.ts checks the two against each other.",
  },
  QaReleaseMergeLaneLatch_reason_check: {
    owner: "list",
    module: "lib/qaReleaseMergeLaneLatchCore.ts",
    list: "QA_RELEASE_MERGE_LANE_LATCH_REASONS",
    reason:
      "Why the merge lane latched (docs/policy/qa-release-agent.md version 4, section 8 item 5). A set event carries one; a person's release carries none.",
  },
  QaReleaseMergeAttempt_outcome_check: {
    owner: "list",
    module: "lib/qaReleaseMergeAttemptCore.ts",
    list: "QA_RELEASE_MERGE_ATTEMPT_OUTCOMES",
    reason:
      "Why a closed attempt closed, each naming who decided it: the lane from what it read, or a person through the latch release from what they confirmed. Set exactly when the state becomes closed.",
  },
  AgentDigestItem_agent_key_check: {
    owner: "list",
    module: "lib/agentDigestContract.ts",
    list: "AGENT_DIGEST_AGENT_KEYS",
    reason:
      "The agents that may store digests in the shared AgentDigestItem table. Adding an agent is a reviewed migration that also gives it a kind list and a body retention; an unknown key would be a write no agent owns.",
  },
  AmuxOrchestratorWrite_call_kind_check: {
    owner: "list",
    module: "lib/amux/orchestratorHaltCore.ts",
    list: "AMUX_ORCHESTRATOR_CALL_KINDS",
    reason:
      "The three orchestrator write calls that are admitted before they are processed (orchestration policy version 20, section 4): claim, recover and the automatic promotion tick. Selection reads, acknowledgements and halt records are not write calls and are never admitted.",
  },
  AmuxOrchestratorWrite_resolution_check: {
    owner: "list",
    module: "lib/amux/orchestratorHaltCore.ts",
    list: "AMUX_ORCHESTRATOR_RESOLUTIONS",
    reason:
      "no_commit is the resolver's rollback confirmed by the evidence, human_confirmed is a person clearing the halt that names the request. An acknowledgement is ackedAt, not a resolution. Null is an admission not yet resolved.",
  },
  AmuxOrchestratorWriteReceipt_target_kind_check: {
    owner: "list",
    module: "lib/amux/orchestratorHaltCore.ts",
    list: "AMUX_ORCHESTRATOR_RECEIPT_TARGET_KINDS",
    reason:
      "The closed list of what a receipt names (policy version 20, section 4): card, claim decision, attempt, automatic promotion grant and consumption, and the quota observation batch. A kind outside it would be a state change the Admin halts screen cannot link or explain.",
  },
  AmuxOrchestratorHalt_reason_code_check: {
    owner: "list",
    module: "lib/amux/orchestratorHaltCore.ts",
    list: "AMUX_ORCHESTRATOR_HALT_REASON_CODES",
    reason:
      "The six halt reasons of policy version 20, section 2. The first four carry the write's request id as the halt key; contract_violation and selection_read_failures carry none. The orchestrator's Rust list is pinned to the same six by tests/amuxOrchestratorHaltCore.test.mjs.",
  },
  AmuxDecisionMakerSwitchEvent_scope_check: {
    owner: "list",
    module: "lib/amux/decisionMakerSwitchCore.ts",
    list: "DM_SWITCH_SCOPES",
    reason:
      "The Decision Maker kill switch and the two DM instances (docs/policy/amux-decision-maker.md sections 7 and 8). The instances are the S1a router's own, pinned to it by tests/amuxDecisionMakerSwitch.test.mjs; a third vendor is a policy version.",
  },
  AmuxDecisionMakerSwitchEvent_value_check: {
    owner: "list",
    module: "lib/amux/decisionMakerSwitchCore.ts",
    list: "DM_SWITCH_VALUES",
    reason:
      "on, off and proposal, and a second CHECK pairs them with the scope: the kill switch takes on or off, an instance off or proposal (section 8). There is no autonomous value; version 1 is proposal-only, and an autonomous mode is a v2 policy and a schema change, never a stored string.",
  },
  AmuxDecisionMakerSwitchEvent_reason_code_check: {
    owner: "list",
    module: "lib/amux/decisionMakerSwitchCore.ts",
    list: "DM_SWITCH_REASON_CODES",
    reason:
      "operator for a person's change; validation_latch (three consecutive DM validation failures, section 8) and cleanup_latch (a request directory whose removal could not be confirmed, section 5) for the system, which may only turn an instance off.",
  },
  AmuxDecisionMakerSwitchEvent_actor_kind_check: {
    owner: "list",
    module: "lib/amux/decisionMakerSwitchCore.ts",
    list: "DM_SWITCH_ACTOR_KINDS",
    reason:
      "human or system. The guard trigger binds each to its own audit entry of the same transaction: a person's under amux.decision.mode or amux.decision.latch_release, a latch under amux.decision.latch by the instance's own system actor.",
  },
  AmuxDecisionMakerRequest_route_check: {
    owner: "list",
    module: "lib/amux/decisionMakerRequestCore.ts",
    list: "DM_REQUEST_ROUTES",
    reason:
      "routeDmQuestion()'s two results (docs/policy/amux-decision-maker.md section 3). There is no autonomous route in policy version 1; a third value would be a v2 policy and a schema change. Further CHECKs tie the route to the refusal codes: dm_proposal carries none, operator at least one.",
  },
  AmuxDecisionMakerRequest_instance_check: {
    owner: "list",
    module: "lib/amux/decisionMakerSwitchCore.ts",
    list: "DM_INSTANCE_SCOPES",
    reason:
      "The two DM instances, the switch store's own list (section 7), or NULL for a provider the router does not verify. A separate CHECK pairs the instance with the asking provider: claude to decision-maker-openai, codex to decision-maker-anthropic.",
  },
  AmuxDecisionMakerRequestEvent_kind_check: {
    owner: "list",
    module: "lib/amux/decisionMakerRequestCore.ts",
    list: "DM_LEDGER_EVENT_KINDS",
    reason:
      "The request lifecycle, each kind named after its section 10 audit action, which the guard trigger requires (amux.decision.<kind>): the nine of stage S1c, which the request store writes and dmEventRefusal() mirrors, and since stage S1e (migration 20261008130100_amux_decision_maker_judgment_delivery, which recreated this CHECK) a person's judgment -- confirm, edit_confirm, reject -- which the judgment table's trigger writes beside the judgment row and which closes the request. Deliveries, retention and body events have tables of their own and are not values here.",
  },
  AmuxDecisionMakerRequestEvent_instance_check: {
    owner: "list",
    module: "lib/amux/decisionMakerSwitchCore.ts",
    list: "DM_INSTANCE_SCOPES",
    reason:
      "The instance a transmission, result or rejection event comes from; NULL on the router's assignment and closing events. The guard trigger also requires it to be the request's own instance.",
  },
  AmuxDecisionMakerRequestEvent_vendor_check: {
    owner: "list",
    module: "lib/amux/decisionMakerRequestCore.ts",
    list: "DM_VENDORS",
    reason:
      "The vendor a transmission intent records (section 10), paired with the instance by a second CHECK: openai with decision-maker-openai, anthropic with decision-maker-anthropic. The writer derives it from the instance.",
  },
  AmuxDecisionMakerRequestEvent_snapshot_state_check: {
    owner: "list",
    module: "lib/amux/decisionMakerRequestCore.ts",
    list: "DM_SNAPSHOT_STATES",
    reason:
      "Section 5's three snapshot states, recorded on the transmission intent: none (card only), worker_head and develop. A second CHECK requires the target SHA and the manifest digest exactly when the state is not none.",
  },
  AmuxDecisionMakerRequestEvent_result_kind_check: {
    owner: "list",
    module: "lib/amux/decisionMakerRequestCore.ts",
    list: "DM_RESULT_KINDS",
    reason:
      "Section 6's five terminal results. A partial unique index keeps one per request; the first three are DM output and are held to the result deadline when recorded and at COMMIT, timeout and unavailable only hand the question to the operator.",
  },
  AmuxDecisionMakerRequestEvent_rejection_reason_check: {
    owner: "list",
    module: "lib/amux/decisionMakerRequestCore.ts",
    list: "DM_RESULT_REJECTION_REASONS",
    reason:
      "Why an arriving result was recorded as rejected (sections 6 and 9). The guard trigger checks the first five against the ledger's own state; binding_mismatch and kill_switch are decided from the submission and the switch store, outside the ledger.",
  },
  AmuxDecisionMakerBody_field_check: {
    owner: "list",
    module: "lib/amux/decisionMakerBodyCore.ts",
    list: "DM_BODY_FIELDS",
    reason:
      "Section 10's five body fields and nothing else: the card text, the DM's answer, rationale and escalation reason, and the operator's edited answer. A second CHECK holds each field's byte cap, and a unique index keeps one row per field per request, so a request holds at most 37 KiB of the 40 KiB section 10 allows. The guard binds each field to the audit row of what it belongs to.",
  },
  AmuxDecisionMakerRetentionEvent_kind_check: {
    owner: "list",
    module: "lib/amux/decisionMakerBodyCore.ts",
    list: "DM_RETENTION_EVENT_KINDS",
    reason:
      "Section 10's three retention events: retention_set (once per request, written by the database when the request closes) and a person's hold_set and hold_release. An open hold counts hold events only; retention_set never enters it.",
  },
  AmuxDecisionMakerRetentionEvent_actor_kind_check: {
    owner: "list",
    module: "lib/amux/decisionMakerBodyCore.ts",
    list: "DM_RETENTION_ACTOR_KINDS",
    reason:
      "system for retention_set, human for a legal hold or its release (section 10: a person with ops:write and a recent step-up). A second CHECK pairs the actor with the kind and requires the person's id exactly for human.",
  },
  AmuxDecisionMakerResultDetail_result_kind_check: {
    owner: "list",
    module: "lib/amux/decisionMakerRequestCore.ts",
    list: "DM_RESULT_KINDS",
    reason:
      "The terminal result a detail row belongs to, the ledger's own five kinds (section 6). The guard requires it to equal the kind of the result event it names, of the same transaction.",
  },
  AmuxDecisionMakerResultDetail_output_kind_check: {
    owner: "list",
    module: "lib/amux/decisionMakerBodyCore.ts",
    list: "DM_OUTPUT_KINDS",
    reason:
      "Section 6's three kinds of DM output: select, free_text and escalate; NULL for a validation failure, a timeout and an unavailable DM. A shape CHECK ties it to the result kind, the option id and the irreversible flag.",
  },
  AmuxDecisionMakerDigestKeyEvent_kind_check: {
    owner: "list",
    module: "lib/amux/decisionMakerBodyCore.ts",
    list: "DM_DIGEST_KEY_EVENT_KINDS",
    reason:
      "A key period's rotation into use and its destruction (section 10: the rotation and destruction of keys are recorded as system audits), each once per period by partial unique indexes and each under its own router audit action, amux.decision.digest_key_rotate or .digest_key_destroy.",
  },
  AmuxDecisionMakerJudgment_kind_check: {
    owner: "list",
    module: "lib/amux/decisionMakerJudgmentCore.ts",
    list: "DM_JUDGMENT_KINDS",
    reason:
      "Section 2-6: a person confirms the proposal as it is, confirms it edited, or rejects it, once per request. The same three kinds close the request in the ledger, and each is recorded under the person's amux.decision.<kind> audit, which the guard requires.",
  },
  AmuxDecisionMakerJudgment_instance_check: {
    owner: "list",
    module: "lib/amux/decisionMakerSwitchCore.ts",
    list: "DM_INSTANCE_SCOPES",
    reason:
      "The DM instance whose proposal was judged, the switch store's own list (section 7). The guard requires it to be the request's own instance; section 4's report counts judgments per instance.",
  },
  AmuxDecisionMakerJudgment_declaration_accuracy_check: {
    owner: "list",
    module: "lib/amux/decisionMakerJudgmentCore.ts",
    list: "DM_DECLARATION_ACCURACIES",
    reason:
      "Section 4: matched, mismatched or not_judged, not_judged by default. A second CHECK requires the wrong items (effect_class, resolution, paths) exactly when mismatched; section 4's report counts each.",
  },
  AmuxDecisionMakerJudgment_shown_snapshot_state_check: {
    owner: "list",
    module: "lib/amux/decisionMakerRequestCore.ts",
    list: "DM_SNAPSHOT_STATES",
    reason:
      "The snapshot state Admin showed beside a confirmed proposal (section 6: none shown as card only, worker_head or develop), the transmission's own list; NULL on a rejection. The guard requires it to equal the transmission intent's state.",
  },
  AmuxDecisionMakerDeliveryEvent_kind_check: {
    owner: "list",
    module: "lib/amux/decisionMakerJudgmentCore.ts",
    list: "DM_DELIVERY_EVENT_KINDS",
    reason:
      "Sections 2-7 and 9: the delivery decision of a confirmed answer, then its receipt or an unknown outcome, then a person's resolution of an unknown outcome -- each once per request by a partial unique index, in that order by the guard.",
  },
  AmuxDecisionMakerDeliveryEvent_outcome_check: {
    owner: "list",
    module: "lib/amux/decisionMakerJudgmentCore.ts",
    list: "DM_DELIVERY_RESOLVE_OUTCOMES",
    reason:
      "What a person found when they checked an unknown delivery (section 9): delivered or not_delivered; NULL on every other kind. A shape CHECK requires it exactly on the resolution.",
  },
  AmuxDecisionMakerDeliveryEvent_actor_kind_check: {
    owner: "list",
    module: "lib/amux/decisionMakerJudgmentCore.ts",
    list: "DM_DELIVERY_ACTOR_KINDS",
    reason:
      "system for the decision, the receipt and the unknown outcome (the router's audit), human for the resolution (a person's audit). A shape CHECK pairs the actor with the kind and requires the person's id exactly for human.",
  },
  AmuxIntakeDraft_status_check: {
    owner: "list",
    module: "lib/amux/intakeRegistrationCore.ts",
    list: "AMUX_INTAKE_DRAFT_STATUSES",
    reason:
      "consumed, rejected, expired. A draft row stores digests only. Proposal text stays null, and the shipped apply latch keeps the public route from inserting one.",
  },
  AmuxIntakeApproval_status_check: {
    owner: "list",
    module: "lib/amux/intakeRegistrationCore.ts",
    list: "AMUX_INTAKE_APPROVAL_STATUSES",
    reason:
      "consumed, outcome_unknown. The consumed row is written in the same transaction as the backlog card and the human audit. This list is not the catalog import approval list.",
  },
  OpsObserverDelivery_status_check: {
    owner: "list",
    module: "scripts/ops-observer/delivery-core.mjs",
    list: "DELIVERY_STATUSES",
    reason:
      "reserved, confirmed, shadowed, abandoned. Created reserved and closed once; the trigger binds confirmed to a live genesis and shadowed to a shadow one, and a CHECK ties each status to its one timestamp.",
  },
  OpsObserverDelivery_mode_check: {
    owner: "list",
    module: "scripts/ops-observer/genesis-core.mjs",
    list: "GENESIS_MODES",
    reason:
      "shadow, live. Copied from the genesis by the trigger, never written by a caller.",
  },
  OpsObserverDeliveryItem_mode_check: {
    owner: "list",
    module: "scripts/ops-observer/genesis-core.mjs",
    list: "GENESIS_MODES",
    reason:
      "shadow, live. Copied from the reservation by the trigger, so a shadow item never occupies a live incident slot.",
  },
  OpsObserverDeliveryItem_kind_check: {
    owner: "list",
    module: "scripts/ops-observer/delivery-core.mjs",
    list: "MESSAGE_KINDS",
    reason:
      "new_open, worsening, reopen, recovery. Each kind is reserved once per incident within a mode (the unique on mode, signal, scope, kind, openedAt).",
  },
  OpsObserverDeliveryItem_origin_check: {
    owner: "list",
    module: "scripts/ops-observer/delivery-core.mjs",
    list: "ITEM_ORIGINS",
    reason:
      "new, reopen. How the incident began, recorded for the digest and the transition review; it does not decide the daily cap, which exempts the first worsening of a key per owner date whatever began the incident (docs/policy/sre-ops.md §5).",
  },
  OpsObserverDeferredItem_mode_check: {
    owner: "list",
    module: "scripts/ops-observer/genesis-core.mjs",
    list: "GENESIS_MODES",
    reason:
      "shadow, live. Copied from the genesis by the trigger, so the digest can tell a shadow day's held-back messages from a live one's.",
  },
  OpsObserverDeferredItem_kind_check: {
    owner: "list",
    module: "scripts/ops-observer/delivery-core.mjs",
    list: "MESSAGE_KINDS",
    reason:
      "new_open, worsening, reopen, recovery. The kinds a reservation item takes; the cap only ever defers the capped ones, and each is deferred once per incident within a mode (the unique on mode, signal, scope, kind, openedAt).",
  },
  OpsObserverDeferredItem_origin_check: {
    owner: "list",
    module: "scripts/ops-observer/delivery-core.mjs",
    list: "ITEM_ORIGINS",
    reason:
      "new, reopen. How the incident began, read from the key's open state as for a reservation item (docs/policy/sre-ops.md §5).",
  },
  OpsObserverRunGuard_kind_check: {
    owner: "list",
    module: "scripts/ops-observer/delivery-core.mjs",
    list: "RUN_GUARD_KINDS",
    reason:
      "daily_digest. The one run whose last write is to shared tables; its guard row carries the deadline the deferred trigger checks at COMMIT (docs/policy/sre-ops.md §6 item 5).",
  },
  OpsObserverGenesis_reason_check: {
    owner: "list",
    module: "scripts/ops-observer/genesis-core.mjs",
    list: "GENESIS_REASONS",
    reason:
      "initial, recovery, activation. The trigger holds each to its place in the chain: initial only first and shadow, recovery in the head mode, activation shadow to live once. Only the Admin genesis action writes a row.",
  },
  OpsObserverGenesis_mode_check: {
    owner: "list",
    module: "scripts/ops-observer/genesis-core.mjs",
    list: "GENESIS_MODES",
    reason:
      "shadow, live. There is no path from live back to shadow; stopping is the switch, not a genesis (docs/policy/sre-ops.md §8).",
  },
  ProductResearchObservation_outcome_check: {
    owner: "list",
    module: "lib/productResearchObservationCore.mjs",
    list: "OBSERVATION_OUTCOMES",
    reason:
      "ok, failed. A failed slot has nowhere to put a payload: the shape CHECK requires every success column to be null, so a failure cannot display an earlier success content.",
  },
  ProductResearchObservation_failureStage_check: {
    owner: "list",
    module: "lib/productResearchObservationCore.mjs",
    list: "OBSERVATION_FAILURE_STAGES",
    reason:
      "Where a failed run stopped. Closed because the stage is stored and displayed with a label of its own; a free string would render as itself.",
  },
  SupportTriageDecisionRecord_decisionKind_check: {
    owner: "list",
    module: "lib/supportTriageCore.ts",
    list: "DECISION_KINDS",
    reason:
      "What a person decided: a suggestion accepted or rejected, a group confirmed or dismissed, a sample judged. One record per decision; the record itself is never changed.",
  },
  SupportTriageGroup_state_check: {
    owner: "list",
    module: "lib/supportTriageCore.ts",
    list: "GROUP_STATES",
    reason:
      "candidate and confirmed are open; dismissed, expired and invalidated are terminal. The guard trigger allows only the core table's transitions, and a terminal group takes nothing but its tombstone clearing.",
  },
  SupportTriageGroup_primaryKind_check: {
    owner: "list",
    module: "lib/supportTriageCore.ts",
    list: "GROUP_KIND_PRIORITY",
    reason:
      "The one kind a group is an equivalence class of, in priority order. Fixed for the life of the group.",
  },
  SupportTriageGroup_decision_check: {
    owner: "list",
    module: "lib/supportTriageCore.ts",
    list: "GROUP_DECISIONS",
    reason:
      "A person's decision, kept apart from the state so that a confirmed group that later loses members still says it was confirmed.",
  },
  SupportTriageGroup_ownerQueueState_check: {
    owner: "list",
    module: "lib/supportTriageCore.ts",
    list: "OWNER_QUEUE_STATES",
    reason:
      "Whether a candidate group has been shown to a person; the same two values as a suggestion's, reached once and stamped by the database.",
  },
  SupportTriageGroupSignal_kind_check: {
    owner: "list",
    module: "lib/supportTriageCore.ts",
    list: "GROUP_KIND_PRIORITY",
    reason:
      "One signal row per group and kind. Every kind is an equality over a server fact; a report's text is never one.",
  },
  SupportTriageGroupSignal_provenanceClass_check: {
    owner: "list",
    module: "lib/supportTriageCore.ts",
    list: "SIGNAL_PROVENANCE_CLASSES",
    reason:
      "Where the signal's server value comes from. A second CHECK ties it to the kind, so the column can never disagree with SIGNAL_PROVENANCE.",
  },
  SupportTriageSuggestion_state_check: {
    owner: "list",
    module: "lib/supportTriageCore.ts",
    list: "SUGGESTION_STATES",
    reason:
      "pending, claimed, ready and six terminal states. The guard trigger allows only the core table's transitions and never changes a terminal row.",
  },
  SupportTriageSuggestion_failureCode_check: {
    owner: "list",
    module: "lib/supportTriageCore.ts",
    list: "SUGGESTION_FAILURE_CODES",
    reason:
      "Why a suggestion failed; present exactly when the state is failed. retry_exhausted is what a fourth reclaim must become, because the attempt count stops at three.",
  },
  SupportTriageSuggestion_lane_check: {
    owner: "list",
    module: "lib/supportTriageCore.ts",
    list: "TRIAGE_LANES",
    reason:
      "Six lanes. Account and privacy reports share trust_safety_human with security, legal and self-harm reports (operator decision 2026-10-03); there is no separate account lane.",
  },
  SupportTriageSuggestion_ownerQueueState_check: {
    owner: "list",
    module: "lib/supportTriageCore.ts",
    list: "OWNER_QUEUE_STATES",
    reason:
      "Whether a ready suggestion has been shown to a person. Separate from the state, reached once and stamped by the database.",
  },
  SupportTriageRun_kind_check: {
    owner: "list",
    module: "lib/supportTriageCore.ts",
    list: "SUPPORT_TRIAGE_RUN_KINDS",
    reason:
      "worker and retention. Each kind has its own deadline (5 minutes, 100 seconds) and its own daily cap of 52, both applied by the row-creation trigger from the kind alone.",
  },
  SupportTriageRun_outcome_check: {
    owner: "list",
    module: "lib/supportTriageCore.ts",
    list: "SUPPORT_TRIAGE_RUN_OUTCOMES",
    reason:
      "running until the run finishes, then one final outcome. The finishing trigger turns a late success or partial into deadline_exceeded, so the list holds a value the database records and the application never asks for.",
  },
  EngineeringAgentRun_status_check: {
    owner: "list",
    module: "lib/engineeringAgentCore.ts",
    list: "RUN_STATUSES",
    reason:
      "active, finished, abandoned. A transition trigger allows only the core table's pairs and refuses a finish after the lease.",
  },
  EngineeringAgentRun_outcome_check: {
    owner: "list",
    module: "lib/engineeringAgentCore.ts",
    list: "RUN_OUTCOMES",
    reason:
      "How a run ended. Null while active; abandoned only with the abandoned status.",
  },
  EngineeringAgentRun_halt_check: {
    owner: "list",
    module: "lib/engineeringAgentCore.ts",
    list: "HALT_VALUES",
    reason:
      "Why the agent stopped taking work, if it did. none is the ordinary value.",
  },
  EngineeringAgentRun_modeAtStart_check: {
    owner: "list",
    module: "lib/engineeringAgentCore.ts",
    list: "ENGINEERING_AGENT_MODES",
    reason:
      "The mode a run started under. The insert trigger reads it from AppSetting and writes it itself; anything unknown is off, as parseEngineeringAgentMode reads it.",
  },
  EngineeringAgentWorkItem_kind_check: {
    owner: "list",
    module: "lib/engineeringAgentCore.ts",
    list: "ENGINEERING_AGENT_WORK_ITEM_KINDS",
    reason:
      "The six work item kinds. Each kind's states are a separate CHECK, compared by tests/engineeringAgentSchema.test.mjs.",
  },
  EngineeringAgentWorkItem_claimMode_check: {
    owner: "list",
    module: "lib/engineeringAgentCore.ts",
    list: "WRITE_CLAIM_MODES",
    reason:
      "write or lookup; set only while an item is claimed.",
  },
  EngineeringAgentApproval_decision_check: {
    owner: "list",
    module: "lib/engineeringAgentCore.ts",
    list: "ENGINEERING_AGENT_T2_DECISIONS",
    reason:
      "A T2 decision's two answers. The table holds T2 decisions only, never a publish approval.",
  },
  EngineeringAgentBinding_state_check: {
    owner: "list",
    module: "lib/engineeringAgentCore.ts",
    list: "BINDING_STATES",
    reason:
      "open, closed, pruned; a trigger allows only open to closed and closed to pruned.",
  },
  EngineeringAgentRegistration_source_check: {
    owner: "list",
    module: "lib/engineeringAgentRegistrationGuard.ts",
    list: "REGISTRATION_SOURCE_IDS",
    reason:
      "The three registration sources the policy names; adding one is a policy revision.",
  },
  EngineeringAgentRegistration_result_check: {
    owner: "list",
    module: "lib/engineeringAgentCore.ts",
    list: "REGISTRATION_RESULTS",
    reason:
      "pending until the AMUX writer answers; then written once.",
  },
  EngineeringAgentRequest_state_check: {
    owner: "list",
    module: "lib/engineeringAgentCore.ts",
    list: "REQUEST_STATES",
    reason:
      "Internal request idempotency; in_progress may stay visible because a COMMIT can land late.",
  },
  AmuxLocalIntakeNormalized_priority_check: {
    owner: "list",
    module: "lib/amux/localIntakeCore.ts",
    list: "LOCAL_INTAKE_PRIORITIES",
    reason:
      "p0 through p3 on the normalized local-intake row. The work item priority check stays the board vocabulary. This row is written only with a policy version 3 local intake card.",
  },
  AmuxLocalIntakeApproval_status_check: {
    owner: "list",
    module: "lib/amux/localIntakeCore.ts",
    list: "LOCAL_INTAKE_APPROVAL_STATUSES",
    reason:
      "consumed or outcome_unknown for one local intake card. The shipped code latch is false, so the public route does not insert one until the environment value is exactly enabled.",
  },
  AmuxWorkDelivery_status_check: {
    owner: "database",
    reason:
      "The queued, leased, acknowledged and cancelled delivery lifecycle. Each transition is an internal literal paired with AmuxWorkDelivery_lifecycle_check; no request supplies a status and there is no independent runtime list to compare.",
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
      "Where a preference row came from: signup, preference_center, unsubscribe_link, admin, system_default, privacy_request, provider_complaint. The last two are the deletion intake and the spam-complaint opt-out (docs/policy/email-product-news-redesign-draft.md, section 7.4). Written as literals at each write site in lib/emailPreferences.ts and its callers. It is audit provenance rather than a value anything branches on, which is why there is no runtime list to compare against -- and why a sixth value has to be argued for here before it can be written.",
  },
  ConsentRecord_action_check: {
    owner: "type_only",
    reason:
      "ConsentAction in lib/emailPreferenceCore.ts: granted, withdrawn, reconfirmed, confirmation_notice_sent, confirmation_requested, lapsed. confirmation_notice_sent and lapsed are the Korean confirmation duty and the optional lapse behind its own flag (\u00a75.5); they are separate values precisely because notifying is not expiring, and folding them together would make the history unable to answer which one happened. confirmation_requested is the double opt-in's request (docs/policy/email-double-opt-in.md \u00a74.4) and is not a consent: recording it as granted would log the sending of a confirmation mail as agreement.",
  },
  ConsentRecord_captured_via_check: {
    owner: "database",
    reason:
      "Which surface captured the consent, kept because the evidence a regulator asks for is where and how, not only when. provider_complaint is a withdrawal the complaint itself made, pinned to the delivery complained about (docs/policy/email-product-news-redesign-draft.md, section 7.4). Written as a literal by each surface; there is no runtime list.",
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
  SuppressionCause_reason_check: {
    owner: "type_only",
    reason:
      "The same six reasons as SuppressionEntry_reason_check (SuppressionReason in lib/emailSuppressionCore.ts). A cause is one event behind a suppression, so it names the same things; the two lists move together until entries are retired (docs/policy/email-product-news-redesign-draft.md, section 7.4).",
  },
  SuppressionCause_source_stream_check: {
    owner: "type_only",
    reason:
      "SendingStream in lib/emailSendingIdentityCore.ts, nullable for the same reason as SuppressionEntry_source_stream_check: a manual or privacy-request cause has no originating stream.",
  },
  SuppressionCause_provider_account_check: {
    owner: "type_only",
    reason:
      "SendingStream in lib/emailSendingIdentityCore.ts: the provider account is one per stream (A18). Nullable, because a cause carried from an entry written before accounts were recorded does not know which it was.",
  },
  EmailDelivery_provider_account_check: {
    owner: "type_only",
    reason:
      "SendingStream in lib/emailSendingIdentityCore.ts, fixed at send from the template version's classification. Nullable for rows never sent and rows from before the column existed.",
  },
  ProviderWebhookEvent_provider_account_check: {
    owner: "type_only",
    reason:
      "SendingStream in lib/emailSendingIdentityCore.ts: the account whose webhook endpoint and signing secret an event came through (docs/policy/email-product-news-redesign-draft.md, section 7.4, C56). Not nullable -- the route knows its account before it stores anything, and events from before the column existed all came through the transactional endpoint.",
  },
  EmailPreferenceTransition_source_check: {
    owner: "type_only",
    reason:
      "setPreference()'s source union in lib/emailPreferences.ts plus consent_confirmation, and two sources reserved for writers the redesign draft names -- privacy_request and provider_complaint (docs/policy/email-product-news-redesign-draft.md, section 7.4). A transition whose origin the code cannot name would be history nobody can read.",
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
  EmailCampaign_status_check: {
    owner: "database",
    reason:
      "A campaign's lifecycle: draft through completed, plus cancelled and halted. Kept off EmailEvent.status deliberately -- approval is a property of the campaign, and adding draft/pending_approval to the outbox's vocabulary would put it in the table that also holds login codes. Written as literals by lib/emailCampaignService.ts and judged by lib/emailCampaignCore.ts.",
  },
  EmailCampaign_category_check: {
    owner: "database",
    reason:
      "What the campaign is about, from section 12.2 of the model lifecycle audit. Five model lifecycle events plus `other`, so a campaign that is not about a model still has somewhere to be rather than borrowing a category that misdescribes it.",
  },
  EmailCampaign_approval_completeness_check: {
    owner: "database",
    reason:
      "An approved campaign has both halves of its approval or neither: an approval id, an approval time, and the copy that was pinned. A row with an approval and no pin would send whatever the code says today, which is the whole failure EM-06 describes.",
  },
  EmailCampaignWave_status_check: {
    owner: "database",
    reason:
      "One send within a campaign, which is a narrower life than the campaign's: pending through done, plus cancelled and halted. Separate from EmailCampaign.status because a campaign that is running has waves in several of these at once.",
  },
  EmailCampaignWave_kind_check: {
    owner: "database",
    reason:
      "Which send this is -- launch, notice, reminder, final reminder, completion. Part of the unique key with sequence, so it is what makes a second `reminder 1` impossible rather than merely unlikely.",
  },
  EmailCampaign_trigger_mode_check: {
    owner: "database",
    reason:
      "How a campaign's waves are started: manual, auto_draft, or approved_schedule. Only the third is the scheduler's to act on -- a campaign left on manual is one somebody intends to watch as it goes out, and starting it for them because a time happened to be set would take that decision away silently. Judged by lib/emailCampaignScheduleCore.ts.",
  },
  EmailCampaignAttestation_kind_check: {
    owner: "list",
    module: "lib/emailCampaignAttestationCore.ts",
    list: "ATTESTATION_KINDS",
    reason:
      "The three conditions of section 13.3 that no field holds, recorded as somebody having said them: the body names the capability and credit differences, staging was verified, the reconciliation and its rollback are ready. Compared against lib/emailCampaignAttestationCore.ts's ATTESTATION_KINDS, which is what lib/automaticTransitionClaim.ts reads -- a kind here with no entry there would be an attestation the gate never asks about.",
  },
  EmailCampaignRecipient_eligibility_reason_check: {
    owner: "database",
    reason:
      "Which cohort a person was filed under: the three of section 13.1 that this repository can actually compute. `recent_usage` is in the audit's list and deliberately absent -- nothing computes it, and allowing the value would let a row claim a cohort no code produces. Written by lib/emailAudienceExpansion.ts from lib/emailCampaignRecipientCore.ts's precedence.",
  },
  EmailCampaignRecipient_excluded_reason_check: {
    owner: "database",
    reason:
      "Why somebody in the audience received nothing. A superset of AudienceExclusion because it also carries reasons decided later: `already_changed` is only knowable at the reminder, after the first notice has had time to work. `malformed` is deliberately not in this list -- an unreadable stored value means the account cannot be migrated automatically, not that it should be left uninformed, and an exclusion here would contradict summariseAudience().",
  },
  EmailDelivery_defer_reason_check: {
    owner: "database",
    reason:
      "Why a pending delivery is waiting for nextAttemptAt when the wait is not a retry. quiet_hours, written by the standard lane when a marketing message reaches a night-time window (docs/policy/email-notifications.md §5.2 E5); send_not_submitted, written when the send-lock step ended without reaching the provider -- a writer held the address, no connection came free, or the transaction had too little left to protect a submission -- so nothing was sent and no attempt was counted (§9.8). The value names the outcome rather than one of its causes; the structured log carries the cause. Kept apart from lastErrorKind so waiting is never recorded as an error, and cleared when the row is next attempted.",
  },
  EmailDelivery_skip_reason_check: {
    owner: "database",
    reason:
      'Why a delivery was never attempted -- no_consent, suppressed_complaint, jurisdiction_unconfirmed, campaign_cancelled and the rest. Nullable, so it is only present on a skipped row. It is the answer to "why did this person not get it", which is a question support has to be able to answer without reading the send code.',
  },
  PinnedDeploymentExperimentHold_status_check: {
    owner: "list",
    module: "lib/pinnedDeploymentExecution.ts",
    list: "PINNED_EXPERIMENT_HOLD_STATUSES",
    reason:
      "held, settled, released, occupied. Released is only a call that was confirmed not to have started. Occupied keeps the reservation when the cost is unknown after dispatch. Settled is a measured cost.",
  },
  AvailabilityObservation_source_check: {
    owner: "database",
    reason:
      "real_traffic, synthetic_probe, operator_verification. An operator proving the API answers is not the same claim as real user traffic being served.",
  },
  AvailabilityObservation_outcome_check: {
    owner: "database",
    reason:
      "succeeded or failed. A rollup divides one by the total, so a third value would need every consumer to decide which side it counted on.",
  },
  AvailabilityObservation_errorClass_check: {
    owner: "database",
    reason:
      "A subset of the attempt error vocabulary. A success has nothing to classify, so the column is nullable.",
  },
  AvailabilityRollupApplication_grain_check: {
    owner: "database",
    reason:
      "deployment, endpoint, provider. Applying the provider grain does not record that the deployment grain was applied.",
  },
  DeploymentPriceSnapshot_knowledge_check: {
    owner: "database",
    reason:
      "unknown, estimate, verified. Unknown is a missing amount, not zero.",
  },
  DeploymentPriceSnapshot_rate_kind_check: {
    owner: "database",
    reason:
      "input, output, cache_read, cache_write. One amount without a kind cannot say which rate it is.",
  },
  RoutingRun_allocationMode_check: {
    owner: "database",
    reason:
      "deterministic or explore_bounded, nullable because a run written before an allocator existed recorded neither.",
  },
  RoutingRun_allocationSeedGrain_check: {
    owner: "database",
    reason:
      "request or session. An exploration must name its grain; a deterministic allocation names none.",
  },
  ModelDeployment_promptCacheSupport_check: {
    owner: "database",
    reason:
      "unproven, verified_absent, verified_automatic, verified_explicit. Unproven is the default and is neither no-cache nor a cache.",
  },
  RoutingCandidateVerdict_verdict_check: {
    owner: "database",
    reason:
      "eligible or rejected. An eligible candidate has no rejection reason.",
  },
  RoutingCandidateVerdict_reason_check: {
    owner: "database",
    reason:
      "The reasons a candidate filter can give. Nullable because an eligible candidate has no reason.",
  },
  QuotaScope_scopeKind_check: {
    owner: "database",
    reason:
      "credential, endpoint_credential, deployment_credential, account, provider. Each kind names its own columns.",
  },
  CredentialBinding_billingOwner_check: {
    owner: "database",
    reason:
      "tomverse or account. It decides which budget a call draws down.",
  },
  CredentialBinding_status_check: {
    owner: "database",
    reason:
      "disabled, active, revoked. Revoked is a withdrawn secret, not a pause.",
  },
  ProviderEndpoint_residencyClass_check: {
    owner: "database",
    reason:
      "proven and unproven. Unproven is the default until a contract names a recipient and a region.",
  },
  RoutingIdentityManifestEntry_versionPinStrength_check: {
    owner: "database",
    reason:
      "strong, weak, alias_only. A published entry copies the pin from the deployment.",
  },
  ModelDeployment_versionPinStrength_check: {
    owner: "database",
    reason:
      "strong, weak, alias_only. The default is strong, so a row that predates the column cannot drift by omission.",
  },
  ModelDeployment_qualityGateStatus_check: {
    owner: "database",
    reason:
      "pending, passed, failed, stale. Stale is evidence that expired, not evidence the model got worse.",
  },

  MarketingChannel_channel_check: {
    owner: "list",
    module: "lib/marketingAutomationSchema.ts",
    list: "MARKETING_CHANNELS",
    reason:
      "The eight platforms the programme posts to (docs/policy/marketing-automation.md O6). Immutable per row, so this list also decides which posts can ever exist against an account: instagram and tiktok are the two the O15 constraint names, and a ninth platform arriving without that review would inherit no answer about whether its posts can be retracted.",
  },
  MarketingChannel_provider_check: {
    owner: "list",
    module: "lib/marketingAutomationSchema.ts",
    list: "MARKETING_PROVIDERS",
    reason:
      "Who carries the post: the publishing tool, or an operator by hand. The distinction is load-bearing rather than descriptive -- a manual account has no connected account to reference, which is the other half of MarketingChannel_external_ref_matches_provider_check, and it has no posting cap to lower.",
  },
  MarketingChannel_status_check: {
    owner: "list",
    module: "lib/marketingAutomationSchema.ts",
    list: "MARKETING_CHANNEL_STATUSES",
    reason:
      "The account lifecycle of docs/policy/marketing-automation.md §8.2. The allowed movements between these five are a trigger, not this list; what the list settles is that `disconnected` is a status rather than a deleted row, so the posts that name the account keep naming something.",
  },
  MarketingChannel_defaultLocale_check: {
    owner: "list",
    module: "lib/marketingAutomationSchema.ts",
    list: "MARKETING_LOCALES",
    reason:
      "The four languages of docs/policy/marketing-automation.md O7. Simplified Chinese is only ever RedNote's, aimed at Chinese speakers outside the mainland, and mainland China is out of scope -- so a fifth locale is a market decision, not a translation.",
  },
  MarketingChannel_lastResumeReasonCode_check: {
    owner: "list",
    module: "lib/marketingAutomationSchema.ts",
    list: "MARKETING_RESUME_REASON_CODES",
    reason:
      "Why an operator returned a paused account to autonomous mode (docs/policy/marketing-automation.md 8.2). A closed list because it is read as a count later -- how often a pause turned out to be a false positive is a question about the halt rules, and free text cannot be counted. The operator sentence goes in the audit row the column names, not here. Nullable, because an account that has never been resumed has no reason.",
  },
  MarketingChannel_pausedFromMode_check: {
    owner: "list",
    module: "lib/marketingAutomationSchema.ts",
    list: "MARKETING_PAUSABLE_MODES",
    reason:
      "Where a paused account came from, and deliberately a two-value subset of the status list rather than the status list itself: an account paused while still connecting has no earlier mode to restore, and a resume reads this column to decide whether returning to autonomous mode is a return or a promotion. Nullable, because only a paused row has one.",
  },
  MarketingPost_locale_check: {
    owner: "list",
    module: "lib/marketingAutomationSchema.ts",
    list: "MARKETING_LOCALES",
    reason:
      "The same four languages as the channel's, on the post. The same list rather than a second one: a post's locale is checked against the account's allowedLocales, and two lists that could drift would let a post claim a language no account can hold.",
  },
  MarketingPost_kind_check: {
    owner: "list",
    module: "lib/marketingAutomationSchema.ts",
    list: "MARKETING_POST_KINDS",
    reason:
      "What the row is: a social post, a RedNote package an operator posts by hand, a landing variant, or a reference to an SEO pull request. They share a table because they share the Guard, the approval and the claim evidence; they differ in what publishing means, which is the publisher's branch and not a column.",
  },
  MarketingPost_guardDecision_check: {
    owner: "list",
    module: "lib/marketingAutomationSchema.ts",
    list: "MARKETING_GUARD_DECISIONS",
    reason:
      "What the Guard concluded (docs/policy/marketing-automation.md §7). `autonomous_eligible` is the only value that can reach autonomous mode, and MarketingPost_autonomous_needs_template_check reads it, so a fourth decision that nothing mapped would silently be a decision autonomy could not act on.",
  },
  MarketingPost_status_check: {
    owner: "list",
    module: "lib/marketingAutomationSchema.ts",
    list: "MARKETING_POST_STATUSES",
    reason:
      "Every state a draft reaches. `outcome_unknown` is separate from `failed` because a failure is a post that did not happen and an unknown outcome is a post that may have -- the second halts the account and the first does not. `deleted` and `removed_by_platform` are likewise different facts about the same absence.",
  },
  MarketingPost_mode_check: {
    owner: "list",
    module: "lib/marketingAutomationSchema.ts",
    list: "MARKETING_POST_MODES",
    reason:
      'Whether a human approved this post or an approved template did. Two values and no third: a post is covered by one authority or the other, and a mode meaning "partly" would have no answer to which digest the approval bound to.',
  },
  MarketingPost_verificationMethod_check: {
    owner: "list",
    module: "lib/marketingAutomationSchema.ts",
    list: "MARKETING_VERIFICATION_METHODS",
    reason:
      "How the app established that a post is publicly visible, which is not the same claim as having published it. Nullable, because an unverified post has no method rather than a method that failed.",
  },
  MarketingPost_deletionMethod_check: {
    owner: "list",
    module: "lib/marketingAutomationSchema.ts",
    list: "MARKETING_DELETION_METHODS",
    reason:
      "How a published post stopped being public. `platform_removed` is a moderation event and the other two are ours, so collapsing them would lose the distinction the automatic-halt rules are built on. Nullable, because a live post has no deletion.",
  },
  MarketingReport_kind_check: {
    owner: "list",
    module: "lib/marketingAutomationSchema.ts",
    list: "MARKETING_REPORT_KINDS",
    reason:
      "Which aggregate a report row is. It is also the key into MARKETING_REPORT_PAYLOAD_SCHEMAS and into the retention periods of docs/policy/marketing-automation.md §12.2, so a kind the list does not know would be a row with no schema to parse it and no date to delete it by -- which is why MarketingReport_retentionUntil_check's CASE has no ELSE.",
  },
  AiVisibilityRun_locale_check: {
    owner: "list",
    module: "lib/marketingAutomationSchema.ts",
    list: "MARKETING_LOCALES",
    reason:
      "The language the prompt was asked in. The same four as the posting locales, because the measurement asks what an assistant says about us in the markets we address.",
  },
  AiVisibilityRun_searchMode_check: {
    owner: "list",
    module: "lib/marketingAutomationSchema.ts",
    list: "AI_VISIBILITY_SEARCH_MODES",
    reason:
      "Whether the assistant could search the web for that answer. Two runs of the same prompt in the two modes answer different questions -- what a model has learned about us, and what it can find -- so the column exists to keep them from being averaged together.",
  },
  EmailPermissionEvent_kind_check: {
    owner: "list",
    module: "lib/emailPermissionLedgerCore.ts",
    list: "EMAIL_PERMISSION_EVENT_KINDS",
    reason:
      "The five facts a basis can rest on that are not a consent: a notice shown, an objection, a relationship starting and ending, and a basis ending on its own. ConsentRecord holds consent and nothing here does, so a sixth kind the application did not know would be a fact no verdict could read -- the ledger would hold it and the send gate would decide as if it were not there.",
  },
  EmailPermissionEvent_capturedVia_check: {
    owner: "list",
    module: "lib/emailPermissionLedgerCore.ts",
    list: "EMAIL_PERMISSION_EVENT_CAPTURE_SOURCES",
    reason:
      "Where the fact was captured. Australia puts the burden of proving an inferred consent on the sender, so where the notice was shown is part of the proof rather than a label; a value the application cannot name is evidence nobody can weigh.",
  },
  EmailSendApproval_approvalType_check: {
    owner: "list",
    module: "lib/emailPermissionLedgerCore.ts",
    list: "EMAIL_SEND_APPROVAL_TYPES",
    reason:
      "risk_accepted (send without a basis) and obligation_waiver (decline a display or notice duty). They carry different scope columns, which EmailSendApproval_scope_check enforces per type, so a third value would be a row whose scope no branch compares -- an approval that applies to everything because nothing checks it.",
  },
  EmailPermissionDecision_phase_check: {
    owner: "list",
    module: "lib/emailPermissionLedgerCore.ts",
    list: "EMAIL_PERMISSION_DECISION_PHASES",
    reason:
      "enqueue and send. The unique index is (deliveryId, phase), so a third phase would silently raise how many verdicts one delivery may have, and the send-time re-decision that the whole design rests on would stop being the last word.",
  },
  EmailSendApproval_purposeKey_check: {
    owner: "list",
    module: "lib/emailPermissionLedgerCore.ts",
    list: "EMAIL_SEND_APPROVAL_PURPOSE_KEYS",
    reason:
      "Which purposes a risk_accepted override may cover: the six, or a star for all of them. It sat inside the composite scope constraint until 2026-09-21, where this checker could not see it -- one closed list per constraint is what it reads -- so the code and the database could have drifted apart silently, which is the failure it exists to catch. A waiver has no purpose scope at all and the column is NULL there.",
  },
  EmailPermissionDecisionEvidence_authority_check: {
    owner: "list",
    module: "lib/emailPermissionLedgerCore.ts",
    list: "EMAIL_PERMISSION_AUTHORITIES",
    reason:
      "The receiver authority and the Australian sender authority, which is all of them. Evidence names the one that cited it, and the insert trigger requires that the verdict actually applied it -- so an open string here would be a row resting on an authority no rule defines, in a table that cannot be corrected.",
  },
  ReleaseNotesRuleObligation_state_check: {
    owner: "list",
    module: "lib/releaseNotesObligationCore.ts",
    list: "OBLIGATION_STATES",
    reason:
      "How a statutory duty is settled: implemented, deferred or waived (docs/policy/email-product-news-redesign-draft.md section 7.8). Each names its own evidence and the evidence CHECK enforces which columns go with which state, so a fourth value would be a duty settled by something no branch reads -- and the one state that can loosen a send, waived, is the one that needs a sealed approval. A duty with no row at all is unsettled and blocks its rule; that is the code list, not this constraint.",
  },
  ReleaseNotesRuleVersion_basis_check: {
    owner: "list",
    module: "lib/releaseNotesCountryRuleCore.ts",
    list: "RELEASE_NOTES_RULE_BASES",
    reason:
      "What the recipient side of a release-notes send rests on: opt_out, express_consent or inferred_consent (docs/policy/email-notifications.md section 5.1.1). The verdict has one branch per value; a fourth stored value would be a rule no branch reads, and the verdict throws on it rather than guessing.",
  },
  ReleaseNotesRuleVersion_status_check: {
    owner: "list",
    module: "lib/releaseNotesCountryRuleCore.ts",
    list: "RELEASE_NOTES_RULE_STATUSES",
    reason:
      "Open or closed: the marketing allowlist as each rule's status (draft section 4.1). A third state -- paused, pending -- would be a question the verdict answers by default, and the default for an unknown permission has to be no.",
  },
  EmailSendApprovalMember_noticeAnchorSource_check: {
    owner: "list",
    module: "lib/emailPermissionLedgerCore.ts",
    list: "NOTICE_ANCHOR_SOURCES",
    reason:
      "One value, signup_date_deemed. The owner decided the signup date is deemed to be the two-year notice anchor for this cohort; the word matters because it records a decision to treat a date as one rather than a claim that somebody consented on it. Both fixtures stored the looser signup until 2026-09-22 and the column took it. A second value is a decision, not an addition.",
  },
  EmailPermissionEvent_scopeKey_check: {
    owner: "list",
    module: "lib/emailPermissionLedgerCore.ts",
    list: "EMAIL_PERMISSION_EVENT_SCOPE_KEYS",
    reason:
      "What a permission fact is about: one purpose, one classification, or a star for the address itself. It was length > 0 until 2026-09-21, which is not a closed set -- and this table is append-only, so a fact scoped to a misspelling is one no verdict will ever find and no later write can correct.",
  },
  EmailPermissionDecision_purpose_check: {
    owner: "list",
    module: "lib/emailPreferenceCore.ts",
    list: "EMAIL_PURPOSES",
    reason:
      "The same six purposes EmailPreference is constrained to. A verdict names the purpose it decided, so a purpose this product does not send would be a permanent record about mail that does not exist -- and EmailPermissionDecision_purpose_classification_check beside it pins which classification each one may carry, which is what stops a marketing purpose being recorded as service and the marketing switches being recorded as not applying.",
  },
  EmailPermissionDecision_classification_check: {
    owner: "list",
    module: "lib/emailPreferenceCore.ts",
    list: "EMAIL_CLASSIFICATIONS",
    reason:
      "transactional, service, marketing. One value switches the sending stream, the kill switch, the Korean and Singaporean subject prefixes, forced unsubscribe and the jurisdiction fail-closed, so a class the application does not know is mail that goes out with none of them.",
  },
  EmailPermissionDecision_overrideType_check: {
    owner: "list",
    module: "lib/emailPermissionLedgerCore.ts",
    list: "EMAIL_PERMISSION_DECISION_OVERRIDE_TYPES",
    reason:
      "One value, risk_accepted. obligation_waiver is deliberately absent: a waiver changes what a country rule requires and is consumed while obligations are resolved, so it can never be the reason a recipient was allowed. A second value here would be a way for a send to be permitted that the admin screen has no wording for.",
  },
};

const migrations = readdirSync(migrationsDirectory)
  .sort()
  .flatMap((directory) => {
    try {
      return [
        {
          name: directory,
          sql: readFileSync(
            join(migrationsDirectory, directory, "migration.sql"),
            "utf8",
          ),
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
const aliases = Object.entries(REGISTRY).filter(
  ([, entry]) => entry.constraintAlias,
);
const registry = Object.fromEntries(
  Object.entries(REGISTRY).filter(([, entry]) => !entry.constraintAlias),
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
    .map((entry) => entry.module),
)) {
  const imported = await import(`../${key}`);
  modules.set(key, imported);
}

const problems = auditEnumConstraints({ constraints, registry, resolve });

for (const [key, entry] of aliases) {
  const constraint = constraints.find(
    (candidate) => candidate.constraint === entry.constraintAlias,
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
      "new constraint with a reason rather than leaving it undecided.\n",
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
    `${counts.database || 0} written down only in the database.`,
);
