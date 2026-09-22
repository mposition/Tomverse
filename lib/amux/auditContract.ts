/**
 * Shared AMUX audit identity re-export and closed claim refusal vocabulary.
 *
 * This module stays framework-free so the route, canonical store writers,
 * and cross-language parity test share the registry's canonical actor.
 */
export { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/adminAuditSystemActors";

export const AMUX_CLAIM_CLOSED_REFUSAL_REASONS = [
  "execution_api_disabled",
  "not_eligible",
  "unclassified",
  "worker_catalog_unavailable",
  "no_authoritative_worker",
  "authoritative_worker_mismatch",
  "execution_lifecycle_unavailable",
  "invalid_routing_evidence",
] as const;

export type AmuxClaimClosedRefusalReason =
  (typeof AMUX_CLAIM_CLOSED_REFUSAL_REASONS)[number];

/**
 * Reasons recorded by the canonical audit writer. Input refusals are audited
 * without retaining request bytes; CAS loss is non-terminal for the server.
 */
export const AMUX_CLAIM_AUDIT_REFUSAL_REASONS = [
  ...AMUX_CLAIM_CLOSED_REFUSAL_REASONS,
  "invalid_request",
  "dependent_weight_mismatch",
  "scheduler_score_mismatch",
  "cas_lost",
] as const;

export type AmuxClaimAuditRefusalReason =
  (typeof AMUX_CLAIM_AUDIT_REFUSAL_REASONS)[number];
