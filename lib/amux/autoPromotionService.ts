import "server-only";

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
} from "@/lib/amux/boardImportCore";
import { boardPromotionCardWrite, boardPromotionExecutionBriefDigest, type BoardPromotionItem } from "@/lib/amux/boardPromotionCore";
import { AMUX_INCIDENT_SETTING_KEY, parseAmuxIncidentSetting } from "@/lib/amux/incidentCore";
import {
  AUTO_AUDIT_KEYS,
  AUTO_PROMOTION_APPLY_ENV,
  AUTO_PROMOTION_CODE_LATCH,
  autoAuditMetadata,
  autoCostAccepted,
  autoGlobalWipAccepted,
  autoGraduationAccepted,
  autoGrantExpiresAt,
  autoGrantUsable,
  autoHaltRequired,
  autoPromotionApplyPermitted,
  autoReadbackCritical,
  autoWorkerAdmitted,
  parseAutoConsumeRequest,
  parseAutoGrantRequest,
} from "@/lib/amux/autoPromotionCore";
import { RECOMMENDATION_LOCK_NAME } from "@/lib/amux/recommendationPoolCore";
import { prisma } from "@/lib/prisma";

const SHA256 = /^[a-f0-9]{64}$/;

const summaries: Record<string, string> = {
  "amux.auto_grant.prepared": "Recorded an AMUX auto-promotion grant.",
  "amux.auto_grant.expired": "Expired an AMUX auto-promotion grant.",
  "amux.auto_promotion.consumed": "Consumed an AMUX auto-promotion grant.",
  "amux.auto_promotion.outcome_unknown": "Recorded an unknown AMUX auto-promotion outcome.",
  "amux.auto_promotion.halted": "Halted AMUX auto-promotion.",
};

const actorId = (session: Session): string => {
  const id = session.user?.id;
  if (!id) throw new BoardImportError("forbidden", 403);
  return id;
};

const applyOpen = (): boolean =>
  autoPromotionApplyPermitted({
    envValue: process.env[AUTO_PROMOTION_APPLY_ENV],
    codeLatch: AUTO_PROMOTION_CODE_LATCH,
  });

const refuseClosed = () => {
  if (!applyOpen()) throw new BoardImportError("apply_disabled", 409);
};

const databaseNow = async (tx: Prisma.TransactionClient): Promise<Date> => {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = rows[0]?.now;
  const parsed = now instanceof Date ? now : new Date(now ?? Number.NaN);
  if (Number.isNaN(parsed.getTime())) throw new BoardImportError("audit_unbound", 500);
  return parsed;
};

const withAutoTransaction = async <T>(
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
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : null;
    if (code === "P2002") throw new BoardImportError("conflict", 409, targetId);
    const message = error instanceof Error ? error.message : "";
    if (
      boardImportFailureIsAmbiguous(typeof code === "string" ? code : null) ||
      /timeout|ECONNRESET|ECONNREFUSED|Connection terminated|closed the connection|Server has closed/i.test(message)
    ) {
      throw new BoardImportError("outcome_unknown", 409, targetId);
    }
    throw error;
  }
};

