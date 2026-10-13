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
import { recordAmuxV22RecoveryEvidenceAudit } from "./v22TaskRecoverySystemAudit.ts";
import { AMUX_V22_RECOVERY_HOST_SCOPE, AMUX_V22_TASK_RECOVERY_POLICY_VERSION,
  AMUX_V22_TASK_RECOVERY_ENABLED_ENV, amuxV22TaskRecoveryEnabled,
  amuxV22RecoveryDigest, amuxV22RecoveryCost, amuxV22RecoveryProofReason,
  amuxV22RecoveryEvidenceSchema, type AmuxV22RecoveryAdminInput,
  type AmuxV22RecoveryEvidenceInput, type AmuxV22RecoveryRead } from "./v22TaskRecoveryCore.ts";

function requireRecoveryEnabled() {
  if (!amuxV22TaskRecoveryEnabled(process.env[AMUX_V22_TASK_RECOVERY_ENABLED_ENV]))
    throw new BoardImportError("recovery_disabled", 409);
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
      targetHost: binding.targetHost,
      id: inspectionId, ownerRequestId: input.requestId, requestDigest,
      requestedByUserId: ownerId, authorizationAuditLogId: auditId, requestedAt: now } });
    return readRecoveryInTransaction(tx, ownerId, task.id, input.requestId, now);
  });
}

/** The fixed launcher receives original bindings, never a command or host path. */
export function pendingAmuxV22RecoveryInspections(workerName: string) {
  requireRecoveryEnabled();
  return withAutoTransaction(null, TICK_TRANSACTION_LIMITS, async (tx) => {
    const rows = await tx.amuxV22TaskRecoveryInspectionRequest.findMany({
      where: { workerName, evidence: null, approval: null }, orderBy: { requestedAt: "asc" }, take: 1 });
    return { requests: rows.map((row) => ({ inspectionId: row.id, taskId: row.taskId,
      taskRevision: row.taskRevision, priorAttemptId: row.priorAttemptId,
      priorAttemptTaskRevision: row.priorAttemptTaskRevision,
      workerName: row.workerName, workerInstanceId: row.workerInstanceId,
      workerGeneration: row.workerGeneration, targetHost: row.targetHost,
      requestDigest: row.requestDigest, requestedAt: row.requestedAt.toISOString() })) };
  });
}

export function reportAmuxV22RecoveryEvidence(input: AmuxV22RecoveryEvidenceInput) {
  requireRecoveryEnabled();
  return withAutoTransaction(input.evidenceId, TICK_TRANSACTION_LIMITS, async (tx, now) => {
    const inspection = await tx.amuxV22TaskRecoveryInspectionRequest.findUnique({
      where: { id: input.inspectionId } });
    if (!inspection || inspection.taskId !== input.taskId || inspection.taskRevision !== input.taskRevision ||
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
      inspectionId: inspection.id, hostInvocationId: input.hostInvocationId,
      report: input as Prisma.InputJsonValue, evidenceDigest, verified: reason === null,
      reason, authorizationAuditLogId: auditId, recordedAt: now } });
    return { recorded: true, evidenceId: input.evidenceId, verified: reason === null,
      evidenceDigest, reason, retryWrite: false };
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
  if (!await auditBound(tx, inspection.authorizationAuditLogId, "amux.v22.recovery.requested",
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
      "amux.v22.recovery.inspected", "AmuxV22TaskRecoveryEvidence", evidence.id))
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
    const task = await lockRecoveryTask(tx, input.taskId);
    requireBlockedIdentity(task, input.expectedRevision, input.priorAttemptId);
    const inspection = await tx.amuxV22TaskRecoveryInspectionRequest.findUnique({ where: { id: input.inspectionId },
      include: { evidence: true, approval: true } });
    const evidence = inspection?.evidence;
    const report = amuxV22RecoveryEvidenceSchema.safeParse(evidence?.report);
    if (!inspection || inspection.approval || inspection.requestedByUserId !== ownerId ||
        inspection.taskId !== task.id || inspection.taskRevision !== task.revision ||
        inspection.priorAttemptId !== input.priorAttemptId || !evidence?.verified ||
        evidence.id !== input.evidenceId || evidence.evidenceDigest !== input.evidenceDigest ||
        evidence.recordedAt < inspection.requestedAt || !report.success ||
        amuxV22RecoveryDigest("evidence", report.data) !== evidence.evidenceDigest ||
        amuxV22RecoveryProofReason(report.data, task.taskRole!) ||
        !await currentRuntime(tx, inspection) || !evidenceFresh(evidence.recordedAt, now) ||
        !await auditBound(tx, inspection.authorizationAuditLogId, "amux.v22.recovery.requested",
          "AmuxV22TaskRecoveryInspectionRequest", inspection.id, ownerId) ||
        !await auditBound(tx, evidence.authorizationAuditLogId, "amux.v22.recovery.inspected",
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

export function recoveryAttemptBudget(input: { historicalAttempts: number; greatestAttemptNumber: number | null;
  approval: { historicalAttempts: number; nextAttemptNumber: number } | null }) {
  return decideAmuxAttemptBudget({ historical_rows: input.historicalAttempts,
    greatest_attempt_number: input.greatestAttemptNumber });
}
