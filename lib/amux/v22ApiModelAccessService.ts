import "server-only";

import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { BoardImportError } from "./boardImportCore.ts";
import { TICK_TRANSACTION_LIMITS, withAutoTransaction } from
  "./autoPromotionService.ts";
import { recordAmuxV22ApiModelAccessEvidenceAudit } from
  "./v22TaskRecoverySystemAudit.ts";
import { AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED_ENV,
  AMUX_V22_TASK_RECOVERY_ENABLED_ENV, AMUX_V22_LEGACY_SAFE_STOP_ENABLED_ENV,
  amuxV22ReadOnlyApiExecutorEnabled, amuxV22TaskRecoveryEnabled,
  amuxV22LegacySafeStopEnabled, amuxV22ReadOnlyLaunchProofScope } from
  "./v22TaskRecoveryCore.ts";
import { AMUX_V22_READ_ONLY_API_EXECUTOR_KIND } from
  "./v22ReadOnlyApiProtocol.mjs";
import { amuxV22ApiModelAccessEvidenceDigest,
  parseAmuxV22ApiModelAccessResult,
  type AmuxV22ApiModelAccessResult } from
  "./v22ApiModelAccessProtocol.mjs";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const amuxV22ApiModelAccessResultSchema = z.object({
  version: z.literal(1), kind: z.literal("api_model_access"),
  requestId: z.string().uuid(),
  taskId: z.literal("c48886b9-86f8-4631-8db8-c0b288a707af"),
  priorAttemptId: z.literal("97858395-3d66-42fa-9bfb-0e5a6cba39d8"),
  worker: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  provider: z.literal("anthropic"), providerHost: z.literal("api.anthropic.com"),
  selectedModelId: z.string().regex(/^claude-[A-Za-z0-9._-]{1,120}$/),
  canonicalModelId: z.string().regex(/^claude-[A-Za-z0-9._-]{1,120}$/).nullable(),
  launchProofId: z.string().uuid(), launchProofDigest: digest,
  apiExecutionFrameDigest: digest, credentialMetadataDigest: digest,
  launcherConfigDigest: digest,
  access: z.enum(["verified", "unavailable", "unknown"]),
  reason: z.enum(["auth_failed", "model_unavailable", "rate_limited",
    "provider_unavailable", "request_timeout", "transport_unknown",
    "invalid_response", "outcome_unknown"]).nullable(),
  balanceKnown: z.literal(false), maximumCostMicroUsd: z.literal(3_400_000),
  worstExposureMicroUsd: z.literal(6_800_000),
}).strict().superRefine((value, context) => {
  const verified = value.access === "verified" && value.canonicalModelId !== null &&
    value.reason === null;
  const refused = value.access !== "verified" && value.canonicalModelId === null &&
    value.reason !== null;
  if ((!verified && !refused) || value.requestId !== value.launchProofId)
    context.addIssue({ code: "custom", message: "invalid API model access result" });
});

function enabled() {
  return amuxV22TaskRecoveryEnabled(
    process.env[AMUX_V22_TASK_RECOVERY_ENABLED_ENV]) &&
    amuxV22LegacySafeStopEnabled(
      process.env[AMUX_V22_LEGACY_SAFE_STOP_ENABLED_ENV]) &&
    amuxV22ReadOnlyApiExecutorEnabled(
      process.env[AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED_ENV]);
}

function fresh(recordedAt: Date, now: Date) {
  const age = now.getTime() - recordedAt.getTime();
  return age >= 0 && age <= 90_000;
}

async function auditBound(tx: Prisma.TransactionClient, id: string, action: string,
  targetType: string, targetId: string) {
  const audit = await tx.adminAuditLog.findUnique({ where: { id },
    select: { action: true, targetType: true, targetId: true, entryHash: true } });
  return !!audit?.entryHash && audit.action === action &&
    audit.targetType === targetType && audit.targetId === targetId;
}

