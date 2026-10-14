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
import { findOpenAmuxOrchestratorHalt } from "./orchestratorHaltStore.ts";
import { calculateCurrentApprovedAmuxV4TaskCost } from "./v4TaskCostCatalogApprovalService.ts";
import { resolveV4TaskApiExecutionBasis } from "./v4TaskCostCatalogCore.ts";
import { evaluateAmuxV4TaskReadyInTransaction, loadAmuxV4TaskReadyContext } from "./v4TaskReadyService.ts";
import { lockAmuxResourcePolicies, evaluateLockedAmuxCostAdmission } from "./resourcePolicy.ts";
import { amuxResourceRefs } from "./resourcePolicyCore.ts";
import { AMUX_MAX_EXECUTION_ATTEMPTS, decideAmuxAttemptBudget } from "./executionBudgetCore.ts";
import { AMUX_WORKER_RUNTIME_LEASE_MS } from "./workerRuntime.ts";
import { recordAmuxV22RecoveryEvidenceAudit,
  recordAmuxV22SafeStopEvidenceAudit, recordAmuxV22ReadOnlyLaunchCheckAudit,
  recordAmuxV22ReadOnlyLaunchProofAudit } from "./v22TaskRecoverySystemAudit.ts";
import { AMUX_V22_RECOVERY_HOST_SCOPE, AMUX_V22_TASK_RECOVERY_POLICY_VERSION,
  AMUX_V22_TASK_RECOVERY_ENABLED_ENV, AMUX_V22_LEGACY_SAFE_STOP_ENABLED_ENV,
  AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID, AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
  AMUX_V22_UNKNOWN_PRIOR_HELD_MICROUSD, AMUX_V22_READ_ONLY_RETRY_CAP_MICROUSD,
  AMUX_V22_READ_ONLY_RETRY_EXPOSURE_MICROUSD,
  AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED_ENV,
  amuxV22TaskRecoveryEnabled, amuxV22LegacySafeStopEnabled,
  amuxV22ReadOnlyApiExecutorEnabled, configuredAmuxV22ReadOnlyApiMetadata,
  configuredAmuxV22RecoveryProfile, amuxV22SafeStopJournalBinding,
  amuxV22RecoveryDigest, amuxV22RecoveryCost, amuxV22RecoveryProofReason,
  amuxV22ReadOnlyRetryRouteCost, amuxV22ReadOnlyLaunchScope,
  amuxV22ReadOnlyLaunchScopeDigest, amuxV22ReadOnlyLaunchProofScope,
  amuxV22ReadOnlyLaunchScopeMatchesIntent, amuxV22ReadOnlyLaunchExecutorKind,
  amuxV22RecoveryEvidenceSchema, amuxV22SafeStopEvidenceSchema,
  amuxV22ReadOnlyLaunchScopeSchema, amuxV22ReadOnlyLaunchCheckSchema,
  amuxV22SafeStopProofReason, type AmuxV22RecoveryAdminInput,
  type AmuxV22RecoveryEvidenceInput, type AmuxV22SafeStopEvidenceInput,
  type AmuxV22ReadOnlyLaunchProofInput,
  type AmuxV22RecoveryRead } from "./v22TaskRecoveryCore.ts";
import { amuxV22SafeStopFencedWorkers } from "./v22LegacySafeStopFence.ts";
import { getConfiguredAmuxV22WorkerCatalog } from "./routing.ts";
import { amuxV22OneShotRouteSupported, amuxV22RequiredTool,
  chooseAmuxV22WorkerRoute } from "./v22WorkerClaimCore.ts";
import { AMUX_V22_READ_ONLY_API_CAPABILITY,
  AMUX_V22_READ_ONLY_API_EXECUTOR_KIND,
  AMUX_V22_READ_ONLY_API_MAX_PROVIDER_TURNS,
  AMUX_V22_READ_ONLY_API_MAX_RETRIES,
  amuxV22ReadOnlyApiExecutionFrameDigest,
  amuxV22ReadOnlyApiNominalLaunchScope,
  parseAmuxV22ReadOnlyApiExecutionFrame,
  type AmuxV22ReadOnlyApiExecutionFrame } from "./v22ReadOnlyApiProtocol.mjs";

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
      v4BriefDigest: true,
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
function readOnlyRetryExecutorKind(protocolCapabilities: string[]) {
  if (protocolCapabilities.length !== 1) return null;
  if (protocolCapabilities[0] === "read_only_retry_v1") return "read_only_retry_v1" as const;
  if (protocolCapabilities[0] === AMUX_V22_READ_ONLY_API_CAPABILITY &&
      amuxV22ReadOnlyApiExecutorEnabled(
        process.env[AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED_ENV]) &&
      configuredAmuxV22ReadOnlyApiMetadata()) return AMUX_V22_READ_ONLY_API_EXECUTOR_KIND;
  return null;
}
async function currentRuntime(tx: Prisma.TransactionClient, inspection: {
  workerName: string; workerInstanceId: string; workerGeneration: number },
  requiredReadOnlyExecutor?: "read_only_retry_v1" | "read_only_api_retry_v1") {
  const rows = await tx.$queryRaw<Array<{
    instanceId: string; generation: number; protocolCapabilities: string[];
  }>>`SELECT "instanceId", "generation", "protocolCapabilities" FROM "AmuxWorkerRuntime"
    WHERE "workerName" = ${inspection.workerName} FOR SHARE`;
  const runtime = rows[0];
  return runtime && runtime.instanceId === inspection.workerInstanceId &&
    runtime.generation === inspection.workerGeneration &&
    (!requiredReadOnlyExecutor ||
      readOnlyRetryExecutorKind(runtime.protocolCapabilities) === requiredReadOnlyExecutor) ?
    runtime : null;
}

