/**
 * Who, other than an administrator, may write to the audit hash chain.
 *
 * docs/policy/marketing-automation.md §6 records system actions in the same
 * chain as human ones, in the same transaction as the change. A system entry
 * has no session, so it carries no `actorUserId`, `actorEmail`, IP or user
 * agent; what it carries instead is `metadata.systemActor`, set by
 * `writeSystemAuditLog()` and by nothing else.
 *
 * The list is closed on purpose. An entry's actor is evidence -- a template
 * approval, a resume into autonomous mode and a webhook verification each
 * require a *human* row -- so a new system actor is a reviewed change to this
 * array, not a string a caller makes up.
 *
 * Pure: no server-only import, so static checks and unit tests can read it.
 */

export const AMUX_SYSTEM_AUDIT_ACTOR = "tomverse-amux-orchestrator" as const;

/** The v4 intake actor is defined here so existing audit consumers do not
 * acquire an unrelated AMUX module in their fixed runtime source closure. */
export const AMUX_V4_IDEA_SYSTEM_ACTOR = "amux-v4-intake" as const;

/**
 * The legacy internal auto-promotion tick consumes an owner-bound grant.
 */
export const AMUX_AUTO_PROMOTER_AUDIT_ACTOR = "amux-auto-promoter" as const;

/** V22 Task admission has a distinct, scoped actor. It is not a human
 * approval and has no authority to claim a worker or execute a Task. */
export const AMUX_V22_AUTO_ADMIT_AUDIT_ACTOR = "amux-v22-auto-admit" as const;
export const AMUX_V22_WORKER_CLAIM_AUDIT_ACTOR = "amux-v22-worker-claim" as const;

/**
 * The engineering agent's actors (docs/policy/engineering-agent.md §11). Each
 * names the service or app path whose action the entry records; none of them
 * is a person, so none of them is approval evidence.
 */
export const ENGINEERING_AGENT_SYSTEM_AUDIT_ACTORS = [
  "engineering-agent-runner",
  "engineering-agent-publisher",
  "engineering-agent-retention",
  "engineering-agent-observer",
  "engineering-agent-registrar",
] as const;
export type EngineeringAgentSystemAuditActor =
  (typeof ENGINEERING_AGENT_SYSTEM_AUDIT_ACTORS)[number];

/**
 * The product-research agent's actors
 * (docs/policy/product-research-agent.md §5). Two actions and no more: a slot
 * recorded, and rows removed once past the retention period. Neither is a
 * person, so neither is approval evidence -- and this agent has nothing to
 * approve, because it decides nothing.
 */
export const PRODUCT_RESEARCH_SYSTEM_AUDIT_ACTORS = [
  "product-research-observer",
  "product-research-retention",
] as const;
export type ProductResearchSystemAuditActor =
  (typeof PRODUCT_RESEARCH_SYSTEM_AUDIT_ACTORS)[number];
/** AMUX intake policy v12 (approved by mposition, 2026-10-01): the v4 actor
 * has an explicit action/target scope per writer, not general audit authority. */
export const AMUX_V4_INITIAL_SOURCE_PLAN_ACTION = "AMUX_V4_INITIAL_SOURCE_PLAN_CREATED" as const;
export const AMUX_V4_INITIAL_SOURCE_PLAN_TARGET = "AmuxIdeaSourcePlanRevision" as const;
export const AMUX_V4_INITIAL_SOURCE_PLAN_SCOPE = "initial-source-plan-v1" as const;
/** An AMUX v4 analysis budget hold is agent cost, never user credit. Its
 * writer stays dark until the price, token-cap and local-runner gates pass. */
