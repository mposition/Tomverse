import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { auditRowActorKind } from "@/lib/adminAuditSystemActors";
import { OWNER_TRANSACTION_LIMITS, TICK_TRANSACTION_LIMITS, withAutoTransaction } from "./autoPromotionService.ts";
import { BoardImportError } from "./boardImportCore.ts";
import { lockAmuxAdmissionAndReadIncident } from "./incident.ts";
import { calculateCurrentApprovedAmuxV4TaskCost } from "./v4TaskCostCatalogApprovalService.ts";
import { evaluateAmuxV4TaskReadyInTransaction, loadAmuxV4TaskReadyContext } from "./v4TaskReadyService.ts";
import { lockAmuxResourcePolicies, evaluateLockedAmuxCostAdmission } from "./resourcePolicy.ts";
import { amuxResourceRefs } from "./resourcePolicyCore.ts";
import { AMUX_MAX_EXECUTION_ATTEMPTS, decideAmuxAttemptBudget } from "./executionBudgetCore.ts";
import { AMUX_WORKER_RUNTIME_LEASE_MS } from "./workerRuntime.ts";
import { recordAmuxV22RecoveryEvidenceAudit,
  recordAmuxV22SafeStopEvidenceAudit } from "./v22TaskRecoverySystemAudit.ts";
import { AMUX_V22_RECOVERY_HOST_SCOPE, AMUX_V22_TASK_RECOVERY_POLICY_VERSION,
  AMUX_V22_TASK_RECOVERY_ENABLED_ENV, AMUX_V22_LEGACY_SAFE_STOP_ENABLED_ENV,
  amuxV22TaskRecoveryEnabled, amuxV22LegacySafeStopEnabled,
  configuredAmuxV22RecoveryProfile, amuxV22SafeStopJournalBinding,
  amuxV22RecoveryDigest, amuxV22RecoveryCost, amuxV22RecoveryProofReason,
  amuxV22RecoveryEvidenceSchema, amuxV22SafeStopEvidenceSchema,
  amuxV22SafeStopProofReason, type AmuxV22RecoveryAdminInput,
  type AmuxV22RecoveryEvidenceInput, type AmuxV22SafeStopEvidenceInput,
  type AmuxV22RecoveryRead } from "./v22TaskRecoveryCore.ts";
import { amuxV22SafeStopFencedWorkers } from "./v22LegacySafeStopFence.ts";

function requireRecoveryEnabled() {
  if (!amuxV22TaskRecoveryEnabled(process.env[AMUX_V22_TASK_RECOVERY_ENABLED_ENV]))
    throw new BoardImportError("recovery_disabled", 409);
}
function requireSafeStopEnabled() {
  requireRecoveryEnabled();
  if (!amuxV22LegacySafeStopEnabled(
      process.env[AMUX_V22_LEGACY_SAFE_STOP_ENABLED_ENV]))
    throw new BoardImportError("safe_stop_disabled", 409);
}