export function pendingAmuxV22ApiModelAccess(workerName: string) {
  if (!enabled()) return Promise.resolve({ requests: [] });
  return withAutoTransaction(null, TICK_TRANSACTION_LIMITS, async (tx, now) => {
    const proofs = await tx.amuxV22ReadOnlyLaunchProof.findMany({ where: {
      verified: true, apiModelAccessEvidence: null,
      recordedAt: { gte: new Date(now.getTime() - 90_000), lte: now },
      launchCheck: { workerName,
        taskId: "c48886b9-86f8-4631-8db8-c0b288a707af",
        priorAttemptId: "97858395-3d66-42fa-9bfb-0e5a6cba39d8" },
    }, include: { launchCheck: { include: { task: { select: { status: true,
      revision: true, owner: true, v22AssignmentId: true } } } } },
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }], take: 1 });
    const requests = [];
    for (const proof of proofs) {
      const check = proof.launchCheck;
      const scope = amuxV22ReadOnlyLaunchProofScope(proof.report);
      if (!scope || !fresh(proof.recordedAt, now) ||
          !("executorKind" in scope.launchScope) ||
          scope.launchScope.executorKind !== AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ||
          !scope.report.apiExecutionFrame ||
          scope.report.apiExecutionFrame.modelId !== check.modelId ||
          scope.report.apiExecutionFrame.provider !== check.provider ||
          scope.report.apiExecutionFrame.credentialMetadataDigest.length !== 64 ||
          check.additionalCapMicroUsd !== BigInt(3_400_000) ||
          check.worstExposureMicroUsd !== BigInt(6_800_000) ||
          check.task.status !== "blocked" || check.task.revision !== check.taskRevision ||
          check.task.owner !== null || check.task.v22AssignmentId !== null ||
          !await auditBound(tx, proof.authorizationAuditLogId,
            "amux.v22.recovery.read_only_launch_observed",
            "AmuxV22ReadOnlyLaunchProof", proof.id)) continue;
      const runtime = await tx.amuxWorkerRuntime.findUnique({
        where: { workerName: check.workerName }, select: { instanceId: true,
          generation: true, leaseExpiresAt: true, status: true,
          dispatchReady: true, protocolCapabilities: true } });
      if (!runtime || runtime.instanceId !== check.workerInstanceId ||
          runtime.generation !== check.workerGeneration ||
          runtime.leaseExpiresAt <= now || runtime.status !== "idle" ||
          !runtime.dispatchReady || runtime.protocolCapabilities.length !== 1 ||
          runtime.protocolCapabilities[0] !== AMUX_V22_READ_ONLY_API_EXECUTOR_KIND)
        continue;
      requests.push({ version: 1 as const, requestId: proof.id,
        taskId: check.taskId, priorAttemptId: check.priorAttemptId,
        worker: check.workerName, provider: "anthropic" as const,
        selectedModelId: check.modelId, launchProofId: proof.id,
        launchProofDigest: proof.proofDigest,
        apiExecutionFrameDigest: scope.launchScope.apiExecutionFrameDigest,
        credentialMetadataDigest:
          scope.report.apiExecutionFrame.credentialMetadataDigest,
        launcherConfigDigest: scope.launchScope.launcherConfigDigest });
    }
    return { requests };
  });
}

