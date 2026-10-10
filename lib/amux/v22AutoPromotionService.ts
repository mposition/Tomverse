import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { BoardImportError } from "./boardImportCore.ts";
import type { AmuxOrchestratorReceiptRecorder } from "./dbBoundary.ts";
import { findOpenAmuxOrchestratorHalt } from "./orchestratorHaltStore.ts";
import { AMUX_INCIDENT_SETTING_KEY, parseAmuxIncidentSetting } from
  "./incidentCore.ts";
import { getConfiguredAmuxWorkerCatalog } from "./routing.ts";
import { AUTO_PROMOTION_APPLY_ENV, AUTO_PROMOTION_CODE_LATCH,
  AUTO_UNKNOWN_BURST_COUNT, AUTO_UNKNOWN_BURST_MS,
  autoCostAccepted, autoGraduationAccepted, autoUnknownEvents,
  autoPromotionApplyPermitted } from
  "./autoPromotionCore.ts";
import { OWNER_TRANSACTION_LIMITS, TICK_TRANSACTION_LIMITS,
  withAutoTransaction } from
  "./autoPromotionService.ts";
import { AMUX_PORTFOLIO_SCORE_VERSION } from "./portfolioScoreCore.ts";
import { evaluateAmuxV4TaskReadyInTransaction,
  loadAmuxV4TaskReadyContext } from "./v4TaskReadyService.ts";
import { AMUX_V22_AUTO_PROMOTION_CODE_LATCH,
  AMUX_V22_AUTO_PROMOTION_ENV, AMUX_V22_AUTO_PROMOTION_POLICY_VERSION,
  AMUX_V22_GRADUATION_EXCEPTION_ENV, AMUX_V22_GRADUATION_EXCEPTION_ID,
  AMUX_V22_GRADUATION_EXCEPTION_POLICY_VERSION,
  AMUX_V22_PARALLEL_RESERVED, AMUX_V22_SEV1_RESERVED,
  amuxV22AssessmentIdsCurrent, amuxV22AutoPromotionEnabled, amuxV22Capacity,
  amuxV22ScoreCurrent, amuxV22GraduationExceptionEnabled,
  amuxV22GraduationPermitted } from "./v22AutoPromotionCore.ts";
import { writeV22AutoPromotionAudit } from "./v22AutoPromotionAudit.ts";

type Candidate = { id: string; taskId: string; scoreTotal: number };
const MAX_CANDIDATES_PER_TICK = 8;
const V22_AUDIT_ACTION = "amux.v22.auto_promotion.consumed";

async function openV22CriticalHalt(tx: Prisma.TransactionClient, now: Date,
  code: "cost_exceeded" | "lifecycle_write",
  recordReceipt: AmuxOrchestratorReceiptRecorder) {
  const already = await tx.amuxRecommendationAutoHalt.findFirst({
    where: { clearedAt: null }, select: { id: true },
  });
  if (already) return { promoted: false as const,
    reason: "auto_halted" as const, haltId: already.id };
  const haltId = randomUUID();
  const auditId = await writeV22AutoPromotionAudit(tx, {
    action: "amux.auto_promotion.halted",
    targetType: "AmuxRecommendationAutoHalt", targetId: haltId,
    summary: "Halted v22 promotion after a critical violation.",
    metadata: { violationCode: code },
  });
  await tx.amuxRecommendationAutoHalt.create({ data: { id: haltId,
    reason: "critical_violation", violationCode: code,
    actorUserId: "system:amux-v22-auto-admit",
    authorizationAuditLogId: auditId, openedAt: now } });
  recordReceipt("v22_promotion_halt", haltId, 1);
  return { promoted: false as const, reason: "auto_halted" as const,
    haltId };
}

/** Owner activation is separate from the v8 switch. Deactivation remains
 * available even while the environment gate is closed. */