async function requireOwner(session: Session) {
  if (!session.user?.id || !isAdminSession(session) || getAdminRole(session) !== "owner")
    throw new BoardImportError("forbidden", 403);
  await assertRecentAdminAuthentication(session);
  return session.user.id;
}
async function lockRecoveryTask(tx: Prisma.TransactionClient, taskId: string) {
  await tx.$queryRaw`SELECT "id" FROM "AmuxWorkItem" WHERE "id" = ${taskId} FOR UPDATE`;
  const task = await tx.amuxWorkItem.findUnique({ where: { id: taskId },
    select: { id: true, sourceSystem: true, cardType: true, archivedAt: true,
      v22ReceiptId: true, taskRole: true, executionGrade: true, status: true,
      owner: true, claimedAt: true, v22AssignmentId: true, revision: true,
      projectKey: true, teamKey: true,
      executionAttempts: { orderBy: [{ taskRevision: "desc" }, { startedAt: "desc" }, { id: "desc" }],
        take: 1, select: { id: true, taskId: true, taskRevision: true, worker: true,
          workerInstanceId: true, workerGeneration: true, endedAt: true,
          outcome: true, reason: true, reservedCostMicrousd: true } } } });
  if (!task || task.sourceSystem !== "admin-idea-v4" || task.cardType !== "task" ||
      task.archivedAt || !task.v22ReceiptId || !task.taskRole || !task.executionGrade)
    throw new BoardImportError("recovery_task_unavailable", 409);
  return task;
}
function requireBlockedIdentity(task: Awaited<ReturnType<typeof lockRecoveryTask>>,
  revision: number, attemptId: string) {
  const attempt = task.executionAttempts[0];
  if (task.status !== "blocked" || task.owner !== null || task.claimedAt !== null ||
      task.v22AssignmentId !== null || task.revision !== revision ||
      !attempt || attempt.id !== attemptId || !attempt.endedAt ||
      !(attempt.outcome === "expired" || attempt.outcome === "outcome_unknown" ||
        attempt.reason === "usage_outcome_unknown" || attempt.reason === "outcome_unknown") ||
      attempt.reservedCostMicrousd <= BigInt(0))
    throw new BoardImportError("recovery_identity_changed", 409);
  return attempt;
}
async function auditBound(tx: Prisma.TransactionClient, auditId: string,
  action: string, targetType: string, targetId: string, ownerId?: string) {
  const row = await tx.adminAuditLog.findUnique({ where: { id: auditId } });
  return !!row?.entryHash && row.action === action && row.targetType === targetType &&
    row.targetId === targetId && (ownerId ? row.actorUserId === ownerId &&
      auditRowActorKind(row) === "human" : auditRowActorKind(row) === "system");
}
async function priorBudget(tx: Prisma.TransactionClient, taskId: string) {
  const prior = await tx.amuxExecutionAttempt.aggregate({ where: { taskId },
    _count: { _all: true }, _max: { attemptNumber: true }, _sum: { reservedCostMicrousd: true } });
  const used = Math.max(prior._count._all, prior._max.attemptNumber ?? 0);
  if (used >= AMUX_MAX_EXECUTION_ATTEMPTS) throw new BoardImportError("attempt_budget_exhausted", 409);
  return { historicalAttempts: prior._count._all, nextAttemptNumber: used + 1,
    reserved: prior._sum.reservedCostMicrousd ?? BigInt(0) };
}
async function currentCost(tx: Prisma.TransactionClient,
  task: Awaited<ReturnType<typeof lockRecoveryTask>>) {
  const budget = await priorBudget(tx, task.id);
  const current = await calculateCurrentApprovedAmuxV4TaskCost(tx,
    task.taskRole!, task.executionGrade!);
  return { current, budget, cost: amuxV22RecoveryCost({ priorReservedMicroUsd: budget.reserved,
    catalogApprovalId: current.approvalId, receipt: current.receipt }) };
}
async function currentRuntime(tx: Prisma.TransactionClient, inspection: {
  workerName: string; workerInstanceId: string; workerGeneration: number }) {
  const rows = await tx.$queryRaw<Array<{ instanceId: string; generation: number }>>`SELECT "instanceId", "generation" FROM "AmuxWorkerRuntime"
    WHERE "workerName" = ${inspection.workerName} FOR SHARE`;
  const runtime = rows[0];
  return runtime && runtime.instanceId === inspection.workerInstanceId &&
    runtime.generation === inspection.workerGeneration ? runtime : null;
}
type SafeStopProfileBinding = {
  alias: string; workerNames: string[]; targetUnit: string;
  profileConfigDigest: string; workerInstanceId: string; workerGeneration: number;
};
async function lockSafeStopProfileRuntime(tx: Prisma.TransactionClient,
  profile: SafeStopProfileBinding) {
  const rows = await tx.$queryRaw<Array<{
    workerName: string; instanceId: string; generation: number;
  }>>`SELECT "workerName", "instanceId", "generation" FROM "AmuxWorkerRuntime"
    WHERE "workerName" = ANY(${profile.workerNames}::text[])
    ORDER BY "workerName" FOR UPDATE`;
  return rows.length === profile.workerNames.length && rows.every((row, index) =>
    row.workerName === profile.workerNames[index] &&
    row.instanceId === profile.workerInstanceId &&
    row.generation === profile.workerGeneration);
}
async function lockPriorAttempt(tx: Prisma.TransactionClient, attemptId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxExecutionAttempt" WHERE "id" = ${attemptId} FOR UPDATE`;
  return rows.length === 1;
}
async function safeStopOtherWorkPresent(tx: Prisma.TransactionClient,
  taskId: string, priorAttemptId: string, workerNames: string[]) {
  const rows = await tx.$queryRaw<Array<{ present: boolean }>>`
    SELECT (
      EXISTS (SELECT 1 FROM "AmuxWorkItem" other
        WHERE other."id" <> ${taskId} AND other."archivedAt" IS NULL
          AND other."status" NOT IN ('done', 'cancelled')
          AND other."owner" = ANY(${workerNames}::text[])) OR
      EXISTS (SELECT 1 FROM "AmuxV22WorkerAssignment" assignment
        JOIN "AmuxWorkItem" other ON other."v22AssignmentId" = assignment."id"
        WHERE other."id" <> ${taskId}
          AND assignment."workerName" = ANY(${workerNames}::text[])) OR
      EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" attempt
        WHERE attempt."id" <> ${priorAttemptId}
          AND attempt."worker" = ANY(${workerNames}::text[])
          AND (attempt."endedAt" IS NULL OR attempt."outcome" IS NULL OR
            attempt."outcome" = 'outcome_unknown' OR
            attempt."reason" IN ('outcome_unknown', 'usage_outcome_unknown'))) OR
      EXISTS (SELECT 1 FROM "AmuxWorkDelivery" delivery
        WHERE delivery."worker" = ANY(${workerNames}::text[])
          AND delivery."status" IN ('queued', 'leased'))
    ) AS present`;
  return rows[0]?.present !== false;
}
function requestAuditAction(requestKind: string) {
  return requestKind === "safe_stop" ?
    "amux.v22.recovery.safe_stop_requested" : "amux.v22.recovery.requested";
}
function evidenceAuditAction(requestKind: string) {
  return requestKind === "safe_stop" ?
    "amux.v22.recovery.safe_stop_reported" : "amux.v22.recovery.inspected";
}
/** Reuse the existing worker observation window; never refresh immutable evidence. */
function evidenceFresh(recordedAt: Date, now: Date) {
  const age = now.getTime() - recordedAt.getTime();
  return age >= 0 && age <= AMUX_WORKER_RUNTIME_LEASE_MS;
}