export function reportAmuxV22ApiModelAccess(raw: AmuxV22ApiModelAccessResult) {
  if (!enabled()) throw new BoardImportError("api_model_access_disabled", 409);
  const input = parseAmuxV22ApiModelAccessResult(raw);
  return withAutoTransaction(input.requestId, TICK_TRANSACTION_LIMITS,
    async (tx, now) => {
      const existing = await tx.amuxV22ApiModelAccessEvidence.findUnique({
        where: { id: input.requestId } });
      const evidenceDigest = amuxV22ApiModelAccessEvidenceDigest(input);
      if (existing) {
        if (existing.evidenceDigest !== evidenceDigest ||
            existing.launchProofId !== input.launchProofId)
          throw new BoardImportError("api_model_access_conflict", 409);
        return { accepted: true as const, evidenceId: existing.id,
          evidenceDigest: existing.evidenceDigest,
          access: existing.accessState, canonicalModelId: existing.canonicalModelId,
          recordedAt: existing.recordedAt.toISOString(), retryWrite: false as const };
      }
      const proof = await tx.amuxV22ReadOnlyLaunchProof.findUnique({ where: {
        id: input.launchProofId }, include: { launchCheck: true } });
      const scope = proof ? amuxV22ReadOnlyLaunchProofScope(proof.report) : null;
      const check = proof?.launchCheck;
      if (!proof?.verified || !check || proof.proofDigest !== input.launchProofDigest ||
          !fresh(proof.recordedAt, now) ||
          input.requestId !== proof.id || check.taskId !== input.taskId ||
          check.priorAttemptId !== input.priorAttemptId ||
          check.workerName !== input.worker || check.provider !== input.provider ||
          check.modelId !== input.selectedModelId || !scope ||
          !("executorKind" in scope.launchScope) ||
          scope.launchScope.executorKind !== AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ||
          scope.report.apiExecutionFrame?.provider !== check.provider ||
          scope.report.apiExecutionFrame?.modelId !== check.modelId ||
          scope.launchScope.apiExecutionFrameDigest !== input.apiExecutionFrameDigest ||
          scope.launchScope.launcherConfigDigest !== input.launcherConfigDigest ||
          scope.report.apiExecutionFrame?.credentialMetadataDigest !==
            input.credentialMetadataDigest ||
          check.additionalCapMicroUsd !== BigInt(3_400_000) ||
          check.worstExposureMicroUsd !== BigInt(6_800_000) ||
          !await auditBound(tx, proof.authorizationAuditLogId,
            "amux.v22.recovery.read_only_launch_observed",
            "AmuxV22ReadOnlyLaunchProof", proof.id))
        throw new BoardImportError("api_model_access_binding_mismatch", 409);
      const task = await tx.amuxWorkItem.findUnique({ where: { id: check.taskId },
        select: { status: true, revision: true, owner: true, v22AssignmentId: true } });
      const runtime = await tx.amuxWorkerRuntime.findUnique({ where: {
        workerName: check.workerName }, select: { instanceId: true, generation: true,
        leaseExpiresAt: true, status: true, dispatchReady: true,
        protocolCapabilities: true } });
      if (!task || task.status !== "blocked" || task.revision !== check.taskRevision ||
          task.owner !== null || task.v22AssignmentId !== null || !runtime ||
          runtime.instanceId !== check.workerInstanceId ||
          runtime.generation !== check.workerGeneration || runtime.leaseExpiresAt <= now ||
          runtime.status !== "idle" || !runtime.dispatchReady ||
          runtime.protocolCapabilities.length !== 1 ||
          runtime.protocolCapabilities[0] !== AMUX_V22_READ_ONLY_API_EXECUTOR_KIND)
        throw new BoardImportError("api_model_access_binding_mismatch", 409);
      const auditId = await recordAmuxV22ApiModelAccessEvidenceAudit(tx,
        input.requestId, { taskId: input.taskId, priorAttemptId: input.priorAttemptId,
          workerName: input.worker, launchProofId: input.launchProofId,
          launchProofDigest: input.launchProofDigest,
          apiExecutionFrameDigest: input.apiExecutionFrameDigest,
          credentialMetadataDigest: input.credentialMetadataDigest,
          launcherConfigDigest: input.launcherConfigDigest,
          selectedModelId: input.selectedModelId,
          canonicalModelId: input.canonicalModelId, access: input.access,
          reason: input.reason, balanceKnown: false,
          maximumCostMicroUsd: input.maximumCostMicroUsd,
          worstExposureMicroUsd: input.worstExposureMicroUsd,
          evidenceDigest });
      const row = await tx.amuxV22ApiModelAccessEvidence.create({ data: {
        id: input.requestId, launchProofId: input.launchProofId,
        taskId: input.taskId, priorAttemptId: input.priorAttemptId,
        workerName: input.worker, workerInstanceId: check.workerInstanceId,
        workerGeneration: check.workerGeneration, provider: input.provider,
        providerHost: input.providerHost, selectedModelId: input.selectedModelId,
        canonicalModelId: input.canonicalModelId,
        apiExecutionFrameDigest: input.apiExecutionFrameDigest,
        credentialMetadataDigest: input.credentialMetadataDigest,
        launcherConfigDigest: input.launcherConfigDigest,
        accessState: input.access, reason: input.reason, balanceKnown: false,
        maximumCostMicroUsd: BigInt(input.maximumCostMicroUsd),
        worstExposureMicroUsd: BigInt(input.worstExposureMicroUsd), evidenceDigest,
        authorizationAuditLogId: auditId, recordedAt: now,
      }, select: { id: true, evidenceDigest: true, accessState: true,
        canonicalModelId: true, recordedAt: true } });
      return { accepted: true as const, evidenceId: row.id,
        evidenceDigest: row.evidenceDigest, access: row.accessState,
        canonicalModelId: row.canonicalModelId,
        recordedAt: row.recordedAt.toISOString(), retryWrite: false as const };
    });
}

export function readAmuxV22ApiModelAccess(evidenceId: string) {
  return withAutoTransaction(null, TICK_TRANSACTION_LIMITS, async (tx) => {
    const row = await tx.amuxV22ApiModelAccessEvidence.findUnique({
      where: { id: evidenceId } });
    return { found: row !== null, ...(row ? { evidence: {
      evidenceId: row.id, evidenceDigest: row.evidenceDigest,
      launchProofId: row.launchProofId, access: row.accessState,
      canonicalModelId: row.canonicalModelId,
      recordedAt: row.recordedAt.toISOString(),
    } } : {}) };
  });
}