export async function configureV22AutoPromotion(input: {
  session: Session; request: Request; active: boolean;
  expectedAuditLogId: string | null;
  graduationExceptionId?: typeof AMUX_V22_GRADUATION_EXCEPTION_ID;
}) {
  const actorUserId = input.session.user?.id;
  if (!actorUserId) throw new BoardImportError("forbidden", 403);
  const exceptionRequested = input.graduationExceptionId ===
    AMUX_V22_GRADUATION_EXCEPTION_ID;
  if (input.graduationExceptionId !== undefined && (!input.active ||
      !exceptionRequested || !amuxV22GraduationExceptionEnabled(
        process.env[AMUX_V22_GRADUATION_EXCEPTION_ENV]))) {
    throw new BoardImportError("graduation_exception_unavailable", 409);
  }
  const exceptionMetadata = exceptionRequested ? {
    graduationExceptionId: AMUX_V22_GRADUATION_EXCEPTION_ID,
    graduationExceptionPolicyVersion: AMUX_V22_GRADUATION_EXCEPTION_POLICY_VERSION,
  } : {};
  if (input.active && !AMUX_V22_AUTO_PROMOTION_CODE_LATCH) {
    throw new BoardImportError("apply_disabled", 409);
  }
  return withAutoTransaction(null, OWNER_TRANSACTION_LIMITS,
    async (tx, now) => {
      const current = await tx.amuxV22PromotionControl.findUnique({
        where: { id: "queue" },
      });
      if ((current?.authorizationAuditLogId ?? null) !==
          input.expectedAuditLogId) {
        throw new BoardImportError("conflict", 409);
      }
      if ((current?.active ?? false) === input.active && !exceptionRequested) {
        return { active: input.active, changed: false as const,
          authorizationAuditLogId: current?.authorizationAuditLogId ?? null };
      }
      if (input.active) {
        if (autoPromotionApplyPermitted({
          envValue: process.env[AUTO_PROMOTION_APPLY_ENV],
          codeLatch: AUTO_PROMOTION_CODE_LATCH,
        })) throw new BoardImportError("legacy_auto_promotion_enabled", 409);
        const decisions = await tx.amuxRecommendationDecision.findMany({
          where: { decision: "approve", status: "consumed" },
          select: { createdAt: true },
        });
        if (!amuxV22GraduationPermitted({
          graduated: autoGraduationAccepted(decisions).ok,
          environmentValue: process.env[AMUX_V22_GRADUATION_EXCEPTION_ENV],
          authorization: exceptionMetadata,
        })) {
          throw new BoardImportError("graduation_unmet", 409);
        }
        const [halt, orchestratorHalt, capacity] = await Promise.all([
          tx.amuxRecommendationAutoHalt.findFirst({
            where: { clearedAt: null }, select: { id: true },
          }),
          findOpenAmuxOrchestratorHalt(tx),
          readCapacity(tx, now),
        ]);
        if (halt || orchestratorHalt) {
          throw new BoardImportError("auto_halted", 409);
        }
        if (!capacity.row?.active || capacity.decision.normalLimit < 1) {
          throw new BoardImportError("capacity_unconfigured", 409);
        }
      }
      const action = input.active ?
        "amux.v22.auto_promotion.activated" :
        "amux.v22.auto_promotion.deactivated";
      const auditId = await writeAdminAuditLog({ tx, session: input.session,
        request: input.request, action,
        targetType: "AmuxV22PromotionControl", targetId: "queue",
        summary: input.active ? "Activated v22 Task auto-promotion." :
          "Deactivated v22 Task auto-promotion.",
        metadata: { policyVersion: AMUX_V22_AUTO_PROMOTION_POLICY_VERSION,
          active: input.active, ...exceptionMetadata },
      });
      await tx.amuxV22PromotionControl.upsert({
        where: { id: "queue" },
        create: { id: "queue", active: input.active, approvedByUserId:
          actorUserId, authorizationAuditLogId: auditId,
          activatedAt: now },
        update: { active: input.active, approvedByUserId: actorUserId,
          authorizationAuditLogId: auditId,
          activatedAt: input.active ? now : current?.activatedAt ?? now },
      });
      return { active: input.active, changed: true as const,
        authorizationAuditLogId: auditId };
    });
}

