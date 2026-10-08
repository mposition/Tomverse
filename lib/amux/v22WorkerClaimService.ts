import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V22_WORKER_CLAIM_AUDIT_ACTOR } from
  "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { BoardImportError } from "./boardImportCore.ts";
import type { AmuxOrchestratorReceiptRecorder } from "./dbBoundary.ts";
import { findOpenAmuxOrchestratorHalt } from "./orchestratorHaltStore.ts";
import { lockAmuxAdmissionAndReadIncident } from "./incident.ts";
import { getConfiguredAmuxWorkerCatalog } from "./routing.ts";
import { getAmuxWorkerTelemetry } from "./telemetry.ts";
import { TICK_TRANSACTION_LIMITS, withAutoTransaction } from
  "./autoPromotionService.ts";
import { calculateCurrentApprovedAmuxV4TaskCost } from
  "./v4TaskCostCatalogApprovalService.ts";
import { checkV4TaskApprovedCeiling } from "./v4TaskCostCeilingCore.ts";
import { evaluateAmuxV4TaskReadyInTransaction,
  loadAmuxV4TaskReadyContext } from "./v4TaskReadyService.ts";
import { amuxV22ClaimCapacity, amuxV22RequiredTool,
  amuxV22OneShotRoleSupported, amuxV22OneShotRouteSupported,
  amuxV22WorkerClaimEnabled, chooseAmuxV22WorkerRoute,
  AMUX_V22_WORKER_CLAIM_ENV, type AmuxV22ClaimLane } from
  "./v22WorkerClaimCore.ts";

