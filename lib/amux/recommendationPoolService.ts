import "server-only";

import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { SYSTEM_AUDIT_ACTOR_METADATA_KEY } from "@/lib/adminAuditSystemActors";
import {
  BOARD_IMPORT_STATEMENT_TIMEOUT,
  BoardImportError,
  boardImportAuditEntryHashMatches,
  boardImportAuditKeysPresent,
  boardImportFailureIsAmbiguous,
  boardImportSameOperatorApproval,
} from "@/lib/amux/boardImportCore";
import { boardPromotionCardWrite } from "@/lib/amux/boardPromotionCore";
import { AMUX_INCIDENT_SETTING_KEY, parseAmuxIncidentSetting } from "@/lib/amux/incidentCore";
import {
  RECOMMENDATION_APPLY_ENV,
  RECOMMENDATION_AUDIT_KEYS,
  RECOMMENDATION_CAPACITY_ID,
  RECOMMENDATION_CODE_LATCH,
  RECOMMENDATION_EXPIRY_MS,
  RECOMMENDATION_LOCK_NAME,
  RECOMMENDATION_POLICY_VERSION,
  RECOMMENDATION_SCORING_VERSION,
  RECOMMENDATION_SNAPSHOT_BACKSTOP,
  type RecommendationCardFact,
  type RecommendationDecisionRequest,
  type RecommendationRow,
  parseRecommendationDecisionRequest,
  parseRecommendationPrepareRequest,
  recommendationApplyPermitted,
  recommendationApproveStillIncluded,
  recommendationAuditMetadata,
  recommendationReviewAfterAccepted,
  recommendationRowsDigest,
  selectRecommendationRows,
} from "@/lib/amux/recommendationPoolCore";
import { prisma } from "@/lib/prisma";

/**
 * Recommendation pool writer.
 *
 * docs/policy/development-agent-orchestration.md (orchestration policy version 7).
 *
 * Preview writes nothing. Prepare and decide throw before a transaction unless
 * the environment value is exactly enabled and the shipped code latch is true.
 * Version 7 ships that latch false. This file does not insert a capacity row,
 * start a worker, or spend credits.
 */

const TARGET_TYPE = "AmuxRecommendationSnapshot";
const SHA256 = /^[a-f0-9]{64}$/;

const summaries: Record<string, string> = {
  "amux.recommendation.prepared": "Prepared an AMUX recommendation snapshot.",
  "amux.recommendation.held": "Held an AMUX recommendation row.",
  "amux.recommendation.rejected": "Rejected an AMUX recommendation row.",
  "amux.recommendation.expired": "Expired an AMUX recommendation snapshot.",
  "amux.recommendation.consumed": "Consumed an AMUX recommendation approval.",
  "amux.recommendation.outcome_unknown": "Recorded an unknown AMUX recommendation outcome.",
};

const actorId = (session: Session): string => {
  const id = session.user?.id;
  if (!id) throw new BoardImportError("forbidden", 403);
  return id;
};

const prismaCode = (error: unknown): string | null => {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
};

const disconnectMessage = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : "";
  return /timeout|ECONNRESET|ECONNREFUSED|Connection terminated|closed the connection|Server has closed/i.test(
    message,
  );
};

type Db = Prisma.TransactionClient | typeof prisma;

const databaseNow = async (tx: Prisma.TransactionClient): Promise<Date> => {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = rows[0]?.now;
  const parsed = now instanceof Date ? now : new Date(now ?? Number.NaN);
  if (Number.isNaN(parsed.getTime())) throw new BoardImportError("audit_unbound", 500);
  return parsed;
};