export async function readV22AutoPromotionControl() {
  const row = await prisma.amuxV22PromotionControl.findUnique({
    where: { id: "queue" }, select: { active: true, activatedAt: true,
      authorizationAuditLogId: true, approvedByUserId: true },
  });
  const [decisions, audit] = await Promise.all([
    prisma.amuxRecommendationDecision.findMany({
      where: { decision: "approve", status: "consumed" },
      select: { createdAt: true },
    }),
    row ? prisma.adminAuditLog.findUnique({
      where: { id: row.authorizationAuditLogId },
      select: { action: true, targetType: true, targetId: true,
        entryHash: true, metadata: true, actorUserId: true },
    }) : null,
  ]);
  const graduation = autoGraduationAccepted(decisions);
  return { codeLatch: AMUX_V22_AUTO_PROMOTION_CODE_LATCH,
    environmentEnabled: process.env[AMUX_V22_AUTO_PROMOTION_ENV] === "enabled",
    active: row?.active ?? false,
    activatedAt: row?.activatedAt ?? null,
    authorizationAuditLogId: row?.authorizationAuditLogId ?? null,
    graduation,
    graduationExceptionId: AMUX_V22_GRADUATION_EXCEPTION_ID,
    graduationExceptionAvailable: amuxV22GraduationExceptionEnabled(
      process.env[AMUX_V22_GRADUATION_EXCEPTION_ENV]),
    graduationExceptionApplied: Boolean(row?.active && audit?.entryHash &&
      audit.actorUserId === row.approvedByUserId &&
      audit.action === "amux.v22.auto_promotion.activated" &&
      audit.targetType === "AmuxV22PromotionControl" && audit.targetId === "queue" &&
      amuxV22GraduationPermitted({ graduated: false,
        environmentValue: process.env[AMUX_V22_GRADUATION_EXCEPTION_ENV],
        authorization: audit.metadata })),
  };
}

async function latestCandidates(tx: Prisma.TransactionClient, now: Date):
  Promise<Candidate[]> {
  return tx.$queryRaw<Candidate[]>`
    WITH newest AS (
      SELECT DISTINCT ON (s."taskId") s."id", s."taskId",
        s."scoreTotal", s."activeStaleAt", s."baselineStaleAt"
      FROM "AmuxPortfolioScoreSnapshot" s
      ORDER BY s."taskId", s."computedAt" DESC, s."id" DESC
    )
    SELECT n."id"::text AS "id", n."taskId", n."scoreTotal"
    FROM newest n JOIN "AmuxWorkItem" w ON w."id" = n."taskId"
    WHERE w."sourceSystem" = 'admin-idea-v4' AND w."cardType" = 'task'
      AND w."status" = 'backlog' AND w."archivedAt" IS NULL
      AND w."owner" IS NULL AND w."claimedAt" IS NULL
      AND n."activeStaleAt" > ${now} AND n."baselineStaleAt" > ${now}
      AND NOT EXISTS (SELECT 1 FROM "AmuxV22PromotionUnknown" u
        WHERE u."workItemId" = w."id")
    ORDER BY n."scoreTotal" DESC, n."taskId" ASC
    LIMIT ${MAX_CANDIDATES_PER_TICK}
  `;
}

async function verifiedWorkerCount(tx: Prisma.TransactionClient, now: Date) {
  const catalog = getConfiguredAmuxWorkerCatalog();
  if (!catalog) return 0;
  const names = [...new Set(catalog.filter((worker) => !worker.archived &&
    !worker.paused && !worker.isolated && !worker.blocked).map(
      (worker) => worker.worker_name))];
  if (!names.length) return 0;
  return tx.amuxWorkerRuntime.count({ where: {
    workerName: { in: names }, leaseExpiresAt: { gt: now },
    status: { in: ["idle", "busy"] },
  } });
}

