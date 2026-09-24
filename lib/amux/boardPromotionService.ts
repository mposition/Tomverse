import "server-only";

import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { SYSTEM_AUDIT_ACTOR_METADATA_KEY } from "@/lib/adminAuditSystemActors";
import {
  BOARD_IMPORT_EXPIRE_BATCH,
  BOARD_IMPORT_EXPIRY_MS,
  BOARD_IMPORT_STATEMENT_TIMEOUT,
  BoardImportError,
  boardImportAuditEntryHashMatches,
  boardImportAuditKeysPresent,
  boardImportFailureIsAmbiguous,
  boardImportSameOperatorApproval,
  boardImportTransitionAllowed,
} from "@/lib/amux/boardImportCore";
import {
  BOARD_PROMOTION_APPLY_CODE_LATCH,
  BOARD_PROMOTION_APPLY_ENV,
  BOARD_PROMOTION_POLICY_VERSION,
  BOARD_PROMOTION_SCANNER_RULESET_DIGEST,
  BOARD_PROMOTION_SCANNER_VERSION,
  type BoardPromotionCardFact,
  type BoardPromotionItem,
  type BoardPromotionRequest,
  boardPromotionApplyPermitted,
  boardPromotionCardWrite,
  boardPromotionItemBindingsDigest,
  classifyBoardPromotion,
  parseBoardPromotionItems,
  parseBoardPromotionRequest,
} from "@/lib/amux/boardPromotionCore";
import { prisma } from "@/lib/prisma";

/**
 * Manual promotion writer.
 *
 * docs/policy/development-agent-orchestration.md (orchestration policy version 5).
 * The request schema stays at policy version 3.
 *
 * Prepare, approve, reject, expire and apply commit with their canonical
 * audit row. applyBoardPromotion does not accept a caller override. The
 * shipped code latch is true. Apply still throws before a card write unless
 * the environment value is exactly enabled. This file does not promote a card
 * by itself.
 */

const TARGET_TYPE = "AmuxBoardPromotionApproval";
const SHA256 = /^[a-f0-9]{64}$/;

