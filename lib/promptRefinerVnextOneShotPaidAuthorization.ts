import "server-only";

import type { Prisma, PromptRefinerVnextOneShotStage } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { promptRefinerVnextOneShotAuditReceiptIsValid } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";
import { readPromptRefinerVnextOneShotCandidateSource } from
  "@/lib/promptRefinerVnextOneShotCandidateSourceReadback";
import { assertPromptRefinerVnextOneShotCurrentPrice } from
  "@/lib/promptRefinerVnextOneShotPriceGuard";
import { readPromptRefinerVnextOneShotOperationalShadow } from
  "@/lib/promptRefinerVnextOneShotOperationalShadow";
import { lockAndReadPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import { prisma } from "@/lib/prisma";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";

export const PROMPT_REFINER_VNEXT_PAID_AUTHORIZATION_ACTION =
  "prompt_refiner.vnext_one_shot.paid_dispatch_authorized";
export const PROMPT_REFINER_VNEXT_PAID_AUTHORIZATION_SUMMARY =
  "Separately authorized the bounded Prompt Refiner vNext one-shot paid dispatch.";
const STAGE_ID = "prompt-refiner-vnext-one-shot-v4";

export function promptRefinerVnextOneShotPaidAuthorizationMetadata(
  stage: PromptRefinerVnextOneShotStage,
  shadowAuditLogId: string,
) {
  return {
    approvalKind: "paid_dispatch",
    stageApprovalAuditLogId: stage.stageApprovalAuditLogId,
    runApprovalAuditLogId: stage.runApprovalAuditLogId,
    shadowAuditLogId,
    sourceCommitSha: stage.sourceCommitSha,
    sourceManifestDigest: stage.sourceManifestDigest,
    runnerDigest: stage.runnerDigest,
    manifestRoot: stage.manifestRoot,
    runtimeDeploymentId: stage.runtimeDeploymentId,
    runtimeCommitSha: stage.runtimeCommitSha,
    pricePinDigest: stage.pricePinDigest,
    perRequestCostMicroUsd: Number(stage.perRequestCostMicroUsd),
    slotCount: stage.slotCount,
    costCeilingMicroUsd: Number(stage.costCeilingMicroUsd),
  };
}

/** A missing, duplicate, drifted or unverifiable paid audit grants nothing. */
export async function readPromptRefinerVnextOneShotPaidAuthorization(
  tx: Prisma.TransactionClient,
  stage: PromptRefinerVnextOneShotStage,
  shadowAuditLogId: string,
): Promise<Readonly<{ present: boolean; valid: boolean; auditLogId: string | null }>> {
  const rows = await tx.adminAuditLog.findMany({
    where: {
      action: PROMPT_REFINER_VNEXT_PAID_AUTHORIZATION_ACTION,
      targetType: "PromptRefinerVnextOneShotStage",
      targetId: STAGE_ID,
    },
  });
  const entry = rows.length === 1 ? rows[0] : null;
  const shadow = entry && await tx.adminAuditLog.findUnique({
    where: { id: shadowAuditLogId }, select: { createdAt: true },
  });
  const valid = Boolean(entry && stage.id === STAGE_ID &&
    stage.status === "run_approved" && stage.runApprovalAuditLogId &&
    shadow && entry.createdAt.getTime() > shadow.createdAt.getTime() &&
    entry.actorUserId === stage.approvedBy &&
    entry.summary === PROMPT_REFINER_VNEXT_PAID_AUTHORIZATION_SUMMARY &&
    canonicalBenchmarkJson(entry.metadata) === canonicalBenchmarkJson(
      promptRefinerVnextOneShotPaidAuthorizationMetadata(stage, shadowAuditLogId),
    ) && await promptRefinerVnextOneShotAuditReceiptIsValid(tx, entry));
  return Object.freeze({ present: rows.length > 0, valid,
    auditLogId: valid ? entry!.id : null });
}

export type PromptRefinerVnextPaidAuthorizationPins = Readonly<{
  stageApprovalAuditLogId: string;
  runApprovalAuditLogId: string;
  shadowAuditLogId: string;
  sourceCommitSha: string;
  sourceManifestDigest: string;
  runnerDigest: string;
  manifestRoot: string;
  runtimeDeploymentId: string;
  runtimeCommitSha: string;
  pricePinDigest: string;
}>;

/** Distinct owner spend approval; this writer never consumes or dispatches. */
export async function approvePromptRefinerVnextOneShotPaidDispatch(input: {
  session: Session;
  request: Request;
  expected: PromptRefinerVnextPaidAuthorizationPins;
}): Promise<Readonly<{ stageId: typeof STAGE_ID; paidAuthorizationAuditLogId: string;
  dispatchAuthorized: false }>> {
  if (!input.session.user?.id || adminAuditIntegrityKeys(process.env).length === 0) {
    throw new Error("vnext_one_shot_paid_approval_context_invalid");
  }
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const snapshot = await lockAndReadPromptRefinerVnextOneShotStage(tx);
    if (!snapshot.stagePresent || snapshot.stageStatus !== "run_approved" ||
        !snapshot.reservationShapeValid || !snapshot.approvalAuditsValid ||
        snapshot.slotCount !== 80 || snapshot.reservedSlots !== 80 ||
        snapshot.consumedSlots !== 0) {
      throw new Error("vnext_one_shot_paid_approval_stage_unavailable");
    }
    await readPromptRefinerVnextOneShotCandidateSource(tx);
    await assertPromptRefinerVnextOneShotCurrentPrice(tx);
    const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
      where: { id: STAGE_ID },
    });
    if (!stage || stage.approvedBy !== input.session.user.id ||
        stage.stageApprovalAuditLogId !== input.expected.stageApprovalAuditLogId ||
        stage.runApprovalAuditLogId !== input.expected.runApprovalAuditLogId ||
        stage.sourceCommitSha !== input.expected.sourceCommitSha ||
        stage.sourceManifestDigest !== input.expected.sourceManifestDigest ||
        stage.runnerDigest !== input.expected.runnerDigest ||
        stage.manifestRoot !== input.expected.manifestRoot ||
        stage.runtimeDeploymentId !== input.expected.runtimeDeploymentId ||
        stage.runtimeCommitSha !== input.expected.runtimeCommitSha ||
        stage.pricePinDigest !== input.expected.pricePinDigest ||
        stage.runnerDigest !== process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST ||
        stage.manifestRoot !== process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT) {
      throw new Error("vnext_one_shot_paid_approval_binding_mismatch");
    }
    const shadow = await readPromptRefinerVnextOneShotOperationalShadow(tx, stage);
    if (!shadow.valid || shadow.cacheWriteInputTokens !== 0 ||
        shadow.shadowAuditLogId !== input.expected.shadowAuditLogId) {
      throw new Error("vnext_one_shot_paid_approval_shadow_unavailable");
    }
    const prior = await readPromptRefinerVnextOneShotPaidAuthorization(
      tx, stage, shadow.shadowAuditLogId,
    );
    if (prior.present) {
      throw new Error("vnext_one_shot_paid_approval_duplicate");
    }
    const paidAuthorizationAuditLogId = await writeAdminAuditLog({
      tx, session: input.session, request: input.request,
      action: PROMPT_REFINER_VNEXT_PAID_AUTHORIZATION_ACTION,
      targetType: "PromptRefinerVnextOneShotStage", targetId: STAGE_ID,
      summary: PROMPT_REFINER_VNEXT_PAID_AUTHORIZATION_SUMMARY,
      metadata: promptRefinerVnextOneShotPaidAuthorizationMetadata(
        stage, shadow.shadowAuditLogId,
      ),
    });
    const readback = await readPromptRefinerVnextOneShotPaidAuthorization(
      tx, stage, shadow.shadowAuditLogId,
    );
    if (!readback.valid || readback.auditLogId !== paidAuthorizationAuditLogId) {
      throw new Error("vnext_one_shot_paid_approval_readback_invalid");
    }
    return Object.freeze({ stageId: STAGE_ID, paidAuthorizationAuditLogId,
      dispatchAuthorized: false as const });
  }, { maxWait: 5_000, timeout: 15_000 });
}