export async function requestAmuxV22RecoveryInspection(input: {
  session: Session; request: Request;
} & Extract<AmuxV22RecoveryAdminInput, { action: "request_inspection" }>) {
  const ownerId = await requireOwner(input.session);
  requireRecoveryEnabled();
  return withAutoTransaction(input.requestId, OWNER_TRANSACTION_LIMITS, async (tx, now) => {
    const existing = await tx.amuxV22TaskRecoveryInspectionRequest.findUnique({
      where: { ownerRequestId: input.requestId } });
    if (existing) {
      if (existing.requestedByUserId !== ownerId || existing.taskId !== input.taskId ||
          existing.taskRevision !== input.expectedRevision || existing.priorAttemptId !== input.priorAttemptId)
        throw new BoardImportError("request_id_reused", 409);
      return readRecoveryInTransaction(tx, ownerId, input.taskId, input.requestId, now);
    }
    const task = await lockRecoveryTask(tx, input.taskId);
    const attempt = requireBlockedIdentity(task, input.expectedRevision, input.priorAttemptId);
    const inspectionId = randomUUID();
    const binding = { inspectionId, taskId: task.id, taskRevision: task.revision,
      priorAttemptId: attempt.id, priorAttemptTaskRevision: attempt.taskRevision, workerName: attempt.worker,
      workerInstanceId: attempt.workerInstanceId, workerGeneration: attempt.workerGeneration,
      targetHost: AMUX_V22_RECOVERY_HOST_SCOPE };
    const requestDigest = amuxV22RecoveryDigest("inspection", binding);
    const auditId = await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: "amux.v22.recovery.requested", targetType: "AmuxV22TaskRecoveryInspectionRequest",
      targetId: inspectionId, summary: "Requested one fixed, read-only exact Task recovery inspection.",
      metadata: { ...binding, ownerRequestId: input.requestId, requestDigest,
        policyVersion: AMUX_V22_TASK_RECOVERY_POLICY_VERSION, executionStarted: false } });
    await tx.amuxV22TaskRecoveryInspectionRequest.create({ data: {
      taskId: binding.taskId, taskRevision: binding.taskRevision, priorAttemptId: binding.priorAttemptId,
      priorAttemptTaskRevision: binding.priorAttemptTaskRevision, workerName: binding.workerName,
      workerInstanceId: binding.workerInstanceId, workerGeneration: binding.workerGeneration,
      targetHost: binding.targetHost, requestKind: "inspect",
      id: inspectionId, ownerRequestId: input.requestId, requestDigest,
      requestedByUserId: ownerId, authorizationAuditLogId: auditId, requestedAt: now } });
    return readRecoveryInTransaction(tx, ownerId, task.id, input.requestId, now);
  });
}

export async function requestAmuxV22LegacySafeStop(input: {
  session: Session; request: Request;
} & Extract<AmuxV22RecoveryAdminInput, { action: "request_safe_stop" }>) {
  const ownerId = await requireOwner(input.session);
  requireSafeStopEnabled();
  return withAutoTransaction(input.requestId, OWNER_TRANSACTION_LIMITS, async (tx, now) => {
    const existing = await tx.amuxV22TaskRecoveryInspectionRequest.findUnique({
      where: { ownerRequestId: input.requestId } });
    if (existing) {
      if (existing.requestedByUserId !== ownerId || existing.requestKind !== "safe_stop" ||
          existing.taskId !== input.taskId || existing.taskRevision !== input.expectedRevision ||
          existing.priorAttemptId !== input.priorAttemptId ||
          existing.sourceEvidenceId !== input.sourceEvidenceId ||
          existing.sourceEvidenceDigest !== input.sourceEvidenceDigest)
        throw new BoardImportError("request_id_reused", 409);
      return readRecoveryInTransaction(tx, ownerId, input.taskId, input.requestId, now);
    }

    // The global admission lock precedes profile runtime, Task and attempt locks.
    await lockAmuxAdmissionAndReadIncident(tx, now);
    const source = await tx.amuxV22TaskRecoveryEvidence.findUnique({
      where: { id: input.sourceEvidenceId }, include: { inspection: true } });
    if (!source || source.evidenceDigest !== input.sourceEvidenceDigest ||
        !await auditBound(tx, source.authorizationAuditLogId,
          evidenceAuditAction(source.requestKind), "AmuxV22TaskRecoveryEvidence", source.id))
      throw new BoardImportError("safe_stop_source_unavailable", 409);
    const sourceRequest = source.inspection;
    if (sourceRequest.taskId !== input.taskId ||
        sourceRequest.taskRevision !== input.expectedRevision ||
        sourceRequest.priorAttemptId !== input.priorAttemptId ||
        source.sourceEvidenceId !== sourceRequest.sourceEvidenceId ||
        source.sourceEvidenceDigest !== sourceRequest.sourceEvidenceDigest)
      throw new BoardImportError("safe_stop_source_mismatch", 409);
    const configured = configuredAmuxV22RecoveryProfile(sourceRequest.workerName);
    if (!configured) throw new BoardImportError("safe_stop_profile_unavailable", 409);
    const profile: SafeStopProfileBinding = { alias: configured.alias,
      workerNames: configured.workerNames, targetUnit: configured.targetUnit,
      profileConfigDigest: configured.profileConfigDigest,
      workerInstanceId: sourceRequest.workerInstanceId,
      workerGeneration: sourceRequest.workerGeneration };
    if (!await lockSafeStopProfileRuntime(tx, profile))
      throw new BoardImportError("safe_stop_profile_unavailable", 409);
    const task = await lockRecoveryTask(tx, input.taskId);
    if (!await lockPriorAttempt(tx, input.priorAttemptId))
      throw new BoardImportError("safe_stop_source_mismatch", 409);
    const attempt = requireBlockedIdentity(task, input.expectedRevision, input.priorAttemptId);
    if (task.taskRole !== "investigate")
      throw new BoardImportError("safe_stop_legacy_not_read_only", 409);
    if (sourceRequest.priorAttemptTaskRevision !== attempt.taskRevision ||
        sourceRequest.workerName !== attempt.worker ||
        sourceRequest.workerInstanceId !== attempt.workerInstanceId ||
        sourceRequest.workerGeneration !== attempt.workerGeneration ||
        sourceRequest.targetHost !== AMUX_V22_RECOVERY_HOST_SCOPE)
      throw new BoardImportError("safe_stop_source_mismatch", 409);
    if (source.requestKind === "inspect") {
      const report = amuxV22RecoveryEvidenceSchema.safeParse(source.report);
      if (!report.success || source.verified || source.reason !== "legacy_invocation_unbound" ||
          report.data.reason !== "legacy_invocation_unbound" ||
          report.data.proof.terminalOutcome === "succeeded")
        throw new BoardImportError("safe_stop_legacy_not_read_only", 409);
      if (!report.data.proof.externalEffectsKnown)
        throw new BoardImportError("safe_stop_external_effects_unknown", 409);
    } else if (source.requestKind === "safe_stop") {
      if (sourceRequest.workerProfileAlias !== profile.alias ||
          sourceRequest.targetUnit !== profile.targetUnit ||
          sourceRequest.profileConfigDigest !== profile.profileConfigDigest ||
          sourceRequest.profileWorkerNames.length !== profile.workerNames.length ||
          sourceRequest.profileWorkerNames.some((name, index) =>
            name !== profile.workerNames[index]))
        throw new BoardImportError("safe_stop_source_mismatch", 409);
    } else throw new BoardImportError("safe_stop_source_unavailable", 409);
    if (await safeStopOtherWorkPresent(tx, task.id, attempt.id, profile.workerNames))
      throw new BoardImportError("safe_stop_other_work_present", 409);

    const inspectionId = randomUUID();
    const binding = { inspectionId, requestKind: "safe_stop" as const,
      taskId: task.id, taskRevision: task.revision,
      priorAttemptId: attempt.id, priorAttemptTaskRevision: attempt.taskRevision,
      workerName: attempt.worker, workerInstanceId: attempt.workerInstanceId,
      workerGeneration: attempt.workerGeneration, targetHost: AMUX_V22_RECOVERY_HOST_SCOPE,
      sourceEvidenceId: source.id, sourceEvidenceDigest: source.evidenceDigest,
      workerProfileAlias: profile.alias, profileWorkerNames: profile.workerNames,
      targetUnit: profile.targetUnit, profileConfigDigest: profile.profileConfigDigest };
    const requestDigest = amuxV22RecoveryDigest("inspection", binding);
    const auditId = await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: "amux.v22.recovery.safe_stop_requested",
      targetType: "AmuxV22TaskRecoveryInspectionRequest", targetId: inspectionId,
      summary: "Requested one fixed-profile root-controller legacy safe-stop verification.",
      metadata: { ...binding, ownerRequestId: input.requestId, requestDigest,
        policyVersion: AMUX_V22_TASK_RECOVERY_POLICY_VERSION,
        executionStarted: false, workerFencePermanent: true } });
    await tx.amuxV22TaskRecoveryInspectionRequest.create({ data: {
      id: inspectionId, ownerRequestId: input.requestId, requestKind: "safe_stop",
      taskId: binding.taskId, taskRevision: binding.taskRevision,
      priorAttemptId: binding.priorAttemptId,
      priorAttemptTaskRevision: binding.priorAttemptTaskRevision,
      workerName: binding.workerName, workerInstanceId: binding.workerInstanceId,
      workerGeneration: binding.workerGeneration, targetHost: binding.targetHost,
      requestDigest, sourceEvidenceId: binding.sourceEvidenceId,
      sourceEvidenceDigest: binding.sourceEvidenceDigest,
      workerProfileAlias: binding.workerProfileAlias,
      profileWorkerNames: binding.profileWorkerNames, targetUnit: binding.targetUnit,
      profileConfigDigest: binding.profileConfigDigest,
      requestedByUserId: ownerId, authorizationAuditLogId: auditId, requestedAt: now } });
    return readRecoveryInTransaction(tx, ownerId, task.id, input.requestId, now);
  });
}