async function requireV22GlobalGate(tx: Prisma.TransactionClient, now: Date) {
  if (autoPromotionApplyPermitted({
    envValue: process.env[AUTO_PROMOTION_APPLY_ENV],
    codeLatch: AUTO_PROMOTION_CODE_LATCH,
  })) throw new BoardImportError("legacy_auto_promotion_enabled", 409);
  const control = await tx.amuxV22PromotionControl.findUnique({
    where: { id: "queue" },
  });
  if (!control?.active || control.activatedAt > now) {
    throw new BoardImportError("v22_not_activated", 409);
  }
  const activationAudit = await tx.adminAuditLog.findUnique({
    where: { id: control.authorizationAuditLogId },
    select: { action: true, actorUserId: true, targetType: true,
      targetId: true, entryHash: true, metadata: true },
  });
  if (!activationAudit?.entryHash ||
      activationAudit.action !== "amux.v22.auto_promotion.activated" ||
      activationAudit.actorUserId !== control.approvedByUserId ||
      activationAudit.targetType !== "AmuxV22PromotionControl" ||
      activationAudit.targetId !== "queue") {
    throw new BoardImportError("v22_not_activated", 409);
  }
  const [halt, orchestratorHalt, incident, decisions, entries] = await Promise.all([
    tx.amuxRecommendationAutoHalt.findFirst({
      where: { clearedAt: null }, select: { id: true } }),
    findOpenAmuxOrchestratorHalt(tx),
    tx.appSetting.findUnique({ where: { key: AMUX_INCIDENT_SETTING_KEY },
      select: { value: true } }),
    tx.amuxRecommendationDecision.findMany({
      where: { decision: "approve", status: "consumed" },
      select: { createdAt: true },
    }),
    tx.amuxRecommendationAutoCostEntry.findMany({
      select: { amountCents: true, recordedAt: true },
    }),
  ]);
  if (halt || orchestratorHalt) throw new BoardImportError("auto_halted", 409);
  if (parseAmuxIncidentSetting(incident?.value).blocks_admission) {
    throw new BoardImportError("incident_blocked", 409);
  }
  const graduation = autoGraduationAccepted(decisions);
  if (!amuxV22GraduationPermitted({ graduated: graduation.ok,
    environmentValue: process.env[AMUX_V22_GRADUATION_EXCEPTION_ENV],
    authorization: activationAudit.metadata,
  })) throw new BoardImportError("graduation_unmet", 409);
  const cost = autoCostAccepted({ proposedCents: 0, entries, now });
  return cost.ok ? null : cost.code;
}

async function readCapacity(tx: Prisma.TransactionClient, now: Date) {
  const [row, occupied, workers] = await Promise.all([
    tx.amuxRecommendationCapacity.findUnique({ where: { id: "queue" } }),
    tx.amuxWorkItem.count({ where: { archivedAt: null,
      status: { in: ["todo", "doing"] } } }),
    verifiedWorkerCount(tx, now),
  ]);
  const decision = amuxV22Capacity({ active: row?.active ?? false,
    wipLimit: row?.wipLimit ?? null, verifiedWorkerCount: workers,
    occupied });
  return { row, occupied, workers, decision };
}