const writeHumanAudit = async (
  tx: Prisma.TransactionClient,
  session: Session,
  request: Request,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, string | number | null>,
) => {
  const auditId = await writeAdminAuditLog({
    session,
    request,
    action,
    targetType,
    targetId,
    summary: summaries[action] ?? "Recorded an AMUX auto-promotion fact.",
    metadata,
    tx,
  });
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
      previousHash: true,
      entryHash: true,
      createdAt: true,
    },
  });
  if (
    !row ||
    row.action !== action ||
    row.targetType !== targetType ||
    row.targetId !== targetId ||
    row.actorUserId !== actorId(session) ||
    typeof row.entryHash !== "string" ||
    !SHA256.test(row.entryHash) ||
    !(row.createdAt instanceof Date)
  ) {
    throw new BoardImportError("audit_unbound", 500, targetId);
  }
  const metadataRow = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? (row.metadata as Record<string, unknown>)
    : {};
  if (typeof metadataRow[SYSTEM_AUDIT_ACTOR_METADATA_KEY] === "string") {
    throw new BoardImportError("audit_unbound", 500, targetId);
  }
  for (const key of Object.keys(metadataRow)) {
    if (!(AUTO_AUDIT_KEYS as readonly string[]).includes(key)) {
      throw new BoardImportError("audit_unbound", 500, targetId);
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
  if (!hashMatches) throw new BoardImportError("audit_unbound", 500, targetId);
  return auditId;
};

const humanDecisions = async (tx: Prisma.TransactionClient) =>
  tx.amuxRecommendationDecision.findMany({
    where: { decision: "approve", status: "consumed" },
    select: { createdAt: true },
  });

const costEntries = async (tx: Prisma.TransactionClient) =>
  tx.amuxRecommendationAutoCostEntry.findMany({ select: { amountCents: true, recordedAt: true } });

const openHalt = async (tx: Prisma.TransactionClient) =>
  tx.amuxRecommendationAutoHalt.findFirst({ where: { clearedAt: null }, select: { id: true } });

export async function previewAutoPromotion() {
  const decisions = await prisma.amuxRecommendationDecision.findMany({
    where: { decision: "approve", status: "consumed" },
    select: { createdAt: true },
  });
  const graduation = autoGraduationAccepted(decisions);
  return {
    applyPermitted: false as const,
    refusal: applyOpen() ? (graduation.ok ? null : graduation.code) : "apply_disabled",
    humanDecisions: graduation.count,
    spanMs: graduation.spanMs,
  };
}

export async function grantAutoPromotion(input: { session: Session; request: Request; raw: string }) {
  refuseClosed();
  const parsed = parseAutoGrantRequest(input.raw);
  if (!parsed.ok) throw new BoardImportError(parsed.code, 400);
  return commitAutoGrant(input.session, input.request, parsed.request, parsed.requestDigest);
}

export async function consumeAutoPromotion(input: { session: Session; request: Request; raw: string }) {
  refuseClosed();
  const parsed = parseAutoConsumeRequest(input.raw);
  if (!parsed.ok) throw new BoardImportError(parsed.code, parsed.code === "one_card" ? 409 : 400);
  return commitAutoPromotion(input.session, input.request, parsed.request, parsed.requestDigest);
}

export async function commitAutoGrant(
  session: Session,
  request: Request,
  grant: { grantId: string; cardId: string },
  requestDigest: string,
) {
  return withAutoTransaction(grant.grantId, async (tx, now) => {
    const existing = await tx.amuxRecommendationAutoGrant.findUnique({ where: { id: grant.grantId } });
    if (existing) {
      if (existing.workItemId !== grant.cardId) throw new BoardImportError("conflict", 409, grant.grantId);
      return { grantId: existing.id, status: existing.status, replayed: true as const };
    }
    const card = await tx.amuxWorkItem.findUnique({
      where: { id: grant.cardId },
      select: { id: true, status: true },
    });
    if (!card || card.status !== "backlog") throw new BoardImportError("not_backlog", 409, grant.grantId);
    const active = await tx.amuxRecommendationAutoGrant.findFirst({
      where: { workItemId: grant.cardId, status: "active" },
      select: { id: true },
    });
    if (active) throw new BoardImportError("conflict", 409, grant.grantId);
    const auditId = await writeHumanAudit(
      tx,
      session,
      request,
      "amux.auto_grant.prepared",
      "AmuxRecommendationAutoGrant",
      grant.grantId,
      autoAuditMetadata({ grantId: grant.grantId, digest: requestDigest }),
    );
    await tx.amuxRecommendationAutoGrant.create({
      data: {
        id: grant.grantId,
        workItemId: grant.cardId,
        status: "active",
        actorUserId: actorId(session),
        authorizationAuditLogId: auditId,
        requestDigest,
        grantedAt: now,
        expiresAt: autoGrantExpiresAt(now),
      },
    });
    const after = await tx.amuxWorkItem.findUnique({ where: { id: grant.cardId }, select: { status: true } });
    if (after?.status !== "backlog") throw new BoardImportError("unapproved_todo", 409, grant.grantId);
    return { grantId: grant.grantId, status: "active" as const, replayed: false as const };
  });
}

export async function commitAutoPromotion(
  session: Session,
  request: Request,
  body: {
    grantId: string;
    consumptionId: string;
    snapshotId: string;
    workerId: null;
    amountCents: number;
    item: BoardPromotionItem;
  },
  requestDigest: string,
) {
  const worker = autoWorkerAdmitted(body.workerId);
  if (!worker.ok) throw new BoardImportError(worker.code, 409, body.consumptionId);
  return withAutoTransaction(body.consumptionId, async (tx, now) => {
    const existing = await tx.amuxRecommendationAutoConsumption.findUnique({ where: { id: body.consumptionId } });
    if (existing) {
      if (existing.workItemId !== body.item.cardId) throw new BoardImportError("conflict", 409, body.consumptionId);
      return { consumptionId: existing.id, status: existing.status, replayed: true as const };
    }
    const halted = await openHalt(tx);
    if (halted) throw new BoardImportError("auto_halted", 409, body.consumptionId);
    const graduation = autoGraduationAccepted(await humanDecisions(tx));
    if (!graduation.ok) throw new BoardImportError(graduation.code, 409, body.consumptionId);
    const grant = await tx.amuxRecommendationAutoGrant.findUnique({ where: { id: body.grantId } });
    if (!grant || grant.workItemId !== body.item.cardId) throw new BoardImportError("grant_missing", 409, body.consumptionId);
    const usable = autoGrantUsable({ status: grant.status, expiresAt: grant.expiresAt, now });
    if (!usable.ok) throw new BoardImportError(usable.code, 409, body.consumptionId);
    const card = await tx.amuxWorkItem.findUnique({
      where: { id: body.item.cardId },
      select: {
        id: true,
        status: true,
        owner: true,
        claimedAt: true,
        archivedAt: true,
        revision: true,
        sourceDigest: true,
        executionBriefDigest: true,
      },
    });
    if (!card || card.status !== "backlog" || card.owner || card.claimedAt || card.archivedAt) {
      throw new BoardImportError("not_backlog", 409, body.consumptionId);
    }
    if (card.revision !== body.item.expectedRevision || card.sourceDigest !== body.item.sourceDigest) {
      throw new BoardImportError("conflict", 409, body.consumptionId);
    }
    const snapshotItem = await tx.amuxRecommendationSnapshotItem.findUnique({
      where: { snapshotId_workItemId: { snapshotId: body.snapshotId, workItemId: card.id } },
      select: { disposition: true, executionBriefDigest: true, sourceDigest: true },
    });
    if (!snapshotItem || snapshotItem.disposition !== "included" || snapshotItem.sourceDigest !== card.sourceDigest) {
      throw new BoardImportError("not_included", 409, body.consumptionId);
    }
    const briefDigest = boardPromotionExecutionBriefDigest(body.item.executionBrief);
    if (snapshotItem.executionBriefDigest !== card.executionBriefDigest) {
      throw new BoardImportError("brief_digest_changed", 409, body.consumptionId);
    }
    if (card.executionBriefDigest && card.executionBriefDigest !== briefDigest) {
      throw new BoardImportError("brief_digest_changed", 409, body.consumptionId);
    }
    const attempts = await tx.amuxExecutionAttempt.count({ where: { taskId: card.id } });
    const deliveries = await tx.amuxWorkDelivery.count({ where: { taskId: card.id } });
    const routes = await tx.amuxRouteDecision.count({ where: { taskId: card.id } });
    if (attempts > 0 || deliveries > 0 || routes > 0) throw new BoardImportError("lifecycle_present", 409, body.consumptionId);
    const incident = await tx.appSetting.findUnique({ where: { key: AMUX_INCIDENT_SETTING_KEY }, select: { value: true } });
    if (parseAmuxIncidentSetting(incident?.value).blocks_admission) {
      throw new BoardImportError("incident_blocked", 409, body.consumptionId);
    }
    const openDependency = await tx.amuxWorkDependency.count({
      where: {
        taskId: card.id,
        dependency: { OR: [{ status: { not: "done" } }, { archivedAt: { not: null } }] },
      },
    });
    if (openDependency > 0) throw new BoardImportError("dependency_open", 409, body.consumptionId);
    const capacity = await tx.amuxRecommendationCapacity.findUnique({ where: { id: "queue" } });
    const occupied = await tx.amuxWorkItem.count({
      where: { archivedAt: null, status: { in: ["todo", "doing"] } },
    });
    if (!capacity || !capacity.active || capacity.wipLimit === null) {
      throw new BoardImportError("capacity_unconfigured", 409, body.consumptionId);
    }
    if (occupied + 1 > capacity.wipLimit) throw new BoardImportError("capacity_full", 409, body.consumptionId);
    const entries = await costEntries(tx);
    const cost = autoCostAccepted({ proposedCents: body.amountCents, entries, now });
    if (!cost.ok) throw new BoardImportError(cost.code, 409, body.consumptionId);
    const active = await tx.amuxRecommendationAutoConsumption.count({
      where: { status: "consumed", workItem: { archivedAt: null, status: { in: ["todo", "doing"] } } },
    });
    const wip = autoGlobalWipAccepted(active);
    if (!wip.ok) throw new BoardImportError(wip.code, 409, body.consumptionId);
    const write = boardPromotionCardWrite(body.item);
    const updated = await tx.amuxWorkItem.updateMany({ where: write.where, data: write.data });
    if (updated.count !== 1) throw new BoardImportError("conflict", 409, body.consumptionId);
    const grantUpdate = await tx.amuxRecommendationAutoGrant.updateMany({
      where: { id: grant.id, status: "active" },
      data: { status: "consumed" },
    });
    if (grantUpdate.count !== 1) throw new BoardImportError("conflict", 409, body.consumptionId);
    const auditId = await writeHumanAudit(
      tx,
      session,
      request,
      "amux.auto_promotion.consumed",
      "AmuxRecommendationAutoConsumption",
      body.consumptionId,
      autoAuditMetadata({
        grantId: body.grantId,
        consumptionId: body.consumptionId,
        snapshotId: body.snapshotId,
        digest: requestDigest,
        amountCents: body.amountCents,
        rowCount: 1,
      }),
    );
    await tx.amuxRecommendationAutoConsumption.create({
      data: {
        id: body.consumptionId,
        grantId: body.grantId,
        workItemId: card.id,
        snapshotId: body.snapshotId,
        status: "consumed",
        actorUserId: actorId(session),
        authorizationAuditLogId: auditId,
        requestDigest,
      },
    });
    return { consumptionId: body.consumptionId, status: "consumed" as const, replayed: false as const };
  });
}

export async function commitAutoHaltFromReadback(input: {
  session: Session;
  request: Request;
  haltId: string;
}) {
  return withAutoTransaction(input.haltId, async (tx, now) => {
    const existing = await openHalt(tx);
    if (existing) return { haltId: existing.id, halted: true as const, replayed: true as const };
    const entries = await costEntries(tx);
    const inWindow = (windowMs: number) =>
      entries.filter((entry) => {
        const time = entry.recordedAt.getTime();
        return time >= now.getTime() - windowMs && time <= now.getTime();
      });
    const sum = (rows: typeof entries) => rows.reduce((total, row) => total + row.amountCents, 0);
    const consumptions = await tx.amuxRecommendationAutoConsumption.findMany({
      select: {
        workItemId: true,
        status: true,
        workItem: { select: { status: true, archivedAt: true, owner: true } },
        outcomeUnknownAt: true,
      },
    });
    const consumed = consumptions.filter((row) => row.status === "consumed");
    const activeCards = consumed.filter(
      (row) => row.workItem.archivedAt === null && (row.workItem.status === "todo" || row.workItem.status === "doing"),
    );
    const ownerCounts = new Map<string, number>();
    for (const row of activeCards) {
      if (!row.workItem.owner) continue;
      ownerCounts.set(row.workItem.owner, (ownerCounts.get(row.workItem.owner) ?? 0) + 1);
    }
    const unapprovedTodo = await tx.amuxWorkItem.count({
      where: {
        archivedAt: null,
        status: { in: ["todo", "doing"] },
        autoGrants: { some: {} },
        autoConsumptions: { none: { status: "consumed" } },
      },
    });
    const consumedIds = consumed.map((row) => row.workItemId);
    const attempts = consumedIds.length === 0
      ? 0
      : await tx.amuxExecutionAttempt.count({ where: { taskId: { in: consumedIds } } });
    const deliveries = consumedIds.length === 0
      ? 0
      : await tx.amuxWorkDelivery.count({ where: { taskId: { in: consumedIds } } });
    const routes = consumedIds.length === 0
      ? 0
      : await tx.amuxRouteDecision.count({ where: { taskId: { in: consumedIds } } });
    const readback = autoReadbackCritical({
      activeCount: activeCards.length,
      ownerCounts: [...ownerCounts.values()],
      costCents24h: sum(inWindow(24 * 60 * 60 * 1000)),
      costCents30d: sum(inWindow(30 * 24 * 60 * 60 * 1000)),
      unapprovedTodo,
      lifecycleWrites: attempts + deliveries + routes,
    });
    const unknownAt = consumptions.flatMap((row) => (row.outcomeUnknownAt ? [row.outcomeUnknownAt] : []));
    const decision = autoHaltRequired({
      criticalCodes: readback,
      unknownAt,
      now,
    });
    if (!decision.halt) return { haltId: null, halted: false as const, replayed: false as const };
    const auditId = await writeHumanAudit(
      tx,
      input.session,
      input.request,
      "amux.auto_promotion.halted",
      "AmuxRecommendationAutoHalt",
      input.haltId,
      autoAuditMetadata({ violationCode: decision.violationCode }),
    );
    await tx.amuxRecommendationAutoHalt.create({
      data: {
        id: input.haltId,
        reason: decision.reason,
        violationCode: decision.violationCode,
        actorUserId: actorId(input.session),
        authorizationAuditLogId: auditId,
        openedAt: now,
      },
    });
    return { haltId: input.haltId, halted: true as const, replayed: false as const };
  });
};
