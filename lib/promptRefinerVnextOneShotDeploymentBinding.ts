import "server-only";

import type { Prisma } from "@prisma/client";

import { observePromptRefinerVnextOneShotDeployment } from
  "@/lib/promptRefinerQualityEvaluationVnextOneShotDeploymentReadback";
import type { PromptRefinerRunnableStageId } from
  "@/lib/promptRefinerVnextOneShotV5Recovery";

const STAGE_ID = "prompt-refiner-vnext-one-shot-v4";
const SHA = /^[0-9a-f]{40}$/;
const DEPLOYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type ApprovedDeploymentRow = {
  id: string;
  status: string;
  runtimeDeploymentId: string;
  runtimeCommitSha: string;
};

/**
 * Recheck the approved deployment from the app transaction and Railway at
 * each future admission call. The stage row stays locked until that transaction
 * ends. This check grants no stage, run, or dispatch authority on its own.
 */
export async function assertPromptRefinerVnextOneShotActiveDeploymentForAdmission(
  tx: Prisma.TransactionClient,
  options: Parameters<typeof observePromptRefinerVnextOneShotDeployment>[0] = {},
  stageId: PromptRefinerRunnableStageId = STAGE_ID,
): Promise<void> {
  const rows = await tx.$queryRaw<ApprovedDeploymentRow[]>`
    SELECT "id", "status", "runtimeDeploymentId", "runtimeCommitSha"
    FROM "PromptRefinerVnextOneShotStage"
    WHERE "id" = ${stageId}
    FOR NO KEY UPDATE NOWAIT
  `;
  const stage = rows.length === 1 ? rows[0] : null;
  if (!stage || stage.id !== stageId) {
    throw new Error("vnext_one_shot_approved_stage_unavailable");
  }
  if (stage.status !== "staged" && stage.status !== "run_approved") {
    throw new Error("vnext_one_shot_approved_stage_inactive");
  }
  if (!DEPLOYMENT_ID.test(stage.runtimeDeploymentId) ||
      !SHA.test(stage.runtimeCommitSha)) {
    throw new Error("vnext_one_shot_approved_deployment_invalid");
  }

  const observed = await observePromptRefinerVnextOneShotDeployment(options);
  if (!observed.runtimeAndRailwayAgree || !observed.activeDeploymentConfirmed ||
      observed.problems.length !== 0) {
    throw new Error("vnext_one_shot_active_deployment_unverified");
  }
  if (stage.runtimeDeploymentId !== observed.deploymentId ||
      stage.runtimeCommitSha !== observed.commitSha) {
    throw new Error("vnext_one_shot_approved_deployment_mismatch");
  }
}
