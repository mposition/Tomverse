/**
 * Shared AMUX audit identity and closed claim refusal vocabulary.
 *
 * Keep this module framework-free so TypeScript routes, the canonical store
 * writer, and the Rust wire contract can use the same finite reason set.
 */
export { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/adminAuditSystemActors";

export const AMUX_CLAIM_CLOSED_REFUSAL_REASONS = [
  "execution_api_disabled",
  "not_eligible",
  "unclassified",
  "worker_catalog_unavailable",
  "no_authoritative_worker",
  "authoritative_worker_mismatch",
  "incident_admission_blocked",
  "wip_limit_reached",
  "execution_lifecycle_unavailable",
  "invalid_routing_evidence",
] as const;

export type AmuxClaimClosedRefusalReason =
  (typeof AMUX_CLAIM_CLOSED_REFUSAL_REASONS)[number];

export const AMUX_CLAIM_AUDIT_REFUSAL_REASONS = [
  ...AMUX_CLAIM_CLOSED_REFUSAL_REASONS,
  "invalid_request",
  "dependent_weight_mismatch",
  "scheduler_score_mismatch",
  "cas_lost",
] as const;

export type AmuxClaimAuditRefusalReason =
  (typeof AMUX_CLAIM_AUDIT_REFUSAL_REASONS)[number];