/** The fixed launcher receives original bindings, never a command or host path. */
export function pendingAmuxV22RecoveryInspections(workerName: string) {
  requireRecoveryEnabled();
  return withAutoTransaction(null, TICK_TRANSACTION_LIMITS, async (tx) => {
    const rows = await tx.amuxV22TaskRecoveryInspectionRequest.findMany({
      where: { requestKind: "inspect", workerName, evidence: null, approval: null },
      orderBy: { requestedAt: "asc" }, take: 1 });
    return { requests: rows.map((row) => ({ inspectionId: row.id, taskId: row.taskId,
      taskRevision: row.taskRevision, priorAttemptId: row.priorAttemptId,
      priorAttemptTaskRevision: row.priorAttemptTaskRevision,
      workerName: row.workerName, workerInstanceId: row.workerInstanceId,
      workerGeneration: row.workerGeneration, targetHost: row.targetHost,
      requestDigest: row.requestDigest, requestedAt: row.requestedAt.toISOString() })) };
  });
}

export function pendingAmuxV22LegacySafeStops() {
  requireSafeStopEnabled();
  return withAutoTransaction(null, TICK_TRANSACTION_LIMITS, async (tx) => {
    const rows = await tx.amuxV22TaskRecoveryInspectionRequest.findMany({
      where: { requestKind: "safe_stop", evidence: null, approval: null },
      orderBy: { requestedAt: "asc" }, take: 1 });
    return { requests: rows.map((row) => ({ inspectionId: row.id,
      requestKind: "safe_stop" as const, requestDigest: row.requestDigest,
      taskId: row.taskId, taskRevision: row.taskRevision,
      priorAttemptId: row.priorAttemptId,
      priorAttemptTaskRevision: row.priorAttemptTaskRevision,
      workerName: row.workerName, workerInstanceId: row.workerInstanceId,
      workerGeneration: row.workerGeneration, targetHost: row.targetHost,
      sourceEvidenceId: row.sourceEvidenceId!,
      sourceEvidenceDigest: row.sourceEvidenceDigest!,
      workerProfileAlias: row.workerProfileAlias!,
      profileWorkerNames: row.profileWorkerNames, targetUnit: row.targetUnit!,
      profileConfigDigest: row.profileConfigDigest!,
      requestedAt: row.requestedAt.toISOString() })) };
  });
}