const withRecommendationTransaction = async <T>(
  targetId: string | null,
  run: (tx: Prisma.TransactionClient, now: Date) => Promise<T>,
): Promise<T> => {
  if (!boardImportAuditKeysPresent(adminAuditIntegrityKeys(process.env).length)) {
    throw new BoardImportError("audit_key_missing", 503, targetId);
  }
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${BOARD_IMPORT_STATEMENT_TIMEOUT}, true)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${RECOMMENDATION_LOCK_NAME}))`;
        return run(tx, await databaseNow(tx));
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
  } catch (error) {
    if (error instanceof BoardImportError) throw error;
    const code = prismaCode(error);
    if (code === "P2002") throw new BoardImportError("conflict", 409, targetId);
    if (boardImportFailureIsAmbiguous(code) || disconnectMessage(error)) {
      throw new BoardImportError("outcome_unknown", 409, targetId);
    }
    throw error;
  }
};

const requireBoundAudit = async (
  tx: Prisma.TransactionClient,
  auditId: string,
  expected: { actorUserId: string; action: string; targetId: string },
) => {
  const row = await tx.adminAuditLog.findUnique({
    where: { id: auditId },
    select: {
      actorUserId: true,
      actorEmail: true,
      action: true,
      targetType: true,
      targetId: true,
      summary: true,
      metadata: true,
      ipAddress: true,
      userAgent: true,
      entryHash: true,
      previousHash: true,
      createdAt: true,
    },
  });
  if (
    !row ||
    row.action !== expected.action ||
    row.targetType !== TARGET_TYPE ||
    row.targetId !== expected.targetId ||
    typeof row.entryHash !== "string" ||
    !SHA256.test(row.entryHash) ||
    !(row.createdAt instanceof Date) ||
    row.actorUserId !== expected.actorUserId
  ) {
    throw new BoardImportError("audit_unbound", 500, expected.targetId);
  }
  const marker =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)[SYSTEM_AUDIT_ACTOR_METADATA_KEY]
      : null;
  if (typeof marker === "string") throw new BoardImportError("audit_unbound", 500, expected.targetId);
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? (row.metadata as Record<string, unknown>)
    : {};
  for (const key of Object.keys(metadata)) {
    if (!(RECOMMENDATION_AUDIT_KEYS as readonly string[]).includes(key)) {
      throw new BoardImportError("audit_unbound", 500, expected.targetId);
    }
  }
  const hashMatches = boardImportAuditEntryHashMatches(
    {
      previousHash: row.previousHash,
      actorUserId: row.actorUserId,
      actorEmail: row.actorEmail,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      summary: row.summary,
      metadata: row.metadata ?? null,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
    },
    row.entryHash,
    adminAuditIntegrityKeys(process.env),
  );
  if (!hashMatches) throw new BoardImportError("audit_unbound", 500, expected.targetId);
};

const writeHumanAudit = async (
  tx: Prisma.TransactionClient,
  session: Session,
  request: Request,
  action: string,
  targetId: string,
  metadata: Record<string, string | number | null>,
) => {
  const auditId = await writeAdminAuditLog({
    session,
    request,
    action,
    targetType: TARGET_TYPE,
    targetId,
    summary: summaries[action] ?? "Recorded an AMUX recommendation.",
    metadata,
    tx,
  });
  await requireBoundAudit(tx, auditId, { actorUserId: actorId(session), action, targetId });
  return auditId;
};

const loadCards = async (db: Db, now: Date): Promise<RecommendationCardFact[]> => {
  const cards = await db.amuxWorkItem.findMany({
    where: { status: "backlog" },
    select: {
      id: true,
      revision: true,
      status: true,
      owner: true,
      claimedAt: true,
      archivedAt: true,
      sourceDigest: true,
      executionBriefDigest: true,
      kind: true,
      priority: true,
      pinned: true,
      drag: true,
      createdAt: true,
    },
    orderBy: { id: "asc" },
    take: RECOMMENDATION_SNAPSHOT_BACKSTOP + 1,
  });
  if (cards.length > RECOMMENDATION_SNAPSHOT_BACKSTOP) {
    throw new BoardImportError("snapshot_backstop", 409);
  }
  const ids = cards.map((card) => card.id);
  if (ids.length === 0) return [];
  const attempts = await db.amuxExecutionAttempt.groupBy({
    by: ["taskId"],
    where: { taskId: { in: ids } },
    _count: { _all: true },
  });
  const deliveries = await db.amuxWorkDelivery.groupBy({
    by: ["taskId"],
    where: { taskId: { in: ids } },
    _count: { _all: true },
  });
  const routes = await db.amuxRouteDecision.groupBy({
    by: ["taskId"],
    where: { taskId: { in: ids } },
    _count: { _all: true },
  });
  const dependencies = await db.amuxWorkDependency.findMany({
    where: { taskId: { in: ids } },
    select: { taskId: true, dependency: { select: { status: true, archivedAt: true } } },
  });
  const dependents = await db.amuxWorkDependency.groupBy({
    by: ["dependencyId"],
    where: { dependencyId: { in: ids } },
    _count: { _all: true },
  });
  const reviews = await db.amuxRecommendationDecision.findMany({
    where: {
      workItemId: { in: ids },
      status: { in: ["held", "rejected"] },
      reviewAfter: { gt: now },
    },
    select: { workItemId: true, reviewAfter: true },
  });
  const attemptCounts = new Map(attempts.map((row) => [row.taskId, row._count._all]));
  const deliveryCounts = new Map(deliveries.map((row) => [row.taskId, row._count._all]));
  const routeCounts = new Map(routes.map((row) => [row.taskId, row._count._all]));
  const dependentCounts = new Map(dependents.map((row) => [row.dependencyId, row._count._all]));
  const dependencyLists = new Map<string, { status: string; archivedAt: Date | null }[]>();
  for (const row of dependencies) {
    const list = dependencyLists.get(row.taskId) ?? [];
    list.push(row.dependency);
    dependencyLists.set(row.taskId, list);
  }
  const reviewAfter = new Map<string, Date>();
  for (const row of reviews) {
    if (!row.reviewAfter) continue;
    const current = reviewAfter.get(row.workItemId);
    if (!current || row.reviewAfter.getTime() > current.getTime()) reviewAfter.set(row.workItemId, row.reviewAfter);
  }
  return cards.map((card) => ({
    ...card,
    attemptCount: attemptCounts.get(card.id) ?? 0,
    deliveryCount: deliveryCounts.get(card.id) ?? 0,
    routeDecisionCount: routeCounts.get(card.id) ?? 0,
    dependentCount: dependentCounts.get(card.id) ?? 0,
    dependencies: dependencyLists.get(card.id) ?? [],
    reviewAfter: reviewAfter.get(card.id) ?? null,
  }));
};

const loadCapacity = async (db: Db) => {
  const row = await db.amuxRecommendationCapacity.findUnique({
    where: { id: RECOMMENDATION_CAPACITY_ID },
    select: { active: true, wipLimit: true },
  });
  return row;
};

const countOccupied = async (db: Db): Promise<number> =>
  db.amuxWorkItem.count({
    where: { archivedAt: null, status: { in: ["todo", "doing"] } },
  });

const loadBlocksAdmission = async (db: Db): Promise<boolean> => {
  const row = await db.appSetting.findUnique({
    where: { key: AMUX_INCIDENT_SETTING_KEY },
    select: { value: true },
  });
  return parseAmuxIncidentSetting(row?.value).blocks_admission;
};

const selectionFor = async (db: Db, now: Date) => {
  const cards = await loadCards(db, now);
  const capacity = await loadCapacity(db);
  const occupied = await countOccupied(db);
  const blocksAdmission = await loadBlocksAdmission(db);
  return selectRecommendationRows({ cards, capacity, occupied, blocksAdmission, now });
};

const viewOf = (
  selection: ReturnType<typeof selectRecommendationRows>,
  applyPermitted: boolean,
  refusal: string | null = null,
) => ({
  applyPermitted,
  refusal,
  occupied: selection.occupied,
  wipLimit: selection.wipLimit,
  includedCount: selection.includedCount,
  excludedCount: selection.rows.length - selection.includedCount,
  included: selection.rows
    .filter((row) => row.disposition === "included")
    .map((row) => ({
      cardId: row.cardId,
      scoreTotal: row.scoreTotal,
      expectedRevision: row.expectedRevision,
    })),
  workerCapacity: "closed" as const,
  classificationCapacity: "closed" as const,
});

const writesPermitted = (): boolean =>
  recommendationApplyPermitted({
    envValue: process.env[RECOMMENDATION_APPLY_ENV],
    codeLatch: RECOMMENDATION_CODE_LATCH,
  });

export async function previewRecommendation(raw: string) {
  const parsed = parseRecommendationPrepareRequest(raw);
  if (!parsed.ok) throw new BoardImportError(parsed.code, 400);
  const now = new Date();
  try {
    const selection = await selectionFor(prisma, now);
    return viewOf(selection, writesPermitted());
  } catch (error) {
    if (error instanceof BoardImportError && error.code === "snapshot_backstop") {
      return {
        applyPermitted: writesPermitted(),
        refusal: "snapshot_backstop",
        occupied: 0,
        wipLimit: null,
        includedCount: 0,
        excludedCount: 0,
        included: [],
        workerCapacity: "closed" as const,
        classificationCapacity: "closed" as const,
      };
    }
    throw error;
  }
}

export async function commitRecommendationSnapshot(
  tx: Prisma.TransactionClient,
  input: { session: Session; request: Request; snapshotId: string; now: Date },
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${RECOMMENDATION_LOCK_NAME}))`;
  const selection = await selectionFor(tx, input.now);
  const digest = recommendationRowsDigest(selection.rows);
  const auditId = await writeHumanAudit(
    tx,
    input.session,
    input.request,
    "amux.recommendation.prepared",
    input.snapshotId,
    recommendationAuditMetadata({
      snapshotId: input.snapshotId,
      digest,
      rowCount: selection.rows.length,
      includedCount: selection.includedCount,
      occupied: selection.occupied,
      wipLimit: selection.wipLimit,
    }),
  );
  await tx.amuxRecommendationSnapshot.create({
    data: {
      id: input.snapshotId,
      status: "prepared",
      actorUserId: actorId(input.session),
      authorizationAuditLogId: auditId,
      scoringVersion: RECOMMENDATION_SCORING_VERSION,
      capacityConfigured: selection.configured,
      capacityLimit: selection.wipLimit,
      capacityOccupied: selection.occupied,
      workerCapacity: "closed",
      classificationCapacity: "closed",
      itemBindingsDigest: digest,
      rowCount: selection.rows.length,
      includedCount: selection.includedCount,
      policyVersion: RECOMMENDATION_POLICY_VERSION,
      preparedAt: input.now,
      expiresAt: new Date(input.now.getTime() + RECOMMENDATION_EXPIRY_MS),
    },
  });
  if (selection.rows.length > 0) {
    await tx.amuxRecommendationSnapshotItem.createMany({
      data: selection.rows.map((row, ordinal) => ({
        snapshotId: input.snapshotId,
        workItemId: row.cardId,
        ordinal,
        expectedRevision: row.expectedRevision,
        sourceDigest: row.sourceDigest,
        executionBriefDigest: row.executionBriefDigest,
        scoreTotal: row.scoreTotal,
        disposition: row.disposition,
        exclusionCode: row.exclusionCode,
      })),
    });
  }
  return {
    snapshotId: input.snapshotId,
    status: "prepared" as const,
    includedCount: selection.includedCount,
    rowCount: selection.rows.length,
    applyPermitted: true,
  };
}