export const AMUX_V4_ANALYSIS_BUDGET_RESERVE_ACTION = "AMUX_V4_ANALYSIS_BUDGET_RESERVED" as const;
export const AMUX_V4_ANALYSIS_BUDGET_RESERVE_TARGET = "AmuxIdeaAnalysisBudgetHold" as const;
export const AMUX_V4_ANALYSIS_BUDGET_RESERVE_SCOPE = "analysis-budget-reserve-v1" as const;
/** The app consumes one confirmed preview before the isolated local attempt. */
export const AMUX_V4_ANALYSIS_CLAIM_ACTION = "AMUX_V4_ANALYSIS_CLAIMED" as const;
export const AMUX_V4_ANALYSIS_CLAIM_TARGET = "AmuxIdeaTransferPreview" as const;
export const AMUX_V4_ANALYSIS_CLAIM_SCOPE = "analysis-claim-v1" as const;
/** One fenced result receipt binds a request ID to content digest before settlement. */
export const AMUX_V4_ANALYSIS_RESULT_ACTION = "AMUX_V4_ANALYSIS_RESULT_ACCEPTED" as const;
export const AMUX_V4_ANALYSIS_RESULT_TARGET = "AmuxIdeaTransferPreview" as const;
export const AMUX_V4_ANALYSIS_RESULT_SCOPE = "analysis-result-v1" as const;
/** Expiry may release only a never-dispatched AMUX analysis hold. */
export const AMUX_V4_ANALYSIS_BUDGET_EXPIRE_ACTION = "AMUX_V4_ANALYSIS_UNUSED_RESERVATION_EXPIRED" as const;
export const AMUX_V4_ANALYSIS_BUDGET_EXPIRE_TARGET = "AmuxIdeaAnalysisBudgetHold" as const;
export const AMUX_V4_ANALYSIS_BUDGET_EXPIRE_SCOPE = "analysis-budget-expire-v1" as const;
/** A known, capped CLI result settles agent cost; unknown usage stays held. */
export const AMUX_V4_ANALYSIS_BUDGET_SETTLE_ACTION = "AMUX_V4_ANALYSIS_BUDGET_SETTLED" as const;
export const AMUX_V4_ANALYSIS_BUDGET_SETTLE_TARGET = "AmuxIdeaAnalysisBudgetHold" as const;
export const AMUX_V4_ANALYSIS_BUDGET_SETTLE_SCOPE = "analysis-budget-settle-v1" as const;
/** An uncertain CLI outcome blocks further analysis until read-back and owner resolution. */
export const AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_ACTION = "AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN" as const;
export const AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_TARGET = "AmuxIdeaAnalysisBudgetHold" as const;
export const AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_SCOPE = "analysis-outcome-unknown-v1" as const;
/** One complete, normalized first analysis is stored as independently purgeable units. */
export const AMUX_V4_FIRST_DRAFT_SAVED_ACTION = "AMUX_V4_FIRST_ANALYSIS_DRAFT_SAVED" as const;
export const AMUX_V4_FIRST_DRAFT_SAVED_TARGET = "AmuxIdeaAnalysisChunk" as const;
export const AMUX_V4_FIRST_DRAFT_SAVED_SCOPE = "first-analysis-draft-save-v1" as const;
/** Policy v6: an unfinished idea stops at its immutable seven-day deadline. */
export const AMUX_V4_IDEA_AUTO_CANCEL_ACTION = "AMUX_V4_IDEA_ANALYSIS_AUTO_CANCELLED" as const;
export const AMUX_V4_IDEA_AUTO_CANCEL_TARGET = "AmuxIdeaSubmission" as const;
export const AMUX_V4_IDEA_AUTO_CANCEL_SCOPE = "idea-analysis-auto-cancel-v1" as const;
/** Retention first clears the DB body, then verifies external key deletion. */
export const AMUX_V4_CONTENT_PURGE_ACTION = "amux.v4.content.body_purged" as const;
export const AMUX_V4_CONTENT_KEY_DELETE_ACTION = "amux.v4.content.key_deleted" as const;
export const AMUX_V4_CONTENT_RETIREMENT_TARGET = "AmuxIdeaContentKeyRetirement" as const;
export const AMUX_V4_CONTENT_PURGE_SCOPE = "idea-content-purge-v1" as const;
export const AMUX_V4_CONTENT_KEY_DELETE_SCOPE = "idea-content-key-delete-v1" as const;
export const AMUX_V4_RETENTION_HOLD_NOTICE_ACTION = "amux.v4.retention_hold.notice_sent" as const;
export const AMUX_V4_RETENTION_HOLD_NOTICE_TARGET = "AmuxIdeaRetentionHold" as const;
export const AMUX_V4_RETENTION_HOLD_NOTICE_SCOPE = "idea-retention-hold-notice-v1" as const;
/** A09 receipt housekeeping is never a human approval or worker action. */
export const AMUX_V4_UNIT_UNKNOWN_ACTION = "amux.v4.unit.outcome_unknown" as const;
export const AMUX_V4_UNIT_INVALIDATE_ACTION = "amux.v4.unit.invalidate" as const;
export const AMUX_V4_UNIT_EXPIRE_ACTION = "amux.v4.unit.expire" as const;
export const AMUX_V4_UNIT_DECISION_TARGET = "AmuxIdeaUnitDecision" as const;
export const AMUX_V4_UNIT_HOUSEKEEPING_SCOPE = "unit-decision-housekeeping-v1" as const;
/** One authenticated source collector claims one already owner-approved file. */