export function reportAmuxV22RecoveryEvidence(input: AmuxV22RecoveryEvidenceInput) {
  requireRecoveryEnabled();
  return withAutoTransaction(input.evidenceId, TICK_TRANSACTION_LIMITS, async (tx, now) => {
    const inspection = await tx.amuxV22TaskRecoveryInspectionRequest.findUnique({
      where: { id: input.inspectionId } });
    if (!inspection || inspection.requestKind !== "inspect" ||
        inspection.taskId !== input.taskId || inspection.taskRevision !== input.taskRevision ||
        inspection.priorAttemptId !== input.priorAttemptId ||
        inspection.priorAttemptTaskRevision !== input.priorAttemptTaskRevision || inspection.workerName !== input.workerName ||
        inspection.workerInstanceId !== input.workerInstanceId || inspection.workerGeneration !== input.workerGeneration ||
        inspection.targetHost !== input.targetHost || inspection.requestDigest !== input.requestDigest ||
        !await auditBound(tx, inspection.authorizationAuditLogId, "amux.v22.recovery.requested",
          "AmuxV22TaskRecoveryInspectionRequest", inspection.id, inspection.requestedByUserId))
      throw new BoardImportError("inspection_binding_mismatch", 409);
    const evidenceDigest = amuxV22RecoveryDigest("evidence", input);
    const existing = await tx.amuxV22TaskRecoveryEvidence.findUnique({ where: { inspectionId: inspection.id } });
    if (existing) {
      if (existing.id !== input.evidenceId || existing.evidenceDigest !== evidenceDigest)
        throw new BoardImportError("evidence_already_recorded", 409);
      return { recorded: true, evidenceId: existing.id, verified: existing.verified,
        evidenceDigest, reason: existing.reason, retryWrite: false };
    }
    const task = await lockRecoveryTask(tx, inspection.taskId);
    let reason = amuxV22RecoveryProofReason(input, task.taskRole!);
    try { requireBlockedIdentity(task, inspection.taskRevision, inspection.priorAttemptId); }
    catch { reason = "recovery_identity_changed"; }
    if (!await currentRuntime(tx, inspection)) reason = "runtime_observation_unverified";
    const auditId = await recordAmuxV22RecoveryEvidenceAudit(tx, input.evidenceId, {
      taskId: task.id, inspectionId: inspection.id, priorAttemptId: inspection.priorAttemptId,
      evidenceDigest, verified: reason === null, reason,
      hostInvocationId: input.hostInvocationId, policyVersion: AMUX_V22_TASK_RECOVERY_POLICY_VERSION });
    await tx.amuxV22TaskRecoveryEvidence.create({ data: { id: input.evidenceId,
      inspectionId: inspection.id, requestKind: "inspect",
      hostInvocationId: input.hostInvocationId,
      report: input as Prisma.InputJsonValue, evidenceDigest, verified: reason === null,
      reason, authorizationAuditLogId: auditId, recordedAt: now } });
    return { recorded: true, evidenceId: input.evidenceId, verified: reason === null,
      evidenceDigest, reason, retryWrite: false };
  });
}

export function reportAmuxV22LegacySafeStopEvidence(input: AmuxV22SafeStopEvidenceInput) {
  requireSafeStopEnabled();
  return withAutoTransaction(input.evidenceId, TICK_TRANSACTION_LIMITS, async (tx, now) => {
    const inspection = await tx.amuxV22TaskRecoveryInspectionRequest.findUnique({
      where: { id: input.inspectionId } });
    if (!inspection || inspection.requestKind !== "safe_stop" ||
        inspection.taskId !== input.taskId || inspection.taskRevision !== input.taskRevision ||
        inspection.priorAttemptId !== input.priorAttemptId ||
        inspection.priorAttemptTaskRevision !== input.priorAttemptTaskRevision ||
        inspection.workerName !== input.workerName ||
        inspection.workerInstanceId !== input.workerInstanceId ||
        inspection.workerGeneration !== input.workerGeneration ||
        inspection.targetHost !== input.targetHost ||
        inspection.sourceEvidenceId !== input.sourceEvidenceId ||
        inspection.sourceEvidenceDigest !== input.sourceEvidenceDigest ||
        inspection.workerProfileAlias !== input.workerProfileAlias ||
        inspection.targetUnit !== input.targetUnit ||
        inspection.profileConfigDigest !== input.profileConfigDigest ||
        inspection.profileWorkerNames.length !== input.profileWorkerNames.length ||
        inspection.profileWorkerNames.some((name, index) =>
          name !== input.profileWorkerNames[index]) ||
        inspection.requestDigest !== input.requestDigest ||
        !await auditBound(tx, inspection.authorizationAuditLogId,
          "amux.v22.recovery.safe_stop_requested",
          "AmuxV22TaskRecoveryInspectionRequest", inspection.id,
          inspection.requestedByUserId))
      throw new BoardImportError("inspection_binding_mismatch", 409);
    const existing = await tx.amuxV22TaskRecoveryEvidence.findUnique({
      where: { inspectionId: inspection.id } });
    if (existing) {
      const stored = amuxV22SafeStopEvidenceSchema.safeParse(existing.report);
      const replayDigest = stored.success ? amuxV22RecoveryDigest("evidence",
        { ...input, reason: stored.data.reason }) : null;
      if (existing.id !== input.evidenceId || existing.evidenceDigest !== replayDigest)
        throw new BoardImportError("evidence_already_recorded", 409);
      return { recorded: true, evidenceId: existing.id, verified: existing.verified,
        evidenceDigest: existing.evidenceDigest, reason: existing.reason, retryWrite: false };
    }

    await lockAmuxAdmissionAndReadIncident(tx, now);
    const configured = configuredAmuxV22RecoveryProfile(inspection.workerName);
    const profile: SafeStopProfileBinding = {
      alias: inspection.workerProfileAlias!,
      workerNames: inspection.profileWorkerNames,
      targetUnit: inspection.targetUnit!,
      profileConfigDigest: inspection.profileConfigDigest!,
      workerInstanceId: inspection.workerInstanceId,
      workerGeneration: inspection.workerGeneration,
    };
    const profileMatches = !!configured && configured.alias === profile.alias &&
      configured.targetUnit === profile.targetUnit &&
      configured.profileConfigDigest === profile.profileConfigDigest &&
      configured.workerNames.length === profile.workerNames.length &&
      configured.workerNames.every((name, index) => name === profile.workerNames[index]);
    const runtimeMatches = await lockSafeStopProfileRuntime(tx, profile);
    const task = await lockRecoveryTask(tx, inspection.taskId);
    const priorLocked = await lockPriorAttempt(tx, inspection.priorAttemptId);
    let reason: string | null = amuxV22SafeStopProofReason(input);
    try { requireBlockedIdentity(task, inspection.taskRevision, inspection.priorAttemptId); }
    catch { reason = "safe_stop_identity_changed"; }
    if (!priorLocked || !runtimeMatches) reason = "safe_stop_identity_changed";
    if (!profileMatches || input.stopProof.journalBindingDigest !==
        amuxV22SafeStopJournalBinding({ taskId: inspection.taskId,
          priorAttemptId: inspection.priorAttemptId,
          workerProfileAlias: profile.alias, targetUnit: profile.targetUnit }))
      reason = "safe_stop_config_unverified";
    if (await safeStopOtherWorkPresent(tx, inspection.taskId,
        inspection.priorAttemptId, profile.workerNames))
      reason = "safe_stop_other_work_present";
    const storedInput: AmuxV22SafeStopEvidenceInput = { ...input,
      reason: (reason ?? "safe_stop_process_gone") as AmuxV22SafeStopEvidenceInput["reason"] };
    const evidenceDigest = amuxV22RecoveryDigest("evidence", storedInput);
    const auditId = await recordAmuxV22SafeStopEvidenceAudit(tx, input.evidenceId, {
      taskId: task.id, inspectionId: inspection.id,
      priorAttemptId: inspection.priorAttemptId, evidenceDigest,
      verified: reason === null, reason,
      stopJournalBindingDigest: input.stopProof.journalBindingDigest,
      stopJournalEntryDigest: input.stopProof.journalEntryDigest,
      stopAcknowledgement: input.stopProof.stopAcknowledgement,
      processState: input.stopProof.processState,
      policyVersion: AMUX_V22_TASK_RECOVERY_POLICY_VERSION,
    });
    await tx.amuxV22TaskRecoveryEvidence.create({ data: {
      id: input.evidenceId, inspectionId: inspection.id,
      requestKind: "safe_stop", sourceEvidenceId: input.sourceEvidenceId,
      sourceEvidenceDigest: input.sourceEvidenceDigest, hostInvocationId: null,
      stopJournalBindingDigest: input.stopProof.journalBindingDigest,
      stopJournalEntryDigest: input.stopProof.journalEntryDigest,
      stopAcknowledgement: input.stopProof.stopAcknowledgement,
      processState: input.stopProof.processState,
      report: storedInput as Prisma.InputJsonValue, evidenceDigest,
      verified: reason === null, reason, authorizationAuditLogId: auditId,
      recordedAt: now } });
    return { recorded: true, evidenceId: input.evidenceId,
      verified: reason === null, evidenceDigest, reason, retryWrite: false };
  });
}

