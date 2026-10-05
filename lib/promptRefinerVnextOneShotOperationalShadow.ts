import "server-only";

import type { PromptRefinerVnextOneShotStage, Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import {
  promptRefinerVnextOneShotApprovalAuditsAreValid,
  promptRefinerVnextOneShotAuditReceiptIsValid,
} from "@/lib/promptRefinerVnextOneShotAuditReadback";
import { readPromptRefinerVnextOneShotCandidateSource } from
  "@/lib/promptRefinerVnextOneShotCandidateSourceReadback";
import { lockAndReadPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import {
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_SLOT_COUNT,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import { prisma } from "@/lib/prisma";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";

const STAGE_ID = "prompt-refiner-vnext-one-shot-v2";
const ACTION = "prompt_refiner.vnext_one_shot.operational_shadow_completed";
const SUMMARY = "Verified the one-shot stage, run, audit and 80 reserved slots without dispatch.";
const SHA256 = /^[0-9a-f]{64}$/;

export type PromptRefinerVnextOneShotShadowTarget = Readonly<{
  stageApprovalAuditLogId: string;
  runApprovalAuditLogId: string;
  runtimeDeploymentId: string;
}>;

const shadowMetadata = (stage: PromptRefinerVnextOneShotStage) => ({
  version: "prompt-refiner-vnext-one-shot-operational-shadow-v1",
  stageApprovalAuditLogId: stage.stageApprovalAuditLogId,
  runApprovalAuditLogId: stage.runApprovalAuditLogId,
  sourceCommitSha: stage.sourceCommitSha,
  sourceManifestDigest: stage.sourceManifestDigest,
  runnerDigest: stage.runnerDigest,
  runtimeDeploymentId: stage.runtimeDeploymentId,
  runtimeCommitSha: stage.runtimeCommitSha,
  pricePinDigest: stage.pricePinDigest,
  perRequestCostMicroUsd: Number(stage.perRequestCostMicroUsd),
  slotCount: PROMPT_REFINER_VNEXT_SLOT_COUNT,
  reservedSlots: PROMPT_REFINER_VNEXT_SLOT_COUNT,
  consumedSlots: 0,
  costCeilingMicroUsd: Number(stage.costCeilingMicroUsd),
});

/** A signed, content-free app observation. Duplicates and unknown rows fail closed. */
export async function readPromptRefinerVnextOneShotOperationalShadow(
  tx: Prisma.TransactionClient,
  stage: PromptRefinerVnextOneShotStage | null
): Promise<Readonly<{
  present: boolean;
  valid: boolean;
  shadowAuditLogId: string | null;
  dispatchAuthorized: false;
}>> {
  const rows = await tx.adminAuditLog.findMany({
    where: { action: ACTION, targetType: "PromptRefinerVnextOneShotStage",
      targetId: STAGE_ID },
  });
  const entry = rows.length === 1 ? rows[0] : null;
  let valid = false;
  if (entry && stage?.id === STAGE_ID &&
      (stage.status === "run_approved" || stage.status === "closed") &&
      stage.runApprovalAuditLogId &&
      stage.slotCount === PROMPT_REFINER_VNEXT_SLOT_COUNT &&
      stage.perRequestCostMicroUsd === BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD) &&
      stage.costCeilingMicroUsd === BigInt(PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD) &&
      entry.actorUserId === stage.approvedBy && entry.summary === SUMMARY &&
      canonicalBenchmarkJson(entry.metadata ?? null) ===
        canonicalBenchmarkJson(shadowMetadata(stage)) &&
      await promptRefinerVnextOneShotApprovalAuditsAreValid(tx, stage)) {
    const runAudit = await tx.adminAuditLog.findUnique({
      where: { id: stage.runApprovalAuditLogId }, select: { createdAt: true },
    });
    valid = Boolean(runAudit && entry.createdAt.getTime() > runAudit.createdAt.getTime() &&
      await promptRefinerVnextOneShotAuditReceiptIsValid(tx, entry));
  }
  return Object.freeze({ present: rows.length !== 0, valid,
    shadowAuditLogId: valid ? entry!.id : null,
    dispatchAuthorized: false as const });
}

/** App-owned, provider-free shadow. The chain lock serializes the one allowed row. */
export async function recordPromptRefinerVnextOneShotOperationalShadow(input: {
  session: Session;
  request: Request;
  expected: PromptRefinerVnextOneShotShadowTarget;
}): Promise<Readonly<{ stageId: string; shadowAuditLogId: string;
  dispatchAuthorized: false }>> {
  if (!input.session?.user?.id || !input.expected ||
      adminAuditIntegrityKeys(process.env).length === 0) {
    throw new Error("vnext_one_shot_shadow_context_invalid");
  }
  const root = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT;
  const runner = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST;
  if (!SHA256.test(root ?? "") || !SHA256.test(runner ?? "")) {
    throw new Error("vnext_one_shot_shadow_custody_pin_unavailable");
  }
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const snapshot = await lockAndReadPromptRefinerVnextOneShotStage(tx);
    if (!snapshot.stagePresent || snapshot.stageStatus !== "run_approved" ||
        !snapshot.reservationShapeValid || !snapshot.approvalAuditsValid ||
        snapshot.slotCount !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        snapshot.reservedSlots !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        snapshot.consumedSlots !== 0) {
      throw new Error("vnext_one_shot_shadow_stage_unavailable");
    }
    await readPromptRefinerVnextOneShotCandidateSource(tx);
    const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
      where: { id: STAGE_ID },
    });
    if (!stage || stage.approvedBy !== input.session.user.id ||
        stage.stageApprovalAuditLogId !== input.expected.stageApprovalAuditLogId ||
        stage.runApprovalAuditLogId !== input.expected.runApprovalAuditLogId ||
        stage.runtimeDeploymentId !== input.expected.runtimeDeploymentId ||
        stage.manifestRoot !== root || stage.runnerDigest !== runner ||
        stage.perRequestCostMicroUsd !== BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD) ||
        stage.costCeilingMicroUsd !== BigInt(PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD)) {
      throw new Error("vnext_one_shot_shadow_binding_mismatch");
    }
    const prior = await readPromptRefinerVnextOneShotOperationalShadow(tx, stage);
    if (prior.present) throw new Error("vnext_one_shot_shadow_duplicate");
    const shadowAuditLogId = await writeAdminAuditLog({
      tx, session: input.session, request: input.request,
      action: ACTION,
      targetType: "PromptRefinerVnextOneShotStage", targetId: STAGE_ID,
      summary: SUMMARY, metadata: shadowMetadata(stage),
    });
    const evidence = await readPromptRefinerVnextOneShotOperationalShadow(tx, stage);
    if (!evidence.valid || evidence.shadowAuditLogId !== shadowAuditLogId) {
      throw new Error("vnext_one_shot_shadow_evidence_unverified");
    }
    return Object.freeze({ stageId: STAGE_ID, shadowAuditLogId,
      dispatchAuthorized: false as const });
  }, { maxWait: 5_000, timeout: 15_000 });
}
