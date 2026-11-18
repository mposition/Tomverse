import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V22_WORKER_CLAIM_AUDIT_ACTOR } from
  "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { BoardImportError } from "./boardImportCore.ts";
import { amuxWorkerMatchesExecutionGrade,
  isAmuxV52TaskConfirmation } from "./executionGradeCore.ts";
import { type AmuxOrchestratorReceiptRecorder, amuxRouteHasBudgetForMs } from "./dbBoundary.ts";
import { AUTO_TICK_TRANSACTION_MAX_MS } from "./autoPromotionCore.ts";
import { findOpenAmuxOrchestratorHalt } from "./orchestratorHaltStore.ts";
import { lockAmuxAdmissionAndReadIncident } from "./incident.ts";
import { readAmuxAssignmentCatalogs } from "./workerAssignmentCatalog.ts";
import { getAmuxWorkerTelemetry } from "./telemetry.ts";
import { TICK_TRANSACTION_LIMITS, withAutoTransaction } from
  "./autoPromotionService.ts";
import { calculateCurrentApprovedAmuxV4TaskCost } from
  "./v4TaskCostCatalogApprovalService.ts";
import { checkV4TaskApprovedCeiling, v4TaskCeilingDecision,
  v4TaskReceiptForApprovedRoutes } from "./v4TaskCostCeilingCore.ts";
import { amuxV4NewModelRouteOptions } from "./v4TaskNewModelRouteSwitch.ts";
import { readAmuxV52TaskReceipt } from "./v52GradeReceipt.ts";
import { inspectV52TaskCatalogGrades } from "./v4TaskCostCatalogCore.ts";
import { amuxTaskRoutePrice } from "./v4TaskCostAutoCatalogCore.ts";
import { amuxV22ApiModelAccessCurrent, readAmuxV22RecoveryAuthority } from
  "./v22TaskRecoveryService.ts";
import { AMUX_V22_PAID_RETRY_ATTEMPT_LIMIT, recoveryAttemptBudget, amuxV22RecoveryAddedRouteConsented, amuxV22RecoveryCost, amuxV22RecoveryStartAllowed,
  amuxV22ReadOnlyRetryRouteCost,
  currentAmuxV22ReadOnlyApiExecutionFrame } from "./v22TaskRecoveryCore.ts";
import { AMUX_V22_READ_ONLY_API_EXECUTOR_KIND } from
  "./v22ReadOnlyApiProtocol.mjs";
import { amuxV22SafeStopFencedWorkers } from "./v22LegacySafeStopFence.ts";
import { amuxWorkerRuntimeUsesReadOnlyApi } from "./workerRuntime.ts";
import { amuxV22RoutesWithSettledUsage } from "./v22WorkerUsageGate.ts";
import { AMUX_REPEATED_FAILURE_RUNS, amuxApprovedCeilingOverrun, amuxResultRetryDelayMs }
  from "./executionBudgetCore.ts";
import { amuxInfraRetryDelayMs } from "./infraFailureCore.ts";
import { readAmuxAttemptBudgetFacts, readAmuxResultFailureStreak,
  recentAmuxInfraFailureWorkers } from "./infraFailureStore.ts";
import { type AmuxWorkerCircuit, amuxWorkerCircuitAdmits } from "./workerCircuitCore.ts";
import { readAmuxWorkerCircuits, reportOpenAmuxWorkerCircuits } from "./workerHealthStore.ts";
import { AMUX_CARD_WAIT_MAX_ROUTES, type AmuxCardWaitDetail } from "./cardWaitReasonCore.ts";
import { type AmuxCardWaitEntry, clearAmuxCardWaitReasons, recordAmuxCardWaitReasons,
  reportLongAmuxCardWaits } from "./cardWaitReasonStore.ts";
import { evaluateAmuxV4TaskReadyInTransaction,
  loadAmuxV4TaskReadyContext } from "./v4TaskReadyService.ts";
import { amuxV22ClaimCapacity, amuxV22ExecutionRole, amuxV22RequiredTool,
  amuxV22TaskRoleSupported, amuxV22OneShotRouteSupported, amuxV22Provider,
  amuxV22ResumeRoutes, chooseAmuxV22WorkerRoute,
  type AmuxV22ClaimLane } from
  "./v22WorkerClaimCore.ts";

type Candidate = { id: string };
/** Candidates one tick reads (owner direction 2026-11-15: widened from 12).
 * The tick stops early, leaving the rest for the next, when its route budget
 * no longer fits another claim transaction. */
const MAX_CANDIDATES = 100;

/** A refusal that carries why, so the tick can store it for the card
 * (owner decision 2026-11-15, lib/amux/cardWaitReasonStore.ts). */
class AmuxClaimSkipError extends BoardImportError {
  readonly detail: AmuxCardWaitDetail;
  constructor(code: string, detail: AmuxCardWaitDetail) {
    super(code, 409);
    this.detail = detail;
  }
}

/** The approved routes, each with the first reason it could not take the card. */
const routeDetail = <T extends { workerName: string; provider: string }>(
  routes: readonly T[], why: (route: T) => string | null) =>
  routes.slice(0, AMUX_CARD_WAIT_MAX_ROUTES).map((route) => ({ worker: route.workerName,
    provider: route.provider.toLowerCase(), why: why(route) ?? "not_chosen" }));