async function readRecoveryInTransaction(tx: Prisma.TransactionClient, ownerId: string,
  taskId: string, requestId: string, now: Date): Promise<AmuxV22RecoveryRead> {
  const approval = await tx.amuxV22TaskRecoveryApproval.findUnique({ where: { ownerRequestId: requestId } });
  if (approval && (approval.taskId !== taskId || approval.approvedByUserId !== ownerId))
    throw new BoardImportError("recovery_receipt_mismatch", 409);
  const inspection = await tx.amuxV22TaskRecoveryInspectionRequest.findFirst({ where: {
    taskId, requestedByUserId: ownerId, ...(approval ? { id: approval.inspectionId } : { ownerRequestId: requestId }) },
    include: { evidence: true, approval: true } });
  const empty: AmuxV22RecoveryRead = { taskId, requestId, state: "not_visible", inspectionId: null,
    evidenceId: null, evidenceDigest: null, reason: null, taskRevision: null,
    priorAttemptId: null, cost: null, retryWrite: false };
  if (!inspection) return empty;
  if (!await auditBound(tx, inspection.authorizationAuditLogId,
      requestAuditAction(inspection.requestKind),
      "AmuxV22TaskRecoveryInspectionRequest", inspection.id, ownerId))
    throw new BoardImportError("audit_unbound", 503);
  const approved = inspection.approval;
  if (approval && (!approved || approved.id !== approval.id || approved.ownerRequestId !== requestId))
    throw new BoardImportError("recovery_receipt_mismatch", 409);
  if (approved && (approved.approvedByUserId !== ownerId || !await auditBound(tx,
      approved.authorizationAuditLogId, "amux.v22.recovery.approved", "AmuxV22TaskRecoveryApproval", approved.id, ownerId)))
    throw new BoardImportError("audit_unbound", 503);
  const evidence = inspection.evidence;
  if (approved && (approved.inspectionId !== inspection.id || approved.taskId !== inspection.taskId ||
      approved.priorAttemptId !== inspection.priorAttemptId ||
      approved.beforeRevision !== inspection.taskRevision || approved.afterRevision !== approved.beforeRevision + 1 ||
      approved.evidenceId !== evidence?.id || approved.evidenceDigest !== evidence?.evidenceDigest ||
      evidence?.inspectionId !== inspection.id))
    throw new BoardImportError("recovery_receipt_mismatch", 409);
  if (evidence && !await auditBound(tx, evidence.authorizationAuditLogId,
      evidenceAuditAction(evidence.requestKind),
      "AmuxV22TaskRecoveryEvidence", evidence.id))
    throw new BoardImportError("audit_unbound", 503);
  let cost = null;
  let reason = evidence?.reason ?? null;
  let state: AmuxV22RecoveryRead["state"] = evidence ? evidence.verified ? "verified" : "unverified" : "pending";
  let currentTask: AmuxV22RecoveryRead["currentTask"];
  if (approved) { state = "approved";
    const observed = await tx.amuxWorkItem.findUnique({ where: { id: taskId },
      select: { revision: true, status: true } });
    currentTask = observed ? { revision: observed.revision, status: observed.status } : null;
    cost = { oldHeldMicroUsd: approved.oldHeldMicroUsd.toString(), additionalCapMicroUsd: approved.additionalCapMicroUsd.toString(),
      worstExposureMicroUsd: approved.worstExposureMicroUsd.toString(), catalogApprovalId: approved.catalogApprovalId,
      catalogVersion: approved.catalogVersion, pricingVersion: approved.pricingVersion,
      costReceiptDigest: approved.costReceiptDigest, costDigest: approved.costDigest };
  } else {
    const task = await lockRecoveryTask(tx, taskId);
    try { requireBlockedIdentity(task, inspection.taskRevision, inspection.priorAttemptId);
      cost = (await currentCost(tx, task)).cost;
      if (evidence?.verified && !evidenceFresh(evidence.recordedAt, now)) {
        state = "unverified"; reason = "evidence_stale";
      } else if (evidence?.verified && !await currentRuntime(tx, inspection)) {
        state = "unverified"; reason = "runtime_observation_unverified";
      }
    } catch { state = "unverified"; reason = "recovery_identity_or_cost_changed"; }
  }
  return { ...empty, state, inspectionId: inspection.id, evidenceId: evidence?.id ?? null,
    evidenceDigest: evidence?.evidenceDigest ?? null, reason,
    taskRevision: approved?.afterRevision ?? inspection.taskRevision,
    priorAttemptId: inspection.priorAttemptId, cost,
    requestKind: inspection.requestKind as "inspect" | "safe_stop",
    sourceEvidenceId: inspection.sourceEvidenceId,
    sourceEvidenceDigest: inspection.sourceEvidenceDigest,
    stopAcknowledgement: evidence?.stopAcknowledgement as
      AmuxV22RecoveryRead["stopAcknowledgement"],
    processState: evidence?.processState as AmuxV22RecoveryRead["processState"],
    workerProfileAlias: inspection.workerProfileAlias,
    profileWorkerNames: inspection.profileWorkerNames,
    targetUnit: inspection.targetUnit,
    profileConfigDigest: inspection.profileConfigDigest,
    ...(approved ? { approvalId: approved.id, currentTask } : {}) };
}
export async function readAmuxV22TaskRecovery(session: Session, taskId: string, requestId: string) {
  const ownerId = await requireOwner(session);
  return withAutoTransaction(null, OWNER_TRANSACTION_LIMITS, (tx, now) =>
    readRecoveryInTransaction(tx, ownerId, taskId, requestId, now));
}