const summaries: Record<string, string> = {
  "amux.board_promotion.prepared": "Prepared an AMUX card promotion.",
  "amux.board_promotion.approved": "Approved an AMUX card promotion.",
  "amux.board_promotion.rejected": "Rejected an AMUX card promotion.",
  "amux.board_promotion.expired": "Expired an AMUX card promotion.",
  "amux.board_promotion.consumed": "Consumed an AMUX card promotion.",
  "amux.board_promotion.outcome_unknown": "Recorded an unknown AMUX card promotion outcome.",
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

const metadataMarker = (metadata: Prisma.JsonValue | null): string | null => {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[SYSTEM_AUDIT_ACTOR_METADATA_KEY];
  return typeof value === "string" ? value : null;
};

const jsonString = (metadata: Prisma.JsonValue | null, key: string): string | null => {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
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

const withPromotionTransaction = async <T>(
  approvalId: string | null,
  run: (tx: Prisma.TransactionClient, now: Date) => Promise<T>,
): Promise<T> => {
  if (!boardImportAuditKeysPresent(adminAuditIntegrityKeys(process.env).length)) {
    throw new BoardImportError("audit_key_missing", 503, approvalId);
  }
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${BOARD_IMPORT_STATEMENT_TIMEOUT}, true)`;
        return run(tx, await databaseNow(tx));
      },
      { maxWait: 5_000, timeout: 20_000 },
    );
  } catch (error) {
    if (error instanceof BoardImportError) throw error;
    const code = prismaCode(error);
    if (code === "P2002") throw new BoardImportError("conflict", 409, approvalId);
    if (boardImportFailureIsAmbiguous(code) || disconnectMessage(error)) {
      throw new BoardImportError("outcome_unknown", 409, approvalId);
    }
    throw error;
  }
};

const requireBoundAudit = async (
  tx: Prisma.TransactionClient,
  auditId: string,
  expected: { actorUserId: string; action: string; targetId: string },
): Promise<Prisma.JsonValue | null> => {
  const row = await tx.adminAuditLog.findUnique({
    where: { id: auditId },
    select: {
      id: true,
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
    !(row.createdAt instanceof Date)
  ) {
    throw new BoardImportError("audit_unbound", 500, expected.targetId);
  }
  if (row.actorUserId !== expected.actorUserId || metadataMarker(row.metadata)) {
    throw new BoardImportError("audit_unbound", 500, expected.targetId);
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
  if (row.previousHash !== null) {
    if (typeof row.previousHash !== "string" || !SHA256.test(row.previousHash)) {
      throw new BoardImportError("audit_unbound", 500, expected.targetId);
    }
    const previous = await tx.adminAuditLog.findFirst({
      where: { entryHash: row.previousHash },
      select: { id: true },
    });
    if (!previous) throw new BoardImportError("audit_unbound", 500, expected.targetId);
  }
  return row.metadata;
};

const writeHumanAudit = async (
  tx: Prisma.TransactionClient,
  session: Session,
  request: Request,
  action: string,
  approvalId: string,
  metadata: Prisma.InputJsonObject,
) => {
  const auditId = await writeAdminAuditLog({
    session,
    request,
    action,
    targetType: TARGET_TYPE,
    targetId: approvalId,
    summary: summaries[action] ?? "Recorded an AMUX card promotion.",
    metadata,
    tx,
  });
  await requireBoundAudit(tx, auditId, {
    actorUserId: actorId(session),
    action,
    targetId: approvalId,
  });
  return auditId;
};

const loadFacts = async (
  db: Prisma.TransactionClient | typeof prisma,
  items: readonly BoardPromotionItem[],
): Promise<Map<string, BoardPromotionCardFact>> => {
  const ids = items.map((item) => item.cardId);
  const rows = await db.amuxWorkItem.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      revision: true,
      status: true,
      owner: true,
      claimedAt: true,
      archivedAt: true,
      sourceSystem: true,
      sourceDigest: true,
      dependencies: {
        select: { dependency: { select: { status: true, archivedAt: true } } },
      },
      _count: { select: { executionAttempts: true, routeDecisions: true } },
    },
  });
  const deliveries = await db.amuxWorkDelivery.findMany({
    where: { taskId: { in: ids } },
    select: { taskId: true },
  });
  const deliveryCount = new Map<string, number>();
  for (const row of deliveries) deliveryCount.set(row.taskId, (deliveryCount.get(row.taskId) ?? 0) + 1);
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        revision: row.revision,
        status: row.status,
        owner: row.owner,
        claimedAt: row.claimedAt,
        archivedAt: row.archivedAt,
        sourceSystem: row.sourceSystem,
        sourceDigest: row.sourceDigest,
        attemptCount: row._count.executionAttempts,
        routeDecisionCount: row._count.routeDecisions,
        deliveryCount: deliveryCount.get(row.id) ?? 0,
        dependencies: row.dependencies.map((edge) => edge.dependency),
      },
    ]),
  );
};

const auditMetadata = (
  request: BoardPromotionRequest,
  requestDigest: string,
  rawBodyDigest: string,
  reason?: string,
): Prisma.InputJsonObject => ({
  policyVersion: request.policyVersion,
  requestDigest,
  rawBodyDigest,
  itemBindingsDigest: boardPromotionItemBindingsDigest(request.items),
  cardCount: request.items.length,
  ...(reason ? { reason } : {}),
});

export async function previewBoardPromotion(raw: string) {
  const parsed = parseBoardPromotionRequest(raw);
  if (!parsed.ok) throw new BoardImportError(parsed.code, 400);
  const facts = await loadFacts(prisma, parsed.request.items);
  const classification = classifyBoardPromotion(parsed.request, facts);
  return {
    policyVersion: BOARD_PROMOTION_POLICY_VERSION,
    cardCount: parsed.request.items.length,
    cardIds: parsed.request.items.map((item) => item.cardId),
    refusal: classification.refusal,
    applyPermitted: boardPromotionApplyPermitted({
      envValue: process.env[BOARD_PROMOTION_APPLY_ENV],
      codeLatch: BOARD_PROMOTION_APPLY_CODE_LATCH,
    }),
  };
}

export async function prepareBoardPromotion(input: { session: Session; request: Request; raw: string }) {
  const parsed = parseBoardPromotionRequest(input.raw);
  if (!parsed.ok) throw new BoardImportError(parsed.code, 400);
  return withPromotionTransaction(null, async (tx, now) => {
    const facts = await loadFacts(tx, parsed.request.items);
    const classification = classifyBoardPromotion(parsed.request, facts);
    const id = randomUUID();
    const refused = classification.refusal !== null;
    const auditId = await writeHumanAudit(
      tx,
      input.session,
      input.request,
      refused ? "amux.board_promotion.rejected" : "amux.board_promotion.prepared",
      id,
      auditMetadata(parsed.request, parsed.requestDigest, parsed.rawBodyDigest, classification.refusal ?? undefined),
    );
    await tx.amuxBoardPromotionApproval.create({
      data: {
        id,
        status: refused ? "rejected" : "prepared",
        actorUserId: actorId(input.session),
        authorizationAuditLogId: auditId,
        requestDigest: parsed.requestDigest,
        rawBodyDigest: parsed.rawBodyDigest,
        itemBindings: parsed.request.items,
        itemBindingsDigest: boardPromotionItemBindingsDigest(parsed.request.items),
        cardCount: parsed.request.items.length,
        scannerVersion: BOARD_PROMOTION_SCANNER_VERSION,
        scannerRulesetDigest: BOARD_PROMOTION_SCANNER_RULESET_DIGEST,
        policyVersion: BOARD_PROMOTION_POLICY_VERSION,
        preparedAt: now,
        rejectedAt: refused ? now : null,
        expiresAt: refused ? now : new Date(now.getTime() + BOARD_IMPORT_EXPIRY_MS),
      },
    });
    return {
      approvalId: id,
      status: refused ? ("rejected" as const) : ("prepared" as const),
      refusal: classification.refusal,
    };
  });
}

const loadOwned = async (tx: Prisma.TransactionClient, approvalId: string, session: Session) => {
  const row = await tx.amuxBoardPromotionApproval.findUnique({ where: { id: approvalId } });
  if (!row || !boardImportSameOperatorApproval(row.actorUserId, actorId(session))) {
    throw new BoardImportError("not_found", 404, approvalId);
  }
  return row;
};

export async function approveBoardPromotion(input: { session: Session; request: Request; approvalId: string }) {
  return withPromotionTransaction(input.approvalId, async (tx, now) => {
    const row = await loadOwned(tx, input.approvalId, input.session);
    if (!boardImportTransitionAllowed(row.status, "approved")) {
      throw new BoardImportError("conflict", 409, row.id);
    }
    if (row.expiresAt.getTime() <= now.getTime()) throw new BoardImportError("approval_window_elapsed", 409, row.id);
    const auditId = await writeHumanAudit(tx, input.session, input.request, "amux.board_promotion.approved", row.id, {
      policyVersion: row.policyVersion,
      requestDigest: row.requestDigest,
      rawBodyDigest: row.rawBodyDigest,
      itemBindingsDigest: row.itemBindingsDigest,
      cardCount: row.cardCount,
    });
    const updated = await tx.amuxBoardPromotionApproval.updateMany({
      where: { id: row.id, status: "prepared", outcomeUnknownAt: null, expiresAt: { gt: now } },
      data: { status: "approved", approvedAt: now, authorizationAuditLogId: auditId },
    });
    if (updated.count !== 1) throw new BoardImportError("conflict", 409, row.id);
    return { approvalId: row.id, status: "approved" as const, expiresAt: row.expiresAt.toISOString() };
  });
}

export async function rejectBoardPromotion(input: { session: Session; request: Request; approvalId: string }) {
  return withPromotionTransaction(input.approvalId, async (tx, now) => {
    const row = await loadOwned(tx, input.approvalId, input.session);
    if (!boardImportTransitionAllowed(row.status, "rejected")) throw new BoardImportError("conflict", 409, row.id);
    const auditId = await writeHumanAudit(tx, input.session, input.request, "amux.board_promotion.rejected", row.id, {
      policyVersion: row.policyVersion,
      requestDigest: row.requestDigest,
      itemBindingsDigest: row.itemBindingsDigest,
      cardCount: row.cardCount,
      reason: "operator_rejected",
    });
    const updated = await tx.amuxBoardPromotionApproval.updateMany({
      where: { id: row.id, status: row.status, outcomeUnknownAt: null },
      data: { status: "rejected", rejectedAt: now, authorizationAuditLogId: auditId },
    });
    if (updated.count !== 1) throw new BoardImportError("conflict", 409, row.id);
    return { approvalId: row.id, status: "rejected" as const };
  });
}

export async function expireBoardPromotion(input: { session: Session; request: Request; approvalId: string }) {
  return withPromotionTransaction(input.approvalId, async (tx, now) => {
    const row = await loadOwned(tx, input.approvalId, input.session);
    if (!boardImportTransitionAllowed(row.status, "expired")) throw new BoardImportError("conflict", 409, row.id);
    const auditId = await writeHumanAudit(tx, input.session, input.request, "amux.board_promotion.expired", row.id, {
      policyVersion: row.policyVersion,
      requestDigest: row.requestDigest,
      itemBindingsDigest: row.itemBindingsDigest,
      cardCount: row.cardCount,
    });
    const updated = await tx.amuxBoardPromotionApproval.updateMany({
      where: { id: row.id, status: row.status, outcomeUnknownAt: null },
      data: { status: "expired", expiredAt: now, authorizationAuditLogId: auditId },
    });
    if (updated.count !== 1) throw new BoardImportError("conflict", 409, row.id);
    return { approvalId: row.id, status: "expired" as const };
  });
}

export async function expireDueBoardPromotions(input: { session: Session; request: Request }) {
  return withPromotionTransaction(null, async (tx, now) => {
    const due = await tx.amuxBoardPromotionApproval.findMany({
      where: {
        actorUserId: actorId(input.session),
        status: { in: ["prepared", "approved"] },
        outcomeUnknownAt: null,
        expiresAt: { lte: now },
      },
      orderBy: { expiresAt: "asc" },
      take: BOARD_IMPORT_EXPIRE_BATCH,
      select: { id: true, status: true, policyVersion: true, requestDigest: true, itemBindingsDigest: true, cardCount: true },
    });
    let expired = 0;
    for (const row of due) {
      if (!boardImportTransitionAllowed(row.status, "expired")) continue;
      const auditId = await writeHumanAudit(tx, input.session, input.request, "amux.board_promotion.expired", row.id, {
        policyVersion: row.policyVersion,
        requestDigest: row.requestDigest,
        itemBindingsDigest: row.itemBindingsDigest,
        cardCount: row.cardCount,
        reason: "window_elapsed",
      });
      const updated = await tx.amuxBoardPromotionApproval.updateMany({
        where: { id: row.id, status: row.status, outcomeUnknownAt: null, expiresAt: { lte: now } },
        data: { status: "expired", expiredAt: now, authorizationAuditLogId: auditId },
      });
      expired += updated.count;
    }
    return { expired };
  });
}

const rejectApproved = async (
  tx: Prisma.TransactionClient,
  session: Session,
  request: Request,
  row: { id: string; policyVersion: number; requestDigest: string; itemBindingsDigest: string; cardCount: number },
  now: Date,
  reason: string,
) => {
  const auditId = await writeHumanAudit(tx, session, request, "amux.board_promotion.rejected", row.id, {
    policyVersion: row.policyVersion,
    requestDigest: row.requestDigest,
    itemBindingsDigest: row.itemBindingsDigest,
    cardCount: row.cardCount,
    reason,
  });
  const updated = await tx.amuxBoardPromotionApproval.updateMany({
    where: { id: row.id, status: "approved", outcomeUnknownAt: null },
    data: { status: "rejected", rejectedAt: now, authorizationAuditLogId: auditId },
  });
  if (updated.count !== 1) throw new BoardImportError("conflict", 409, row.id);
  return { approvalId: row.id, status: "rejected" as const, refusal: reason };
};

export async function applyBoardPromotion(input: { session: Session; request: Request; approvalId: string }) {
  if (
    !boardPromotionApplyPermitted({
      envValue: process.env[BOARD_PROMOTION_APPLY_ENV],
      codeLatch: BOARD_PROMOTION_APPLY_CODE_LATCH,
    })
  ) {
    throw new BoardImportError("apply_disabled", 409, input.approvalId);
  }
  return withPromotionTransaction(input.approvalId, async (tx, now) => {
    const row = await loadOwned(tx, input.approvalId, input.session);
    if (!boardImportTransitionAllowed(row.status, "consumed")) throw new BoardImportError("conflict", 409, row.id);
    if (row.expiresAt.getTime() <= now.getTime()) throw new BoardImportError("approval_window_elapsed", 409, row.id);
    const items = parseBoardPromotionItems(row.itemBindings);
    if (!items || boardPromotionItemBindingsDigest(items) !== row.itemBindingsDigest) {
      return rejectApproved(tx, input.session, input.request, row, now, "binding_mismatch");
    }
    const signed = await requireBoundAudit(tx, row.authorizationAuditLogId, {
      actorUserId: row.actorUserId,
      action: "amux.board_promotion.approved",
      targetId: row.id,
    });
    if (
      jsonString(signed, "itemBindingsDigest") !== row.itemBindingsDigest ||
      jsonString(signed, "requestDigest") !== row.requestDigest ||
      jsonString(signed, "rawBodyDigest") !== row.rawBodyDigest ||
      row.policyVersion !== BOARD_PROMOTION_POLICY_VERSION ||
      row.scannerVersion !== BOARD_PROMOTION_SCANNER_VERSION ||
      row.scannerRulesetDigest !== BOARD_PROMOTION_SCANNER_RULESET_DIGEST ||
      row.cardCount !== items.length
    ) {
      return rejectApproved(tx, input.session, input.request, row, now, "binding_mismatch");
    }
    const request: BoardPromotionRequest = {
      canonicalizationVersion: "amux-json-v1",
      policyVersion: BOARD_PROMOTION_POLICY_VERSION,
      items,
    };
    const live = classifyBoardPromotion(request, await loadFacts(tx, items));
    if (live.refusal || boardPromotionItemBindingsDigest(live.promote) !== row.itemBindingsDigest) {
      return rejectApproved(tx, input.session, input.request, row, now, live.refusal ?? "binding_mismatch");
    }
    for (const item of live.promote) {
      const write = boardPromotionCardWrite(item);
      const updated = await tx.amuxWorkItem.updateMany({ where: write.where, data: write.data });
      if (updated.count !== 1) throw new BoardImportError("conflict", 409, row.id);
    }
    const auditId = await writeHumanAudit(
      tx,
      input.session,
      input.request,
      "amux.board_promotion.consumed",
      row.id,
      auditMetadata(request, row.requestDigest, row.rawBodyDigest),
    );
    const consumed = await tx.amuxBoardPromotionApproval.updateMany({
      where: { id: row.id, status: "approved", outcomeUnknownAt: null, expiresAt: { gt: now } },
      data: { status: "consumed", consumedAt: now, authorizationAuditLogId: auditId },
    });
    if (consumed.count !== 1) throw new BoardImportError("conflict", 409, row.id);
    return { approvalId: row.id, status: "consumed" as const, promoted: live.promote.length };
  });
}

export async function markBoardPromotionOutcomeUnknown(input: {
  session: Session;
  request: Request;
  approvalId: string;
}) {
  try {
    return await withPromotionTransaction(input.approvalId, async (tx, now) => {
      const owned = await tx.amuxBoardPromotionApproval.findUnique({
        where: { id: input.approvalId },
        select: { actorUserId: true, status: true },
      });
      if (!owned || !boardImportSameOperatorApproval(owned.actorUserId, actorId(input.session))) {
        return { marked: false as const };
      }
      if (!boardImportTransitionAllowed(owned.status, "expired")) return { marked: false as const };
      const reserved = await tx.amuxBoardPromotionApproval.updateMany({
        where: { id: input.approvalId, actorUserId: owned.actorUserId, status: owned.status, outcomeUnknownAt: null },
        data: { outcomeUnknownAt: now, status: "expired", expiredAt: now },
      });
      if (reserved.count !== 1) return { marked: false as const };
      const auditId = await writeHumanAudit(
        tx,
        input.session,
        input.request,
        "amux.board_promotion.outcome_unknown",
        input.approvalId,
        { reason: "outcome_unknown" },
      );
      await tx.amuxBoardPromotionApproval.updateMany({
        where: { id: input.approvalId, actorUserId: owned.actorUserId },
        data: { authorizationAuditLogId: auditId },
      });
      return { marked: true as const };
    });
  } catch {
    return { marked: false as const };
  }
}
