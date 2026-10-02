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
 * The internal auto-promotion tick (orchestration policy version 15,
 * "자동 승격 개정"). It expires due grants and consumes a grant an owner
 * already bound to one item and one cent amount. It records nothing else.
 */
export const AMUX_AUTO_PROMOTER_AUDIT_ACTOR = "amux-auto-promoter" as const;

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
/** Policy v6: an unfinished idea stops at its immutable seven-day deadline. */
export const AMUX_V4_IDEA_AUTO_CANCEL_ACTION = "AMUX_V4_IDEA_ANALYSIS_AUTO_CANCELLED" as const;
export const AMUX_V4_IDEA_AUTO_CANCEL_TARGET = "AmuxIdeaSubmission" as const;
export const AMUX_V4_IDEA_AUTO_CANCEL_SCOPE = "idea-analysis-auto-cancel-v1" as const;

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
  "amux-v22-auto-admit",
] as const;

export const SYSTEM_AUDIT_ACTORS = [
  "marketing-publisher",
  "marketing-retention",
  "marketing-guard",
  "prompt-refiner-shadow-runner",
  AMUX_SYSTEM_AUDIT_ACTOR,
  AMUX_AUTO_PROMOTER_AUDIT_ACTOR,
  // Scoped below to the reviewed v4 intake actions only.
  AMUX_V4_IDEA_SYSTEM_ACTOR,
  ...ENGINEERING_AGENT_SYSTEM_AUDIT_ACTORS,
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
  if (action === AMUX_V4_IDEA_AUTO_CANCEL_ACTION &&
      targetType === AMUX_V4_IDEA_AUTO_CANCEL_TARGET) {
    return AMUX_V4_IDEA_AUTO_CANCEL_SCOPE;
  }
  return null;
};

export const systemAuditActionAllowed = (
  actor: unknown, action: unknown, targetType: unknown,
): actor is SystemAuditActor =>
  isSystemAuditActor(actor) &&
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
