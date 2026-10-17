import {
  AMUX_SESSION_ANALYSIS_RESERVED_ACTION,
  AMUX_SESSION_ANALYSIS_RESERVED_SCOPE,
  AMUX_SESSION_ANALYSIS_RESERVED_TARGET,
  AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR,
} from "../adminAuditSystemActors.ts";

export const AMUX_SESSION_ANALYSIS_RESERVATION_POLICY_VERSION = 19;
export const AMUX_SESSION_ANALYSIS_RESERVATION_STATUSES = ["queued"] as const;
export const AMUX_SESSION_ANALYSIS_RESERVATION_PROVIDERS =
  ["openai", "anthropic"] as const;
export const AMUX_SESSION_ANALYSIS_RESERVATION_REASONING_EFFORTS =
  ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const AMUX_SESSION_ANALYSIS_RESERVATION_STATUS =
  AMUX_SESSION_ANALYSIS_RESERVATION_STATUSES[0];
export const AMUX_SESSION_ANALYSIS_RESERVATION_AUDIT_SUMMARY =
  "Queued one AMUX v19 analysis reservation under the current owner-approved operating scope.";

export {
  AMUX_SESSION_ANALYSIS_RESERVED_ACTION,
  AMUX_SESSION_ANALYSIS_RESERVED_SCOPE,
  AMUX_SESSION_ANALYSIS_RESERVED_TARGET,
  AMUX_SESSION_INTAKE_SYSTEM_AUDIT_ACTOR,
};

export type AmuxSessionAnalysisReservationBinding = Readonly<{
  reservationId: string;
  ideaId: string;
  requestId: string;
  submissionAuditId: string;
  operatingScopeSettingId: string;
  dataOwnerUserId: string;
  modelProvider: string;
  modelId: string;
  reasoningEffort: string;
}>;

/** Closed, content-free metadata for the queue receipt. Repository names,
 * paths, idea text and source labels never enter the audit chain. */
export function amuxSessionAnalysisReservationAuditMetadata(
  input: AmuxSessionAnalysisReservationBinding,
) {
  return Object.freeze({
    policyVersion: AMUX_SESSION_ANALYSIS_RESERVATION_POLICY_VERSION,
    reservationId: input.reservationId,
    ideaId: input.ideaId,
    requestId: input.requestId,
    submissionAuditId: input.submissionAuditId,
    operatingScopeSettingId: input.operatingScopeSettingId,
    dataOwnerUserId: input.dataOwnerUserId,
    modelProvider: input.modelProvider,
    modelId: input.modelId,
    reasoningEffort: input.reasoningEffort,
  });
}
