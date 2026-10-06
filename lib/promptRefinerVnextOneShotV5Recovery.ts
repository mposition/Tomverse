import { PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD } from
  "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";

export const V4_STAGE_ID = "prompt-refiner-vnext-one-shot-v4";
export const V5_STAGE_ID = "prompt-refiner-vnext-one-shot-v5";
export type PromptRefinerRunnableStageId =
  typeof V4_STAGE_ID | typeof V5_STAGE_ID;
export const V4_DEPLOYMENT_ID = "35787baf-2329-4002-b837-182ae9f51d13";
export const V4_COMMIT_SHA = "e3ecfcdc5eee9cbce8f79fda39eb76a87c445819";
export const V4_OBSERVED_COST_MICRO_USD = 7_624;
export const V4_HELD_COST_MICRO_USD =
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD;
export const V5_RECOVERY_ACTION =
  "prompt_refiner.vnext_one_shot.post_unknown_new_run_approved";
export const V5_RECOVERY_SUMMARY =
  "Approved one independent v5 stage after the immutable v4 safe stop.";

export const promptRefinerVnextV5RecoveryMetadata = (input: {
  stopAuditLogId: string;
  v4StageApprovalAuditLogId: string;
  v4RunApprovalAuditLogId: string;
  v5StageApprovalAuditLogId: string;
}) => ({
  version: "prompt-refiner-vnext-one-shot-post-unknown-v1",
  predecessorStageId: V4_STAGE_ID,
  successorStageId: V5_STAGE_ID,
  predecessorStopAuditLogId: input.stopAuditLogId,
  predecessorStageApprovalAuditLogId: input.v4StageApprovalAuditLogId,
  predecessorRunApprovalAuditLogId: input.v4RunApprovalAuditLogId,
  successorStageApprovalAuditLogId: input.v5StageApprovalAuditLogId,
  predecessorTerminalReceipts: 33,
  predecessorUnknownReceipts: 1,
  predecessorNotAttemptedSlots: 46,
  predecessorObservedCostMicroUsd: V4_OBSERVED_COST_MICRO_USD,
  predecessorHeldCostUpperBoundMicroUsd: V4_HELD_COST_MICRO_USD,
  successorRunCeilingMicroUsd: PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD,
  crossRunWorstCaseMicroUsd: V4_OBSERVED_COST_MICRO_USD + V4_HELD_COST_MICRO_USD +
    PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD,
});
