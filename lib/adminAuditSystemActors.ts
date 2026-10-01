/**
 * Who, other than an administrator, may write to the audit hash chain.
 *
 * docs/policy/development-agent-orchestration.md requires orchestration audit
 * events. System actions use the same chain as human ones and the same
 * transaction as the change. A system entry has no session, so it carries no
 * `actorUserId`, `actorEmail`, IP or user agent; what it carries instead is
 * `metadata.systemActor`, set by `writeSystemAuditLog()` and by nothing else.
 *
 * The list is closed on purpose. An entry's actor is evidence, so a new system
 * actor is a reviewed change to this array, not a string a caller makes up.
 *
 * Pure: no server-only import, so static checks and unit tests can read it.
 */

import { AMUX_V4_IDEA_SYSTEM_ACTOR } from "./amux/ideaIdentityCore.ts";

export const AMUX_SYSTEM_AUDIT_ACTOR = "tomverse-amux-orchestrator" as const;

/**
 * The internal auto-promotion tick (orchestration policy version 15,
 * "자동 승격 개정"). It expires due grants and consumes a grant an owner
 * already bound to one item and one cent amount. It records nothing else.
 */
export const AMUX_AUTO_PROMOTER_AUDIT_ACTOR = "amux-auto-promoter" as const;

/**
 * Candidate actor identities for the approved AMUX intake v4 and
 * orchestration v22 designs. They are deliberately NOT in the active list:
 * adding a name there makes writeSystemAuditLog accept it immediately.
 * Each future activation needs a scoped writer, policy citation, tests and
 * separate review. The auto-admission actor especially needs its own gate.
 */
export const AMUX_PROPOSED_SYSTEM_AUDIT_ACTORS = [
  AMUX_V4_IDEA_SYSTEM_ACTOR,
  "amux-intake-supervisor",
  "amux-intake-retention",
  "amux-portfolio-scorer",
  "amux-v22-auto-admit",
] as const;

export const SYSTEM_AUDIT_ACTORS = [AMUX_SYSTEM_AUDIT_ACTOR, AMUX_AUTO_PROMOTER_AUDIT_ACTOR] as const;

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
  Object.prototype.hasOwnProperty.call(metadata, SYSTEM_AUDIT_ACTOR_METADATA_KEY);

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
  row: AuditRowActorFields
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