/**
 * Candidate actor identities for the approved AMUX intake v4 and
 * orchestration v22 designs. They are deliberately NOT in the active list:
 * adding a name there makes writeSystemAuditLog accept it immediately.
 * Each future activation needs a scoped writer, policy citation, tests and
 * separate review. The auto-admission actor especially needs its own gate.
 */
export const AMUX_PROPOSED_SYSTEM_AUDIT_ACTORS = [
  "amux-intake-supervisor",
  "amux-intake-retention",
  "amux-portfolio-scorer",
] as const;

export const SYSTEM_AUDIT_ACTORS = [
  "marketing-publisher",
  "marketing-retention",
  "marketing-guard", "marketing-webhook",
  "prompt-refiner-shadow-runner",
  "prompt-refiner-vnext-one-shot-runner",
  "prompt-refiner-auto-budget",
  AMUX_SYSTEM_AUDIT_ACTOR,
  AMUX_AUTO_PROMOTER_AUDIT_ACTOR,
  AMUX_V22_AUTO_ADMIT_AUDIT_ACTOR,
  AMUX_V22_WORKER_CLAIM_AUDIT_ACTOR,
  // Scoped below to the reviewed v4 intake actions only.
  AMUX_V4_IDEA_SYSTEM_ACTOR,
  ...ENGINEERING_AGENT_SYSTEM_AUDIT_ACTORS,
  ...PRODUCT_RESEARCH_SYSTEM_AUDIT_ACTORS, "qa-release-intake", "support-triage-worker", "support-triage-retention", "billing-finance-ops-intake", "support-triage-account-deletion", "agent-digest-retention", "qa-release-merge-lane", "ops-observer", "amux-decision-router", "amux-decision-maker-openai", "amux-decision-maker-anthropic",
] as const;
export type SystemAuditActor = (typeof SYSTEM_AUDIT_ACTORS)[number];

/**
 * The metadata key that marks a system entry.
 *
 * Reserved in both writers: the system writer sets it, and the administrator
 * writer refuses metadata that already has it, so a human action cannot be
 * recorded as a system one or the other way round.
 */
export const SYSTEM_AUDIT_ACTOR_METADATA_KEY = "systemActor";

export const isSystemAuditActor = (value: unknown): value is SystemAuditActor =>
  typeof value === "string" &&
  (SYSTEM_AUDIT_ACTORS as readonly string[]).includes(value);

/** Existing actors retain their established call-site contracts. Each v4
 * intake action/target pair has its own immutable scope marker. */