function apiExecutionBinding(input: {
  approved: Awaited<ReturnType<typeof calculateCurrentApprovedAmuxV4TaskCost>>;
  role: string; grade: string; routeId: string; routePolicyDigest: string;
  provider: string; modelId: string; maximumCostMicroUsd: bigint;
  workerName: string; profileConfigDigest: string; now: Date;
}): { frame: AmuxV22ReadOnlyApiExecutionFrame;
  launchScope: ReturnType<typeof amuxV22ReadOnlyApiNominalLaunchScope> } | null {
  if (input.provider !== "anthropic" || input.maximumCostMicroUsd <= BigInt(0) ||
      input.maximumCostMicroUsd > AMUX_V22_READ_ONLY_RETRY_CAP_MICROUSD) return null;
  const metadata = configuredAmuxV22ReadOnlyApiMetadata();
  if (!metadata) return null;
  const resolved = resolveV4TaskApiExecutionBasis({ rawCatalog: input.approved.catalog,
    role: input.role, grade: input.grade, routeId: input.routeId,
    asOfIso: input.now.toISOString() });
  if (!resolved.ok || resolved.basis.catalogVersion !==
      input.approved.receipt.catalogVersion || resolved.basis.catalogDigest !==
      input.approved.catalogDigest || resolved.basis.pricingVersion !==
      input.approved.receipt.pricingVersion) return null;
  try {
    const frame = parseAmuxV22ReadOnlyApiExecutionFrame({
      version: 1, executorKind: AMUX_V22_READ_ONLY_API_EXECUTOR_KIND,
      provider: "anthropic", modelId: input.modelId, routeId: input.routeId,
      routePolicyDigest: input.routePolicyDigest,
      catalogApprovalId: input.approved.approvalId,
      catalogVersion: resolved.basis.catalogVersion,
      catalogDigest: resolved.basis.catalogDigest,
      pricingVersion: resolved.basis.pricingVersion,
      pricingSource: resolved.basis.pricingSource,
      pricingVerifiedAt: resolved.basis.pricingVerifiedAt,
      pricingExpiresAt: resolved.basis.pricingExpiresAt,
      uncachedInputMicroUsdPerMillion: resolved.basis.uncachedInputMicroUsdPerMillion,
      cacheReadMicroUsdPerMillion: resolved.basis.cacheReadMicroUsdPerMillion,
      cacheWriteMicroUsdPerMillion: resolved.basis.cacheWriteMicroUsdPerMillion,
      outputMicroUsdPerMillion: resolved.basis.outputMicroUsdPerMillion,
      tokenLimits: resolved.basis.tokenLimits,
      maxProviderTurns: AMUX_V22_READ_ONLY_API_MAX_PROVIDER_TURNS,
      maxOutputTokensPerTurn: resolved.basis.tokenLimits.outputTokens,
      maxRetries: AMUX_V22_READ_ONLY_API_MAX_RETRIES,
      maximumCostMicroUsd: Number(input.maximumCostMicroUsd), ...metadata,
    }, { now: input.now });
    const nominalLauncherConfigDigest = amuxV22RecoveryDigest(
      "read-only-api-nominal-launcher-config", {
        version: 1, workerName: input.workerName,
        profileConfigDigest: input.profileConfigDigest,
        apiExecutionFrameDigest: amuxV22ReadOnlyApiExecutionFrameDigest(frame),
      });
    return { frame, launchScope: amuxV22ReadOnlyApiNominalLaunchScope(
      frame, nominalLauncherConfigDigest) };
  } catch { return null; }
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
/** Policy v45: a legacy safe stop binds the profile's current runtime, not the
 * prior attempt's. A restart since that attempt already ended its control
 * group; the stop proves the live one gone and fences the profile. Every
 * profile row must share one live instance and generation. */
async function lockCurrentSafeStopProfileRuntime(tx: Prisma.TransactionClient,
  workerNames: string[]): Promise<{ instanceId: string; generation: number } | null> {
  const rows = await tx.$queryRaw<Array<{
    workerName: string; instanceId: string; generation: number;
  }>>`SELECT "workerName", "instanceId", "generation" FROM "AmuxWorkerRuntime"
    WHERE "workerName" = ANY(${workerNames}::text[])
    ORDER BY "workerName" FOR UPDATE`;
  const first = rows[0];
  return first && rows.length === workerNames.length && rows.every((row, index) =>
    row.workerName === workerNames[index] && row.instanceId === first.instanceId &&
    row.generation === first.generation) ?
    { instanceId: first.instanceId, generation: first.generation } : null;
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
async function createAmuxV22ReadOnlyLaunchCheck(tx: Prisma.TransactionClient, now: Date,
  task: Awaited<ReturnType<typeof lockRecoveryTask>>, sourceEvidence: {
    id: string; evidenceDigest: string }, stoppedProfileWorkerNames: string[],
  risk: { id: string; acceptanceDigest: string; launchBindingId: string;
    briefDigest: string; oldHeldMicroUsd: bigint; additionalCapMicroUsd: bigint;
    worstExposureMicroUsd: bigint }) {
  const existing = await tx.amuxV22ReadOnlyLaunchCheck.findUnique({
    where: { sourceEvidenceId: sourceEvidence.id } });
  if (existing) return existing;
  if (task.id !== AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID ||
      task.executionAttempts[0]?.id !== AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID ||
      task.taskRole !== "investigate" || task.v4BriefDigest !== risk.briefDigest ||
      risk.oldHeldMicroUsd !== AMUX_V22_UNKNOWN_PRIOR_HELD_MICROUSD ||
      risk.additionalCapMicroUsd !== AMUX_V22_READ_ONLY_RETRY_CAP_MICROUSD ||
      risk.worstExposureMicroUsd !== AMUX_V22_READ_ONLY_RETRY_EXPOSURE_MICROUSD)
    throw new BoardImportError("read_only_launch_binding_changed", 409);
  const catalog = getConfiguredAmuxV22WorkerCatalog();
  if (!catalog) return null;
  const approved = await calculateCurrentApprovedAmuxV4TaskCost(tx,
    task.taskRole, task.executionGrade!);
  const workerNames = catalog.map((worker) => worker.worker_name);
  const fenced = await amuxV22SafeStopFencedWorkers(tx, workerNames);
  const live = await tx.amuxWorkerRuntime.findMany({ where: {
    workerName: { in: workerNames }, leaseExpiresAt: { gt: now },
    status: "idle", dispatchReady: true }, select: { workerName: true,
    instanceId: true, generation: true, protocolCapabilities: true } });
  const liveByName = new Map(live.map((runtime) => [runtime.workerName, runtime]));
  const occupied = new Set((await tx.amuxWorkItem.findMany({ where: {
    owner: { not: null }, archivedAt: null, status: { in: ["todo", "doing", "review"] } },
    select: { owner: true } })).map((row) => row.owner));
  const requiredTool = amuxV22RequiredTool("investigate");
  const routes = approved.receipt.routes.filter((route) => {
    const worker = catalog.find((candidate) => candidate.worker_name === route.workerName);
    const runtime = liveByName.get(route.workerName);
    const executorKind = runtime ? readOnlyRetryExecutorKind(
      runtime.protocolCapabilities) : null;
    return !!worker && !!runtime &&
      !!executorKind &&
      !stoppedProfileWorkerNames.includes(route.workerName) && !fenced.has(route.workerName) &&
      !occupied.has(route.workerName) && !worker.archived && !worker.paused &&
      !worker.isolated && !worker.blocked && worker.provider === route.provider.toLowerCase() &&
      worker.model === route.modelId && worker.routing_roles.includes("investigate") &&
      !!requiredTool && worker.tool_capabilities.includes(requiredTool) &&
      (executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ?
        route.provider === "anthropic" && route.modelId.startsWith("claude-") :
        amuxV22OneShotRouteSupported(route.provider, route.modelId)) &&
      BigInt(route.perAttemptMicroUsd) > BigInt(0) &&
      BigInt(route.perAttemptMicroUsd) <= AMUX_V22_READ_ONLY_RETRY_CAP_MICROUSD;
  });
  const route = chooseAmuxV22WorkerRoute({ routes, priorAuthorWorkers: [],
    priorAuthorProviders: [], isReview: false });
  if (!route) return null;
  const runtime = liveByName.get(route.workerName);
  const profile = configuredAmuxV22RecoveryProfile(route.workerName);
  const executorKind = runtime ? readOnlyRetryExecutorKind(
    runtime.protocolCapabilities) : null;
  if (!runtime || !profile || !executorKind ||
      profile.workerNames.some((name) => fenced.has(name)))
    return null;
  const cost = amuxV22ReadOnlyRetryRouteCost({
    priorReservedMicroUsd: risk.oldHeldMicroUsd, catalogApprovalId: approved.approvalId,
    receipt: approved.receipt, routeId: route.routeId, workerName: route.workerName,
    provider: route.provider, modelId: route.modelId });
  const apiBinding = executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ?
    apiExecutionBinding({ approved, role: task.taskRole, grade: task.executionGrade!,
      routeId: route.routeId, routePolicyDigest: route.routePolicyDigest,
      provider: route.provider, modelId: route.modelId,
      maximumCostMicroUsd: BigInt(cost.additionalCapMicroUsd),
      workerName: route.workerName, profileConfigDigest: profile.profileConfigDigest,
      now }) : null;
  if (executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND && !apiBinding) return null;
  const launchScope = apiBinding?.launchScope ?? amuxV22ReadOnlyLaunchScope({
    profileConfigDigest: profile.profileConfigDigest });
  const launchScopeDigest = amuxV22ReadOnlyLaunchScopeDigest(launchScope);
  const launchCheckId = randomUUID();
  const binding = { requestKind: "read_only_launch_check" as const, launchCheckId,
    taskId: task.id, taskRevision: task.revision,
    priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
    workerName: route.workerName, workerInstanceId: runtime.instanceId,
    workerGeneration: runtime.generation, targetHost: AMUX_V22_RECOVERY_HOST_SCOPE,
    sourceEvidenceId: sourceEvidence.id, sourceEvidenceDigest: sourceEvidence.evidenceDigest,
    riskAcceptanceId: risk.id, riskAcceptanceDigest: risk.acceptanceDigest,
    launchBindingId: risk.launchBindingId, briefDigest: risk.briefDigest,
    provider: route.provider, modelId: route.modelId, routeId: route.routeId,
    routePolicyDigest: route.routePolicyDigest,
    catalogApprovalId: approved.approvalId, catalogVersion: approved.receipt.catalogVersion,
    pricingVersion: approved.receipt.pricingVersion,
    costReceiptDigest: approved.receipt.receiptDigest,
    additionalCapMicroUsd: cost.additionalCapMicroUsd,
    worstExposureMicroUsd: cost.worstExposureMicroUsd, launchScope,
    ...(apiBinding ? { apiExecutionFrame: apiBinding.frame } : {}) };
  const requestDigest = amuxV22RecoveryDigest("read-only-launch-check", binding);
  const auditId = await recordAmuxV22ReadOnlyLaunchCheckAudit(tx, launchCheckId, {
    taskId: task.id, priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
    sourceEvidenceId: sourceEvidence.id, riskAcceptanceId: risk.id,
    riskAcceptanceDigest: risk.acceptanceDigest, launchBindingId: risk.launchBindingId,
    requestDigest, launchScopeDigest, workerName: route.workerName,
    provider: route.provider, modelId: route.modelId, routeId: route.routeId,
    routePolicyDigest: route.routePolicyDigest,
    catalogApprovalId: approved.approvalId,
    catalogVersion: approved.receipt.catalogVersion,
    pricingVersion: approved.receipt.pricingVersion,
    costReceiptDigest: approved.receipt.receiptDigest, costDigest: cost.costDigest,
    additionalCapMicroUsd: cost.additionalCapMicroUsd,
    worstExposureMicroUsd: cost.worstExposureMicroUsd,
    policyVersion: AMUX_V22_TASK_RECOVERY_POLICY_VERSION,
    executionStarted: false, reservationCreated: false });
  return tx.amuxV22ReadOnlyLaunchCheck.create({ data: {
    id: launchCheckId, requestDigest, riskAcceptanceId: risk.id,
    riskAcceptanceDigest: risk.acceptanceDigest, sourceEvidenceId: sourceEvidence.id,
    sourceEvidenceDigest: sourceEvidence.evidenceDigest, taskId: task.id,
    taskRevision: task.revision, priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
    workerName: route.workerName, workerInstanceId: runtime.instanceId,
    workerGeneration: runtime.generation, targetHost: AMUX_V22_RECOVERY_HOST_SCOPE,
    launchBindingId: risk.launchBindingId, briefDigest: risk.briefDigest,
    provider: route.provider, modelId: route.modelId, routeId: route.routeId,
    routePolicyDigest: route.routePolicyDigest, catalogApprovalId: approved.approvalId,
    catalogVersion: approved.receipt.catalogVersion,
    pricingVersion: approved.receipt.pricingVersion,
    costReceiptDigest: approved.receipt.receiptDigest, costDigest: cost.costDigest,
    additionalCapMicroUsd: BigInt(cost.additionalCapMicroUsd),
    worstExposureMicroUsd: BigInt(cost.worstExposureMicroUsd),
    launchScope: launchScope as unknown as Prisma.InputJsonValue, launchScopeDigest,
    authorizationAuditLogId: auditId, requestedAt: now } });
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

export async function acceptAmuxV22UnknownPriorEffects(input: {
  session: Session; request: Request;
} & Extract<AmuxV22RecoveryAdminInput, { action: "accept_unknown_prior_effects" }>) {
  const ownerId = await requireOwner(input.session);
  requireRecoveryEnabled();
  if (input.taskId !== AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID ||
      input.priorAttemptId !== AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID)
    throw new BoardImportError("risk_acceptance_exact_target_only", 409);
  return withAutoTransaction(input.requestId, OWNER_TRANSACTION_LIMITS, async (tx, now) => {
    const existing = await tx.amuxV22TaskRecoveryRiskAcceptance.findUnique({
      where: { ownerRequestId: input.requestId } });
    if (existing) {
      if (existing.acceptedByUserId !== ownerId || existing.taskId !== input.taskId ||
          existing.taskRevision !== input.expectedRevision ||
          existing.priorAttemptId !== input.priorAttemptId ||
          existing.sourceEvidenceId !== input.sourceEvidenceId ||
          existing.sourceEvidenceDigest !== input.sourceEvidenceDigest)
        throw new BoardImportError("request_id_reused", 409);
      return readRecoveryInTransaction(tx, ownerId, input.taskId, input.requestId, now);
    }
    await lockAmuxAdmissionAndReadIncident(tx, now);
    const task = await lockRecoveryTask(tx, input.taskId);
    const attempt = requireBlockedIdentity(task, input.expectedRevision, input.priorAttemptId);
    if (task.taskRole !== "investigate" || !task.v4BriefDigest ||
        attempt.taskRevision !== task.revision)
      throw new BoardImportError("risk_acceptance_identity_changed", 409);
    const budget = await priorBudget(tx, task.id);
    if (budget.historicalAttempts !== 1 || budget.nextAttemptNumber !== 2 ||
        attempt.reservedCostMicrousd !== AMUX_V22_UNKNOWN_PRIOR_HELD_MICROUSD ||
        budget.reserved !== AMUX_V22_UNKNOWN_PRIOR_HELD_MICROUSD)
      throw new BoardImportError("risk_acceptance_cost_mismatch", 409);
    const source = await tx.amuxV22TaskRecoveryEvidence.findUnique({
      where: { id: input.sourceEvidenceId }, include: { inspection: true } });
    const report = amuxV22RecoveryEvidenceSchema.safeParse(source?.report);
    if (!source || source.requestKind !== "inspect" || source.verified ||
        source.reason !== "legacy_invocation_unbound" ||
        source.evidenceDigest !== input.sourceEvidenceDigest || !report.success ||
        report.data.reason !== "legacy_invocation_unbound" ||
        report.data.proof.externalEffectsKnown ||
        report.data.proof.terminalOutcome === "succeeded" ||
        source.inspection.taskId !== task.id ||
        source.inspection.taskRevision !== task.revision ||
        source.inspection.priorAttemptId !== attempt.id ||
        !await auditBound(tx, source.authorizationAuditLogId,
          "amux.v22.recovery.inspected", "AmuxV22TaskRecoveryEvidence", source.id))
      throw new BoardImportError("risk_acceptance_source_mismatch", 409);
    const acceptanceId = randomUUID();
    const launchBindingId = randomUUID();
    const binding = { acceptanceId, ownerRequestId: input.requestId,
      taskId: task.id, taskRevision: task.revision,
      priorAttemptId: attempt.id, priorAttemptTaskRevision: attempt.taskRevision,
      sourceEvidenceId: source.id, sourceEvidenceDigest: source.evidenceDigest,
      briefDigest: task.v4BriefDigest, launchBindingId,
      oldHeldMicroUsd: AMUX_V22_UNKNOWN_PRIOR_HELD_MICROUSD.toString(),
      additionalCapMicroUsd: AMUX_V22_READ_ONLY_RETRY_CAP_MICROUSD.toString(),
      worstExposureMicroUsd: AMUX_V22_READ_ONLY_RETRY_EXPOSURE_MICROUSD.toString() };
    const acceptanceDigest = amuxV22RecoveryDigest("unknown-prior-risk-acceptance", binding);
    const auditId = await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: "amux.v22.recovery.unknown_prior_risk_accepted",
      targetType: "AmuxV22TaskRecoveryRiskAcceptance", targetId: acceptanceId,
      summary: "Accepted one exact historical UNKNOWN risk before a read-only retry preflight.",
      metadata: { ...binding, acceptanceDigest,
        policyVersion: AMUX_V22_TASK_RECOVERY_POLICY_VERSION,
        priorEffects: "unknown", executionStarted: false, reservationCreated: false } });
    await tx.amuxV22TaskRecoveryRiskAcceptance.create({ data: {
      id: acceptanceId, ownerRequestId: input.requestId, taskId: task.id,
      taskRevision: task.revision, priorAttemptId: attempt.id,
      priorAttemptTaskRevision: attempt.taskRevision, sourceEvidenceId: source.id,
      sourceEvidenceDigest: source.evidenceDigest, briefDigest: task.v4BriefDigest,
      launchBindingId, oldHeldMicroUsd: AMUX_V22_UNKNOWN_PRIOR_HELD_MICROUSD,
      additionalCapMicroUsd: AMUX_V22_READ_ONLY_RETRY_CAP_MICROUSD,
      worstExposureMicroUsd: AMUX_V22_READ_ONLY_RETRY_EXPOSURE_MICROUSD,
      acceptanceDigest, acceptedByUserId: ownerId,
      authorizationAuditLogId: auditId, acceptedAt: now } });
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
    const liveRuntime = await lockCurrentSafeStopProfileRuntime(tx, configured.workerNames);
    if (!liveRuntime) throw new BoardImportError("safe_stop_profile_unavailable", 409);
    const profile: SafeStopProfileBinding = { alias: configured.alias,
      workerNames: configured.workerNames, targetUnit: configured.targetUnit,
      profileConfigDigest: configured.profileConfigDigest,
      workerInstanceId: liveRuntime.instanceId,
      workerGeneration: liveRuntime.generation };
    const task = await lockRecoveryTask(tx, input.taskId);
    if (!await lockPriorAttempt(tx, input.priorAttemptId))
      throw new BoardImportError("safe_stop_source_mismatch", 409);
    const attempt = requireBlockedIdentity(task, input.expectedRevision, input.priorAttemptId);
    if (task.taskRole !== "investigate")
      throw new BoardImportError("safe_stop_legacy_not_read_only", 409);
    // The source request stays bound to the prior attempt's runtime. A safe
    // stop recorded against a newer live runtime therefore cannot seed another
    // request; policy v45 does not open chained re-requests.
    if (sourceRequest.priorAttemptTaskRevision !== attempt.taskRevision ||
        sourceRequest.workerName !== attempt.worker ||
        sourceRequest.workerInstanceId !== attempt.workerInstanceId ||
        sourceRequest.workerGeneration !== attempt.workerGeneration ||
        sourceRequest.targetHost !== AMUX_V22_RECOVERY_HOST_SCOPE)
      throw new BoardImportError("safe_stop_source_mismatch", 409);
    let riskAcceptance: Awaited<ReturnType<typeof tx.amuxV22TaskRecoveryRiskAcceptance.findFirst>> = null;
    if (source.requestKind === "inspect") {
      const report = amuxV22RecoveryEvidenceSchema.safeParse(source.report);
      if (!report.success || source.verified || source.reason !== "legacy_invocation_unbound" ||
          report.data.reason !== "legacy_invocation_unbound" ||
          report.data.proof.terminalOutcome === "succeeded")
        throw new BoardImportError("safe_stop_legacy_not_read_only", 409);
      if (!report.data.proof.externalEffectsKnown) {
        riskAcceptance = await tx.amuxV22TaskRecoveryRiskAcceptance.findFirst({ where: {
          taskId: task.id, priorAttemptId: attempt.id,
          sourceEvidenceId: source.id, sourceEvidenceDigest: source.evidenceDigest } });
        if (!riskAcceptance || task.id !== AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID ||
            attempt.id !== AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID ||
            riskAcceptance.taskRevision !== task.revision ||
            riskAcceptance.priorAttemptTaskRevision !== attempt.taskRevision ||
            riskAcceptance.briefDigest !== task.v4BriefDigest ||
            riskAcceptance.oldHeldMicroUsd !== AMUX_V22_UNKNOWN_PRIOR_HELD_MICROUSD ||
            riskAcceptance.additionalCapMicroUsd !== AMUX_V22_READ_ONLY_RETRY_CAP_MICROUSD ||
            riskAcceptance.worstExposureMicroUsd !== AMUX_V22_READ_ONLY_RETRY_EXPOSURE_MICROUSD ||
            !await auditBound(tx, riskAcceptance.authorizationAuditLogId,
              "amux.v22.recovery.unknown_prior_risk_accepted",
              "AmuxV22TaskRecoveryRiskAcceptance", riskAcceptance.id,
              riskAcceptance.acceptedByUserId))
          throw new BoardImportError("safe_stop_external_effects_unknown", 409);
      }
    } else if (source.requestKind === "safe_stop") {
      if (sourceRequest.workerProfileAlias !== profile.alias ||
          sourceRequest.targetUnit !== profile.targetUnit ||
          sourceRequest.profileConfigDigest !== profile.profileConfigDigest ||
          sourceRequest.profileWorkerNames.length !== profile.workerNames.length ||
          sourceRequest.profileWorkerNames.some((name, index) =>
            name !== profile.workerNames[index]))
        throw new BoardImportError("safe_stop_source_mismatch", 409);
      if (sourceRequest.riskAcceptanceId) {
        riskAcceptance = await tx.amuxV22TaskRecoveryRiskAcceptance.findUnique({
          where: { id: sourceRequest.riskAcceptanceId } });
        if (!riskAcceptance || sourceRequest.riskAcceptanceDigest !==
            riskAcceptance.acceptanceDigest || riskAcceptance.taskId !== task.id ||
            riskAcceptance.priorAttemptId !== attempt.id)
          throw new BoardImportError("safe_stop_source_mismatch", 409);
      }
    } else throw new BoardImportError("safe_stop_source_unavailable", 409);
    if (await safeStopOtherWorkPresent(tx, task.id, attempt.id, profile.workerNames))
      throw new BoardImportError("safe_stop_other_work_present", 409);

    const inspectionId = randomUUID();
    const binding = { inspectionId, requestKind: "safe_stop" as const,
      taskId: task.id, taskRevision: task.revision,
      priorAttemptId: attempt.id, priorAttemptTaskRevision: attempt.taskRevision,
      workerName: attempt.worker, workerInstanceId: profile.workerInstanceId,
      workerGeneration: profile.workerGeneration, targetHost: AMUX_V22_RECOVERY_HOST_SCOPE,
      sourceEvidenceId: source.id, sourceEvidenceDigest: source.evidenceDigest,
      workerProfileAlias: profile.alias, profileWorkerNames: profile.workerNames,
      targetUnit: profile.targetUnit, profileConfigDigest: profile.profileConfigDigest,
      riskAcceptanceId: riskAcceptance?.id ?? null,
      riskAcceptanceDigest: riskAcceptance?.acceptanceDigest ?? null };
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
      riskAcceptanceId: binding.riskAcceptanceId,
      riskAcceptanceDigest: binding.riskAcceptanceDigest,
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
  return withAutoTransaction(null, TICK_TRANSACTION_LIMITS, async (tx, now) => {
    const rows = await tx.amuxV22TaskRecoveryInspectionRequest.findMany({
      where: { requestKind: "safe_stop", evidence: null, approval: null },
      orderBy: { requestedAt: "asc" }, take: 1 });
    if (rows.length) return { requests: rows.map((row) => ({ inspectionId: row.id,
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
    const checks = await tx.amuxV22ReadOnlyLaunchCheck.findMany({
      where: { NOT: { id: { in: (await tx.amuxV22ReadOnlyLaunchProof.findMany({
        select: { launchCheckId: true } })).map((proof) => proof.launchCheckId) } } },
      include: { task: { select: { taskRole: true, executionGrade: true } } },
      orderBy: { requestedAt: "asc" }, take: 1 });
    const requests = [];
    for (const row of checks) {
      const launchScope = amuxV22ReadOnlyLaunchScopeSchema.parse(row.launchScope);
      let apiExecutionFrame: AmuxV22ReadOnlyApiExecutionFrame | undefined;
      if (amuxV22ReadOnlyLaunchExecutorKind(launchScope) ===
          AMUX_V22_READ_ONLY_API_EXECUTOR_KIND) {
        if (!row.task.taskRole || !row.task.executionGrade) continue;
        const approved = await calculateCurrentApprovedAmuxV4TaskCost(tx,
          row.task.taskRole, row.task.executionGrade);
        const profile = configuredAmuxV22RecoveryProfile(row.workerName);
        const binding = profile ? apiExecutionBinding({ approved,
          role: row.task.taskRole, grade: row.task.executionGrade,
          routeId: row.routeId, routePolicyDigest: row.routePolicyDigest,
          provider: row.provider, modelId: row.modelId,
          maximumCostMicroUsd: row.additionalCapMicroUsd,
          workerName: row.workerName, profileConfigDigest: profile.profileConfigDigest,
          now }) : null;
        if (!binding || amuxV22ReadOnlyLaunchScopeDigest(binding.launchScope) !==
            row.launchScopeDigest) continue;
        apiExecutionFrame = binding.frame;
      }
      requests.push({ requestKind: "read_only_launch_check" as const,
        launchCheckId: row.id, requestDigest: row.requestDigest,
        taskId: row.taskId, taskRevision: row.taskRevision,
        priorAttemptId: row.priorAttemptId, workerName: row.workerName,
        workerInstanceId: row.workerInstanceId, workerGeneration: row.workerGeneration,
        targetHost: row.targetHost, sourceEvidenceId: row.sourceEvidenceId,
        sourceEvidenceDigest: row.sourceEvidenceDigest,
        riskAcceptanceId: row.riskAcceptanceId,
        riskAcceptanceDigest: row.riskAcceptanceDigest,
        launchBindingId: row.launchBindingId, briefDigest: row.briefDigest,
        provider: row.provider, modelId: row.modelId, routeId: row.routeId,
        routePolicyDigest: row.routePolicyDigest,
        catalogApprovalId: row.catalogApprovalId, catalogVersion: row.catalogVersion,
        pricingVersion: row.pricingVersion, costReceiptDigest: row.costReceiptDigest,
        additionalCapMicroUsd: row.additionalCapMicroUsd.toString(),
        worstExposureMicroUsd: row.worstExposureMicroUsd.toString(), launchScope,
        ...(apiExecutionFrame ? { apiExecutionFrame } : {}) });
    }
    return { requests };
  });
}

export function reportAmuxV22ReadOnlyLaunchProof(input: AmuxV22ReadOnlyLaunchProofInput) {
  requireSafeStopEnabled();
  return withAutoTransaction(input.launchProofId, TICK_TRANSACTION_LIMITS, async (tx, now) => {
    const check = await tx.amuxV22ReadOnlyLaunchCheck.findUnique({
      where: { id: input.launchCheckId },
      include: { task: { select: { taskRole: true, executionGrade: true } } } });
    if (!check) throw new BoardImportError("read_only_launch_check_unavailable", 409);
    const launchScope = amuxV22ReadOnlyLaunchScopeSchema.safeParse(check.launchScope);
    const executorKind = launchScope.success ?
      amuxV22ReadOnlyLaunchExecutorKind(launchScope.data) : null;
    let expectedApiBinding: ReturnType<typeof apiExecutionBinding> = null;
    if (executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND &&
        check.task.taskRole && check.task.executionGrade) {
      const approved = await calculateCurrentApprovedAmuxV4TaskCost(tx,
        check.task.taskRole, check.task.executionGrade);
      const profile = configuredAmuxV22RecoveryProfile(check.workerName);
      if (profile) expectedApiBinding = apiExecutionBinding({ approved,
        role: check.task.taskRole, grade: check.task.executionGrade,
        routeId: check.routeId, routePolicyDigest: check.routePolicyDigest,
        provider: check.provider, modelId: check.modelId,
        maximumCostMicroUsd: check.additionalCapMicroUsd,
        workerName: check.workerName, profileConfigDigest: profile.profileConfigDigest,
        now });
    }
    const expected = launchScope.success ? amuxV22ReadOnlyLaunchCheckSchema.safeParse({
      requestKind: "read_only_launch_check", launchCheckId: check.id,
      requestDigest: check.requestDigest, taskId: check.taskId,
      taskRevision: check.taskRevision, priorAttemptId: check.priorAttemptId,
      workerName: check.workerName, workerInstanceId: check.workerInstanceId,
      workerGeneration: check.workerGeneration, targetHost: check.targetHost,
      sourceEvidenceId: check.sourceEvidenceId, sourceEvidenceDigest: check.sourceEvidenceDigest,
      riskAcceptanceId: check.riskAcceptanceId,
      riskAcceptanceDigest: check.riskAcceptanceDigest,
      launchBindingId: check.launchBindingId, briefDigest: check.briefDigest,
      provider: check.provider, modelId: check.modelId, routeId: check.routeId,
      routePolicyDigest: check.routePolicyDigest,
      catalogApprovalId: check.catalogApprovalId, catalogVersion: check.catalogVersion,
      pricingVersion: check.pricingVersion, costReceiptDigest: check.costReceiptDigest,
      additionalCapMicroUsd: check.additionalCapMicroUsd.toString(),
      worstExposureMicroUsd: check.worstExposureMicroUsd.toString(),
      launchScope: launchScope.data,
      ...(expectedApiBinding ? { apiExecutionFrame: expectedApiBinding.frame } : {}) }) : null;
    const inputBase = { ...input };
    delete (inputBase as Partial<AmuxV22ReadOnlyLaunchProofInput>).launchProofId;
    delete (inputBase as Partial<AmuxV22ReadOnlyLaunchProofInput>).observation;
    const reportedScope = input.launchScope;
    const normalizedInput = launchScope.success ? { ...inputBase,
      launchScope: { ...reportedScope,
        launcherConfigDigest: launchScope.data.launcherConfigDigest } } : inputBase;
    const reportedScopeDigest = amuxV22ReadOnlyLaunchScopeDigest(reportedScope);
    if (!expected?.success || JSON.stringify(normalizedInput) !== JSON.stringify(expected.data) ||
        !await auditBound(tx, check.authorizationAuditLogId,
          "amux.v22.recovery.read_only_launch_requested",
          "AmuxV22ReadOnlyLaunchCheck", check.id))
      throw new BoardImportError("read_only_launch_binding_mismatch", 409);
    const launchProofDigest = amuxV22RecoveryDigest("read-only-launch-proof", input);
    const existing = await tx.amuxV22ReadOnlyLaunchProof.findUnique({
      where: { launchCheckId: check.id } });
    if (existing) {
      if (existing.id !== input.launchProofId || existing.proofDigest !== launchProofDigest ||
          existing.observation !== input.observation)
        throw new BoardImportError("read_only_launch_proof_already_recorded", 409);
      return { recorded: true as const, launchProofId: existing.id,
        launchProofDigest: existing.proofDigest,
        observation: existing.observation as AmuxV22ReadOnlyLaunchProofInput["observation"],
        retryWrite: false as const };
    }
    const risk = await tx.amuxV22TaskRecoveryRiskAcceptance.findUnique({
      where: { id: check.riskAcceptanceId } });
    const source = await tx.amuxV22TaskRecoveryEvidence.findUnique({
      where: { id: check.sourceEvidenceId }, include: { inspection: true } });
    const runtime = executorKind ? await currentRuntime(tx, check, executorKind) : null;
    const profile = configuredAmuxV22RecoveryProfile(check.workerName);
    const scopeCurrent = launchScope.success && profile &&
      (executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ?
        "executorKind" in launchScope.data && !!expectedApiBinding &&
          amuxV22ReadOnlyLaunchScopeMatchesIntent(
          expectedApiBinding.launchScope, launchScope.data) &&
          input.apiExecutionFrame !== undefined &&
          amuxV22ReadOnlyApiExecutionFrameDigest(input.apiExecutionFrame) ===
            launchScope.data.apiExecutionFrameDigest :
        !("executorKind" in reportedScope) &&
          profile.profileConfigDigest === reportedScope.profileConfigDigest) &&
      amuxV22ReadOnlyLaunchScopeDigest(launchScope.data) === check.launchScopeDigest;
    const verified = input.observation === "current" && !!risk && !!source?.verified &&
      source.reason === null && source.requestKind === "safe_stop" &&
      source.evidenceDigest === check.sourceEvidenceDigest &&
      source.inspection.riskAcceptanceId === risk.id &&
      source.inspection.riskAcceptanceDigest === risk.acceptanceDigest &&
      risk.acceptanceDigest === check.riskAcceptanceDigest && !!runtime && !!scopeCurrent;
    const reason = verified ? null : input.observation === "current" ?
      "read_only_launch_binding_changed" : `read_only_launch_${input.observation}`;
    const auditId = await recordAmuxV22ReadOnlyLaunchProofAudit(tx, input.launchProofId, {
      taskId: check.taskId, priorAttemptId: check.priorAttemptId,
      launchCheckId: check.id, launchBindingId: check.launchBindingId,
      riskAcceptanceId: check.riskAcceptanceId, sourceEvidenceId: check.sourceEvidenceId,
      launchProofDigest, launchScopeDigest: reportedScopeDigest,
      launcherConfigDigest: reportedScope.launcherConfigDigest,
      observation: input.observation, verified, reason,
      policyVersion: AMUX_V22_TASK_RECOVERY_POLICY_VERSION, executionStarted: false });
    await tx.amuxV22ReadOnlyLaunchProof.create({ data: {
      id: input.launchProofId, launchCheckId: check.id, proofDigest: launchProofDigest,
      observation: input.observation, report: input as unknown as Prisma.InputJsonValue,
      verified, reason, authorizationAuditLogId: auditId, recordedAt: now } });
    return { recorded: true as const, launchProofId: input.launchProofId,
      launchProofDigest, observation: input.observation, retryWrite: false as const };
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
    // A runtime change only matters to a proof that would otherwise verify. A
    // legacy report already proves nothing about the prior invocation, and a
    // restart since that attempt must not hide that reason (policy v45).
    if (reason === null && !await currentRuntime(tx, inspection))
      reason = "runtime_observation_unverified";
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
    if (reason === null && inspection.riskAcceptanceId) {
      const risk = await tx.amuxV22TaskRecoveryRiskAcceptance.findUnique({
        where: { id: inspection.riskAcceptanceId } });
      if (!risk || inspection.riskAcceptanceDigest !== risk.acceptanceDigest ||
          risk.taskId !== task.id || risk.priorAttemptId !== inspection.priorAttemptId ||
          !await auditBound(tx, risk.authorizationAuditLogId,
            "amux.v22.recovery.unknown_prior_risk_accepted",
            "AmuxV22TaskRecoveryRiskAcceptance", risk.id, risk.acceptedByUserId))
        throw new BoardImportError("risk_acceptance_binding_mismatch", 409);
      await createAmuxV22ReadOnlyLaunchCheck(tx, now, task,
        { id: input.evidenceId, evidenceDigest }, inspection.profileWorkerNames, risk);
    }
    return { recorded: true, evidenceId: input.evidenceId,
      verified: reason === null, evidenceDigest, reason, retryWrite: false };
  });
}

async function readRecoveryInTransaction(tx: Prisma.TransactionClient, ownerId: string,
  taskId: string, requestId: string, now: Date): Promise<AmuxV22RecoveryRead> {
  const approval = await tx.amuxV22TaskRecoveryApproval.findUnique({ where: { ownerRequestId: requestId } });
  if (approval && (approval.taskId !== taskId || approval.approvedByUserId !== ownerId))
    throw new BoardImportError("recovery_receipt_mismatch", 409);
  const requestedRisk = await tx.amuxV22TaskRecoveryRiskAcceptance.findUnique({
    where: { ownerRequestId: requestId } });
  if (requestedRisk && (requestedRisk.taskId !== taskId ||
      requestedRisk.acceptedByUserId !== ownerId))
    throw new BoardImportError("recovery_receipt_mismatch", 409);
  let resumableRisk: typeof requestedRisk = null;
  if (!requestedRisk && !approval && taskId === AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID) {
    const candidate = await tx.amuxV22TaskRecoveryRiskAcceptance.findFirst({ where: {
      taskId, priorAttemptId: AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID,
      acceptedByUserId: ownerId }, orderBy: [{ acceptedAt: "desc" }, { id: "desc" }] });
    if (candidate) {
      const currentTask = await tx.amuxWorkItem.findUnique({ where: { id: taskId },
        select: { revision: true, status: true, owner: true, claimedAt: true,
          v22AssignmentId: true, v4BriefDigest: true } });
      const consumed = await tx.amuxV22TaskRecoveryApproval.findFirst({ where: {
        riskAcceptanceId: candidate.id } });
      const source = await tx.amuxV22TaskRecoveryEvidence.findUnique({
        where: { id: candidate.sourceEvidenceId }, include: { inspection: true } });
      const sourceReport = amuxV22RecoveryEvidenceSchema.safeParse(source?.report);
      if (currentTask?.revision === candidate.taskRevision && currentTask.status === "blocked" &&
          currentTask.owner === null && currentTask.claimedAt === null &&
          currentTask.v22AssignmentId === null && currentTask.v4BriefDigest === candidate.briefDigest &&
          !consumed && source && source.evidenceDigest === candidate.sourceEvidenceDigest &&
          source.requestKind === "inspect" && !source.verified &&
          source.reason === "legacy_invocation_unbound" && sourceReport.success &&
          sourceReport.data.reason === "legacy_invocation_unbound" &&
          !sourceReport.data.proof.externalEffectsKnown &&
          sourceReport.data.proof.terminalOutcome !== "succeeded" &&
          source.inspection.taskId === candidate.taskId &&
          source.inspection.taskRevision === candidate.taskRevision &&
          source.inspection.priorAttemptId === candidate.priorAttemptId &&
          source.inspection.requestedByUserId === ownerId &&
          await auditBound(tx, source.inspection.authorizationAuditLogId,
            "amux.v22.recovery.requested", "AmuxV22TaskRecoveryInspectionRequest",
            source.inspection.id, ownerId) &&
          await auditBound(tx, source.authorizationAuditLogId,
            "amux.v22.recovery.inspected", "AmuxV22TaskRecoveryEvidence", source.id))
        resumableRisk = candidate;
    }
  }
  const visibleRisk = requestedRisk ?? resumableRisk;
  let inspection = await tx.amuxV22TaskRecoveryInspectionRequest.findFirst({ where: {
    taskId, requestedByUserId: ownerId, ...(approval ? { id: approval.inspectionId } : { ownerRequestId: requestId }) },
    include: { evidence: true, approval: true } });
  if (!inspection && visibleRisk) inspection = await tx.amuxV22TaskRecoveryInspectionRequest.findFirst({
    where: { taskId, requestedByUserId: ownerId, requestKind: "safe_stop",
      riskAcceptanceId: visibleRisk.id,
      riskAcceptanceDigest: visibleRisk.acceptanceDigest,
      sourceEvidenceId: visibleRisk.sourceEvidenceId,
      sourceEvidenceDigest: visibleRisk.sourceEvidenceDigest },
    include: { evidence: true, approval: true },
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }] });
  const linkedRiskId = visibleRisk?.id ?? inspection?.riskAcceptanceId ??
    approval?.riskAcceptanceId ?? null;
  const risk = linkedRiskId ? await tx.amuxV22TaskRecoveryRiskAcceptance.findUnique({
    where: { id: linkedRiskId } }) : null;
  if (risk && (risk.taskId !== taskId || risk.acceptedByUserId !== ownerId ||
      !await auditBound(tx, risk.authorizationAuditLogId,
        "amux.v22.recovery.unknown_prior_risk_accepted",
        "AmuxV22TaskRecoveryRiskAcceptance", risk.id, ownerId)))
    throw new BoardImportError("recovery_receipt_mismatch", 409);
  const launchCheck = risk ? await tx.amuxV22ReadOnlyLaunchCheck.findFirst({
    where: { riskAcceptanceId: risk.id },
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }] }) : null;
  const launchProof = launchCheck ? await tx.amuxV22ReadOnlyLaunchProof.findUnique({
    where: { launchCheckId: launchCheck.id } }) : null;
  const launchProofScope = launchProof ?
    amuxV22ReadOnlyLaunchProofScope(launchProof.report) : null;
  const apiExecutor = launchProofScope ?
    amuxV22ReadOnlyLaunchExecutorKind(launchProofScope.launchScope) ===
      AMUX_V22_READ_ONLY_API_EXECUTOR_KIND : false;
  const apiAccessEvidence = apiExecutor && launchProof ?
    await tx.amuxV22ApiModelAccessEvidence.findUnique({ where: {
      launchProofId: launchProof.id } }) : null;
  const apiAccessFresh = !!apiAccessEvidence &&
    evidenceFresh(apiAccessEvidence.recordedAt, now);
  const apiAccessBindingMatches = !!apiAccessEvidence && !!launchCheck &&
    !!launchProofScope && apiAccessEvidence.launchProofId === launchProof?.id &&
    apiAccessEvidence.taskId === launchCheck.taskId &&
    apiAccessEvidence.priorAttemptId === launchCheck.priorAttemptId &&
    apiAccessEvidence.workerName === launchCheck.workerName &&
    apiAccessEvidence.provider === launchCheck.provider &&
    apiAccessEvidence.selectedModelId === launchCheck.modelId &&
    apiAccessEvidence.apiExecutionFrameDigest ===
      ("apiExecutionFrameDigest" in launchProofScope.launchScope ?
        launchProofScope.launchScope.apiExecutionFrameDigest : null) &&
    apiAccessEvidence.credentialMetadataDigest ===
      launchProofScope.report.apiExecutionFrame?.credentialMetadataDigest &&
    apiAccessEvidence.launcherConfigDigest ===
      launchProofScope.launchScope.launcherConfigDigest &&
    !apiAccessEvidence.balanceKnown;
  const apiAccessCurrent = apiAccessBindingMatches && apiAccessFresh &&
    apiAccessEvidence?.accessState === "verified" &&
    apiAccessEvidence.canonicalModelId === launchCheck?.modelId;
  const apiModelAccess: AmuxV22RecoveryRead["apiModelAccess"] = !apiExecutor ||
    !launchCheck ? undefined : {
      state: !apiAccessEvidence ? "required" :
        !apiAccessBindingMatches ? "unknown" : !apiAccessFresh ? "stale" :
          apiAccessEvidence.accessState === "verified" ?
            apiAccessEvidence.canonicalModelId === launchCheck.modelId ?
              "verified" : "catalog_mismatch" :
            apiAccessEvidence.accessState === "unavailable" ? "unavailable" : "unknown",
      selectedModelId: launchCheck.modelId,
      canonicalModelId: apiAccessEvidence?.canonicalModelId ?? null,
      balanceKnown: false, maximumCostMicroUsd: "3400000",
      worstExposureMicroUsd: "6800000",
      recordedAt: apiAccessEvidence?.recordedAt.toISOString() ?? null,
    };
  const riskRead = risk ? { id: risk.id, digest: risk.acceptanceDigest,
    ownerRequestId: risk.ownerRequestId, sourceEvidenceId: risk.sourceEvidenceId,
    sourceEvidenceDigest: risk.sourceEvidenceDigest,
    acceptedAt: risk.acceptedAt.toISOString(), oldHeldMicroUsd: risk.oldHeldMicroUsd.toString(),
    additionalCapMicroUsd: risk.additionalCapMicroUsd.toString(),
    worstExposureMicroUsd: risk.worstExposureMicroUsd.toString(),
    executionStarted: false as const, reservationCreated: false as const } : null;
  let launchCurrent = !!launchCheck && !!launchProof && !!launchProofScope && launchProof.verified &&
    evidenceFresh(launchProof.recordedAt, now);
  let launchBindingChanged = false;
  let launchRead = launchCheck && launchProof ? { id: launchProof.id,
    digest: launchProof.proofDigest, launchBindingId: launchCheck.launchBindingId,
    state: (launchProof.verified ? launchCurrent ? "current" : "stale" : "mismatch") as
      "current" | "stale" | "mismatch", workerName: launchCheck.workerName,
    provider: launchCheck.provider, modelId: launchCheck.modelId,
    routeId: launchCheck.routeId, role: "investigate" as const,
    briefDigest: launchCheck.briefDigest, pricingVersion: launchCheck.pricingVersion,
    costReceiptDigest: launchCheck.costReceiptDigest, launchScopeVersion: 1 as const } : null;
  const empty: AmuxV22RecoveryRead = { taskId, requestId, state: "not_visible", inspectionId: null,
    evidenceId: null, evidenceDigest: null, reason: null, taskRevision: null,
    priorAttemptId: null, cost: null, quote: null, riskAcceptance: riskRead,
    launchProof: launchRead, ...(apiModelAccess ? { apiModelAccess } : {}),
    eligibility: { acceptUnknownPriorEffects: taskId === AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID && !risk,
      requestSafeStop: false, approveAttempt: false,
      reason: taskId === AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID ?
        risk ? "safe_stop_required" : "risk_acceptance_required" : "exact_target_only" },
    guards: { priorEffects: "unknown", oldCost: "held", readOnlyLaunch: "required",
      taskAttemptLimit: 2 }, retryWrite: false };
  if (!inspection && !risk) return empty;
  if (!inspection && risk) {
    let quote = null;
    try { quote = (await currentCost(tx, await lockRecoveryTask(tx, taskId))).cost; }
    catch { /* Identity changes are rendered as ineligible, never inferred. */ }
    return { ...empty, state: "pending", reason: "safe_stop_required",
      taskRevision: risk.taskRevision, priorAttemptId: risk.priorAttemptId,
      cost: quote, quote, eligibility: { acceptUnknownPriorEffects: false,
        requestSafeStop: true, approveAttempt: false, reason: "safe_stop_required" } };
  }
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
      cost = launchCheck ? { oldHeldMicroUsd: risk!.oldHeldMicroUsd.toString(),
        additionalCapMicroUsd: launchCheck.additionalCapMicroUsd.toString(),
        worstExposureMicroUsd: launchCheck.worstExposureMicroUsd.toString(),
        catalogApprovalId: launchCheck.catalogApprovalId,
        catalogVersion: launchCheck.catalogVersion,
        pricingVersion: launchCheck.pricingVersion,
        costReceiptDigest: launchCheck.costReceiptDigest,
        costDigest: launchCheck.costDigest } : (await currentCost(tx, task)).cost;
      if (risk && launchCheck && launchProof) {
        const current = await calculateCurrentApprovedAmuxV4TaskCost(tx,
          task.taskRole!, task.executionGrade!);
        const currentRouteCost = amuxV22ReadOnlyRetryRouteCost({
          priorReservedMicroUsd: risk.oldHeldMicroUsd,
          catalogApprovalId: current.approvalId, receipt: current.receipt,
          routeId: launchCheck.routeId, workerName: launchCheck.workerName,
          provider: launchCheck.provider, modelId: launchCheck.modelId });
        const catalogWorker = getConfiguredAmuxV22WorkerCatalog()?.find((entry) =>
          entry.worker_name === launchCheck.workerName);
        const profile = configuredAmuxV22RecoveryProfile(launchCheck.workerName);
        const nominalScope = amuxV22ReadOnlyLaunchScopeSchema.safeParse(launchCheck.launchScope);
        const scope = launchProofScope?.launchScope;
        const executorKind = scope ? amuxV22ReadOnlyLaunchExecutorKind(scope) : null;
        const currentApiBinding = executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND &&
          profile ? apiExecutionBinding({ approved: current, role: task.taskRole!,
            grade: task.executionGrade!, routeId: launchCheck.routeId,
            routePolicyDigest: launchCheck.routePolicyDigest,
            provider: launchCheck.provider, modelId: launchCheck.modelId,
            maximumCostMicroUsd: launchCheck.additionalCapMicroUsd,
            workerName: launchCheck.workerName,
            profileConfigDigest: profile.profileConfigDigest, now }) : null;
        const fenced = await amuxV22SafeStopFencedWorkers(tx, [launchCheck.workerName]);
        launchBindingChanged = current.approvalId !== launchCheck.catalogApprovalId ||
          current.receipt.catalogVersion !== launchCheck.catalogVersion ||
          current.receipt.pricingVersion !== launchCheck.pricingVersion ||
          current.receipt.receiptDigest !== launchCheck.costReceiptDigest ||
          currentRouteCost.costDigest !== launchCheck.costDigest ||
          currentRouteCost.additionalCapMicroUsd !== launchCheck.additionalCapMicroUsd.toString() ||
          currentRouteCost.worstExposureMicroUsd !== launchCheck.worstExposureMicroUsd.toString() ||
          !catalogWorker || catalogWorker.archived || catalogWorker.paused ||
          catalogWorker.isolated || catalogWorker.blocked ||
          catalogWorker.provider !== launchCheck.provider.toLowerCase() ||
          catalogWorker.model !== launchCheck.modelId ||
          !catalogWorker.routing_roles.includes("investigate") ||
          !catalogWorker.tool_capabilities.includes("repo_read") ||
          !profile || !nominalScope.success || !scope || !executorKind ||
          (executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ?
            !currentApiBinding || !amuxV22ReadOnlyLaunchScopeMatchesIntent(
              currentApiBinding.launchScope, nominalScope.data) :
            "executorKind" in scope ||
              profile.profileConfigDigest !== scope.profileConfigDigest) ||
          !amuxV22ReadOnlyLaunchScopeMatchesIntent(nominalScope.data, scope) ||
          amuxV22ReadOnlyLaunchScopeDigest(nominalScope.data) !== launchCheck.launchScopeDigest ||
          !await currentRuntime(tx, launchCheck, executorKind) || fenced.size > 0;
        if (launchBindingChanged) {
          launchCurrent = false;
          cost = null;
        }
      }
      if (evidence?.verified && !evidenceFresh(evidence.recordedAt, now)) {
        state = "unverified"; reason = "evidence_stale";
      } else if (evidence?.verified && !await currentRuntime(tx, inspection)) {
        state = "unverified"; reason = "runtime_observation_unverified";
      }
    } catch {
      state = "unverified"; reason = "recovery_identity_or_cost_changed";
      if (risk && launchCheck) { launchBindingChanged = true; launchCurrent = false; cost = null; }
    }
  }
  if (launchRead && !launchCurrent) launchRead = { ...launchRead,
    state: launchBindingChanged ? "mismatch" : "stale" };
  const exception = !!risk;
  const approveEligible = !approved && !!evidence?.verified &&
    (!exception || (launchCurrent && (!apiExecutor || apiAccessCurrent)));
  // The unknown-risk intent is offered on exactly the source the write path
  // accepts: an unverified legacy inspect report for the approved FIRST Task.
  // The write rechecks identity, cost, audit binding and uniqueness itself.
  const riskIntentEligible = !approved && !exception &&
    taskId === AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID &&
    inspection.requestKind === "inspect" && !!evidence && !evidence.verified &&
    evidence.reason === "legacy_invocation_unbound" && reason === "legacy_invocation_unbound";
  const eligibilityReason: AmuxV22RecoveryRead["eligibility"]["reason"] = approved ?
    "already_approved" : riskIntentEligible ? "risk_acceptance_required" :
    !exception ? null : !evidence?.verified ? "safe_stop_required" :
      !launchProof ? "launch_proof_required" : !launchProof.verified || launchBindingChanged ?
        "binding_changed" : !launchCurrent ? "launch_proof_stale" :
          !apiExecutor ? null : !apiAccessEvidence ? "api_model_access_required" :
            !apiAccessBindingMatches ? "api_model_access_unverified" :
              !apiAccessFresh ? "api_model_access_stale" :
                apiAccessEvidence.accessState !== "verified" ?
                  "api_model_access_unverified" :
                  apiAccessEvidence.canonicalModelId !== launchCheck?.modelId ?
                    "canonical_catalog_approval_required" : null;
  return { ...empty, state, inspectionId: inspection.id, evidenceId: evidence?.id ?? null,
    evidenceDigest: evidence?.evidenceDigest ?? null, reason,
    taskRevision: approved?.afterRevision ?? inspection.taskRevision,
    priorAttemptId: inspection.priorAttemptId, cost, quote: cost,
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
    eligibility: { acceptUnknownPriorEffects: riskIntentEligible,
      requestSafeStop: exception && (!evidence?.verified || !launchCurrent),
      approveAttempt: approveEligible, reason: eligibilityReason },
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
          existing.evidenceDigest !== input.evidenceDigest || existing.costDigest !== input.costDigest ||
          existing.riskAcceptanceId !== (input.riskAcceptanceId ?? null) ||
          existing.riskAcceptanceDigest !== (input.riskAcceptanceDigest ?? null) ||
          existing.launchProofId !== (input.launchProofId ?? null) ||
          existing.launchProofDigest !== (input.launchProofDigest ?? null))
        throw new BoardImportError("request_id_reused", 409);
      return readRecoveryInTransaction(tx, ownerId, input.taskId, input.requestId, now);
    }
    const incident = await lockAmuxAdmissionAndReadIncident(tx, now);
    if (incident.blocks_admission) throw new BoardImportError("incident_blocked", 409);
    if (await findOpenAmuxOrchestratorHalt(tx))
      throw new BoardImportError("orchestrator_halted", 409);
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
    const isRiskException = !!inspection.riskAcceptanceId;
    if (isRiskException !== !!input.riskAcceptanceId ||
        (!isRiskException && (input.riskAcceptanceDigest || input.launchProofId ||
          input.launchProofDigest || input.acceptRetry)))
      throw new BoardImportError("risk_acceptance_binding_mismatch", 409);
    let risk: Awaited<ReturnType<typeof tx.amuxV22TaskRecoveryRiskAcceptance.findUnique>> = null;
    let launchCheck: Awaited<ReturnType<typeof tx.amuxV22ReadOnlyLaunchCheck.findUnique>> = null;
    let launchProof: Awaited<ReturnType<typeof tx.amuxV22ReadOnlyLaunchProof.findUnique>> = null;
    let apiModelAccessEvidence: Awaited<ReturnType<
      typeof tx.amuxV22ApiModelAccessEvidence.findUnique>> = null;
    let launchScope: ReturnType<typeof amuxV22ReadOnlyLaunchProofScope> = null;
    let launchProfileConfigDigest: string | null = null;
    let current: Awaited<ReturnType<typeof calculateCurrentApprovedAmuxV4TaskCost>>;
    let budget: Awaited<ReturnType<typeof priorBudget>>;
    let cost;
    if (isRiskException) {
      if (!input.riskAcceptanceId || !input.riskAcceptanceDigest || !input.launchProofId ||
          !input.launchProofDigest || input.acceptRetry !== true ||
          task.id !== AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID ||
          input.priorAttemptId !== AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID)
        throw new BoardImportError("risk_acceptance_binding_mismatch", 409);
      risk = await tx.amuxV22TaskRecoveryRiskAcceptance.findUnique({
        where: { id: input.riskAcceptanceId } });
      launchProof = await tx.amuxV22ReadOnlyLaunchProof.findUnique({
        where: { id: input.launchProofId } });
      launchCheck = risk && launchProof ? await tx.amuxV22ReadOnlyLaunchCheck.findUnique({
        where: { id: launchProof.launchCheckId } }) : null;
      const currentProfile = launchCheck ? configuredAmuxV22RecoveryProfile(
        launchCheck.workerName) : null;
      launchScope = launchProof ? amuxV22ReadOnlyLaunchProofScope(
        launchProof.report) : null;
      const nominalLaunchScope = launchCheck ? amuxV22ReadOnlyLaunchScopeSchema.safeParse(
        launchCheck.launchScope) : null;
      const catalog = getConfiguredAmuxV22WorkerCatalog();
      const worker = launchCheck && catalog?.find((entry) =>
        entry.worker_name === launchCheck!.workerName);
      const selectedFenced = launchCheck ? await amuxV22SafeStopFencedWorkers(tx,
        [launchCheck.workerName]) : new Set<string>();
      current = await calculateCurrentApprovedAmuxV4TaskCost(tx,
        task.taskRole!, task.executionGrade!);
      budget = await priorBudget(tx, task.id);
      const riskCost = launchCheck ? amuxV22ReadOnlyRetryRouteCost({
        priorReservedMicroUsd: budget.reserved,
        catalogApprovalId: current.approvalId, receipt: current.receipt,
        routeId: launchCheck.routeId, workerName: launchCheck.workerName,
        provider: launchCheck.provider, modelId: launchCheck.modelId }) : null;
      cost = riskCost;
      const executorKind = launchScope ?
        amuxV22ReadOnlyLaunchExecutorKind(launchScope.launchScope) : null;
      apiModelAccessEvidence = executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND &&
        launchProof ? await tx.amuxV22ApiModelAccessEvidence.findUnique({
          where: { launchProofId: launchProof.id } }) : null;
      launchProfileConfigDigest = executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ?
        null : currentProfile?.profileConfigDigest ?? null;
      const currentApiBinding = executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND &&
        launchCheck && currentProfile ? apiExecutionBinding({ approved: current,
          role: task.taskRole!, grade: task.executionGrade!, routeId: launchCheck.routeId,
          routePolicyDigest: launchCheck.routePolicyDigest,
          provider: launchCheck.provider, modelId: launchCheck.modelId,
          maximumCostMicroUsd: launchCheck.additionalCapMicroUsd,
          workerName: launchCheck.workerName,
          profileConfigDigest: currentProfile.profileConfigDigest, now }) : null;
      if (!riskCost || !risk || risk.acceptedByUserId !== ownerId ||
          risk.acceptanceDigest !== input.riskAcceptanceDigest ||
          inspection.riskAcceptanceId !== risk.id ||
          inspection.riskAcceptanceDigest !== risk.acceptanceDigest ||
          risk.taskId !== task.id || risk.taskRevision !== task.revision ||
          risk.priorAttemptId !== input.priorAttemptId ||
          risk.briefDigest !== task.v4BriefDigest ||
          risk.oldHeldMicroUsd !== AMUX_V22_UNKNOWN_PRIOR_HELD_MICROUSD ||
          !launchCheck || launchCheck.sourceEvidenceId !== evidence.id ||
          launchCheck.sourceEvidenceDigest !== evidence.evidenceDigest ||
          launchCheck.riskAcceptanceDigest !== risk.acceptanceDigest ||
          launchCheck.launchBindingId !== risk.launchBindingId ||
          launchCheck.taskRevision !== task.revision ||
          launchCheck.briefDigest !== task.v4BriefDigest ||
          !launchProof || launchProof.id !== input.launchProofId ||
          launchProof.proofDigest !== input.launchProofDigest || !launchProof.verified ||
          !evidenceFresh(launchProof.recordedAt, now) || !executorKind ||
          !await currentRuntime(tx, launchCheck, executorKind) || selectedFenced.size > 0 ||
          !launchScope || !nominalLaunchScope?.success || !currentProfile ||
          (executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ?
            !currentApiBinding || !amuxV22ReadOnlyLaunchScopeMatchesIntent(
              currentApiBinding.launchScope, nominalLaunchScope.data) ||
              !apiModelAccessEvidence ||
              apiModelAccessEvidence.accessState !== "verified" ||
              !evidenceFresh(apiModelAccessEvidence.recordedAt, now) ||
              apiModelAccessEvidence.taskId !== task.id ||
              apiModelAccessEvidence.priorAttemptId !== input.priorAttemptId ||
              apiModelAccessEvidence.workerName !== launchCheck.workerName ||
              apiModelAccessEvidence.workerInstanceId !== launchCheck.workerInstanceId ||
              apiModelAccessEvidence.workerGeneration !== launchCheck.workerGeneration ||
              apiModelAccessEvidence.provider !== launchCheck.provider ||
              apiModelAccessEvidence.selectedModelId !== launchCheck.modelId ||
              apiModelAccessEvidence.canonicalModelId !== launchCheck.modelId ||
              apiModelAccessEvidence.apiExecutionFrameDigest !==
                ("apiExecutionFrameDigest" in launchScope.launchScope ?
                  launchScope.launchScope.apiExecutionFrameDigest : null) ||
              apiModelAccessEvidence.credentialMetadataDigest !==
                currentApiBinding.frame.credentialMetadataDigest ||
              apiModelAccessEvidence.launcherConfigDigest !==
                launchScope.launchScope.launcherConfigDigest ||
              apiModelAccessEvidence.balanceKnown :
            "executorKind" in launchScope.launchScope ||
              currentProfile.profileConfigDigest !==
                launchScope.launchScope.profileConfigDigest) ||
          !amuxV22ReadOnlyLaunchScopeMatchesIntent(
            nominalLaunchScope.data, launchScope.launchScope) ||
          amuxV22ReadOnlyLaunchScopeDigest(nominalLaunchScope.data) !==
            launchCheck.launchScopeDigest ||
          !worker || worker.archived || worker.paused || worker.isolated || worker.blocked ||
          worker.provider !== launchCheck.provider.toLowerCase() ||
          worker.model !== launchCheck.modelId ||
          !worker.routing_roles.includes("investigate") ||
          !worker.tool_capabilities.includes("repo_read") ||
          !await auditBound(tx, risk.authorizationAuditLogId,
            "amux.v22.recovery.unknown_prior_risk_accepted",
            "AmuxV22TaskRecoveryRiskAcceptance", risk.id, ownerId) ||
          !await auditBound(tx, launchCheck.authorizationAuditLogId,
            "amux.v22.recovery.read_only_launch_requested",
            "AmuxV22ReadOnlyLaunchCheck", launchCheck.id) ||
          !await auditBound(tx, launchProof.authorizationAuditLogId,
            "amux.v22.recovery.read_only_launch_observed",
            "AmuxV22ReadOnlyLaunchProof", launchProof.id))
        throw new BoardImportError("read_only_launch_proof_unverified", 409);
      if (budget.historicalAttempts !== 1 || budget.nextAttemptNumber !== 2 ||
          current.approvalId !== launchCheck.catalogApprovalId ||
          current.receipt.catalogVersion !== launchCheck.catalogVersion ||
          current.receipt.pricingVersion !== launchCheck.pricingVersion ||
          current.receipt.receiptDigest !== launchCheck.costReceiptDigest ||
          riskCost.costDigest !== launchCheck.costDigest ||
          riskCost.additionalCapMicroUsd !== launchCheck.additionalCapMicroUsd.toString() ||
          riskCost.worstExposureMicroUsd !== launchCheck.worstExposureMicroUsd.toString())
        throw new BoardImportError("recovery_cost_changed", 409);
    } else {
      ({ current, budget, cost } = await currentCost(tx, task));
    }
    const approvedCost = cost;
    if (!approvedCost || approvedCost.costDigest !== input.costDigest)
      throw new BoardImportError("recovery_cost_changed", 409);
    const policies = await lockAmuxResourcePolicies(tx, amuxResourceRefs(task));
    const admission = await evaluateLockedAmuxCostAdmission(tx, policies,
      BigInt(approvedCost.additionalCapMicroUsd), now);
    if (!admission.allowed) throw new BoardImportError(admission.reason, 409);
    const approvalId = randomUUID();
    const auditId = await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: "amux.v22.recovery.approved", targetType: "AmuxV22TaskRecoveryApproval", targetId: approvalId,
      summary: "Approved exactly one additional capped Task attempt while preserving its prior unconfirmed cap.",
      metadata: { taskId: task.id, inspectionId: inspection.id, evidenceId: evidence.id,
        ownerRequestId: input.requestId, priorAttemptId: input.priorAttemptId,
        beforeRevision: task.revision, afterRevision: task.revision + 1,
        evidenceDigest: evidence.evidenceDigest, ...approvedCost,
        ...(risk && launchCheck && launchProof ? { riskAcceptanceId: risk.id,
          riskAcceptanceDigest: risk.acceptanceDigest, launchProofId: launchProof.id,
          launchProofDigest: launchProof.proofDigest,
          launchBindingId: risk.launchBindingId,
          launchScopeDigest: launchScope!.launchScopeDigest,
          workerName: launchCheck.workerName, provider: launchCheck.provider,
          modelId: launchCheck.modelId, routeId: launchCheck.routeId,
          routePolicyDigest: launchCheck.routePolicyDigest,
          briefDigest: launchCheck.briefDigest,
          profileConfigDigest: launchProfileConfigDigest,
          ...(apiModelAccessEvidence ? {
            apiModelAccessEvidenceId: apiModelAccessEvidence.id,
            apiModelAccessEvidenceDigest: apiModelAccessEvidence.evidenceDigest,
            canonicalModelId: apiModelAccessEvidence.canonicalModelId,
          } : {}) } : {}),
        policyVersion: AMUX_V22_TASK_RECOVERY_POLICY_VERSION, executionStarted: false, reservationCreated: false } });
    await tx.amuxV22TaskRecoveryApproval.create({ data: { id: approvalId, ownerRequestId: input.requestId,
      inspectionId: inspection.id, evidenceId: evidence.id, taskId: task.id,
      beforeRevision: task.revision, afterRevision: task.revision + 1, priorAttemptId: input.priorAttemptId,
      evidenceDigest: evidence.evidenceDigest, costDigest: approvedCost.costDigest,
      catalogApprovalId: current.approvalId, catalogVersion: approvedCost.catalogVersion,
      pricingVersion: approvedCost.pricingVersion, costReceiptDigest: current.receipt.receiptDigest,
      costReceipt: current.receipt as unknown as Prisma.InputJsonValue,
      historicalAttempts: budget.historicalAttempts, nextAttemptNumber: budget.nextAttemptNumber,
      oldHeldMicroUsd: budget.reserved,
      additionalCapMicroUsd: BigInt(approvedCost.additionalCapMicroUsd),
      worstExposureMicroUsd: BigInt(approvedCost.worstExposureMicroUsd),
      riskAcceptanceId: risk?.id ?? null,
      riskAcceptanceDigest: risk?.acceptanceDigest ?? null,
      launchProofId: launchProof?.id ?? null,
      launchProofDigest: launchProof?.proofDigest ?? null,
      launchBindingId: risk?.launchBindingId ?? null,
      launchScopeDigest: launchScope?.launchScopeDigest ?? null,
      workerName: launchCheck?.workerName ?? null,
      provider: launchCheck?.provider ?? null, modelId: launchCheck?.modelId ?? null,
      routeId: launchCheck?.routeId ?? null,
      routePolicyDigest: launchCheck?.routePolicyDigest ?? null,
      briefDigest: launchCheck?.briefDigest ?? null,
      profileConfigDigest: launchProfileConfigDigest,
      apiModelAccessEvidenceId: apiModelAccessEvidence?.id ?? null,
      apiModelAccessEvidenceDigest: apiModelAccessEvidence?.evidenceDigest ?? null,
      canonicalModelId: apiModelAccessEvidence?.canonicalModelId ?? null,
      approvedByUserId: ownerId,
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
  taskId: string, taskRevision: number, approvalId?: string | null, now?: Date) {
  void now; // Callers separately apply the 90-second access freshness at claim/start.
  const row = await tx.amuxV22TaskRecoveryApproval.findFirst({ where: {
    taskId, afterRevision: taskRevision, ...(approvalId ? { id: approvalId } : {}),
    ...(approvalId ? {} : { assignment: null }) }, include: { inspection: true,
      evidence: true, apiModelAccessEvidence: true } });
  if (!row) return null;
  if (!row.evidence.verified || row.evidenceDigest !== row.evidence.evidenceDigest ||
      !await auditBound(tx, row.authorizationAuditLogId, "amux.v22.recovery.approved",
        "AmuxV22TaskRecoveryApproval", row.id, row.approvedByUserId))
    throw new BoardImportError("recovery_approval_unbound", 409);
  let readOnlyExecutorKind: "read_only_retry_v1" | "read_only_api_retry_v1" | null = null;
  let apiExecutionFrame: AmuxV22ReadOnlyApiExecutionFrame | null = null;
  let launcherConfigDigest: string | null = null;
  let launchProofRecordedAt: Date | null = null;
  if (row.riskAcceptanceId) {
    const risk = await tx.amuxV22TaskRecoveryRiskAcceptance.findUnique({
      where: { id: row.riskAcceptanceId } });
    const proof = row.launchProofId ? await tx.amuxV22ReadOnlyLaunchProof.findUnique({
      where: { id: row.launchProofId } }) : null;
    const check = proof ? await tx.amuxV22ReadOnlyLaunchCheck.findUnique({
      where: { id: proof.launchCheckId } }) : null;
    const scope = proof ? amuxV22ReadOnlyLaunchProofScope(proof.report) : null;
    const nominalScope = check ?
      amuxV22ReadOnlyLaunchScopeSchema.safeParse(check.launchScope) : null;
    const executorKind = scope ?
      amuxV22ReadOnlyLaunchExecutorKind(scope.launchScope) : null;
    const access = row.apiModelAccessEvidence;
    if (row.taskId !== AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID ||
        row.priorAttemptId !== AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID ||
        row.historicalAttempts !== 1 || row.nextAttemptNumber !== 2 ||
        row.oldHeldMicroUsd !== AMUX_V22_UNKNOWN_PRIOR_HELD_MICROUSD ||
        row.additionalCapMicroUsd > AMUX_V22_READ_ONLY_RETRY_CAP_MICROUSD ||
        row.worstExposureMicroUsd !== row.oldHeldMicroUsd + row.additionalCapMicroUsd ||
        row.worstExposureMicroUsd > AMUX_V22_READ_ONLY_RETRY_EXPOSURE_MICROUSD ||
        !risk || row.riskAcceptanceDigest !== risk.acceptanceDigest ||
        row.launchBindingId !== risk.launchBindingId ||
        !proof?.verified || row.launchProofDigest !== proof.proofDigest ||
        !check || check.riskAcceptanceId !== risk.id ||
        check.sourceEvidenceId !== row.evidenceId ||
        check.launchBindingId !== row.launchBindingId ||
        scope?.launchScopeDigest !== row.launchScopeDigest ||
        check.workerName !== row.workerName || check.provider !== row.provider ||
        check.modelId !== row.modelId || check.routeId !== row.routeId ||
        check.routePolicyDigest !== row.routePolicyDigest ||
        check.briefDigest !== row.briefDigest ||
        !scope || !nominalScope?.success || !executorKind ||
        !amuxV22ReadOnlyLaunchScopeMatchesIntent(
          nominalScope.data, scope.launchScope) ||
        (executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ?
          row.profileConfigDigest !== null || !access ||
            row.apiModelAccessEvidenceId !== access.id ||
            row.apiModelAccessEvidenceDigest !== access.evidenceDigest ||
            access.launchProofId !== proof.id || access.accessState !== "verified" ||
            access.taskId !== row.taskId || access.priorAttemptId !== row.priorAttemptId ||
            access.workerName !== row.workerName || access.provider !== row.provider ||
            access.selectedModelId !== row.modelId ||
            access.canonicalModelId !== row.canonicalModelId ||
            access.canonicalModelId !== row.modelId || access.balanceKnown ||
            access.apiExecutionFrameDigest !==
              ("apiExecutionFrameDigest" in scope.launchScope ?
                scope.launchScope.apiExecutionFrameDigest : null) ||
            access.credentialMetadataDigest !==
              scope.report.apiExecutionFrame?.credentialMetadataDigest ||
            access.launcherConfigDigest !== scope.launchScope.launcherConfigDigest :
          row.apiModelAccessEvidenceId !== null ||
            row.apiModelAccessEvidenceDigest !== null || row.canonicalModelId !== null ||
            "executorKind" in scope.launchScope ||
            scope.launchScope.profileConfigDigest !== row.profileConfigDigest) ||
        check.additionalCapMicroUsd !== row.additionalCapMicroUsd ||
        check.worstExposureMicroUsd !== row.worstExposureMicroUsd)
      throw new BoardImportError("recovery_approval_unbound", 409);
    readOnlyExecutorKind = executorKind;
    launcherConfigDigest = scope.launchScope.launcherConfigDigest;
    launchProofRecordedAt = proof.recordedAt;
    apiExecutionFrame = executorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ?
      scope.report.apiExecutionFrame ?? null : null;
  } else if (row.launchProofId || row.launchBindingId || row.workerName || row.provider ||
      row.modelId || row.routeId || row.briefDigest || row.launchScopeDigest ||
      row.apiModelAccessEvidenceId || row.apiModelAccessEvidenceDigest ||
      row.canonicalModelId) {
    throw new BoardImportError("recovery_approval_unbound", 409);
  }
  return { ...row, readOnlyExecutorKind, apiExecutionFrame, launcherConfigDigest,
    launchProofRecordedAt };
}

export function amuxV22ApiModelAccessCurrent(authority: null | {
  readOnlyExecutorKind: string | null; modelId: string | null;
  launchProofRecordedAt: Date | null;
  apiModelAccessEvidence: null | { accessState: string; balanceKnown: boolean;
    canonicalModelId: string | null; selectedModelId: string; recordedAt: Date };
}, now: Date) {
  const evidence = authority?.apiModelAccessEvidence;
  if (authority?.readOnlyExecutorKind !== AMUX_V22_READ_ONLY_API_EXECUTOR_KIND)
    return true;
  return !!evidence && evidence.accessState === "verified" &&
    evidence.balanceKnown === false && evidence.canonicalModelId === authority.modelId &&
    evidence.selectedModelId === authority.modelId &&
    evidence.recordedAt.getTime() <= now.getTime() &&
    now.getTime() - evidence.recordedAt.getTime() <= 90_000 &&
    // A late report records its own DB time; the window still closes 90
    // seconds after the launch proof it answered, never after the report.
    !!authority.launchProofRecordedAt &&
    authority.launchProofRecordedAt.getTime() <= evidence.recordedAt.getTime() &&
    now.getTime() - authority.launchProofRecordedAt.getTime() <= 90_000;
}

export function recoveryAttemptBudget(input: {
  historicalAttempts: number;
  greatestAttemptNumber: number | null;
}) {
  return decideAmuxAttemptBudget({ historical_rows: input.historicalAttempts,
    greatest_attempt_number: input.greatestAttemptNumber });
}