async function candidates(tx: Prisma.TransactionClient): Promise<Candidate[]> {
  return tx.$queryRaw<Candidate[]>`
    SELECT w."id" FROM "AmuxWorkItem" w
    JOIN "AmuxV22PromotionReceipt" p ON p."id" = w."v22ReceiptId"
    LEFT JOIN LATERAL (SELECT d."lane" FROM "AmuxV22LaneDecision" d
      WHERE d."workItemId" = w."id" ORDER BY d."sequence" DESC LIMIT 1) lane ON TRUE
    WHERE w."sourceSystem" = 'admin-idea-v4' AND w."cardType" = 'task'
      AND w."status" = 'todo' AND w."archivedAt" IS NULL
      AND w."owner" IS NULL AND w."claimedAt" IS NULL
      AND w."v22AssignmentId" IS NULL
    ORDER BY CASE WHEN lane."lane" = 'sev1' THEN 0 ELSE 1 END,
      p."scoreTotal" DESC, w."createdAt", w."id"
    LIMIT ${MAX_CANDIDATES}`;
}

async function currentLane(tx: Prisma.TransactionClient, taskId: string) {
  const row = await tx.amuxV22LaneDecision.findFirst({
    where: { workItemId: taskId }, orderBy: { sequence: "desc" },
    select: { sequence: true, lane: true, approvedByUserId: true,
      authorizationAuditLogId: true },
  });
  if (!row) return { lane: "normal" as AmuxV22ClaimLane,
    sequence: null as bigint | null };
  const audit = await tx.adminAuditLog.findUnique({
    where: { id: row.authorizationAuditLogId },
    select: { action: true, targetType: true, targetId: true,
      actorUserId: true, entryHash: true },
  });
  if (!audit?.entryHash || audit.action !== "amux.v22.lane.declared" ||
      audit.targetType !== "AmuxV22LaneDecision" ||
      audit.targetId !== row.sequence.toString() ||
      audit.actorUserId !== row.approvedByUserId ||
      !["normal", "parallel", "sev1"].includes(row.lane)) {
    throw new BoardImportError("lane_unbound", 409);
  }
  return { lane: row.lane as AmuxV22ClaimLane, sequence: row.sequence };
}

/** A review commonly depends on test, not directly on implementation. Walk
 * the approved Task DAG and bind independence to accepted implement receipts. */
async function implementAuthors(tx: Prisma.TransactionClient, taskId: string) {
  return tx.$queryRaw<Array<{ workerName: string; provider: string }>>`
    WITH RECURSIVE ancestors("dependencyId") AS (
      SELECT d."dependencyId"
      FROM "AmuxWorkDependency" d WHERE d."taskId" = ${taskId}
      UNION
      SELECT d."dependencyId"
      FROM "AmuxWorkDependency" d
      JOIN ancestors a ON a."dependencyId" = d."taskId"
    )
    SELECT DISTINCT r."workerName", r."provider" FROM ancestors a
    JOIN "AmuxWorkItem" w ON w."id" = a."dependencyId"
    JOIN "AmuxV22WorkerAssignment" r ON r."id" = w."v22AssignmentId"
    WHERE w."sourceSystem" = 'admin-idea-v4' AND w."cardType" = 'task'
      AND w."taskRole" = 'implement' AND w."status" = 'done'
      AND w."v4TerminalAt" IS NOT NULL`;
}

