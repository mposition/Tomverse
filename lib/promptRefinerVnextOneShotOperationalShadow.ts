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
import { assertPromptRefinerVnextOneShotCurrentPrice } from
  "@/lib/promptRefinerVnextOneShotPriceGuard";
import { lockAndReadPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import {
  PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST,
  promptRefinerVnextOneShotShadowPublicKeyDigest,
  promptRefinerVnextOneShotShadowTargetSchema,
  verifyPromptRefinerVnextOneShotShadowProof,
  type PromptRefinerVnextOneShotShadowProof,
  type PromptRefinerVnextOneShotShadowTarget,
} from "@/lib/promptRefinerVnextOneShotShadowProof";
import {
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_SLOT_COUNT,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import { prisma } from "@/lib/prisma";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";
import { V5_STAGE_ID, type PromptRefinerRunnableStageId } from
  "@/lib/promptRefinerVnextOneShotV5Recovery";

const STAGE_ID = "prompt-refiner-vnext-one-shot-v4";
const HISTORICAL_STAGE_ID = "prompt-refiner-vnext-one-shot-v3";
const ACTION = "prompt_refiner.vnext_one_shot.operational_shadow_completed";
const SUMMARY = "Verified the one-shot stage, run, audit and 80 reserved slots without dispatch.";
const SHA256 = /^[0-9a-f]{64}$/;

export function promptRefinerVnextOneShotShadowTarget(
  stage: PromptRefinerVnextOneShotStage,
): PromptRefinerVnextOneShotShadowTarget | null {
  const parsed = promptRefinerVnextOneShotShadowTargetSchema.safeParse({
    stageApprovalAuditLogId: stage.stageApprovalAuditLogId,
    runApprovalAuditLogId: stage.runApprovalAuditLogId,
    sourceCommitSha: stage.sourceCommitSha,
    sourceManifestDigest: stage.sourceManifestDigest,
    runnerDigest: stage.runnerDigest,
    runtimeDeploymentId: stage.runtimeDeploymentId,
    runtimeCommitSha: stage.runtimeCommitSha,
    pricePinDigest: stage.pricePinDigest,
    perRequestCostMicroUsd: Number(stage.perRequestCostMicroUsd),
    costCeilingMicroUsd: Number(stage.costCeilingMicroUsd),
    slotCount: stage.slotCount,
    reservedSlots: PROMPT_REFINER_VNEXT_SLOT_COUNT,
    consumedSlots: 0,
  });
  return parsed.success ? parsed.data : null;
}

function readSignerPin() {
  const publicKey =
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_B64 ?? "";
  const digest =
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_DIGEST ?? "";
  try {
    if (!SHA256.test(digest) ||
        promptRefinerVnextOneShotShadowPublicKeyDigest(publicKey) !== digest) {
      throw new Error("pin_mismatch");
    }
    return Object.freeze({ publicKey, digest });
  } catch {
    throw new Error("vnext_one_shot_shadow_signer_pin_unavailable");
  }
}

const shadowMetadata = (stage: PromptRefinerVnextOneShotStage,
  signedAt: string, signerDigest: string, cacheWriteInputTokens: 0) => ({
  version: "prompt-refiner-vnext-one-shot-operational-shadow-v2",
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
  runnerPreflightDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST,
  cacheWriteInputTokens,
  providerCalls: 0,
  slotConsumeCalls: 0,
  signedAt,
  signerPublicKeyDigest: signerDigest,
});

/** A signed, content-free app observation. Duplicates and unknown rows fail closed. */
export async function readPromptRefinerVnextOneShotOperationalShadow(
  tx: Prisma.TransactionClient,
  stage: PromptRefinerVnextOneShotStage | null,
  stageId: PromptRefinerRunnableStageId = STAGE_ID,
): Promise<Readonly<{
  present: boolean;
  valid: boolean;
  shadowAuditLogId: string | null;
  cacheWriteInputTokens: 0 | null;
  dispatchAuthorized: false;
}>> {
  const rows = await tx.adminAuditLog.findMany({
    where: { action: ACTION, targetType: "PromptRefinerVnextOneShotStage",
      targetId: stage?.id ?? stageId },
  });
  const entry = rows.length === 1 ? rows[0] : null;
  let valid = false;
  const metadata = entry?.metadata;
  const signedAt = metadata && typeof metadata === "object" &&
    !Array.isArray(metadata) && typeof metadata.signedAt === "string"
    ? metadata.signedAt : null;
  const signerDigest = metadata && typeof metadata === "object" &&
    !Array.isArray(metadata) && typeof metadata.signerPublicKeyDigest === "string"
    ? metadata.signerPublicKeyDigest : null;
  const cacheWriteInputTokens = metadata && typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    typeof metadata.cacheWriteInputTokens === "number" &&
    Number.isInteger(metadata.cacheWriteInputTokens) &&
    metadata.cacheWriteInputTokens === 0 ? 0 as const : null;
  const signedMs = signedAt ? Date.parse(signedAt) : NaN;
  if (entry && (stage?.id === STAGE_ID || stage?.id === HISTORICAL_STAGE_ID ||
      stage?.id === V5_STAGE_ID) &&
      signedAt && signerDigest &&
      cacheWriteInputTokens === 0 &&
      SHA256.test(signerDigest) && Number.isFinite(signedMs) &&
      new Date(signedMs).toISOString() === signedAt &&
      (stage.status === "run_approved" || stage.status === "closed") &&
      stage.runApprovalAuditLogId &&
      stage.slotCount === PROMPT_REFINER_VNEXT_SLOT_COUNT &&
      stage.perRequestCostMicroUsd === BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD) &&
      stage.costCeilingMicroUsd === BigInt(PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD) &&
      entry.actorUserId === stage.approvedBy && entry.summary === SUMMARY &&
      // The write verified freshness using the app clock. Readback checks the
      // hash-chained audit without comparing it with a different DB clock.
      // The stored signer digest records the historical pin, including after rotation.
      canonicalBenchmarkJson(metadata) ===
        canonicalBenchmarkJson(shadowMetadata(stage, signedAt, signerDigest,
          cacheWriteInputTokens)) &&
      await promptRefinerVnextOneShotApprovalAuditsAreValid(tx, stage)) {
    const runAudit = await tx.adminAuditLog.findUnique({
      where: { id: stage.runApprovalAuditLogId }, select: { createdAt: true },
    });
    valid = Boolean(runAudit && entry.createdAt.getTime() > runAudit.createdAt.getTime() &&
      await promptRefinerVnextOneShotAuditReceiptIsValid(tx, entry));
  }
  return Object.freeze({ present: rows.length !== 0, valid,
    shadowAuditLogId: valid ? entry!.id : null,
    cacheWriteInputTokens: valid ? cacheWriteInputTokens : null,
    dispatchAuthorized: false as const });
}

/** App-owned, provider-free shadow. The chain lock serializes the one allowed row. */
export async function recordPromptRefinerVnextOneShotOperationalShadow(input: {
  session: Session;
  request: Request;
  proof: unknown;
  stageId?: PromptRefinerRunnableStageId;
}): Promise<Readonly<{ stageId: string; shadowAuditLogId: string;
  dispatchAuthorized: false }>> {
  if (!input.session?.user?.id || !input.proof ||
      adminAuditIntegrityKeys(process.env).length === 0) {
    throw new Error("vnext_one_shot_shadow_context_invalid");
  }
  const stageId = input.stageId ?? STAGE_ID;
  if (stageId !== STAGE_ID && stageId !== V5_STAGE_ID) {
    throw new Error("vnext_one_shot_shadow_stage_invalid");
  }
  const signer = readSignerPin();
  const proof: PromptRefinerVnextOneShotShadowProof =
    verifyPromptRefinerVnextOneShotShadowProof(input.proof, signer.publicKey);
  const root = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT;
  const runner = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST;
  if (!SHA256.test(root ?? "") || !SHA256.test(runner ?? "")) {
    throw new Error("vnext_one_shot_shadow_custody_pin_unavailable");
  }
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const snapshot = await lockAndReadPromptRefinerVnextOneShotStage(tx, {}, stageId);
    if (!snapshot.stagePresent || snapshot.stageStatus !== "run_approved" ||
        !snapshot.reservationShapeValid || !snapshot.approvalAuditsValid ||
        snapshot.slotCount !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        snapshot.reservedSlots !== PROMPT_REFINER_VNEXT_SLOT_COUNT ||
        snapshot.consumedSlots !== 0) {
      throw new Error("vnext_one_shot_shadow_stage_unavailable");
    }
    await readPromptRefinerVnextOneShotCandidateSource(tx, stageId);
    await assertPromptRefinerVnextOneShotCurrentPrice(tx);
    const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
      where: { id: stageId },
    });
    if (!stage) throw new Error("vnext_one_shot_shadow_binding_mismatch");
    const target = promptRefinerVnextOneShotShadowTarget(stage);
    if (stage.approvedBy !== input.session.user.id || !target ||
        canonicalBenchmarkJson(target) !==
          canonicalBenchmarkJson(
            promptRefinerVnextOneShotShadowTargetSchema.strip().parse(proof)) ||
        stage.manifestRoot !== root || proof.manifestRoot !== root ||
        stage.runnerDigest !== runner ||
        stage.perRequestCostMicroUsd !== BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD) ||
        stage.costCeilingMicroUsd !== BigInt(PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD)) {
      throw new Error("vnext_one_shot_shadow_binding_mismatch");
    }
    const prior = await readPromptRefinerVnextOneShotOperationalShadow(tx, stage);
    if (prior.present) throw new Error("vnext_one_shot_shadow_duplicate");
    const shadowAuditLogId = await writeAdminAuditLog({
      tx, session: input.session, request: input.request,
      action: ACTION,
      targetType: "PromptRefinerVnextOneShotStage", targetId: stageId,
      summary: SUMMARY,
      metadata: shadowMetadata(stage, proof.signedAt, signer.digest,
        proof.cacheWriteInputTokens),
    });
    const evidence = await readPromptRefinerVnextOneShotOperationalShadow(tx, stage);
    if (!evidence.valid || evidence.shadowAuditLogId !== shadowAuditLogId) {
      throw new Error("vnext_one_shot_shadow_evidence_unverified");
    }
    return Object.freeze({ stageId, shadowAuditLogId,
      dispatchAuthorized: false as const });
  }, { maxWait: 5_000, timeout: 15_000 });
}
