import "server-only";

import type { AdminAuditLog, Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { prisma } from "@/lib/prisma";
import {
  PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST,
  PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
  PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
} from "@/lib/promptRefinerProductContract";
import {
  PROMPT_REFINER_AUTO_EXCEPTION_POLICY_COMMIT,
  PROMPT_REFINER_AUTO_EXCEPTION_POLICY_SHA256,
  validatePromptRefinerProductReleaseEntry,
} from "@/lib/promptRefinerProductRelease";
import { readPromptRefinerVnextOneShotCandidateSource } from
  "@/lib/promptRefinerVnextOneShotCandidateSourceReadback";
import {
  readPromptRefinerVnextOneShotDisposition,
  readPromptRefinerVnextOneShotGateEvidence,
} from "@/lib/promptRefinerVnextOneShotGateEvidence";
import { promptRefinerVnextOneShotAuditReceiptIsValid } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";
import { readPromptRefinerVnextOneShotPrice } from
  "@/lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback";
import {
  V4_STAGE_ID,
  V5_STAGE_ID,
  type PromptRefinerRunnableStageId,
} from "@/lib/promptRefinerVnextOneShotV5Recovery";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";

const LIMITED_ACTION = "prompt_refiner.product_limited_audit_recorded";
const LIMITED_SUMMARY =
  "Recorded the owner's content-free Prompt Refiner limited audit receipt.";
const ACTIVATION_ACTION = "prompt_refiner.product_release_activated";
const ACTIVATION_SUMMARY =
  "Activated the exact-deployment Prompt Refiner product release.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;

type Tx = Prisma.TransactionClient;

type EvidenceTarget = Readonly<{
  stageId: PromptRefinerRunnableStageId;
  gateAuditLogId: string;
  dispositionAuditLogId: string;
}>;

const limitedMetadata = (target: EvidenceTarget, reviewedCaseCount: number) => ({
  version: "prompt-refiner-product-limited-audit-v1",
  policyCommit: PROMPT_REFINER_AUTO_EXCEPTION_POLICY_COMMIT,
  policySha256: PROMPT_REFINER_AUTO_EXCEPTION_POLICY_SHA256,
  ...target,
  reviewedCaseCount,
  unresolvedAuditViolations: 0,
  disposition: "no_unresolved_non_latency_violation",
  candidateDigest: PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
  pricePinDigest: PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
  adapterConfigDigest: PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST,
});

const activationMetadata = (input: EvidenceTarget & {
  limitedAuditReceiptId: string;
  runtimeCommitSha: string;
  runtimeDeploymentId: string;
}) => ({
  version: "prompt-refiner-product-release-v1",
  policyCommit: PROMPT_REFINER_AUTO_EXCEPTION_POLICY_COMMIT,
  policySha256: PROMPT_REFINER_AUTO_EXCEPTION_POLICY_SHA256,
  ...input,
  gateOutcome: "fail",
  gateReasonCodes: ["latency_ceiling_exceeded"],
  latencyOnlyFailure: true,
  limitedAuditDisposition: "pass",
  unresolvedAuditViolations: 0,
  candidateDigest: PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
  pricePinDigest: PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
  adapterConfigDigest: PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST,
  explicitEnabled: true,
  autoEnabled: true,
});

async function exactStageEvidence(tx: Tx, target: EvidenceTarget) {
  const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
    where: { id: target.stageId },
  });
  const gate = await readPromptRefinerVnextOneShotGateEvidence(
    tx, stage, target.stageId);
  const disposition = await readPromptRefinerVnextOneShotDisposition(
    tx, stage, target.stageId);
  if (!stage || !gate.valid || gate.gateAuditLogId !== target.gateAuditLogId ||
      gate.gateOutcome !== "fail" || gate.latencyOnlyFailure !== true ||
      gate.reasonCodes?.length !== 1 ||
      gate.reasonCodes[0] !== "latency_ceiling_exceeded" ||
      !disposition.valid ||
      disposition.dispositionAuditLogId !== target.dispositionAuditLogId ||
      disposition.finalDisposition !== "fail") {
    throw new Error("prompt_refiner_product_quality_evidence_unavailable");
  }
  await readPromptRefinerVnextOneShotCandidateSource(tx, target.stageId);
  const price = await readPromptRefinerVnextOneShotPrice(tx);
  if (!price.pricePinMatchesRegistry || price.problems.length !== 0) {
    throw new Error("prompt_refiner_product_price_evidence_unavailable");
  }
  return stage;
}