type Candidate = { id: string };
const MAX_CANDIDATES = 12;

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
  context: Awaited<ReturnType<typeof loadAmuxV4TaskReadyContext>>) {
  return withAutoTransaction(assignmentId, TICK_TRANSACTION_LIMITS,
    async (tx, now, recordReceipt: AmuxOrchestratorReceiptRecorder) => {
      const incident = await lockAmuxAdmissionAndReadIncident(tx, now);
      if (incident.blocks_admission) throw new BoardImportError("incident_blocked", 409);
      const halt = await findOpenAmuxOrchestratorHalt(tx);
      if (halt) throw new BoardImportError("orchestrator_halted", 409);
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
      if (!ready.ready || !promotion || promotion.workItemId !== taskId ||
          promotion.sourceApprovalId !== ready.sourceApprovalId ||
          promotion.briefDigest !== ready.briefDigest) {
        throw new BoardImportError("task_not_ready", 409);
      }
      if (!amuxV22OneShotRoleSupported(card.taskRole)) {
        throw new BoardImportError("one_shot_role_unavailable", 409);
      }
      const lane = await currentLane(tx, taskId);
      const catalog = getConfiguredAmuxWorkerCatalog();
      if (!catalog) throw new BoardImportError("worker_catalog_unavailable", 409);
      const live = await tx.amuxWorkerRuntime.findMany({ where: {
        workerName: { in: catalog.map((worker) => worker.worker_name) },
        leaseExpiresAt: { gt: now }, status: { in: ["idle", "busy"] },
      }, select: { workerName: true, instanceId: true, generation: true,
        status: true, dispatchReady: true } });
      const liveByName = new Map(live.map((worker) => [worker.workerName, worker]));
      const verifiedNames = new Set(catalog.filter((worker) =>
        !worker.archived && !worker.paused && !worker.isolated &&
        !worker.blocked && liveByName.has(worker.worker_name)).map(
        (worker) => worker.worker_name));
      const occupied = await tx.amuxWorkItem.findMany({ where: {
        owner: { not: null }, archivedAt: null,
        status: { in: ["todo", "doing", "review"] },
      }, select: { id: true, owner: true, v22AssignmentId: true,
        sourceSystem: true },
      });
      const assignedIds = occupied.map((item) => item.v22AssignmentId).filter(
        (id): id is string => id !== null);
      const assignments = assignedIds.length ?
        await tx.amuxV22WorkerAssignment.findMany({ where: {
          id: { in: assignedIds } }, select: { id: true, lane: true },
        }) : [];
      const lanes = new Map(assignments.map((item) => [item.id, item.lane]));
      const laneAssigned = occupied.filter((item) =>
        (item.v22AssignmentId ? lanes.get(item.v22AssignmentId) ?? "normal" :
          "normal") === lane.lane).length;
      const capacity = amuxV22ClaimCapacity({ lane: lane.lane,
        verifiedWorkerCount: verifiedNames.size,
        totalAssigned: occupied.length, laneAssigned });
      if (!capacity.allowed) throw new BoardImportError(capacity.reason, 409);

      const approved = await calculateCurrentApprovedAmuxV4TaskCost(tx,
        card.taskRole, card.executionGrade);
      const source = ready.sourceApprovalId ?
        await tx.amuxIdeaUnitDecision.findUnique({
          where: { id: ready.sourceApprovalId },
          select: { confirmationSnapshot: true },
        }) : null;
      const snapshot = source?.confirmationSnapshot;
      const approvedCost = snapshot && typeof snapshot === "object" &&
        !Array.isArray(snapshot) && "card" in snapshot &&
        snapshot.card && typeof snapshot.card === "object" &&
        !Array.isArray(snapshot.card) && "task" in snapshot.card &&
        snapshot.card.task && typeof snapshot.card.task === "object" &&
        !Array.isArray(snapshot.card.task) && "costReceipt" in snapshot.card.task ?
          snapshot.card.task.costReceipt : null;
      if (checkV4TaskApprovedCeiling(approvedCost,
        { ok: true, receipt: approved.receipt }).decision !== "allow") {
        throw new BoardImportError("cost_reconfirmation_required", 409);
      }
      const requiredTool = amuxV22RequiredTool(card.taskRole);
      if (!requiredTool) throw new BoardImportError("role_unavailable", 409);
      const busy = new Set(occupied.map((item) => item.owner));
      const matchingRoutes = approved.receipt.routes.filter((route) => {
        const worker = catalog.find((item) => item.worker_name === route.workerName);
        const runtime = liveByName.get(route.workerName);
        return worker && runtime?.status === "idle" && runtime.dispatchReady &&
          !busy.has(route.workerName) && verifiedNames.has(route.workerName) &&
          amuxV22OneShotRouteSupported(route.provider, route.modelId) &&
          worker.provider === route.provider.toLowerCase() &&
          worker.model === route.modelId &&
          worker.routing_roles.includes(card.taskRole!) &&
          worker.tool_capabilities.includes(requiredTool);
      });
      const telemetry = await getAmuxWorkerTelemetry(catalog.filter((worker) =>
        matchingRoutes.some((route) => route.workerName === worker.worker_name)), now, tx);
      const quotaRoutes = matchingRoutes.filter((route) => {
        const quota = telemetry.get(route.workerName);
        return quota?.evidence.quota.state === "fresh" &&
          !quota.scoring.provider_exhausted &&
          (quota.scoring.quota_remaining.value ?? 0) > 0;
      });
      const authors = card.taskRole === "review" ?
        await implementAuthors(tx, taskId) : [];
      if (card.taskRole === "review" && authors.length === 0) {
        throw new BoardImportError("review_author_unknown", 409);
      }
      const authorWorkers = authors.map((author) => author.workerName);
      const authorProviders = authors.map((author) => author.provider);
      const route = chooseAmuxV22WorkerRoute({ routes: quotaRoutes,
        priorAuthorWorkers: authorWorkers, priorAuthorProviders: authorProviders,
        isReview: card.taskRole === "review" });
      if (!route) throw new BoardImportError("worker_unavailable", 409);
      // Never treat a prior v4 worker's absent/partial CLI observation as a
      // zero-cost run when admitting another cost-bound assignment. A15 owns
      // the audited owner-release and reservation-occupancy recovery path.
      const usageUnknown = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT a."id" FROM "AmuxExecutionAttempt" a
        JOIN "AmuxWorkItem" w ON w."id" = a."taskId"
        WHERE a."worker" = ${route.workerName}
          AND a."endedAt" IS NOT NULL
          AND w."sourceSystem" = 'admin-idea-v4'
          AND (NOT EXISTS (SELECT 1 FROM "AmuxCliUsageEvent" u
               WHERE u."attemptId" = a."id")
            OR EXISTS (SELECT 1 FROM "AmuxCliUsageEvent" u
               WHERE u."attemptId" = a."id"
                 AND u."completeness" <> 'reported_complete'))
        LIMIT 1`;
      if (usageUnknown.length) throw new BoardImportError("usage_unverified", 409);
      const runtime = liveByName.get(route.workerName)!;
      const pinnedRuntime = await tx.$queryRaw<Array<{
        workerName: string; instanceId: string; generation: number;
        status: string; dispatchReady: boolean; leaseExpiresAt: Date;
      }>>`SELECT "workerName", "instanceId", "generation", "status",
        "dispatchReady", "leaseExpiresAt" FROM "AmuxWorkerRuntime"
        WHERE "workerName" = ${route.workerName} FOR UPDATE`;
      const pinned = pinnedRuntime[0];
      if (!pinned || pinned.instanceId !== runtime.instanceId ||
          pinned.generation !== runtime.generation ||
          pinned.status !== "idle" || !pinned.dispatchReady ||
          pinned.leaseExpiresAt.getTime() <= now.getTime()) {
        throw new BoardImportError("worker_unavailable", 409);
      }
      const auditId = await writeSystemAuditLog({ tx,
        systemActor: AMUX_V22_WORKER_CLAIM_AUDIT_ACTOR,
        action: "amux.v22.worker.assigned",
        targetType: "AmuxV22WorkerAssignment", targetId: assignmentId,
        summary: "Assigned an owner-approved AMUX v4 Task to a verified worker.",
        metadata: { taskId, workerName: route.workerName,
          promotionReceiptId: promotion.id, lane: lane.lane,
          laneDecisionSequence: lane.sequence?.toString() ?? null,
          routeId: route.routeId, catalogApprovalId: approved.approvalId,
          costReceiptDigest: approved.receipt.receiptDigest,
          capacityAssigned: occupied.length,
          verifiedWorkerCount: verifiedNames.size },
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
        costReceiptDigest: approved.receipt.receiptDigest,
        perAttemptMicroUsd: BigInt(route.perAttemptMicroUsd),
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

/** One admitted tick assigns at most one Task, without starting execution. */
export async function tickV22WorkerClaim() {
  if (!amuxV22WorkerClaimEnabled(process.env[AMUX_V22_WORKER_CLAIM_ENV])) {
    return { claimed: false as const, reason: "apply_disabled" as const };
  }
  const rows = await prisma.$transaction((tx) => candidates(tx));
  if (!rows.length) return { claimed: false as const, reason: "no_candidate" as const };
  for (const candidate of rows) {
    let context: Awaited<ReturnType<typeof loadAmuxV4TaskReadyContext>>;
    try { context = await loadAmuxV4TaskReadyContext(candidate.id); }
    catch { continue; }
    const assignmentId = randomUUID();
    try { return await claimCandidate(candidate.id, assignmentId, context); }
    catch (error) {
      if (!(error instanceof BoardImportError)) throw error;
      if (error.code === "outcome_unknown") {
        try { return await readBackLostClaim(candidate.id, assignmentId); }
        catch { return { claimed: false as const,
          reason: "outcome_unknown" as const }; }
      }
      if (["not_unassigned_todo", "task_not_ready", "worker_unavailable",
        "one_shot_role_unavailable",
        "review_author_unknown", "reserved_capacity_unavailable",
        "lane_capacity_full", "conflict"].includes(error.code)) continue;
      return { claimed: false as const, reason: error.code };
    }
  }
  return { claimed: false as const, reason: "no_ready_candidate" as const };
}