export async function prepareRecommendation(input: { session: Session; request: Request; raw: string }) {
  const parsed = parseRecommendationPrepareRequest(input.raw);
  if (!parsed.ok) throw new BoardImportError(parsed.code, 400);
  if (!writesPermitted()) throw new BoardImportError("apply_disabled", 409);
  const snapshotId = randomUUID();
  return withRecommendationTransaction(snapshotId, (tx, now) =>
    commitRecommendationSnapshot(tx, { session: input.session, request: input.request, snapshotId, now }),
  );
}

const rowFromItem = (item: {
  workItemId: string;
  expectedRevision: number;
  sourceDigest: string | null;
  executionBriefDigest: string | null;
  scoreTotal: number;
  disposition: string;
  exclusionCode: string | null;
}): RecommendationRow => ({
  cardId: item.workItemId,
  expectedRevision: item.expectedRevision,
  sourceDigest: item.sourceDigest,
  executionBriefDigest: item.executionBriefDigest,
  scoreTotal: item.scoreTotal,
  disposition: item.disposition === "included" ? "included" : "excluded",
  exclusionCode: item.exclusionCode as RecommendationRow["exclusionCode"],
});

export async function decideRecommendation(input: { session: Session; request: Request; raw: string }) {
  if (!writesPermitted()) throw new BoardImportError("apply_disabled", 409);
  let snapshotId: string | null = null;
  try {
    const body = JSON.parse(input.raw) as { snapshotId?: unknown };
    if (typeof body.snapshotId === "string") snapshotId = body.snapshotId;
  } catch {
    snapshotId = null;
  }
  return withRecommendationTransaction(snapshotId, async (tx, now) => {
    const parsed = parseRecommendationDecisionRequest(input.raw, now);
    if (!parsed.ok) throw new BoardImportError(parsed.code, 400);
    return commitRecommendationDecision(tx, {
      session: input.session,
      request: input.request,
      decision: parsed.request,
      requestDigest: parsed.requestDigest,
      now,
    });
  });
}