async function readLimitedReceipt(tx: Tx, target: EvidenceTarget,
  receiptId: string): Promise<AdminAuditLog | null> {
  const rows = await tx.adminAuditLog.findMany({
    where: { action: LIMITED_ACTION,
      targetType: "PromptRefinerVnextOneShotStage", targetId: target.stageId },
  });
  const row = rows.length === 1 && rows[0].id === receiptId ? rows[0] : null;
  if (!row || row.summary !== LIMITED_SUMMARY || !row.actorUserId ||
      !row.metadata || typeof row.metadata !== "object" ||
      Array.isArray(row.metadata)) return null;
  const metadata = row.metadata as Record<string, unknown>;
  const count = metadata.reviewedCaseCount;
  if (!Number.isInteger(count) || (count as number) < 0 || (count as number) > 8 ||
      canonicalBenchmarkJson(metadata) !==
        canonicalBenchmarkJson(limitedMetadata(target, count as number)) ||
      !await promptRefinerVnextOneShotAuditReceiptIsValid(tx, row)) return null;
  return row;
}

export async function recordPromptRefinerProductLimitedAudit(input: {
  session: Session;
  request: Request;
  target: EvidenceTarget;
  reviewedCaseCount: number;
}) {
  if (!input.session.user?.id || adminAuditIntegrityKeys(process.env).length === 0 ||
      !Number.isInteger(input.reviewedCaseCount) || input.reviewedCaseCount < 0 ||
      input.reviewedCaseCount > 8) {
    throw new Error("prompt_refiner_product_limited_audit_context_invalid");
  }
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const stage = await exactStageEvidence(tx, input.target);
    if (stage.approvedBy !== input.session.user!.id) {
      throw new Error("prompt_refiner_product_limited_audit_owner_mismatch");
    }
    const prior = await tx.adminAuditLog.findMany({ where: {
      action: LIMITED_ACTION, targetType: "PromptRefinerVnextOneShotStage",
      targetId: input.target.stageId,
    } });
    if (prior.length !== 0) {
      throw new Error("prompt_refiner_product_limited_audit_duplicate");
    }
    const receiptId = await writeAdminAuditLog({ tx, session: input.session,
      request: input.request, action: LIMITED_ACTION,
      targetType: "PromptRefinerVnextOneShotStage", targetId: input.target.stageId,
      summary: LIMITED_SUMMARY,
      metadata: limitedMetadata(input.target, input.reviewedCaseCount) });
    if (!await readLimitedReceipt(tx, input.target, receiptId)) {
      throw new Error("prompt_refiner_product_limited_audit_readback_invalid");
    }
    return Object.freeze({ receiptId, dispatchAuthorized: false as const });
  }, { maxWait: 5_000, timeout: 30_000 });
}

export async function activatePromptRefinerProductRelease(input: {
  session: Session;
  request: Request;
  target: EvidenceTarget & { limitedAuditReceiptId: string;
    runtimeCommitSha: string; runtimeDeploymentId: string };
}) {
  const runtimeCommitSha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase();
  const runtimeDeploymentId = process.env.RAILWAY_DEPLOYMENT_ID?.trim().toLowerCase();
  if (!input.session.user?.id || adminAuditIntegrityKeys(process.env).length === 0 ||
      !SHA.test(runtimeCommitSha ?? "") || !UUID.test(runtimeDeploymentId ?? "") ||
      input.target.runtimeCommitSha !== runtimeCommitSha ||
      input.target.runtimeDeploymentId !== runtimeDeploymentId) {
    throw new Error("prompt_refiner_product_activation_context_invalid");
  }
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const stage = await exactStageEvidence(tx, input.target);
    const limited = await readLimitedReceipt(tx, input.target,
      input.target.limitedAuditReceiptId);
    if (!limited || limited.actorUserId !== input.session.user!.id ||
        stage.approvedBy !== input.session.user!.id) {
      throw new Error("prompt_refiner_product_activation_evidence_invalid");
    }
    const prior = await tx.adminAuditLog.findMany({ where: {
      action: ACTIVATION_ACTION, targetType: "RailwayDeployment",
      targetId: runtimeDeploymentId,
    } });
    if (prior.length !== 0) {
      throw new Error("prompt_refiner_product_activation_duplicate");
    }
    const approvalAuditLogId = await writeAdminAuditLog({ tx,
      session: input.session, request: input.request,
      action: ACTIVATION_ACTION, targetType: "RailwayDeployment",
      targetId: runtimeDeploymentId!, summary: ACTIVATION_SUMMARY,
      metadata: activationMetadata(input.target),
    });
    const release = await readPromptRefinerProductRelease(tx, process.env);
    if (!release.explicitEnabled || !release.autoEnabled ||
        release.approvalAuditLogId !== approvalAuditLogId) {
      throw new Error("prompt_refiner_product_activation_readback_invalid");
    }
    return Object.freeze({ approvalAuditLogId,
      explicitEnabled: true as const, autoEnabled: true as const,
      runtimeCommitSha, runtimeDeploymentId });
  }, { maxWait: 5_000, timeout: 30_000 });
}