export const amuxV4SystemAuditScope = (action: unknown, targetType: unknown): string | null => {
  if (action === AMUX_V4_INITIAL_SOURCE_PLAN_ACTION &&
      targetType === AMUX_V4_INITIAL_SOURCE_PLAN_TARGET) {
    return AMUX_V4_INITIAL_SOURCE_PLAN_SCOPE;
  }
  if (action === AMUX_V4_ANALYSIS_BUDGET_RESERVE_ACTION &&
      targetType === AMUX_V4_ANALYSIS_BUDGET_RESERVE_TARGET) {
    return AMUX_V4_ANALYSIS_BUDGET_RESERVE_SCOPE;
  }
  if (action === AMUX_V4_ANALYSIS_CLAIM_ACTION &&
      targetType === AMUX_V4_ANALYSIS_CLAIM_TARGET) {
    return AMUX_V4_ANALYSIS_CLAIM_SCOPE;
  }
  if (action === AMUX_V4_ANALYSIS_RESULT_ACTION &&
      targetType === AMUX_V4_ANALYSIS_RESULT_TARGET) {
    return AMUX_V4_ANALYSIS_RESULT_SCOPE;
  }
  if (action === AMUX_V4_ANALYSIS_BUDGET_EXPIRE_ACTION &&
      targetType === AMUX_V4_ANALYSIS_BUDGET_EXPIRE_TARGET) {
    return AMUX_V4_ANALYSIS_BUDGET_EXPIRE_SCOPE;
  }
  if (action === AMUX_V4_ANALYSIS_BUDGET_SETTLE_ACTION &&
      targetType === AMUX_V4_ANALYSIS_BUDGET_SETTLE_TARGET) {
    return AMUX_V4_ANALYSIS_BUDGET_SETTLE_SCOPE;
  }
  if (action === AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_ACTION &&
      targetType === AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_TARGET) {
    return AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_SCOPE;
  }
  if (action === AMUX_V4_FIRST_DRAFT_SAVED_ACTION &&
      targetType === AMUX_V4_FIRST_DRAFT_SAVED_TARGET) {
    return AMUX_V4_FIRST_DRAFT_SAVED_SCOPE;
  }
  if (action === AMUX_V4_IDEA_AUTO_CANCEL_ACTION &&
      targetType === AMUX_V4_IDEA_AUTO_CANCEL_TARGET) {
    return AMUX_V4_IDEA_AUTO_CANCEL_SCOPE;
  }
  if (action === AMUX_V4_CONTENT_PURGE_ACTION &&
      targetType === AMUX_V4_CONTENT_RETIREMENT_TARGET) {
    return AMUX_V4_CONTENT_PURGE_SCOPE;
  }
  if (action === AMUX_V4_CONTENT_KEY_DELETE_ACTION &&
      targetType === AMUX_V4_CONTENT_RETIREMENT_TARGET) {
    return AMUX_V4_CONTENT_KEY_DELETE_SCOPE;
  }
  if (action === AMUX_V4_RETENTION_HOLD_NOTICE_ACTION &&
      targetType === AMUX_V4_RETENTION_HOLD_NOTICE_TARGET) {
    return AMUX_V4_RETENTION_HOLD_NOTICE_SCOPE;
  }
  if (targetType === AMUX_V4_UNIT_DECISION_TARGET &&
      (action === AMUX_V4_UNIT_UNKNOWN_ACTION ||
       action === AMUX_V4_UNIT_INVALIDATE_ACTION ||
       action === AMUX_V4_UNIT_EXPIRE_ACTION)) {
    return AMUX_V4_UNIT_HOUSEKEEPING_SCOPE;
  }
  return null;
};

export const systemAuditActionAllowed = (
  actor: unknown, action: unknown, targetType: unknown,
): actor is SystemAuditActor =>
  isSystemAuditActor(actor) &&
  (actor !== "prompt-refiner-auto-budget" ||
    (action === "prompt_refiner.auto_budget_reserved" &&
      targetType === "PromptRefinerAutoBudgetHold")) &&
  (actor !== AMUX_V22_WORKER_CLAIM_AUDIT_ACTOR ||
    (action === "amux.v22.worker.assigned" &&
      targetType === "AmuxV22WorkerAssignment")) &&
  (actor !== AMUX_V22_AUTO_ADMIT_AUDIT_ACTOR ||
    (action === "amux.v22.auto_promotion.consumed" &&
      targetType === "AmuxV22PromotionReceipt") ||
    (action === "amux.v22.auto_promotion.outcome_unknown" &&
      targetType === "AmuxV22PromotionUnknown") ||
    (action === "amux.auto_promotion.halted" &&
      targetType === "AmuxRecommendationAutoHalt")) &&
  (actor !== AMUX_V4_IDEA_SYSTEM_ACTOR ||
    amuxV4SystemAuditScope(action, targetType) !== null);