export async function approveAmuxV22TaskRecovery(input: { session: Session; request: Request } &
  Extract<AmuxV22RecoveryAdminInput, { action: "approve_attempt" }>) {
  const ownerId = await requireOwner(input.session);
  requireRecoveryEnabled();
  const readyContext = await loadAmuxV4TaskReadyContext(input.taskId);
  return withAutoTransaction(input.requestId, OWNER_TRANSACTION_LIMITS, async (tx, now) => {
    const existing = await tx.amuxV22TaskRecoveryApproval.findUnique({ where: { ownerRequestId: input.requestId } });
    if (existing) {
      if (existing.approvedByUserId !== ownerId || existing.taskId !== input.taskId ||
          existing.beforeRevision !== input.expectedRevision || existing.priorAttemptId !== input.priorAttemptId ||
          existing.inspectionId !== input.inspectionId || existing.evidenceId !== input.evidenceId ||
          existing.evidenceDigest !== input.evidenceDigest || existing.costDigest !== input.costDigest)
        throw new BoardImportError("request_id_reused", 409);
      return readRecoveryInTransaction(tx, ownerId, input.taskId, input.requestId, now);
    }
    const incident = await lockAmuxAdmissionAndReadIncident(tx, now);
    if (incident.blocks_admission) throw new BoardImportError("incident_blocked", 409);
    const inspection = await tx.amuxV22TaskRecoveryInspectionRequest.findUnique({ where: { id: input.inspectionId },
      include: { evidence: true, approval: true } });
    let safeProfileCurrent = true;
    if (inspection?.requestKind === "safe_stop") {
      requireSafeStopEnabled();
      const configured = configuredAmuxV22RecoveryProfile(inspection.workerName);
      const profile: SafeStopProfileBinding = { alias: inspection.workerProfileAlias!,
        workerNames: inspection.profileWorkerNames, targetUnit: inspection.targetUnit!,
        profileConfigDigest: inspection.profileConfigDigest!,
        workerInstanceId: inspection.workerInstanceId,
        workerGeneration: inspection.workerGeneration };
      safeProfileCurrent = !!configured && configured.alias === profile.alias &&
        configured.targetUnit === profile.targetUnit &&
        configured.profileConfigDigest === profile.profileConfigDigest &&
        configured.workerNames.length === profile.workerNames.length &&
        configured.workerNames.every((name, index) => name === profile.workerNames[index]) &&
        await lockSafeStopProfileRuntime(tx, profile);
    }
    const task = await lockRecoveryTask(tx, input.taskId);
    requireBlockedIdentity(task, input.expectedRevision, input.priorAttemptId);
    const evidence = inspection?.evidence;
    const inspectReport = amuxV22RecoveryEvidenceSchema.safeParse(evidence?.report);
    const safeReport = amuxV22SafeStopEvidenceSchema.safeParse(evidence?.report);
    const reportDigest = inspectReport.success ?
      amuxV22RecoveryDigest("evidence", inspectReport.data) : safeReport.success ?
        amuxV22RecoveryDigest("evidence", safeReport.data) : null;
    const proofRefused = inspection?.requestKind === "safe_stop" ?
      !safeReport.success || amuxV22SafeStopProofReason(safeReport.data) !== null ||
        safeReport.data.reason !== "safe_stop_process_gone" || !safeProfileCurrent :
      !inspectReport.success || !!amuxV22RecoveryProofReason(inspectReport.data, task.taskRole!);
    const fenced = inspection?.requestKind === "safe_stop" ?
      await amuxV22SafeStopFencedWorkers(tx, inspection.profileWorkerNames) : new Set<string>();
    const safeOtherWork = inspection?.requestKind === "safe_stop" ?
      await safeStopOtherWorkPresent(tx, inspection.taskId,
        inspection.priorAttemptId, inspection.profileWorkerNames) : false;
    if (!inspection || inspection.approval || inspection.requestedByUserId !== ownerId ||
        inspection.taskId !== task.id || inspection.taskRevision !== task.revision ||
        inspection.priorAttemptId !== input.priorAttemptId || !evidence?.verified ||
        evidence.id !== input.evidenceId || evidence.evidenceDigest !== input.evidenceDigest ||
        evidence.recordedAt < inspection.requestedAt || reportDigest !== evidence.evidenceDigest ||
        proofRefused || (inspection.requestKind === "inspect" && !await currentRuntime(tx, inspection)) ||
        (inspection.requestKind === "safe_stop" &&
          (fenced.size !== inspection.profileWorkerNames.length || safeOtherWork)) ||
        !evidenceFresh(evidence.recordedAt, now) ||
        !await auditBound(tx, inspection.authorizationAuditLogId,
          requestAuditAction(inspection.requestKind),
          "AmuxV22TaskRecoveryInspectionRequest", inspection.id, ownerId) ||
        !await auditBound(tx, evidence.authorizationAuditLogId,
          evidenceAuditAction(evidence.requestKind),
          "AmuxV22TaskRecoveryEvidence", evidence.id))
      throw new BoardImportError("recovery_evidence_unverified", 409);
    const ready = await evaluateAmuxV4TaskReadyInTransaction(tx, task.id, readyContext, null, "blocked");
    if (!ready.ready) throw new BoardImportError("task_not_ready", 409);
    const { current, budget, cost } = await currentCost(tx, task);
    if (cost.costDigest !== input.costDigest) throw new BoardImportError("recovery_cost_changed", 409);
    const policies = await lockAmuxResourcePolicies(tx, amuxResourceRefs(task));
    const admission = await evaluateLockedAmuxCostAdmission(tx, policies, BigInt(cost.additionalCapMicroUsd), now);
    if (!admission.allowed) throw new BoardImportError(admission.reason, 409);
    const approvalId = randomUUID();
    const auditId = await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: "amux.v22.recovery.approved", targetType: "AmuxV22TaskRecoveryApproval", targetId: approvalId,
      summary: "Approved exactly one additional capped Task attempt while preserving its prior unconfirmed cap.",
      metadata: { taskId: task.id, inspectionId: inspection.id, evidenceId: evidence.id,
        ownerRequestId: input.requestId, priorAttemptId: input.priorAttemptId,
        beforeRevision: task.revision, afterRevision: task.revision + 1,
        evidenceDigest: evidence.evidenceDigest, ...cost,
        policyVersion: AMUX_V22_TASK_RECOVERY_POLICY_VERSION, executionStarted: false, reservationCreated: false } });
    await tx.amuxV22TaskRecoveryApproval.create({ data: { id: approvalId, ownerRequestId: input.requestId,
      inspectionId: inspection.id, evidenceId: evidence.id, taskId: task.id,
      beforeRevision: task.revision, afterRevision: task.revision + 1, priorAttemptId: input.priorAttemptId,
      evidenceDigest: evidence.evidenceDigest, costDigest: cost.costDigest,
      catalogApprovalId: current.approvalId, catalogVersion: cost.catalogVersion,
      pricingVersion: cost.pricingVersion, costReceiptDigest: current.receipt.receiptDigest,
      costReceipt: current.receipt as unknown as Prisma.InputJsonValue,
      historicalAttempts: budget.historicalAttempts, nextAttemptNumber: budget.nextAttemptNumber,
      oldHeldMicroUsd: budget.reserved, additionalCapMicroUsd: BigInt(cost.additionalCapMicroUsd),
      worstExposureMicroUsd: BigInt(cost.worstExposureMicroUsd), approvedByUserId: ownerId,
      authorizationAuditLogId: auditId, approvedAt: now } });
    const changed = await tx.amuxWorkItem.updateMany({ where: { id: task.id, revision: task.revision,
      status: "blocked", owner: null, claimedAt: null, v22AssignmentId: null, archivedAt: null },
      data: { status: "todo", revision: { increment: 1 } } });
    if (changed.count !== 1) throw new BoardImportError("recovery_identity_changed", 409);
    return readRecoveryInTransaction(tx, ownerId, task.id, input.requestId, now);
  });
}

/** Only the approval at this exact Todo revision can exempt its own held prior attempt. */
export async function readAmuxV22RecoveryAuthority(tx: Prisma.TransactionClient,
  taskId: string, taskRevision: number, approvalId?: string | null) {
  const row = await tx.amuxV22TaskRecoveryApproval.findFirst({ where: {
    taskId, afterRevision: taskRevision, ...(approvalId ? { id: approvalId } : {}),
    ...(approvalId ? {} : { assignment: null }) }, include: { inspection: true, evidence: true } });
  if (!row) return null;
  if (!row.evidence.verified || row.evidenceDigest !== row.evidence.evidenceDigest ||
      !await auditBound(tx, row.authorizationAuditLogId, "amux.v22.recovery.approved",
        "AmuxV22TaskRecoveryApproval", row.id, row.approvedByUserId))
    throw new BoardImportError("recovery_approval_unbound", 409);
  return row;
}

export function recoveryAttemptBudget(input: {
  historicalAttempts: number;
  greatestAttemptNumber: number | null;
}) {
  return decideAmuxAttemptBudget({ historical_rows: input.historicalAttempts,
    greatest_attempt_number: input.greatestAttemptNumber });
}
