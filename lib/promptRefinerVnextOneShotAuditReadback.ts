import "server-only";

import type { Prisma } from "@prisma/client";

import {
  ADMIN_AUDIT_VERIFICATION_KEY_ORDERS,
  adminAuditEntryHashVariants,
  adminAuditIntegrityKeys,
} from "@/lib/adminAuditIntegrityCore";
import {
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";

export type PromptRefinerVnextOneShotAuditBinding = {
  id: string;
  sourceCommitSha: string;
  sourceManifestDigest: string;
  runnerDigest: string;
  manifestRoot: string;
  runtimeDeploymentId: string;
  runtimeCommitSha: string;
  pricePinDigest: string;
  perRequestCostMicroUsd: bigint;
  slotCount: number;
  costCeilingMicroUsd: bigint;
};

type Stage = PromptRefinerVnextOneShotAuditBinding & {
  approvedBy: string;
  approvedAt: Date;
  stageApprovalAuditLogId: string;
  runApprovalAuditLogId: string | null;
};

type AuditEntry = {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  previousHash: string | null;
  entryHash: string | null;
  createdAt: Date;
};

export type PromptRefinerVnextOneShotApprovalKind = "stage" | "run";

export const PROMPT_REFINER_VNEXT_ONE_SHOT_APPROVAL_SUMMARIES = {
  stage: "Approved the bounded Prompt Refiner vNext one-shot stage.",
  run: "Approved the bounded Prompt Refiner vNext one-shot run.",
} as const;

// The database fixes both cost values to these small integers before an audit
// row can be linked, so converting them into JSON numbers is lossless.
export const promptRefinerVnextOneShotApprovalAuditMetadata = (
  stage: PromptRefinerVnextOneShotAuditBinding,
  kind: PromptRefinerVnextOneShotApprovalKind
) => ({
  approvalKind: kind,
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
});

const auditEntryHashIsValid = (entry: AuditEntry, keys: readonly string[]): boolean => {
  if (!entry.entryHash || keys.length === 0) return false;
  const hashInput = {
    previousHash: entry.previousHash,
    actorUserId: entry.actorUserId,
    actorEmail: entry.actorEmail,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    summary: entry.summary,
    metadata: entry.metadata ?? null,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    createdAt: entry.createdAt.toISOString(),
  };
  return keys.some((key) => {
    const variants = adminAuditEntryHashVariants(hashInput, key);
    return ADMIN_AUDIT_VERIFICATION_KEY_ORDERS.some(
      (order) => variants[order] === entry.entryHash
    );
  });
};

/** Verify an arbitrary one-shot receipt and its immediate signed predecessor. */
export const promptRefinerVnextOneShotAuditReceiptIsValid = async (
  tx: Prisma.TransactionClient,
  entry: AuditEntry,
  keys: readonly string[] = adminAuditIntegrityKeys(process.env)
): Promise<boolean> => {
  if (!auditEntryHashIsValid(entry, keys)) return false;
  if (!entry.previousHash) return true;
  const previous = await tx.adminAuditLog.findUnique({
    where: { entryHash: entry.previousHash },
  });
  return Boolean(previous && previous.entryHash === entry.previousHash &&
    previous.createdAt.getTime() < entry.createdAt.getTime() &&
    auditEntryHashIsValid(previous, keys));
};

/** DB triggers bind the row shape; this verifies the app-owned HMAC key. */
export const promptRefinerVnextOneShotApprovalAuditEntryIsValid = (
  stage: Stage,
  entry: AuditEntry,
  kind: PromptRefinerVnextOneShotApprovalKind,
  keys: readonly string[]
): boolean => {
  const id = kind === "stage" ? stage.stageApprovalAuditLogId : stage.runApprovalAuditLogId;
  if (
    keys.length === 0 ||
    !id ||
    entry.id !== id ||
    !entry.entryHash ||
    (stage.id !== "prompt-refiner-vnext-one-shot-v1" &&
      stage.id !== "prompt-refiner-vnext-one-shot-v2" &&
      stage.id !== "prompt-refiner-vnext-one-shot-v3" &&
      stage.id !== "prompt-refiner-vnext-one-shot-v4" &&
      stage.id !== "prompt-refiner-vnext-one-shot-v5") ||
    stage.slotCount !== 80 ||
    stage.perRequestCostMicroUsd !== BigInt(PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD) ||
    stage.costCeilingMicroUsd !== BigInt(PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD) ||
    entry.actorUserId !== stage.approvedBy ||
    entry.action !== `prompt_refiner.vnext_one_shot.${kind}_approved` ||
    entry.targetType !== "PromptRefinerVnextOneShotStage" ||
    entry.targetId !== stage.id ||
    entry.summary !== PROMPT_REFINER_VNEXT_ONE_SHOT_APPROVAL_SUMMARIES[kind] ||
    (kind === "stage" && entry.createdAt.getTime() !== stage.approvedAt.getTime()) ||
    (kind === "run" && entry.createdAt.getTime() <= stage.approvedAt.getTime()) ||
    canonicalBenchmarkJson(entry.metadata ?? null) !==
      canonicalBenchmarkJson(promptRefinerVnextOneShotApprovalAuditMetadata(stage, kind))
  ) {
    return false;
  }

  return auditEntryHashIsValid(entry, keys);
};

/** Read both approval rows and the immediate signed predecessor in one transaction. */
export const promptRefinerVnextOneShotApprovalAuditsAreValid = async (
  tx: Prisma.TransactionClient,
  stage: Stage
): Promise<boolean> => {
  const keys = adminAuditIntegrityKeys(process.env);
  if (keys.length === 0 || !stage.stageApprovalAuditLogId) return false;

  const kinds: PromptRefinerVnextOneShotApprovalKind[] =
    stage.runApprovalAuditLogId ? ["stage", "run"] : ["stage"];
  for (const kind of kinds) {
    const id = kind === "stage" ? stage.stageApprovalAuditLogId : stage.runApprovalAuditLogId;
    if (!id) return false;
    const entry = await tx.adminAuditLog.findUnique({ where: { id } });
    if (!entry || !promptRefinerVnextOneShotApprovalAuditEntryIsValid(stage, entry, kind, keys)) {
      return false;
    }
    if (entry.previousHash) {
      const previous = await tx.adminAuditLog.findUnique({
        where: { entryHash: entry.previousHash },
      });
      if (!previous || previous.entryHash !== entry.previousHash ||
          !auditEntryHashIsValid(previous, keys)) return false;
    }
  }
  return true;
};