/** Whether caller-supplied metadata claims the reserved key at its top level. */
export const metadataClaimsSystemActor = (metadata: unknown): boolean =>
  metadata !== null &&
  typeof metadata === "object" &&
  !Array.isArray(metadata) &&
  Object.hasOwn(metadata, SYSTEM_AUDIT_ACTOR_METADATA_KEY);

type AuditRowActorFields = {
  action?: string;
  targetType?: string;
  actorUserId: string | null;
  actorEmail: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
};

/**
 * What kind of actor a stored row records.
 *
 * `human` needs an actor id and no system marker; `system` needs a listed
 * marker and none of the session-derived fields. Anything else -- a row with
 * both, or with neither -- is `unknown`, and a check that requires a human or
 * a system actor treats `unknown` as a failure rather than choosing one.
 * This classifies the row's fields only; whether the row belongs to a valid
 * chain is the integrity verifier's question.
 */
export const auditRowActorKind = (
  row: AuditRowActorFields,
): "human" | "system" | "unknown" => {
  const claimsSystem = metadataClaimsSystemActor(row.metadata);
  if (!claimsSystem) return row.actorUserId ? "human" : "unknown";
  const actor = (row.metadata as Record<string, unknown>)[
    SYSTEM_AUDIT_ACTOR_METADATA_KEY
  ];
  const sessionFieldsEmpty =
    row.actorUserId === null &&
    row.actorEmail === null &&
    row.ipAddress === null &&
    row.userAgent === null;
  if (!sessionFieldsEmpty || !isSystemAuditActor(actor)) return "unknown";
  if (actor === AMUX_V4_IDEA_SYSTEM_ACTOR) {
    const metadata = row.metadata as Record<string, unknown>;
    return systemAuditActionAllowed(actor, row.action, row.targetType) &&
      metadata.actorScope === amuxV4SystemAuditScope(row.action, row.targetType)
      ? "system" : "unknown";
  }
  return "system";
};

/**
 * The support-triage agent's actors (docs/policy/support-triage.md §7): the
 * worker pass and the retention run, listed in SYSTEM_AUDIT_ACTORS above.
 * Neither is a person, so neither is approval evidence. Declared at the end of
 * the file, and listed above on an existing line, so no access above moves.
 */
export const SUPPORT_TRIAGE_SYSTEM_AUDIT_ACTORS = [
  "support-triage-worker",
  "support-triage-retention",
  "support-triage-account-deletion",
] as const satisfies readonly SystemAuditActor[];
export type SupportTriageSystemAuditActor =
  (typeof SUPPORT_TRIAGE_SYSTEM_AUDIT_ACTORS)[number];

/**
 * The sre-ops agent's actor (docs/policy/sre-ops.md §3-10): every monitored
 * state transition, reservation close and retention batch the store writes.
 * Not a person, so never approval evidence -- a genesis is the owner's own
 * Admin action and is written with writeAdminAuditLog. Declared at the end of
 * the file, and listed above on an existing line, so no access above moves.
 */
export const OPS_OBSERVER_SYSTEM_AUDIT_ACTOR = "ops-observer" as const satisfies SystemAuditActor;

/**
 * The AMUX Decision Maker's actors (docs/policy/amux-decision-maker.md §10):
 * the app route that routes a question, and one per DM instance. A DM writes
 * proposals, never approvals, so none of them is a person in any gate (§1).
 * Declared at the end of the file, and listed above on an existing line, so no
 * access above moves.
 */
export const AMUX_DECISION_MAKER_SYSTEM_AUDIT_ACTORS = [
  "amux-decision-router",
  "amux-decision-maker-openai",
  "amux-decision-maker-anthropic",
] as const satisfies readonly SystemAuditActor[];
export type AmuxDecisionMakerSystemAuditActor =
  (typeof AMUX_DECISION_MAKER_SYSTEM_AUDIT_ACTORS)[number];