async function claimCandidate(taskId: string, assignmentId: string,
  context: Awaited<ReturnType<typeof loadAmuxV4TaskReadyContext>>,
  circuits: ReadonlyMap<string, AmuxWorkerCircuit>) {
  return withAutoTransaction(assignmentId, TICK_TRANSACTION_LIMITS,
    async (tx, now, recordReceipt: AmuxOrchestratorReceiptRecorder) => {
      const incident = await lockAmuxAdmissionAndReadIncident(tx, now);
      if (incident.blocks_admission) throw new BoardImportError("incident_blocked", 409);
      const halt = await findOpenAmuxOrchestratorHalt(tx);
      if (halt) throw new BoardImportError("orchestrator_halted", 409);
      // Lock order (lib/adminAudit.ts takeAuditChainLock): worker runtimes,
      // then the audit chain, then the Task. The route is chosen below, so
      // every runtime row is locked here; the admission lock above already
      // serializes claims, and the chosen worker's row is locked again below.
      await tx.$queryRaw`SELECT "workerName" FROM "AmuxWorkerRuntime"
        ORDER BY "workerName" FOR UPDATE`;
      await takeAuditChainLock(tx);
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "AmuxWorkItem" WHERE "id" = ${taskId} FOR UPDATE`;
      if (locked.length !== 1) throw new BoardImportError("not_unassigned_todo", 409);
      const card = await tx.amuxWorkItem.findUnique({ where: { id: taskId },
        select: { status: true, sourceSystem: true, cardType: true,
          archivedAt: true, owner: true, claimedAt: true, revision: true,
          taskRole: true, executionGrade: true, v22ReceiptId: true,
          v22AssignmentId: true },
      });
      if (!card || card.status !== "todo" || card.sourceSystem !== "admin-idea-v4" ||
          card.cardType !== "task" || card.archivedAt || card.owner || card.claimedAt ||
          card.v22AssignmentId || !card.v22ReceiptId || !card.taskRole ||
          !card.executionGrade) throw new BoardImportError("not_unassigned_todo", 409);
      const promotion = await tx.amuxV22PromotionReceipt.findUnique({
        where: { id: card.v22ReceiptId }, select: { id: true,
          workItemId: true, sourceApprovalId: true, briefDigest: true },
      });
      const ready = await evaluateAmuxV4TaskReadyInTransaction(tx,
        taskId, context, null, "todo");
      // Policy v48: only the FIRST Task retry may carry a cost reconfirmation,
      // and only for a route added after registration (checked below once the
      // owner-approved recovery is read).
      const reconfirmOnly = !ready.ready && ready.reasons.length === 1 &&
        ready.reasons[0] === "cost_reconfirmation_required";
      if ((!ready.ready && !reconfirmOnly) || !promotion || promotion.workItemId !== taskId ||
          promotion.sourceApprovalId !== ready.sourceApprovalId ||
          promotion.briefDigest !== ready.briefDigest) {
        throw new AmuxClaimSkipError("task_not_ready", { reasons: ready.ready ?
          ["promotion_receipt_changed"] : [...ready.reasons] });
      }
      if (!amuxV22TaskRoleSupported(card.taskRole)) {
        throw new BoardImportError("one_shot_role_unavailable", 409);
      }
      // Execution start refuses a Task whose attempts are spent
      // (startAmuxV22TaskExecution, the same budget). Assigning it anyway only
      // reserved it for a start that never came, so the unstarted release
      // requeued it and the next tick, which assigns at most one Task, took it
      // again ahead of every lower-scored Task (production 2026-11-06 to 11-07:
      // 149 assignments of one Task, no other Task assigned).
      // Infrastructure failures keep their attempt number but use none of the
      // card's attempts (owner decision 2026-11-15, infraFailureCore.ts).
      const prior = await readAmuxAttemptBudgetFacts(tx, taskId);
      const priorReserved = prior.reservedMicrousd;
      // An ordinary card has no bound (owner direction 2026-11-18); only a paid
      // retry's own bound is checked, once its recovery is read below.
      // A card whose newest run was a platform failure waits before a worker
      // takes it again (infraFailureCore.ts amuxInfraRetryDelayMs); it is never
      // parked for a person.
      const infraWaitMs = amuxInfraRetryDelayMs(prior.infraWindowRows);
      if (infraWaitMs > 0 && prior.lastEndedIsInfra && prior.lastEndedAt &&
          now.getTime() - prior.lastEndedAt.getTime() < infraWaitMs) {
        throw new AmuxClaimSkipError("infra_retry_backoff", {
          attemptsUsed: prior.infraWindowRows });
      }
      // The same failure of the worker's own result, again and again, also
      // waits longer each time and never stops the card or goes to a person
      // (owner direction 2026-11-18, executionBudgetCore.ts amuxResultRetryDelayMs).
      if (prior.historicalRows > AMUX_REPEATED_FAILURE_RUNS && !prior.lastEndedIsInfra &&
          prior.lastEndedAt) {
        const { streak } = await readAmuxResultFailureStreak(tx, taskId);
        const resultWaitMs = amuxResultRetryDelayMs(streak);
        if (resultWaitMs > 0 && now.getTime() - prior.lastEndedAt.getTime() < resultWaitMs) {
          throw new AmuxClaimSkipError("result_retry_backoff", { attemptsUsed: streak });
        }
      }
      const lane = await currentLane(tx, taskId);
      // Orchestration policy version 35, section 3: the variables while R2c is
      // off; the catalog derived from the registry, read in this transaction,
      // once it is on.
      const { v22: catalog, ceilings } = await readAmuxAssignmentCatalogs(tx);
      if (!catalog) throw new BoardImportError("worker_catalog_unavailable", 409);
      const safeStopFenced = await amuxV22SafeStopFencedWorkers(tx,
        catalog.map((worker) => worker.worker_name));
      const live = await tx.amuxWorkerRuntime.findMany({ where: {
        workerName: { in: catalog.map((worker) => worker.worker_name) },
        leaseExpiresAt: { gt: now }, status: { in: ["idle", "busy"] },
      }, select: { workerName: true, instanceId: true, generation: true,
        status: true, dispatchReady: true, protocolCapabilities: true } });
      const liveByName = new Map(live.map((worker) => [worker.workerName, worker]));
      const operationalNames = new Set(catalog.filter((worker) =>
        !worker.archived && !worker.paused && !worker.isolated &&
        !worker.blocked && liveByName.has(worker.worker_name)).map(
        (worker) => worker.worker_name));
      const verifiedNames = new Set([...operationalNames].filter((worker) =>
        !safeStopFenced.has(worker)));
      if (operationalNames.size > 0 && verifiedNames.size === 0)
        throw new BoardImportError("worker_safe_stop_fenced", 409);
      const occupied = await tx.amuxWorkItem.findMany({ where: {
        owner: { not: null }, archivedAt: null,
        status: { in: ["todo", "doing", "review"] },
      }, select: { id: true, owner: true, v22AssignmentId: true,
        sourceSystem: true },
      });
      const capacity = amuxV22ClaimCapacity({
        verifiedWorkerCount: verifiedNames.size,
        totalAssigned: occupied.length });
      if (!capacity.allowed) throw new BoardImportError(capacity.reason, 409);
      // How many Tasks each provider holds now, so the route choice spreads
      // Tasks across providers instead of sending them all to the cheapest.
      const providerOf = new Map(catalog.map((worker) =>
        [worker.worker_name, worker.provider]));
      const activeByProvider = new Map<string, number>();
      for (const item of occupied) {
        const provider = item.owner ? providerOf.get(item.owner) : undefined;
        if (provider) activeByProvider.set(provider,
          (activeByProvider.get(provider) ?? 0) + 1);
      }

      const approved = await calculateCurrentApprovedAmuxV4TaskCost(tx,
        card.taskRole, card.executionGrade);
      const recovery = await readAmuxV22RecoveryAuthority(tx, taskId, card.revision,
        null, now);
      // A paid retry keeps its own bound, the same one its start and its
      // approval apply: platform failures use none of it.
      if (recovery?.riskAcceptanceId && !recoveryAttemptBudget({
        historicalAttempts: prior.historicalRows,
        greatestAttemptNumber: prior.greatestAttemptNumber,
        infraRows: prior.infraRows }).allowed) {
        throw new AmuxClaimSkipError("attempt_budget_exhausted", {
          limit: "attempts", maxAttempts: AMUX_V22_PAID_RETRY_ATTEMPT_LIMIT });
      }
      // A v39 retry is bound to the receipt its launch check recorded; recompute
      // that receipt as of the check so its time-stamped digest matches (v47).
      const recoveryApproved = recovery?.costAsOf ?
        await calculateCurrentApprovedAmuxV4TaskCost(tx, card.taskRole, card.executionGrade,
          { asOf: recovery.costAsOf }) : approved;
      const source = ready.sourceApprovalId ?
        await tx.amuxIdeaUnitDecision.findUnique({
          where: { id: ready.sourceApprovalId },
          select: { confirmationSnapshot: true },
        }) : null;
      const snapshot = source?.confirmationSnapshot;
      const sourceApprovedCost = snapshot && typeof snapshot === "object" &&
        !Array.isArray(snapshot) && "card" in snapshot &&
        snapshot.card && typeof snapshot.card === "object" &&
        !Array.isArray(snapshot.card) && "task" in snapshot.card &&
        snapshot.card.task && typeof snapshot.card.task === "object" &&
        !Array.isArray(snapshot.card.task) && "costReceipt" in snapshot.card.task ?
          snapshot.card.task.costReceipt : null;
      const approvedCost = await readAmuxV52TaskReceipt(tx, taskId,
        sourceApprovedCost, card.executionGrade);
      const sourceGrade = sourceApprovedCost && typeof sourceApprovedCost === "object" &&
        !Array.isArray(sourceApprovedCost) && "grade" in sourceApprovedCost ?
        sourceApprovedCost.grade : null;
      const exactGradeRouting =
        isAmuxV52TaskConfirmation(snapshot, sourceGrade) &&
        approvedCost !== null;
      if (exactGradeRouting &&
          !inspectV52TaskCatalogGrades(approved.catalog, ceilings).ok) {
        throw new BoardImportError("grade_catalog_mismatch", 409);
      }
      const addedRouteConsented = !!recovery?.riskAcceptanceId && !!recovery.routeId &&
        amuxV22RecoveryAddedRouteConsented(approvedCost, approved.receipt, recovery.routeId);
      if (reconfirmOnly && !addedRouteConsented)
        throw new BoardImportError("task_not_ready", 409);
      const routeOptions = amuxV4NewModelRouteOptions(process.env, !!recovery);
      // Only routes this Task's approval can run on are judged and offered; a
      // recovery binds its own added route (policy v48) and keeps them all.
      const runnable = recovery ? approved.receipt :
        v4TaskReceiptForApprovedRoutes(approvedCost, approved.receipt, routeOptions);
      if (v4TaskCeilingDecision(checkV4TaskApprovedCeiling(approvedCost,
        { ok: true, receipt: runnable }, routeOptions), !!recovery) !== "allow" && !addedRouteConsented) {
        throw new BoardImportError("cost_reconfirmation_required", 409);
      }
      const executionRole = amuxV22ExecutionRole(card.taskRole);
      const requiredTool = amuxV22RequiredTool(executionRole);
      if (!requiredTool) throw new BoardImportError("role_unavailable", 409);
      const busy = new Set(occupied.map((item) => item.owner));
      const currentApiFrame = recovery?.readOnlyExecutorKind ===
        AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ?
        currentAmuxV22ReadOnlyApiExecutionFrame(
          recovery.apiExecutionFrame, { now }) : null;
      // Each route's first reason it cannot take the card, or null; the same
      // conditions as before, named so the card can say why it waits
      // (owner decision 2026-11-15).
      const routeExclusion = (route: (typeof runnable.routes)[number]): string | null => {
        const worker = catalog.find((item) => item.worker_name === route.workerName);
        const runtime = liveByName.get(route.workerName);
        const nativeApiOnly = !!runtime &&
          amuxWorkerRuntimeUsesReadOnlyApi(runtime.protocolCapabilities);
        if (!worker) return "not_in_catalog";
        if (!runtime) return "offline";
        if (busy.has(route.workerName) || runtime.status === "busy") return "busy";
        if (runtime.status !== "idle" || !runtime.dispatchReady) return "starting";
        if (safeStopFenced.has(route.workerName)) return "safe_stop_fenced";
        if (!verifiedNames.has(route.workerName)) return "operator_excluded";
        if (!amuxV22OneShotRouteSupported(route.provider, route.modelId) ||
            worker.provider !== route.provider.toLowerCase() ||
            worker.model !== route.modelId) return "route_mismatch";
        if (!worker.routing_roles.includes(executionRole)) return "role";
        if (exactGradeRouting && !amuxWorkerMatchesExecutionGrade(card.executionGrade,
          worker.worker_name, ceilings)) return "grade";
        if (!worker.tool_capabilities.includes(requiredTool)) return "tool";
        return (!nativeApiOnly || (!!recovery?.riskAcceptanceId &&
            recovery.readOnlyExecutorKind ===
              AMUX_V22_READ_ONLY_API_EXECUTOR_KIND)) &&
          (!recovery?.riskAcceptanceId ||
            (route.workerName === recovery.workerName &&
             route.provider === recovery.provider && route.modelId === recovery.modelId &&
             route.routeId === recovery.routeId &&
             route.routePolicyDigest === recovery.routePolicyDigest &&
             runtime.protocolCapabilities.length === 1 &&
             runtime.protocolCapabilities[0] === recovery.readOnlyExecutorKind &&
             (recovery.readOnlyExecutorKind !==
                AMUX_V22_READ_ONLY_API_EXECUTOR_KIND ||
              (!!currentApiFrame &&
               currentApiFrame.provider === route.provider &&
               currentApiFrame.modelId === route.modelId &&
               currentApiFrame.routeId === route.routeId &&
               currentApiFrame.routePolicyDigest === route.routePolicyDigest &&
               currentApiFrame.catalogApprovalId === approved.approvalId &&
               currentApiFrame.catalogVersion === approved.receipt.catalogVersion &&
               currentApiFrame.catalogDigest === approved.catalogDigest &&
               currentApiFrame.pricingVersion === approved.receipt.pricingVersion &&
               BigInt(currentApiFrame.maximumCostMicroUsd) ===
                 BigInt(route.perAttemptMicroUsd))))) ? null : "recovery_binding";
      };
      const matchingRoutes = runnable.routes.filter((route) => routeExclusion(route) === null);
      const apiModelAccessCurrent = amuxV22ApiModelAccessCurrent(recovery, now);
      const telemetry = await getAmuxWorkerTelemetry(catalog.filter((worker) =>
        matchingRoutes.some((route) => route.workerName === worker.worker_name) &&
        !(recovery?.readOnlyExecutorKind ===
            AMUX_V22_READ_ONLY_API_EXECUTOR_KIND &&
          recovery.workerName === worker.worker_name)), now, tx);
      const quotaExclusion = (route: (typeof runnable.routes)[number]): string | null => {
        if (recovery?.readOnlyExecutorKind ===
              AMUX_V22_READ_ONLY_API_EXECUTOR_KIND &&
            route.workerName === recovery.workerName)
          return apiModelAccessCurrent ? null : "api_model_access_stale";
        const quota = telemetry.get(route.workerName);
        // Another provider's limit shows up as a failed attempt, not a
        // blocked claim: its reading reaches this check from telemetry.ts,
        // and only a fresh exhausted one holds the route.
        if (amuxV22Provider(route.provider) !== "anthropic")
          return quota?.scoring.provider_exhausted ? "quota_exhausted" : null;
        // An Anthropic route needs a fresh reading: a sign-in whose usage
        // cannot be read (an expired login, 2026-11-15) is held here.
        if (quota?.evidence.quota.state !== "fresh") return "quota_unobserved";
        return !quota.scoring.provider_exhausted &&
          (quota.scoring.quota_remaining.value ?? 0) > 0 ? null : "quota_exhausted";
      };
      const quotaRoutes = matchingRoutes.filter((route) => quotaExclusion(route) === null);
      const authors = card.taskRole === "review" ?
        await implementAuthors(tx, taskId) : [];
      if (card.taskRole === "review" && authors.length === 0) {
        throw new BoardImportError("review_author_unknown", 409);
      }
      const authorWorkers = authors.map((author) => author.workerName);
      const authorProviders = authors.map((author) => author.provider);
      // A Task resumed after its owner question goes back to the worker that
      // asked (amuxV22ResumeRoutes). The answer is pending until a resumed run
      // settles at the same grade.
      const resume = await tx.amuxV22TaskQuestion.findFirst({
        where: { taskId, answerText: { not: null },
          state: { in: ["answered", "resumed"] } },
        orderBy: [{ answeredAt: "desc" }, { id: "desc" }],
        select: { worker: true } });
      // A15 owns the audited owner-release and reservation-occupancy recovery
      // path; an unsettled worker takes no new Task, but another one can. An
      // owner-approved retry of this Task's named CLI failure is not held by
      // that failure (amuxV22WorkerUsageUnverified).
      const settled = await amuxV22RoutesWithSettledUsage(tx, quotaRoutes,
        recovery?.priorAttemptId ?? null, taskId);
      // A worker failing on the platform again and again waits out its
      // quarantine (workerCircuitCore.ts, owner decision 2026-11-15).
      const admittedRoutes = settled.routes.filter((route) =>
        amuxWorkerCircuitAdmits(circuits.get(route.workerName)));
      const resumeRoutes = amuxV22ResumeRoutes({
        resumeWorker: resume?.worker ?? null,
        approvedRoutes: approved.receipt.routes, routes: admittedRoutes,
        workerServesGrade: (workerName) => !exactGradeRouting ||
          amuxWorkerMatchesExecutionGrade(card.executionGrade, workerName,
            ceilings) });
      // Whose turn it is: every worker's latest assignment, so a provider's
      // turn counts its busy workers too (review r-20261113-071016-e1734a).
      const lastAssigned = resumeRoutes.length ? await tx.amuxV22WorkerAssignment.groupBy({
        by: ["workerName"], _max: { assignedAt: true } }) : [];
      const lastAssignedAtByWorker = new Map(lastAssigned.flatMap((row) =>
        row._max.assignedAt ? [[row.workerName, row._max.assignedAt.getTime()] as const] : []));
      const lastAssignedAtByProvider = new Map<string, number>();
      for (const [workerName, at] of lastAssignedAtByWorker) {
        const provider = providerOf.get(workerName);
        if (provider) lastAssignedAtByProvider.set(provider,
          Math.max(lastAssignedAtByProvider.get(provider) ?? 0, at));
      }
      // A card the platform just failed goes to another worker, and another
      // provider, first (owner decision 2026-11-15).
      const recentInfra = resumeRoutes.length ? await recentAmuxInfraFailureWorkers(tx, taskId) : [];
      const route = chooseAmuxV22WorkerRoute({ routes: resumeRoutes,
        priorAuthorWorkers: authorWorkers, priorAuthorProviders: authorProviders,
        isReview: card.taskRole === "review", activeByProvider, lastAssignedAtByWorker, lastAssignedAtByProvider,
        infraFailedWorkers: recentInfra,
        infraFailedProviders: recentInfra.flatMap((worker) => providerOf.get(worker) ?? []) });
      if (!route) {
        const settledNames = new Set(settled.routes.map((item) => item.workerName));
        const admittedNames = new Set(admittedRoutes.map((item) => item.workerName));
        const resumeNames = new Set(resumeRoutes.map((item) => item.workerName));
        const code = exactGradeRouting && matchingRoutes.length === 0 ? "no_worker_for_grade" :
          settled.routes.length > 0 && admittedRoutes.length === 0 ? "worker_quarantined" :
          settled.unsettled ? "usage_unverified" : "worker_unavailable";
        throw new AmuxClaimSkipError(code, { routes: routeDetail(runnable.routes, (item) => {
          const match = routeExclusion(item);
          if (match) return match;
          const quota = quotaExclusion(item);
          if (quota) return quota;
          if (!settledNames.has(item.workerName)) return "usage_unsettled";
          if (!admittedNames.has(item.workerName)) return "quarantined";
          if (!resumeNames.has(item.workerName)) return "resume_worker";
          return card.taskRole === "review" && authorWorkers.includes(item.workerName) ?
            "review_author" : null;
        }) });
      }
      if (recovery) {
        const quote = recovery.riskAcceptanceId ? amuxV22ReadOnlyRetryRouteCost({
          priorReservedMicroUsd: priorReserved,
          catalogApprovalId: recoveryApproved.approvalId, receipt: recoveryApproved.receipt,
          routeId: route.routeId, workerName: route.workerName,
          provider: route.provider, modelId: route.modelId }) :
          amuxV22RecoveryCost({ priorReservedMicroUsd: priorReserved,
            catalogApprovalId: approved.approvalId, receipt: approved.receipt });
        if (!amuxV22RecoveryStartAllowed({ approval: recovery, taskId,
          assignmentRevision: card.revision, historicalAttempts: prior.historicalRows,
          nextAttemptNumber: Math.max(prior.historicalRows, prior.greatestAttemptNumber ?? 0) + 1,
          priorReservedMicroUsd: priorReserved,
          assignedMicroUsd: BigInt(route.perAttemptMicroUsd),
          catalogApprovalId: approved.approvalId, costDigest: quote.costDigest }))
          throw new BoardImportError("recovery_approval_changed", 409);
      }
      const runtime = liveByName.get(route.workerName)!;
      const pinnedRuntime = await tx.$queryRaw<Array<{
        workerName: string; instanceId: string; generation: number;
        status: string; dispatchReady: boolean; leaseExpiresAt: Date;
        protocolCapabilities: string[];
      }>>`SELECT "workerName", "instanceId", "generation", "status",
        "dispatchReady", "leaseExpiresAt", "protocolCapabilities" FROM "AmuxWorkerRuntime"
        WHERE "workerName" = ${route.workerName} FOR UPDATE`;
      const pinned = pinnedRuntime[0];
      if (!pinned || pinned.instanceId !== runtime.instanceId ||
          pinned.generation !== runtime.generation ||
          pinned.status !== "idle" || !pinned.dispatchReady ||
          pinned.leaseExpiresAt.getTime() <= now.getTime() ||
          (amuxWorkerRuntimeUsesReadOnlyApi(pinned.protocolCapabilities) &&
            (!recovery?.riskAcceptanceId || recovery.readOnlyExecutorKind !==
              AMUX_V22_READ_ONLY_API_EXECUTOR_KIND)) ||
          (recovery?.riskAcceptanceId &&
            (pinned.protocolCapabilities.length !== 1 ||
             pinned.protocolCapabilities[0] !== recovery.readOnlyExecutorKind))) {
        throw new BoardImportError("worker_unavailable", 409);
      }
      // The prices this assignment reserves against. Its CLI usage is settled
      // at these, never at a price the registry gives later.
      const routePrice = amuxTaskRoutePrice(approved.catalog, route.routeId);
      if (!routePrice || routePrice.modelId !== route.modelId) {
        throw new BoardImportError("worker_unavailable", 409);
      }
      // Recorded, never refused (owner decision 2026-11-14): this route's
      // attempt would take the Task's reserved total past its approved
      // ceiling. Execution start records the same calculation.
      const ceilingOverrun = amuxApprovedCeilingOverrun({ approvedReceipt: approvedCost,
        priorReservedMicroUsd: priorReserved,
        nextAttemptMicroUsd: BigInt(route.perAttemptMicroUsd) });
      if (ceilingOverrun) console.warn(JSON.stringify({ subsystem: "amux",
        event: "v22_approved_ceiling_overrun", phase: "claim", taskId,
        assignmentId, workerName: route.workerName, routeId: route.routeId,
        ...ceilingOverrun }));
      const auditId = await writeSystemAuditLog({ tx,
        systemActor: AMUX_V22_WORKER_CLAIM_AUDIT_ACTOR,
        action: "amux.v22.worker.assigned",
        targetType: "AmuxV22WorkerAssignment", targetId: assignmentId,
        summary: "Assigned an owner-approved AMUX v4 Task to a verified worker.",
        metadata: { taskId, workerName: route.workerName,
          promotionReceiptId: promotion.id, lane: lane.lane,
          laneDecisionSequence: lane.sequence?.toString() ?? null,
          routeId: route.routeId, catalogApprovalId: approved.approvalId,
          costReceiptDigest: recoveryApproved.receipt.receiptDigest, routePrice,
          v52GradeRouting: exactGradeRouting,
          ...(recovery ? { recoveryApprovalId: recovery.id,
            recoveryCostDigest: recovery.costDigest } : {}),
          capacityAssigned: occupied.length,
          verifiedWorkerCount: verifiedNames.size,
          ...(ceilingOverrun ? { ceilingOverrun } : {}) },
      });
      await tx.amuxV22WorkerAssignment.create({ data: {
        id: assignmentId, workItemId: taskId,
        promotionReceiptId: promotion.id,
        laneDecisionSequence: lane.sequence, lane: lane.lane,
        taskRevision: card.revision, workerName: route.workerName,
        workerInstanceId: runtime.instanceId,
        workerGeneration: runtime.generation, provider: route.provider,
        modelId: route.modelId, role: card.taskRole,
        grade: card.executionGrade, routeId: route.routeId,
        routePolicyDigest: route.routePolicyDigest,
        catalogApprovalId: approved.approvalId,
        catalogVersion: approved.receipt.catalogVersion,
        costReceiptDigest: recoveryApproved.receipt.receiptDigest,
        perAttemptMicroUsd: BigInt(route.perAttemptMicroUsd),
        recoveryApprovalId: recovery?.id ?? null,
        authorizationAuditLogId: auditId, assignedAt: now,
      } });
      const changed = await tx.amuxWorkItem.updateMany({ where: {
        id: taskId, sourceSystem: "admin-idea-v4", cardType: "task",
        status: "todo", archivedAt: null, owner: null, claimedAt: null,
        v22ReceiptId: promotion.id, v22AssignmentId: null,
        revision: card.revision,
      }, data: { owner: route.workerName, claimedAt: now,
        v22AssignmentId: assignmentId, revision: { increment: 1 } } });
      if (changed.count !== 1) throw new BoardImportError("conflict", 409);
      recordReceipt("work_item", taskId, 1);
      recordReceipt("v22_worker_assignment", assignmentId, 1);
      return { claimed: true as const, taskId, assignmentId,
        workerName: route.workerName };
    });
}

async function readBackLostClaim(taskId: string, assignmentId: string) {
  return withAutoTransaction(assignmentId, TICK_TRANSACTION_LIMITS,
    async (tx) => {
      const receipt = await tx.amuxV22WorkerAssignment.findUnique({
        where: { id: assignmentId }, select: { workItemId: true,
          workerName: true, authorizationAuditLogId: true },
      });
      const card = receipt ? await tx.amuxWorkItem.findUnique({
        where: { id: taskId }, select: { v22AssignmentId: true,
          owner: true, status: true },
      }) : null;
      const audit = receipt ? await tx.adminAuditLog.findUnique({
        where: { id: receipt.authorizationAuditLogId },
        select: { action: true, targetId: true, entryHash: true },
      }) : null;
      if (receipt?.workItemId === taskId && card?.v22AssignmentId === assignmentId &&
          card.status === "todo" && card.owner === receipt.workerName &&
          audit?.entryHash && audit.action === "amux.v22.worker.assigned" &&
          audit.targetId === assignmentId) return { claimed: true as const,
        taskId, assignmentId, workerName: receipt.workerName };
      return { claimed: false as const, reason: "outcome_unknown" as const };
    });
}

type ClaimTickResult =
  | { claimed: true; taskId: string; assignmentId: string; workerName: string }
  | { claimed: false; reason: string };

/** Reasons a candidate is passed over while the tick goes on to the next.
 * A reason about one card's own route or approval never holds the others
 * (AMUX process audit bundle 3, AMUXFLOW/B3: a card that needed a cost
 * reconfirmation stopped every tick from 2026-11-13 22:23 AEST). */
const SKIPPED_CODES = new Set(["not_unassigned_todo", "task_not_ready",
  "worker_unavailable", "one_shot_role_unavailable", "attempt_budget_exhausted",
  "review_author_unknown", "conflict", "usage_unverified", "no_worker_for_grade",
  "cost_reconfirmation_required", "lane_unbound", "recovery_approval_changed",
  "role_unavailable", "worker_quarantined",
  // One card waiting out its platform-failure backoff never holds the rest
  // (review r-20261116-184542-69dcb8). So does one waiting out a repeated
  // result failure (owner direction 2026-11-18).
  "infra_retry_backoff", "result_retry_backoff"]);

/**
 * One admitted tick assigns every ready Task it can, one transaction each, up
 * to the global capacity (owner decision 2026-11-13; it used to assign one
 * Task per tick, so a queue of ten took fifty minutes to reach the workers).
 * It never starts execution. The reply names the first assignment; one line
 * of log names how many were made and why the others were passed over.
 */
export async function tickV22WorkerClaim(): Promise<ClaimTickResult> {
  const rows = await prisma.$transaction((tx) => candidates(tx));
  // Read once per tick, before any claim: which workers wait out a quarantine
  // after repeated infrastructure failures (owner decision 2026-11-15). A
  // failed read quarantines nobody.
  const circuits = await readAmuxWorkerCircuits().catch(() => new Map<string, AmuxWorkerCircuit>());
  if (!rows.length) {
    await reportOpenAmuxWorkerCircuits(circuits);
    return { claimed: false as const, reason: "no_candidate" as const };
  }
  const claims: Array<Extract<ClaimTickResult, { claimed: true }>> = [];
  const skipped: Record<string, number> = {};
  // Why each card passed over waits, stored for its Admin card.
  const waits: AmuxCardWaitEntry[] = [];
  let stop: string | null = null;
  let stopIndex = rows.length;
  for (const [index, candidate] of rows.entries()) {
    // Two claim transactions' room left: this one and the stores below.
    if (!amuxRouteHasBudgetForMs(2 * AUTO_TICK_TRANSACTION_MAX_MS)) {
      skipped.tick_budget = rows.length - index;
      break;
    }
    let context: Awaited<ReturnType<typeof loadAmuxV4TaskReadyContext>>;
    try { context = await loadAmuxV4TaskReadyContext(candidate.id); }
    catch {
      skipped.context_unreadable = (skipped.context_unreadable ?? 0) + 1;
      waits.push({ taskId: candidate.id, stage: "claim", code: "context_unreadable", detail: {} });
      continue;
    }
    const assignmentId = randomUUID();
    try {
      const claimed = await claimCandidate(candidate.id, assignmentId, context, circuits);
      if (claimed.claimed) claims.push(claimed);
    } catch (error) {
      if (!(error instanceof BoardImportError)) throw error;
      if (error.code === "outcome_unknown") {
        // Read the lost write back once; never claim past an unknown outcome.
        let readBack: ClaimTickResult;
        try { readBack = await readBackLostClaim(candidate.id, assignmentId); }
        catch { readBack = { claimed: false, reason: "outcome_unknown" }; }
        if (readBack.claimed) { claims.push(readBack); continue; }
        stop = "outcome_unknown";
        stopIndex = index;
        break;
      }
      if (SKIPPED_CODES.has(error.code)) {
        skipped[error.code] = (skipped[error.code] ?? 0) + 1;
        waits.push({ taskId: candidate.id, stage: "claim", code: error.code,
          detail: error instanceof AmuxClaimSkipError ? error.detail : {} });
        continue;
      }
      // Global capacity full, or a reason that holds every candidate alike.
      stop = error.code;
      stopIndex = index;
      break;
    }
  }
  // A stop holds this card and every one after it alike.
  if (stop && stop !== "outcome_unknown") for (const candidate of rows.slice(stopIndex))
    waits.push({ taskId: candidate.id, stage: "claim", code: stop, detail: { holdsAll: true } });
  await recordAmuxCardWaitReasons(waits);
  await clearAmuxCardWaitReasons(claims.map((claim) => claim.taskId));
  await reportLongAmuxCardWaits();
  await reportOpenAmuxWorkerCircuits(circuits);
  console.info(JSON.stringify({ event: "amux_v22_claim_tick",
    candidates: rows.length, claimed: claims.length,
    workers: claims.map((claim) => claim.workerName), skipped, stop,
    quarantined: [...circuits].filter(([, circuit]) => circuit.state === "open")
      .map(([worker]) => worker) }));
  if (claims.length > 0) return claims[0]!;
  if (stop) return { claimed: false as const, reason: stop };
  return { claimed: false as const, reason: skipped.no_worker_for_grade ?
    "no_worker_for_grade" as const : "no_ready_candidate" as const };
}
