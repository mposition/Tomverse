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

export const SYSTEM_AUDIT_ACTORS = [
  "marketing-publisher",
  "marketing-retention",
  "marketing-guard", "marketing-webhook",
  "prompt-refiner-shadow-runner",
  AMUX_SYSTEM_AUDIT_ACTOR,
  AMUX_AUTO_PROMOTER_AUDIT_ACTOR,
  ...ENGINEERING_AGENT_SYSTEM_AUDIT_ACTORS,
  ...PRODUCT_RESEARCH_SYSTEM_AUDIT_ACTORS, "qa-release-intake", "support-triage-worker", "support-triage-retention", "billing-finance-ops-intake",
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

/** Whether caller-supplied metadata claims the reserved key at its top level. */
export const metadataClaimsSystemActor = (metadata: unknown): boolean =>
  metadata !== null &&
  typeof metadata === "object" &&
  !Array.isArray(metadata) &&
  Object.hasOwn(metadata, SYSTEM_AUDIT_ACTOR_METADATA_KEY);

type AuditRowActorFields = {
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
  return isSystemAuditActor(actor) && sessionFieldsEmpty ? "system" : "unknown";
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
] as const satisfies readonly SystemAuditActor[];
export type SupportTriageSystemAuditActor =
  (typeof SUPPORT_TRIAGE_SYSTEM_AUDIT_ACTORS)[number];