export async function commitRecommendationDecision(
  tx: Prisma.TransactionClient,
  input: {
    session: Session;
    request: Request;
    decision: RecommendationDecisionRequest;
    requestDigest: string;
    now: Date;
  },
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${RECOMMENDATION_LOCK_NAME}))`;
  const existing = await tx.amuxRecommendationDecision.findUnique({
    where: { id: input.decision.decisionId },
    select: {
      id: true,
      snapshotId: true,
      workItemId: true,
      actorUserId: true,
      requestDigest: true,
      status: true,
    },
  });
  const cardId = input.decision.decision === "approve" ? input.decision.item.cardId : input.decision.cardId;
  if (existing) {
    if (
      existing.snapshotId === input.decision.snapshotId &&
      existing.workItemId === cardId &&
      existing.actorUserId === actorId(input.session) &&
      existing.requestDigest === input.requestDigest
    ) {
      return { decisionId: existing.id, snapshotId: existing.snapshotId, status: existing.status, replayed: true as const };
    }
    throw new BoardImportError("conflict", 409, input.decision.decisionId);
  }
  const snapshot = await tx.amuxRecommendationSnapshot.findUnique({
    where: { id: input.decision.snapshotId },
    select: {
      id: true,
      status: true,
      actorUserId: true,
      preparedAt: true,
      expiresAt: true,
      outcomeUnknownAt: true,
      itemBindingsDigest: true,
    },
  });
  if (!snapshot || !boardImportSameOperatorApproval(snapshot.actorUserId, actorId(input.session))) {
    throw new BoardImportError("not_found", 404, input.decision.snapshotId);
  }
  if (snapshot.outcomeUnknownAt || snapshot.status === "outcome_unknown") {
    throw new BoardImportError("outcome_unknown", 409, snapshot.id);
  }
  const item = await tx.amuxRecommendationSnapshotItem.findUnique({
    where: { snapshotId_workItemId: { snapshotId: snapshot.id, workItemId: cardId } },
  });
  if (!item) throw new BoardImportError("not_included", 409, snapshot.id);
  if (snapshot.expiresAt.getTime() <= input.now.getTime()) {
    const auditId = await writeHumanAudit(
      tx,
      input.session,
      input.request,
      "amux.recommendation.expired",
      snapshot.id,
      recommendationAuditMetadata({ snapshotId: snapshot.id, decisionId: input.decision.decisionId, digest: input.requestDigest }),
    );
    await tx.amuxRecommendationDecision.create({
      data: {
        id: input.decision.decisionId,
        snapshotId: snapshot.id,
        workItemId: cardId,
        decision: "expired",
        status: "expired",
        actorUserId: actorId(input.session),
        authorizationAuditLogId: auditId,
        requestDigest: input.requestDigest,
      },
    });
    return { decisionId: input.decision.decisionId, snapshotId: snapshot.id, status: "expired" as const, replayed: false as const };
  }
  const live = await tx.amuxWorkItem.findUnique({
    where: { id: cardId },
    select: { id: true, status: true, revision: true },
  });
  if (!live || live.status !== "backlog") throw new BoardImportError("not_backlog", 409, snapshot.id);
  if (input.decision.decision === "hold" || input.decision.decision === "reject") {
    if (!recommendationReviewAfterAccepted(input.decision.reviewAfter, input.now)) {
      throw new BoardImportError("schema_rejected", 400, snapshot.id);
    }
    const action = input.decision.decision === "hold" ? "amux.recommendation.held" : "amux.recommendation.rejected";
    const auditId = await writeHumanAudit(tx, input.session, input.request, action, snapshot.id, recommendationAuditMetadata({
      snapshotId: snapshot.id,
      decisionId: input.decision.decisionId,
      digest: input.requestDigest,
      reasonCode: input.decision.reasonCode,
      reviewAfter: new Date(input.decision.reviewAfter).toISOString(),
    }));
    await tx.amuxRecommendationDecision.create({
      data: {
        id: input.decision.decisionId,
        snapshotId: snapshot.id,
        workItemId: cardId,
        decision: input.decision.decision,
        status: input.decision.decision === "hold" ? "held" : "rejected",
        reasonCode: input.decision.reasonCode,
        reviewAfter: new Date(input.decision.reviewAfter),
        actorUserId: actorId(input.session),
        authorizationAuditLogId: auditId,
        requestDigest: input.requestDigest,
      },
    });
    return {
      decisionId: input.decision.decisionId,
      snapshotId: snapshot.id,
      status: input.decision.decision === "hold" ? ("held" as const) : ("rejected" as const),
      replayed: false as const,
    };
  }
  const selection = await selectionFor(tx, input.now);
  if (item.disposition !== "included") throw new BoardImportError("not_included", 409, snapshot.id);
  const liveCards = await loadCards(tx, input.now);
  const fact = liveCards.find((card) => card.id === cardId);
  if (!fact) throw new BoardImportError("not_backlog", 409, snapshot.id);
  const still = recommendationApproveStillIncluded({
    row: rowFromItem(item),
    live: fact,
    item: input.decision.item,
    blocksAdmission: await loadBlocksAdmission(tx),
    configured: selection.configured,
    remaining: selection.remaining,
    now: input.now,
  });
  if (!still.ok) throw new BoardImportError(still.code, 409, snapshot.id);
  const write = boardPromotionCardWrite(input.decision.item);
  const updated = await tx.amuxWorkItem.updateMany({ where: write.where, data: write.data });
  if (updated.count !== 1) throw new BoardImportError("conflict", 409, snapshot.id);
  const auditId = await writeHumanAudit(
    tx,
    input.session,
    input.request,
    "amux.recommendation.consumed",
    snapshot.id,
    recommendationAuditMetadata({
      snapshotId: snapshot.id,
      decisionId: input.decision.decisionId,
      digest: input.requestDigest,
      occupied: selection.occupied,
      wipLimit: selection.wipLimit,
      includedCount: 1,
    }),
  );
  await tx.amuxRecommendationDecision.create({
    data: {
      id: input.decision.decisionId,
      snapshotId: snapshot.id,
      workItemId: cardId,
      decision: "approve",
      status: "consumed",
      actorUserId: actorId(input.session),
      authorizationAuditLogId: auditId,
      requestDigest: input.requestDigest,
    },
  });
  return { decisionId: input.decision.decisionId, snapshotId: snapshot.id, status: "consumed" as const, replayed: false as const };
}

export async function markRecommendationOutcomeUnknown(input: {
  session: Session;
  request: Request;
  snapshotId: string;
}) {
  try {
    return await withRecommendationTransaction(input.snapshotId, async (tx, now) => {
      const snapshot = await tx.amuxRecommendationSnapshot.findUnique({
        where: { id: input.snapshotId },
        select: { id: true, actorUserId: true, status: true, outcomeUnknownAt: true },
      });
      if (!snapshot || !boardImportSameOperatorApproval(snapshot.actorUserId, actorId(input.session))) {
        return { marked: false as const };
      }
      if (snapshot.outcomeUnknownAt) return { marked: true as const };
      const reserved = await tx.amuxRecommendationSnapshot.updateMany({
        where: { id: snapshot.id, status: snapshot.status, outcomeUnknownAt: null },
        data: { outcomeUnknownAt: now, status: "outcome_unknown" },
      });
      if (reserved.count !== 1) return { marked: false as const };
      await writeHumanAudit(
        tx,
        input.session,
        input.request,
        "amux.recommendation.outcome_unknown",
        snapshot.id,
        recommendationAuditMetadata({ snapshotId: snapshot.id }),
      );
      return { marked: true as const };
    });
  } catch {
    return { marked: false as const };
  }
}
