import { z } from "zod";

export const PROMPT_REFINER_PRODUCT_AUTO_RESUME_PATH =
  "/api/admin/prompt-refiner/product-auto-resume";
export const PROMPT_REFINER_PRODUCT_AUTO_RESUME_CONFIRMATION =
  "RESUME_REFINER_PRODUCT_AUTO_AFTER_OPERATOR_REVIEW";

export const promptRefinerProductAutoResumeStateSchema = z.object({
  version: z.literal("prompt-refiner-product-auto-resume-state-v1"),
  runtimeCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
  runtimeDeploymentId: z.string().uuid(),
  writerEnabled: z.boolean(),
  active: z.boolean(),
  generation: z.number().int().min(1).max(2_147_483_647).nullable(),
  reasonCode: z.enum(["latency_p90_exceeded", "original_fallback_rate_exceeded",
    "critical_safety_failure", "unknown_dispatch_or_cost", "audit_failure"]).nullable(),
  transitionAuditLogId: z.string().min(1).max(128).nullable(),
}).strict();

export type PromptRefinerProductAutoResumeState = z.infer<
  typeof promptRefinerProductAutoResumeStateSchema>;

export function promptRefinerProductAutoResumeBody(
  state: PromptRefinerProductAutoResumeState,
) {
  if (state.active || !state.writerEnabled || state.generation === null ||
      !state.reasonCode || !state.transitionAuditLogId) return null;
  return {
    expectedGeneration: state.generation,
    expectedReasonCode: state.reasonCode,
    expectedPauseAuditLogId: state.transitionAuditLogId,
    confirmation: PROMPT_REFINER_PRODUCT_AUTO_RESUME_CONFIRMATION,
  };
}
