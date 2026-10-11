import "server-only";

import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { prisma } from "@/lib/prisma";
import {
  PROMPT_REFINER_VNEXT_ONE_SHOT_APPROVAL_SUMMARIES,
  promptRefinerVnextOneShotApprovalAuditMetadata,
} from "@/lib/promptRefinerVnextOneShotAuditReadback";
import { readPromptRefinerVnextOneShotCandidateSource } from
  "@/lib/promptRefinerVnextOneShotCandidateSourceReadback";
import { assertPromptRefinerVnextOneShotCurrentPrice } from
  "@/lib/promptRefinerVnextOneShotPriceGuard";
import { lockAndReadPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import { V5_STAGE_ID, type PromptRefinerRunnableStageId } from
  "@/lib/promptRefinerVnextOneShotV5Recovery";

const STAGE_ID = "prompt-refiner-vnext-one-shot-v4";
const SHA256 = /^[0-9a-f]{64}$/;

export type PromptRefinerVnextOneShotRunApprovalPins = Readonly<{
  stageApprovalAuditLogId: string;
  sourceCommitSha: string;
  sourceManifestDigest: string;
  runnerDigest: string;
  manifestRoot: string;
  runtimeDeploymentId: string;
  runtimeCommitSha: string;
  pricePinDigest: string;
}>;

/**
 * A09: a distinct human audit and staged -> run_approved transition commit
 * together. The stage row, all 80 slots, its first audit, deployed source,
 * active Railway deployment and current registry price are re-read under the
 * caller transaction. No slot is consumed and no provider is called.
 */
export async function approvePromptRefinerVnextOneShotRun(input: {
  session: Session;
  request: Request;
  expected: PromptRefinerVnextOneShotRunApprovalPins;
  stageId?: PromptRefinerRunnableStageId;
}): Promise<Readonly<{
  stageId: string;
  runApprovalAuditLogId: string;
  dispatchAuthorized: false;
}>> {
  if (!input.session?.user?.id || !input.request || !input.expected ||
      adminAuditIntegrityKeys(process.env).length === 0) {
    throw new Error("vnext_one_shot_run_approval_context_invalid");
  }
  const stageId = input.stageId ?? STAGE_ID;
  if (stageId !== STAGE_ID && stageId !== V5_STAGE_ID) {
    throw new Error("vnext_one_shot_run_stage_invalid");
  }
  const pinnedRoot = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT;
  const pinnedRunner = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST;
  if (!SHA256.test(pinnedRoot ?? "") || !SHA256.test(pinnedRunner ?? "")) {
    throw new Error("vnext_one_shot_run_custody_pin_unavailable");
  }
  return prisma.$transaction(async (tx) => {
    // The shared chain lock precedes stage/slot/registry locks to retain the
    // existing audit writer's global lock order. Refusals roll it all back.
    await takeAuditChainLock(tx);
    const readback = await lockAndReadPromptRefinerVnextOneShotStage(tx, {}, stageId);
    if (!readback.stagePresent || readback.stageStatus !== "staged" ||
        !readback.reservationShapeValid || !readback.approvalAuditsValid ||
        readback.reservedSlots !== 80 || readback.consumedSlots !== 0) {
      throw new Error("vnext_one_shot_run_stage_not_ready");
    }
    await readPromptRefinerVnextOneShotCandidateSource(tx, stageId);
    await assertPromptRefinerVnextOneShotCurrentPrice(tx);
    const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
      where: { id: stageId },
    });
    if (!stage || stage.approvedBy !== input.session.user.id ||
        stage.runApprovalAuditLogId !== null ||
        stage.stageApprovalAuditLogId !== input.expected.stageApprovalAuditLogId ||
        stage.sourceCommitSha !== input.expected.sourceCommitSha ||
        stage.sourceManifestDigest !== input.expected.sourceManifestDigest ||
        stage.runnerDigest !== input.expected.runnerDigest ||
        stage.manifestRoot !== input.expected.manifestRoot ||
        stage.runtimeDeploymentId !== input.expected.runtimeDeploymentId ||
        stage.runtimeCommitSha !== input.expected.runtimeCommitSha ||
        stage.pricePinDigest !== input.expected.pricePinDigest ||
        stage.manifestRoot !== pinnedRoot || stage.runnerDigest !== pinnedRunner) {
      throw new Error("vnext_one_shot_run_binding_mismatch");
    }
    const auditLogId = await writeAdminAuditLog({
      tx,
      session: input.session,
      request: input.request,
      action: "prompt_refiner.vnext_one_shot.run_approved",
      targetType: "PromptRefinerVnextOneShotStage",
      targetId: stageId,
      summary: PROMPT_REFINER_VNEXT_ONE_SHOT_APPROVAL_SUMMARIES.run,
      metadata: promptRefinerVnextOneShotApprovalAuditMetadata(stage, "run"),
    });
    const updated = await tx.promptRefinerVnextOneShotStage.updateMany({
      where: { id: stageId, status: "staged", runApprovalAuditLogId: null },
      data: { status: "run_approved", runApprovalAuditLogId: auditLogId },
    });
    if (updated.count !== 1) {
      throw new Error("vnext_one_shot_run_transition_conflict");
    }
    return Object.freeze({ stageId,
      runApprovalAuditLogId: auditLogId,
      dispatchAuthorized: false as const });
  }, { maxWait: 5_000, timeout: 15_000 });
}
