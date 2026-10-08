import "server-only";

import type { Prisma, PromptRefinerVnextOneShotStage } from "@prisma/client";

import type { PromptRefinerVnextOneShotAuditBinding } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";
import { readPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import { readPromptRefinerVnextOneShotTerminalReceipts } from
  "@/lib/promptRefinerVnextOneShotTerminalReceipt";
import {
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_SLOT_COUNT,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import {
  V4_COMMIT_SHA, V4_DEPLOYMENT_ID, V4_HELD_COST_MICRO_USD,
  V4_OBSERVED_COST_MICRO_USD, V4_STAGE_ID, V5_STAGE_ID,
} from "@/lib/promptRefinerVnextOneShotV5Recovery";

const V4 = V4_STAGE_ID;
const V5 = V5_STAGE_ID;
const SLOT_COST = BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD);
const RUN_COST = BigInt(PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD);

/** Read-only eligibility check shared by the writer and owner preflight. */
export async function inspectPromptRefinerVnextOneShotV5Predecessor(
  tx: Prisma.TransactionClient,
  binding: PromptRefinerVnextOneShotAuditBinding,
  approvedBy: string,
): Promise<Readonly<{
  predecessor: PromptRefinerVnextOneShotStage;
  stopAuditLogId: string;
  runApprovalAuditLogId: string;
}> | null> {
  const predecessor = await tx.promptRefinerVnextOneShotStage.findUnique({
    where: { id: V4 },
  });
  const v4Stage = await readPromptRefinerVnextOneShotStage(tx, V4);
  const v4Terminals = await readPromptRefinerVnextOneShotTerminalReceipts(tx);
  const stop = v4Terminals.slots[33];
  if (!predecessor || !stop?.terminalAuditLogId ||
      !predecessor.runApprovalAuditLogId) return null;
  const eligible = predecessor.status === "closed" &&
    predecessor.runtimeDeploymentId === V4_DEPLOYMENT_ID &&
    predecessor.runtimeCommitSha === V4_COMMIT_SHA &&
    predecessor.approvedBy === approvedBy &&
    v4Stage.reservationShapeValid && v4Stage.approvalAuditsValid &&
    v4Stage.stageStatus === "closed" &&
    v4Terminals.valid && v4Terminals.stageStatus === "closed" &&
    v4Terminals.terminalReceipts === 33 &&
    v4Terminals.unknownReceipts === 1 &&
    v4Terminals.consumedWithoutReceipt === 0 &&
    v4Terminals.observedCostMicroUsd === V4_OBSERVED_COST_MICRO_USD &&
    v4Terminals.unresolvedCostUpperBoundMicroUsd === V4_HELD_COST_MICRO_USD &&
    v4Terminals.slots.length === PROMPT_REFINER_VNEXT_SLOT_COUNT &&
    v4Terminals.slots.slice(0, 33).every((slot) => slot.state === "terminal") &&
    stop.state === "outcome_unknown" &&
    v4Terminals.slots.slice(34).every((slot) => slot.state === "not_attempted") &&
    predecessor.sourceCommitSha === binding.sourceCommitSha &&
    predecessor.sourceManifestDigest === binding.sourceManifestDigest &&
    predecessor.manifestRoot !== binding.manifestRoot &&
    predecessor.runnerDigest !== binding.runnerDigest &&
    predecessor.pricePinDigest === binding.pricePinDigest &&
    predecessor.perRequestCostMicroUsd === SLOT_COST &&
    predecessor.costCeilingMicroUsd === RUN_COST &&
    predecessor.slotCount === PROMPT_REFINER_VNEXT_SLOT_COUNT &&
    predecessor.runtimeDeploymentId !== binding.runtimeDeploymentId &&
    predecessor.runtimeCommitSha !== binding.runtimeCommitSha &&
    await tx.promptRefinerVnextOneShotStage.count({ where: { id: V5 } }) === 0;
  return eligible ? Object.freeze({ predecessor,
    stopAuditLogId: stop.terminalAuditLogId,
    runApprovalAuditLogId: predecessor.runApprovalAuditLogId }) : null;
}