export async function readPromptRefinerProductRelease(
  tx: Tx,
  runtime: Record<string, string | undefined>,
) {
  const runtimeCommitSha = runtime.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase();
  const runtimeDeploymentId = runtime.RAILWAY_DEPLOYMENT_ID?.trim().toLowerCase();
  const closed = () => Object.freeze({ explicitEnabled: false,
    autoEnabled: false, runtimeCommitSha: null, runtimeDeploymentId: null,
    approvalAuditLogId: null });
  if (!SHA.test(runtimeCommitSha ?? "") || !UUID.test(runtimeDeploymentId ?? "")) {
    return closed();
  }
  const rows = await tx.adminAuditLog.findMany({ where: {
    action: ACTIVATION_ACTION, targetType: "RailwayDeployment",
    targetId: runtimeDeploymentId,
  } });
  const row = rows.length === 1 ? rows[0] : null;
  if (!row || row.summary !== ACTIVATION_SUMMARY || !row.actorUserId ||
      !row.metadata || typeof row.metadata !== "object" ||
      Array.isArray(row.metadata)) return closed();
  const metadata = row.metadata as Record<string, unknown>;
  const stageId = metadata.stageId;
  if (stageId !== V4_STAGE_ID && stageId !== V5_STAGE_ID) return closed();
  const target = {
    stageId,
    gateAuditLogId: String(metadata.gateAuditLogId ?? ""),
    dispositionAuditLogId: String(metadata.dispositionAuditLogId ?? ""),
    limitedAuditReceiptId: String(metadata.limitedAuditReceiptId ?? ""),
    runtimeCommitSha: runtimeCommitSha!,
    runtimeDeploymentId: runtimeDeploymentId!,
  } as const;
  let approvedAt: string;
  try {
    await exactStageEvidence(tx, target);
    const limited = await readLimitedReceipt(tx, target,
      target.limitedAuditReceiptId);
    if (!limited || limited.actorUserId !== row.actorUserId ||
        canonicalBenchmarkJson(metadata) !==
          canonicalBenchmarkJson(activationMetadata(target)) ||
        !await promptRefinerVnextOneShotAuditReceiptIsValid(tx, row)) return closed();
    approvedAt = row.createdAt.toISOString();
  } catch {
    return closed();
  }
  const valid = validatePromptRefinerProductReleaseEntry({
    version: "prompt-refiner-product-release-v1", status: "active",
    approvedBy: row.actorUserId, approvedAt,
    policyCommit: PROMPT_REFINER_AUTO_EXCEPTION_POLICY_COMMIT,
    policySha256: PROMPT_REFINER_AUTO_EXCEPTION_POLICY_SHA256,
    gateAuditLogId: target.gateAuditLogId,
    dispositionAuditLogId: target.dispositionAuditLogId,
    limitedAuditReceiptId: target.limitedAuditReceiptId,
    gateOutcome: "fail", gateReasonCodes: ["latency_ceiling_exceeded"],
    latencyOnlyFailure: true, limitedAuditDisposition: "pass",
    unresolvedAuditViolations: 0,
    candidateDigest: PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
    pricePinDigest: PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
    adapterConfigDigest: PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST,
    runtimeCommitSha: runtimeCommitSha!, runtimeDeploymentId: runtimeDeploymentId!,
    explicitEnabled: true, autoEnabled: true,
  }, runtime);
  return valid ? Object.freeze({ explicitEnabled: true, autoEnabled: true,
    runtimeCommitSha, runtimeDeploymentId, approvalAuditLogId: row.id }) : closed();
}

export async function loadPromptRefinerProductRelease(
  runtime: Record<string, string | undefined> = process.env,
) {
  if (!SHA.test(runtime.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase() ?? "") ||
      !UUID.test(runtime.RAILWAY_DEPLOYMENT_ID?.trim().toLowerCase() ?? "")) {
    return Object.freeze({ explicitEnabled: false, autoEnabled: false,
      runtimeCommitSha: null, runtimeDeploymentId: null,
      approvalAuditLogId: null });
  }
  return prisma.$transaction((tx) =>
    readPromptRefinerProductRelease(tx, runtime),
  { maxWait: 2_000, timeout: 10_000 });
}