async function commitCandidate(input: { candidate: Candidate; receiptId: string;
  context: Awaited<ReturnType<typeof loadAmuxV4TaskReadyContext>> }) {
  return withAutoTransaction(input.receiptId, TICK_TRANSACTION_LIMITS,
    async (tx, now, recordReceipt) => {
      // The same queue lock as v8 serializes the total occupancy calculation.
      const critical = await requireV22GlobalGate(tx, now);
      if (critical === "cost_exceeded") {
        return openV22CriticalHalt(tx, now, critical, recordReceipt);
      }
      const capacity = await readCapacity(tx, now);
      if (capacity.occupied > capacity.decision.queueLimit &&
          capacity.decision.queueLimit > 0) {
        // Worker leases can lapse while existing Todo/doing cards remain.
        // That is temporary saturation, not an irreversible violation.
        throw new BoardImportError("capacity_full", 409);
      }
      if (!capacity.decision.allowed || !capacity.row?.wipLimit) {
        throw new BoardImportError(capacity.decision.reason ?? "capacity_full", 409);
      }
      // Owner assessment and score approvals take this lock before their
      // subject row. Keep the same order and read the latest evidence only
      // after the lock, so a superseded score cannot promote a Task.
      await takeAuditChainLock(tx);
      const top = await latestCandidates(tx, now);
      const current = top.find((row) => row.taskId === input.candidate.taskId);
      if (!current || current.id !== input.candidate.id) {
        throw new BoardImportError("score_changed", 409);
      }
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "AmuxWorkItem"
        WHERE "id" = ${current.taskId} FOR UPDATE`;
      if (locked.length !== 1) throw new BoardImportError("not_backlog", 409);
      const ready = await evaluateAmuxV4TaskReadyInTransaction(tx,
        current.taskId, input.context, null);
      if (!ready.ready || !ready.sourceApprovalId ||
          !ready.sourceApprovalDigest || !ready.briefDigest ||
          !ready.parentFeatureNodeId) {
        throw new BoardImportError("task_not_ready", 409);
      }
      const score = await tx.amuxPortfolioScoreSnapshot.findUnique({
        where: { id: current.id },
        select: { id: true, taskId: true, taskRevision: true,
          sourceApprovalId: true, scoreVersion: true, scoreTotal: true,
          activeStaleAt: true, baselineStaleAt: true,
          approvalAuditLogId: true,
          initiativeAssessmentId: true, epicAssessmentId: true,
          featureAssessmentId: true, storyAssessmentId: true,
          taskAssessmentId: true,
          initiativeAssessment: { select: { nodeId: true } },
          epicAssessment: { select: { nodeId: true } },
          featureAssessment: { select: { nodeId: true } },
          storyAssessment: { select: { cardId: true } },
          taskAssessment: { select: { cardId: true } } },
      });
      if (!score || score.taskId !== current.taskId ||
          !amuxV22ScoreCurrent({ scoreVersion: score.scoreVersion,
            expectedVersion: AMUX_PORTFOLIO_SCORE_VERSION,
            taskRevision: score.taskRevision,
            currentRevision: ready.taskRevision,
            sourceApprovalId: score.sourceApprovalId,
            currentSourceApprovalId: ready.sourceApprovalId,
            activeStaleAt: score.activeStaleAt,
            baselineStaleAt: score.baselineStaleAt, now })) {
        throw new BoardImportError("score_changed", 409);
      }
      const initiativeNodeId = score.initiativeAssessment.nodeId;
      const epicNodeId = score.epicAssessment.nodeId;
      const featureNodeId = score.featureAssessment.nodeId;
      const storyCardId = score.storyAssessment?.cardId ?? null;
      if (!initiativeNodeId || !epicNodeId ||
          featureNodeId !== ready.parentFeatureNodeId ||
          storyCardId !== ready.parentStoryCardId ||
          score.taskAssessment.cardId !== current.taskId ||
          (score.storyAssessmentId === null) !==
            (ready.parentStoryCardId === null)) {
        throw new BoardImportError("score_changed", 409);
      }
      const assessmentBindings = [
        { id: score.initiativeAssessmentId, where: { nodeId: initiativeNodeId } },
        { id: score.epicAssessmentId, where: { nodeId: epicNodeId } },
        { id: score.featureAssessmentId, where: { nodeId: featureNodeId } },
        ...(storyCardId && score.storyAssessmentId ? [{
          id: score.storyAssessmentId, where: { cardId: storyCardId },
        }] : []),
        { id: score.taskAssessmentId, where: { cardId: current.taskId } },
      ];
      const latestAssessments = await Promise.all(assessmentBindings.map(
        (binding) => tx.amuxPortfolioAssessment.findFirst({
          where: binding.where,
          orderBy: { assessmentVersion: "desc" }, select: { id: true },
        })));
      if (!amuxV22AssessmentIdsCurrent(
        assessmentBindings.map((binding) => binding.id),
        latestAssessments.map((assessment) => assessment?.id ?? null))) {
        throw new BoardImportError("score_changed", 409);
      }
      const scoreAudit = await tx.adminAuditLog.findUnique({
        where: { id: score.approvalAuditLogId },
        select: { action: true, targetId: true, entryHash: true },
      });
      if (!scoreAudit?.entryHash ||
          scoreAudit.action !== "amux.v4.portfolio.score.confirm" ||
          scoreAudit.targetId !== score.id) {
        throw new BoardImportError("score_unbound", 409);
      }
      if (await tx.amuxExecutionAttempt.count({ where: { taskId: current.taskId } }) ||
          await tx.amuxWorkDelivery.count({ where: { taskId: current.taskId } }) ||
          await tx.amuxRouteDecision.count({ where: { taskId: current.taskId } })) {
        return openV22CriticalHalt(tx, now, "lifecycle_write", recordReceipt);
      }
      const auditId = await writeV22AutoPromotionAudit(tx, {
        action: V22_AUDIT_ACTION, targetType: "AmuxV22PromotionReceipt",
        targetId: input.receiptId,
        summary: "Promoted one owner-approved v4 Task into unassigned Todo.",
        metadata: { taskId: current.taskId, sourceApprovalId:
          ready.sourceApprovalId, scoreSnapshotId: score.id,
          scoreVersion: score.scoreVersion, scoreTotal: score.scoreTotal,
          policyVersion: AMUX_V22_AUTO_PROMOTION_POLICY_VERSION,
          queueLimit: capacity.decision.queueLimit,
          capacityOccupied: capacity.occupied, workerCount: capacity.workers },
      });
      await tx.amuxV22PromotionReceipt.create({ data: {
        id: input.receiptId, workItemId: current.taskId,
        sourceApprovalId: ready.sourceApprovalId,
        sourceApprovalDigest: ready.sourceApprovalDigest,
        briefDigest: ready.briefDigest,
        parentFeatureNodeId: ready.parentFeatureNodeId,
        parentStoryCardId: ready.parentStoryCardId,
        taskRevision: ready.taskRevision, scoreSnapshotId: score.id,
        scoreVersion: score.scoreVersion, scoreTotal: score.scoreTotal,
        capacityWipLimit: capacity.row.wipLimit,
        capacityOccupied: capacity.occupied,
        verifiedWorkerCount: capacity.workers,
        queueLimit: capacity.decision.queueLimit,
        normalLimit: capacity.decision.normalLimit,
        parallelReserved: AMUX_V22_PARALLEL_RESERVED,
        sev1Reserved: AMUX_V22_SEV1_RESERVED,
        costCents: 0, policyVersion: AMUX_V22_AUTO_PROMOTION_POLICY_VERSION,
        authorizationAuditLogId: auditId, promotedAt: now,
      } });
      const updated = await tx.amuxWorkItem.updateMany({ where: {
        id: current.taskId, sourceSystem: "admin-idea-v4", cardType: "task",
        status: "backlog", archivedAt: null, owner: null, claimedAt: null,
        v22ReceiptId: null, revision: ready.taskRevision,
        v4SourceApprovalId: ready.sourceApprovalId,
        v4BriefDigest: ready.briefDigest,
      }, data: { status: "todo", v22ReceiptId: input.receiptId,
        revision: { increment: 1 } } });
      if (updated.count !== 1) throw new BoardImportError("conflict", 409);
      recordReceipt("work_item", current.taskId, 1);
      recordReceipt("v22_promotion_receipt", input.receiptId, 1);
      return { promoted: true as const, taskId: current.taskId,
        receiptId: input.receiptId };
    });
}

/** The queue lock makes this read-back final with respect to the attempted
 * transaction. A missing receipt is recorded as unknown, never retried. */
async function readBackLostPromotion(receiptId: string, taskId: string) {
  return withAutoTransaction(receiptId, TICK_TRANSACTION_LIMITS,
    async (tx, now, recordReceipt) => {
      const existing = await tx.amuxV22PromotionUnknown.findUnique({
        where: { id: receiptId }, select: { id: true },
      });
      if (existing) return { promoted: false as const,
        reason: "outcome_unknown", receiptId, taskId };
      const receipt = await tx.amuxV22PromotionReceipt.findUnique({
        where: { id: receiptId }, select: { workItemId: true,
          authorizationAuditLogId: true },
      });
      const card = receipt ? await tx.amuxWorkItem.findUnique({
        where: { id: receipt.workItemId },
        select: { v22ReceiptId: true },
      }) : null;
      const audit = receipt ? await tx.adminAuditLog.findUnique({
        where: { id: receipt.authorizationAuditLogId },
        select: { action: true, targetId: true, entryHash: true },
      }) : null;
      if (receipt?.workItemId === taskId && card &&
          card.v22ReceiptId === receiptId && audit?.entryHash &&
          audit.action === V22_AUDIT_ACTION && audit.targetId === receiptId) {
        return { promoted: true as const, receiptId, taskId,
          recoveredByReadback: true as const };
      }
      const auditId = await writeV22AutoPromotionAudit(tx, {
        action: "amux.v22.auto_promotion.outcome_unknown",
        targetType: "AmuxV22PromotionUnknown", targetId: receiptId,
        summary: "Stopped a v22 promotion with an unconfirmed result.",
        metadata: { receiptId, taskId,
          receiptFound: receipt ? 1 : 0,
          policyVersion: AMUX_V22_AUTO_PROMOTION_POLICY_VERSION },
      });
      await tx.amuxV22PromotionUnknown.create({ data: { id: receiptId,
        workItemId: taskId, receiptFound: receipt !== null,
        authorizationAuditLogId: auditId, recordedAt: now } });
      recordReceipt("v22_promotion_unknown", receiptId, 1);
      const since = new Date(now.getTime() - AUTO_UNKNOWN_BURST_MS);
      const [v22Unknowns, oldUnknowns, oldConsumptions, openHalt] = await Promise.all([
        tx.amuxV22PromotionUnknown.count({ where: {
          recordedAt: { gte: since, lte: now },
        } }),
        tx.amuxRecommendationAutoUnknown.findMany({
          where: { recordedAt: { gte: since, lte: now } },
          select: { id: true, recordedAt: true },
        }),
        tx.amuxRecommendationAutoConsumption.findMany({
          where: { outcomeUnknownAt: { gte: since, lte: now } },
          select: { id: true, outcomeUnknownAt: true },
        }),
        tx.amuxRecommendationAutoHalt.findFirst({
          where: { clearedAt: null }, select: { id: true },
        }),
      ]);
      if (v22Unknowns + autoUnknownEvents({ unknowns: oldUnknowns,
        consumptions: oldConsumptions }).length >= AUTO_UNKNOWN_BURST_COUNT &&
          !openHalt) {
        const haltId = randomUUID();
        const haltAuditId = await writeV22AutoPromotionAudit(tx, {
          action: "amux.auto_promotion.halted",
          targetType: "AmuxRecommendationAutoHalt", targetId: haltId,
          summary: "Halted AMUX promotion after two unknown outcomes.",
          metadata: { violationCode: null },
        });
        await tx.amuxRecommendationAutoHalt.create({ data: { id: haltId,
          reason: "outcome_unknown_burst",
          violationCode: null,
          actorUserId: "system:amux-v22-auto-admit",
          authorizationAuditLogId: haltAuditId, openedAt: now } });
        recordReceipt("v22_promotion_halt", haltId, 1);
      }
      return { promoted: false as const, reason: "outcome_unknown",
        receiptId, taskId };
    });
}

/** One tick moves at most one card. A cryptographically invalid high-score
 * candidate is skipped for this tick; no lower card borrows its approval. */
export async function tickV22AutoPromotion() {
  if (!amuxV22AutoPromotionEnabled(
    process.env[AMUX_V22_AUTO_PROMOTION_ENV])) {
    return { promoted: false as const, reason: "apply_disabled" };
  }
  const candidates = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS now`;
    return latestCandidates(tx, rows[0]?.now ?? new Date());
  });
  if (!candidates.length) return { promoted: false as const,
    reason: "no_candidate" };
  let unavailable = 0;
  for (const candidate of candidates) {
    let context: Awaited<ReturnType<typeof loadAmuxV4TaskReadyContext>>;
    try { context = await loadAmuxV4TaskReadyContext(candidate.taskId); }
    catch { unavailable += 1; continue; }
    const receiptId = randomUUID();
    try { return await commitCandidate({ candidate, receiptId, context }); }
    catch (error) {
      if (!(error instanceof BoardImportError)) throw error;
      if (error.code === "outcome_unknown") {
        try {
          return await readBackLostPromotion(receiptId, candidate.taskId);
        } catch (readbackError) {
          // A second lost result is still unknown. The orchestrator sees the
          // same 409 stop code and resolves its admitted write receipt.
          console.error(JSON.stringify({
            event: "amux_v22_promotion_readback_unavailable",
            code: readbackError instanceof BoardImportError ?
              readbackError.code : "unexpected",
          }));
          return { promoted: false as const, reason: "outcome_unknown",
            receiptId, taskId: candidate.taskId };
        }
      }
      if (["task_not_ready", "score_changed", "score_unbound",
        "lifecycle_present", "not_backlog", "conflict"].includes(error.code)) {
        continue;
      }
      return { promoted: false as const, reason: error.code };
    }
  }
  return { promoted: false as const,
    reason: unavailable > 0 ? "candidate_unavailable" : "no_ready_candidate" };
}
