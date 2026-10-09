import "server-only";

import { AMUX_V4_IDEA_SUBMISSION_CODE_LATCH,
  AMUX_V4_IDEA_SUBMISSION_ENV } from "./ideaSubmissionCore.ts";
import { AMUX_V4_ANALYSIS_QUEUE_CODE_LATCH,
  AMUX_V4_ANALYSIS_QUEUE_READ_ENV } from "./ideaAnalysisQueueCore.ts";
import { AMUX_V4_UNIT_WRITE_CODE_ENABLED,
  AMUX_V4_UNIT_WRITE_ENV } from "./ideaUnitDecisionStore.ts";
import { AMUX_V4_PORTFOLIO_WRITE_CODE_ENABLED,
  AMUX_V4_PORTFOLIO_WRITE_ENV } from "./portfolioAssessmentService.ts";
import { AMUX_V22_AUTO_PROMOTION_CODE_LATCH,
  AMUX_V22_AUTO_PROMOTION_ENV } from "./v22AutoPromotionCore.ts";
import { AMUX_V22_WORKER_CLAIM_CODE_LATCH,
  AMUX_V22_WORKER_CLAIM_ENV } from "./v22WorkerClaimCore.ts";
import { AMUX_V22_TASK_EXECUTION_CODE_LATCH,
  AMUX_V22_TASK_EXECUTION_ENV,
  AMUX_V22_ENGINEERING_PUBLICATION_CODE_LATCH,
  AMUX_V22_ENGINEERING_PUBLICATION_ENV } from "./v22TaskExecutionCore.ts";
import { AMUX_V22_OUTCOME_WRITE_CODE_LATCH,
  AMUX_V22_OUTCOME_WRITE_ENV } from "./v22OutcomeObservationCore.ts";
import { inspectAmuxActivationStages,
  type AmuxActivationStage } from "./v22ActivationReadinessCore.ts";

const gate = (id: string, codeLatch: boolean, envName: string) => ({ id,
  codeLatch, environmentEnabled: process.env[envName] === "enabled" });

/** No secret values, credentials or input payloads are returned. A green
 * code/env pair is still not operational approval or deployment evidence. */
export function readAmuxV22ActivationStatus() {
  const stages: AmuxActivationStage[] = [
    { id: "intake", gates: [gate("idea_submission",
      AMUX_V4_IDEA_SUBMISSION_CODE_LATCH, AMUX_V4_IDEA_SUBMISSION_ENV)] },
    { id: "analysis", gates: [gate("queue_read",
      AMUX_V4_ANALYSIS_QUEUE_CODE_LATCH, AMUX_V4_ANALYSIS_QUEUE_READ_ENV),
      { id: "claim_and_result", codeLatch: null, environmentEnabled: null }] },
    { id: "registration", gates: [gate("unit_write",
      AMUX_V4_UNIT_WRITE_CODE_ENABLED, AMUX_V4_UNIT_WRITE_ENV)] },
    { id: "portfolio", gates: [gate("assessment_write",
      AMUX_V4_PORTFOLIO_WRITE_CODE_ENABLED, AMUX_V4_PORTFOLIO_WRITE_ENV)] },
    { id: "dispatch", gates: [gate("auto_promotion",
      AMUX_V22_AUTO_PROMOTION_CODE_LATCH, AMUX_V22_AUTO_PROMOTION_ENV),
      gate("worker_claim", AMUX_V22_WORKER_CLAIM_CODE_LATCH,
        AMUX_V22_WORKER_CLAIM_ENV)] },
    { id: "execution", gates: [gate("task_execution",
      AMUX_V22_TASK_EXECUTION_CODE_LATCH, AMUX_V22_TASK_EXECUTION_ENV)] },
    { id: "optional_public_pr", gates: [gate("public_pr",
      AMUX_V22_ENGINEERING_PUBLICATION_CODE_LATCH,
      AMUX_V22_ENGINEERING_PUBLICATION_ENV)] },
    { id: "feedback", gates: [gate("owner_outcome_write",
      AMUX_V22_OUTCOME_WRITE_CODE_LATCH, AMUX_V22_OUTCOME_WRITE_ENV)] },
  ];
  return { asOf: new Date().toISOString(),
    stages: inspectAmuxActivationStages(stages),
    activationAuthorized: false as const,
    reason: "owner_review_and_runtime_evidence_not_evaluated" as const };
}
