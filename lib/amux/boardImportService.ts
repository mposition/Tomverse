import "server-only";

import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { SYSTEM_AUDIT_ACTOR_METADATA_KEY } from "@/lib/adminAuditSystemActors";
import {
  BOARD_IMPORT_APPLY_CODE_LATCH,
  BOARD_IMPORT_APPLY_ENV,
  BOARD_IMPORT_SCANNER_RULESET_DIGEST,
  BOARD_IMPORT_EXPIRE_BATCH,
  BOARD_IMPORT_STATEMENT_TIMEOUT,
  type BoardImportClassification,
  type BoardImportManifest,
  BoardImportError,
  boardImportApplyPermitted,
  boardImportAuditEntryHashMatches,
  boardImportAuditKeysPresent,
  boardImportCardWrites,
  boardImportClassificationSetsEqual,
  boardImportExecutionBriefDigests,
  boardImportItemBindings,
  boardImportItemsFromBindings,
  parseBoardImportItemBindings,
  boardImportExpiresAt,
  boardImportFailureIsAmbiguous,
  boardImportItemBindingsDigest,
  boardImportSameOperatorApproval,
  boardImportTransitionAllowed,
  classifyBoardImport,
  boardImportConflictReasons,
  digestAmuxManifest,
  parseBoardImportManifest,
  boardImportSourceMissing,
  boardImportSubmissionRefusal,
} from "@/lib/amux/boardImportCore";
import { loadBoardImportExistingCards, loadBoardImportSourcePresence } from "@/lib/amux/boardImportPreview";
import { prisma } from "@/lib/prisma";

/**
 * Catalog-import writer.
 *
 * docs/policy/development-agent-orchestration.md (policy version 2).
 *
 * Every prepare, approve, reject, expire, apply and consume commits or rolls
 * back with its canonical audit row. The signing key is checked before the
 * transaction starts. A missing or unbound entryHash throws inside the
 * transaction so the domain write rolls back with it.
 *
 * This transaction does not use the AMUX worker boundary (200ms statement
 * timeout, 100ms idle). It sets its own 15s statement timeout and leaves the
 * idle timeout alone. There is no measured evidence that the worker boundary
 * can cover the audit-chain lock.
 *
 * Production apply needs the environment latch and BOARD_IMPORT_APPLY_CODE_LATCH.
 * The constant ships false. applyBoardImport does not accept a caller override.
 */

const TARGET_TYPE = "AmuxBoardImportApproval";
const SHA256 = /^[a-f0-9]{64}$/;

type ApprovalRow = {
  id: string;
  status: string;
  actorUserId: string;
  manifestDigest: string;
  policyVersion: number;
  outcomeUnknownAt: Date | null;
  expiresAt: Date;
  createKeys: Prisma.JsonValue;
  noOpKeys: Prisma.JsonValue;
  conflictKeys: Prisma.JsonValue;
  excludeKeys: Prisma.JsonValue;
  authorizationAuditLogId: string;
  itemBindings: Prisma.JsonValue;
  itemBindingsDigest: string;
  rawBodyDigest: string;
  canonicalizerVersion: string;
  sourceCommit: string;
  boardDigest: string;
  sourceVerificationMode: string;
  plannerVersion: string;
  validatorVersion: string;
  scannerVersion: string;
  scannerRulesetDigest: string;
  recommendationReferenceCount: number;
};

const approvalSelect = {
  id: true,
  status: true,
  actorUserId: true,
  manifestDigest: true,
  policyVersion: true,
  outcomeUnknownAt: true,
  expiresAt: true,
  createKeys: true,
  noOpKeys: true,
  conflictKeys: true,
  excludeKeys: true,
  authorizationAuditLogId: true,
  itemBindings: true,
  itemBindingsDigest: true,
  rawBodyDigest: true,
  canonicalizerVersion: true,
  sourceCommit: true,
  boardDigest: true,
  sourceVerificationMode: true,
  plannerVersion: true,
  validatorVersion: true,
  scannerVersion: true,
  scannerRulesetDigest: true,
  recommendationReferenceCount: true,
} as const;

const summaries: Record<string, string> = {
  "amux.board_import.prepared": "Prepared an AMUX catalog import.",
  "amux.board_import.approved": "Approved an AMUX catalog import.",
  "amux.board_import.rejected": "Rejected an AMUX catalog import.",
  "amux.board_import.expired": "Expired an AMUX catalog import.",
  "amux.board_import.consumed": "Consumed an AMUX catalog import.",
  "amux.board_import.outcome_unknown": "Recorded an unknown AMUX catalog import outcome.",
};

const requireTransition = (from: string, to: string, approvalId: string) => {
  if (!boardImportTransitionAllowed(from, to)) throw new BoardImportError("conflict", 409, approvalId);
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

const stringArray = (value: Prisma.JsonValue): string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value].sort()
    : [];

const classificationFromRow = (row: ApprovalRow): BoardImportClassification => ({
  create: stringArray(row.createKeys),
  noOp: stringArray(row.noOpKeys),
  conflict: stringArray(row.conflictKeys),
  exclude: stringArray(row.excludeKeys),
});

const metadataMarker = (metadata: Prisma.JsonValue | null): string | null => {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[SYSTEM_AUDIT_ACTOR_METADATA_KEY];
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

const requireBoundAudit = async (
  tx: Prisma.TransactionClient,
  auditId: string,
  expected: {
    actorUserId: string;
    action: string;
    targetId: string;
  },
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
    return row.metadata;
  }
  const hashedBefore = await tx.adminAuditLog.count({
    where: { id: { not: row.id }, entryHash: { not: null } },
  });
  if (hashedBefore !== 0) throw new BoardImportError("audit_unbound", 500, expected.targetId);
  return row.metadata;
};

const withBoardImportTransaction = async <T>(
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
    summary: summaries[action] ?? "Recorded an AMUX catalog import.",
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

const jsonString = (metadata: Prisma.JsonValue | null, key: string): string | null => {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

const countMetadata = (
  manifest: BoardImportManifest,
  classification: BoardImportClassification,
  rawBodyDigest: string,
  itemBindingsDigest: string,
  reason?: string,
): Prisma.InputJsonObject => ({
  policyVersion: manifest.policyVersion,
  manifestDigest: manifest.manifestDigest,
  rawBodyDigest,
  itemBindingsDigest,
  createCount: classification.create.length,
  noOpCount: classification.noOp.length,
  conflictCount: classification.conflict.length,
  excludeCount: classification.exclude.length,
  ...(reason ? { reason } : {}),
});

const insertApproval = async (
  tx: Prisma.TransactionClient,
  input: {
    id: string;
    status: "prepared" | "rejected";
    session: Session;
    now: Date;
    auditId: string;
    manifest: BoardImportManifest;
    rawBodyDigest: string;
    classification: BoardImportClassification;
    itemBindingsDigest: string;
  },
) => {
  const refused = input.status === "rejected";
  await tx.amuxBoardImportApproval.create({
    data: {
      id: input.id,
      status: input.status,
      actorUserId: actorId(input.session),
      authorizationAuditLogId: input.auditId,
      manifestDigest: input.manifest.manifestDigest,
      canonicalizerVersion: input.manifest.canonicalizationVersion,
      sourceCommit: input.manifest.source.commit,
      boardDigest: input.manifest.source.boardDigest,
      sourceVerificationMode: input.manifest.source.verificationMode,
      sourceAttestedAt: input.now,
      activeItemCount: input.manifest.source.activeItemCount,
      sectionCount: input.manifest.source.sectionCount,
      recommendationReferenceCount: input.manifest.source.recommendationReferenceCount,
      createKeys: input.classification.create,
      noOpKeys: input.classification.noOp,
      conflictKeys: input.classification.conflict,
      excludeKeys: input.classification.exclude,
      executionBriefDigests: boardImportExecutionBriefDigests(input.manifest),
      itemBindings: boardImportItemBindings(input.manifest),
      itemBindingsDigest: input.itemBindingsDigest,
      plannerVersion: input.manifest.plannerVersion,
      validatorVersion: input.manifest.validatorVersion,
      scannerVersion: input.manifest.scannerVersion,
      scannerRulesetDigest: input.manifest.scannerRulesetDigest,
      policyVersion: input.manifest.policyVersion,
      rawBodyDigest: input.rawBodyDigest,
      preparedAt: input.now,
      rejectedAt: refused ? input.now : null,
      expiresAt: refused ? input.now : boardImportExpiresAt(input.now),
    },
  });
};

export async function previewBoardImport(raw: string) {
  const parsed = parseBoardImportManifest(raw);
  if (!parsed.ok) throw new BoardImportError(parsed.code, 400);
  const existing = await loadBoardImportExistingCards(prisma, parsed.manifest.items);
  const presence = await loadBoardImportSourcePresence(prisma, parsed.manifest.items);
  const classification = classifyBoardImport(parsed.manifest, existing);
  const sourceMissing = boardImportSourceMissing(parsed.manifest, presence.rows);
  const conflictReasons = boardImportConflictReasons(parsed.manifest, existing);
  return {
    classification,
    refusal: boardImportSubmissionRefusal(classification),
    sourceMissingCount: sourceMissing.length,
    sourceMissingTruncated: presence.truncated,
    sourceDriftCount: conflictReasons.sourceDrift,
    activeExecutionCount: conflictReasons.activeExecution,
    otherConflictCount: conflictReasons.otherConflict,
    applyPermitted: boardImportApplyPermitted({
      envValue: process.env[BOARD_IMPORT_APPLY_ENV],
      codeLatch: BOARD_IMPORT_APPLY_CODE_LATCH,
    }),
  };
}

export async function prepareBoardImport(input: {
  session: Session;
  request: Request;
  raw: string;
}) {
  const parsed = parseBoardImportManifest(input.raw);
  if (!parsed.ok) throw new BoardImportError(parsed.code, 400);
  const approvalId = randomUUID();
  return withBoardImportTransaction(approvalId, async (tx, now) => {
    const existing = await loadBoardImportExistingCards(tx, parsed.manifest.items);
    const classification = classifyBoardImport(parsed.manifest, existing);
    const refusal = boardImportSubmissionRefusal(classification);
    const status = refusal ? "rejected" : "prepared";
    const action = refusal ? "amux.board_import.rejected" : "amux.board_import.prepared";
    const itemBindingsDigest = boardImportItemBindingsDigest(boardImportItemBindings(parsed.manifest));
    const auditId = await writeHumanAudit(
      tx,
      input.session,
      input.request,
      action,
      approvalId,
      countMetadata(parsed.manifest, classification, parsed.rawBodyDigest, itemBindingsDigest, refusal ?? undefined),
    );
    await insertApproval(tx, {
      id: approvalId,
      status,
      session: input.session,
      now,
      auditId,
      manifest: parsed.manifest,
      rawBodyDigest: parsed.rawBodyDigest,
      classification,
      itemBindingsDigest,
    });
    return {
      approvalId,
      status,
      refusal,
      classification,
      expiresAt: (refusal ? now : boardImportExpiresAt(now)).toISOString(),
    };
  });
}

const loadOwned = async (
  tx: Prisma.TransactionClient,
  approvalId: string,
  session: Session,
): Promise<ApprovalRow> => {
  const row = await tx.amuxBoardImportApproval.findUnique({
    where: { id: approvalId },
    select: approvalSelect,
  });
  if (!row) throw new BoardImportError("not_found", 404, approvalId);
  if (!boardImportSameOperatorApproval(row.actorUserId, actorId(session))) {
    throw new BoardImportError("approver_mismatch", 403, approvalId);
  }
  if (row.outcomeUnknownAt) throw new BoardImportError("outcome_unknown", 409, approvalId);
  return row;
};

export async function approveBoardImport(input: {
  session: Session;
  request: Request;
  approvalId: string;
}) {
  return withBoardImportTransaction(input.approvalId, async (tx, now) => {
    const row = await loadOwned(tx, input.approvalId, input.session);
    requireTransition(row.status, "approved", input.approvalId);
    if (row.expiresAt.getTime() <= now.getTime()) {
      throw new BoardImportError("approval_window_elapsed", 409, input.approvalId);
    }
    const signed = await requireBoundAudit(tx, row.authorizationAuditLogId, {
      actorUserId: row.actorUserId,
      action: "amux.board_import.prepared",
      targetId: row.id,
    });
    const bindings = parseBoardImportItemBindings(row.itemBindings);
    const liveDigest = bindings ? boardImportItemBindingsDigest(bindings) : null;
    const signedDigest = jsonString(signed, "itemBindingsDigest");
    const signedManifest = jsonString(signed, "manifestDigest");
    const signedRaw = jsonString(signed, "rawBodyDigest");
    if (
      !bindings ||
      !signedDigest ||
      liveDigest !== signedDigest ||
      row.itemBindingsDigest !== signedDigest ||
      signedManifest !== row.manifestDigest ||
      !signedRaw ||
      signedRaw !== row.rawBodyDigest
    ) {
      requireTransition(row.status, "rejected", row.id);
      const auditId = await writeHumanAudit(tx, input.session, input.request, "amux.board_import.rejected", row.id, {
        policyVersion: row.policyVersion,
        manifestDigest: row.manifestDigest,
        reason: "binding_mismatch",
      });
      const rejected = await tx.amuxBoardImportApproval.updateMany({
        where: { id: row.id, status: "prepared", actorUserId: row.actorUserId, outcomeUnknownAt: null },
        data: { status: "rejected", rejectedAt: now, authorizationAuditLogId: auditId },
      });
      if (rejected.count !== 1) throw new BoardImportError("conflict", 409, row.id);
      return { approvalId: row.id, status: "rejected" as const, reason: "binding_mismatch" };
    }
    const auditId = await writeHumanAudit(tx, input.session, input.request, "amux.board_import.approved", row.id, {
      policyVersion: row.policyVersion,
      manifestDigest: row.manifestDigest,
      rawBodyDigest: signedRaw,
      itemBindingsDigest: signedDigest,
    });
    const updated = await tx.amuxBoardImportApproval.updateMany({
      where: {
        id: row.id,
        status: "prepared",
        actorUserId: row.actorUserId,
        outcomeUnknownAt: null,
        expiresAt: { gt: now },
      },
      data: {
        status: "approved",
        approvedAt: now,
        expiresAt: boardImportExpiresAt(now),
        authorizationAuditLogId: auditId,
      },
    });
    if (updated.count !== 1) throw new BoardImportError("conflict", 409, row.id);
    return { approvalId: row.id, status: "approved" as const, expiresAt: boardImportExpiresAt(now).toISOString() };
  });
}

export async function rejectBoardImport(input: {
  session: Session;
  request: Request;
  approvalId: string;
}) {
  return withBoardImportTransaction(input.approvalId, async (tx, now) => {
    const row = await loadOwned(tx, input.approvalId, input.session);
    requireTransition(row.status, "rejected", input.approvalId);
    const auditId = await writeHumanAudit(tx, input.session, input.request, "amux.board_import.rejected", row.id, {
      policyVersion: row.policyVersion,
      manifestDigest: row.manifestDigest,
      reason: "operator_rejected",
    });
    const updated = await tx.amuxBoardImportApproval.updateMany({
      where: { id: row.id, status: row.status, outcomeUnknownAt: null },
      data: { status: "rejected", rejectedAt: now, authorizationAuditLogId: auditId },
    });
    if (updated.count !== 1) throw new BoardImportError("conflict", 409, row.id);
    return { approvalId: row.id, status: "rejected" as const };
  });
}

export async function expireBoardImport(input: {
  session: Session;
  request: Request;
  approvalId: string;
}) {
  return withBoardImportTransaction(input.approvalId, async (tx, now) => {
    const row = await loadOwned(tx, input.approvalId, input.session);
    requireTransition(row.status, "expired", input.approvalId);
    const auditId = await writeHumanAudit(tx, input.session, input.request, "amux.board_import.expired", row.id, {
      policyVersion: row.policyVersion,
      manifestDigest: row.manifestDigest,
      reason: "operator_expired",
    });
    const updated = await tx.amuxBoardImportApproval.updateMany({
      where: { id: row.id, status: row.status, outcomeUnknownAt: null },
      data: { status: "expired", expiredAt: now, authorizationAuditLogId: auditId },
    });
    if (updated.count !== 1) throw new BoardImportError("conflict", 409, row.id);
    return { approvalId: row.id, status: "expired" as const };
  });
}

export async function expireDueBoardImports(input: { session: Session; request: Request }) {
  const operatorId = actorId(input.session);
  return withBoardImportTransaction(null, async (tx, now) => {
    const due = await tx.amuxBoardImportApproval.findMany({
      where: {
        actorUserId: operatorId,
        status: { in: ["prepared", "approved"] },
        outcomeUnknownAt: null,
        expiresAt: { lte: now },
      },
      orderBy: { expiresAt: "asc" },
      take: BOARD_IMPORT_EXPIRE_BATCH,
      select: { id: true, status: true, policyVersion: true, manifestDigest: true },
    });
    const expired: string[] = [];
    for (const row of due) {
      requireTransition(row.status, "expired", row.id);
      const reserved = await tx.amuxBoardImportApproval.updateMany({
        where: {
          id: row.id,
          actorUserId: operatorId,
          status: row.status,
          outcomeUnknownAt: null,
          expiresAt: { lte: now },
        },
        data: { status: "expired", expiredAt: now },
      });
      if (reserved.count !== 1) continue;
      const auditId = await writeHumanAudit(tx, input.session, input.request, "amux.board_import.expired", row.id, {
        policyVersion: row.policyVersion,
        manifestDigest: row.manifestDigest,
        reason: "operator_expire_due",
      });
      await tx.amuxBoardImportApproval.updateMany({
        where: { id: row.id, actorUserId: operatorId, status: "expired" },
        data: { authorizationAuditLogId: auditId },
      });
      expired.push(row.id);
    }
    return { expired };
  });
}

export async function markBoardImportOutcomeUnknown(input: {
  session: Session;
  request: Request;
  approvalId: string;
}) {
  try {
    return await withBoardImportTransaction(input.approvalId, async (tx, now) => {
      const owned = await tx.amuxBoardImportApproval.findUnique({
        where: { id: input.approvalId },
        select: { actorUserId: true, status: true },
      });
      if (!owned || !boardImportSameOperatorApproval(owned.actorUserId, actorId(input.session))) {
        return { marked: false as const };
      }
      // Close the approval in the same write. The marker stays set, so apply
      // cannot treat this as a retry, and the elapsed sweep does not see it.
      if (!boardImportTransitionAllowed(owned.status, "expired")) return { marked: false as const };
      const reserved = await tx.amuxBoardImportApproval.updateMany({
        where: {
          id: input.approvalId,
          actorUserId: owned.actorUserId,
          status: owned.status,
          outcomeUnknownAt: null,
        },
        data: { outcomeUnknownAt: now, status: "expired", expiredAt: now },
      });
      if (reserved.count !== 1) return { marked: false as const };
      const auditId = await writeHumanAudit(
        tx,
        input.session,
        input.request,
        "amux.board_import.outcome_unknown",
        input.approvalId,
        { reason: "outcome_unknown" },
      );
      await tx.amuxBoardImportApproval.updateMany({
        where: { id: input.approvalId, actorUserId: owned.actorUserId },
        data: { authorizationAuditLogId: auditId },
      });
      return { marked: true as const };
    });
  } catch {
    return { marked: false as const };
  }
}

const rejectApproved = async (
  tx: Prisma.TransactionClient,
  session: Session,
  request: Request,
  row: ApprovalRow,
  now: Date,
  reason: string,
) => {
  requireTransition(row.status, "rejected", row.id);
  const auditId = await writeHumanAudit(tx, session, request, "amux.board_import.rejected", row.id, {
    policyVersion: row.policyVersion,
    manifestDigest: row.manifestDigest,
    reason,
  });
  const updated = await tx.amuxBoardImportApproval.updateMany({
    where: { id: row.id, status: "approved", outcomeUnknownAt: null },
    data: { status: "rejected", rejectedAt: now, authorizationAuditLogId: auditId },
  });
  if (updated.count !== 1) throw new BoardImportError("conflict", 409, row.id);
  return { approvalId: row.id, status: "rejected" as const, reason };
};

export async function applyBoardImport(input: {
  session: Session;
  request: Request;
  approvalId: string;
}) {
  if (
    !boardImportApplyPermitted({
      envValue: process.env[BOARD_IMPORT_APPLY_ENV],
      codeLatch: BOARD_IMPORT_APPLY_CODE_LATCH,
    })
  ) {
    throw new BoardImportError("apply_disabled", 409, input.approvalId);
  }
  return withBoardImportTransaction(input.approvalId, async (tx, now) => {
    const row = await loadOwned(tx, input.approvalId, input.session);
    requireTransition(row.status, "consumed", row.id);
    if (row.expiresAt.getTime() <= now.getTime()) {
      throw new BoardImportError("approval_window_elapsed", 409, row.id);
    }
    const bindings = parseBoardImportItemBindings(row.itemBindings);
    if (!bindings) {
      return rejectApproved(tx, input.session, input.request, row, now, "binding_mismatch");
    }
    const signed = await requireBoundAudit(tx, row.authorizationAuditLogId, {
      actorUserId: row.actorUserId,
      action: "amux.board_import.approved",
      targetId: row.id,
    });
    const signedDigest = jsonString(signed, "itemBindingsDigest");
    const signedManifest = jsonString(signed, "manifestDigest");
    const signedRaw = jsonString(signed, "rawBodyDigest");
    const liveDigest = boardImportItemBindingsDigest(bindings);
    if (
      !signedDigest ||
      liveDigest !== signedDigest ||
      row.itemBindingsDigest !== signedDigest ||
      signedManifest !== row.manifestDigest ||
      !signedRaw ||
      signedRaw !== row.rawBodyDigest
    ) {
      return rejectApproved(tx, input.session, input.request, row, now, "binding_mismatch");
    }
    const items = boardImportItemsFromBindings(bindings);
    const manifest: BoardImportManifest = {
      canonicalizationVersion: "amux-json-v1",
      manifestDigest: row.manifestDigest,
      policyVersion: 2,
      scannerVersion: "amux-board-content-scan-v1",
      scannerRulesetDigest: row.scannerRulesetDigest,
      plannerVersion: row.plannerVersion,
      validatorVersion: row.validatorVersion,
      source: {
        commit: row.sourceCommit,
        boardDigest: row.boardDigest,
        verificationMode: "operator_attested",
        activeItemCount: items.filter((item) => !item.exclude).length,
        sectionCount: new Set(items.map((item) => item.sectionCode)).size,
        recommendationReferenceCount: row.recommendationReferenceCount,
      },
      items,
    };
    let recomputedDigest: string;
    try {
      recomputedDigest = digestAmuxManifest(manifest);
    } catch {
      return rejectApproved(tx, input.session, input.request, row, now, "binding_mismatch");
    }
    if (
      recomputedDigest !== row.manifestDigest ||
      row.canonicalizerVersion !== manifest.canonicalizationVersion ||
      row.sourceVerificationMode !== manifest.source.verificationMode ||
      row.scannerVersion !== manifest.scannerVersion ||
      row.scannerRulesetDigest !== BOARD_IMPORT_SCANNER_RULESET_DIGEST ||
      row.policyVersion !== manifest.policyVersion
    ) {
      return rejectApproved(tx, input.session, input.request, row, now, "binding_mismatch");
    }
    const existing = await loadBoardImportExistingCards(tx, items);
    const live = classifyBoardImport(manifest, existing);
    const bound = classificationFromRow(row);
    if (!boardImportClassificationSetsEqual(live, bound)) {
      return rejectApproved(tx, input.session, input.request, row, now, "binding_mismatch");
    }
    const refusal = boardImportSubmissionRefusal(bound);
    if (refusal) {
      return rejectApproved(tx, input.session, input.request, row, now, refusal);
    }
    const writes = boardImportCardWrites(manifest, bound);
    // A unique conflict aborts the transaction. The outer catch reports
    // `conflict` and does not retry. The approval stays approved, so the next
    // apply reclassifies the live card instead of inserting again.
    for (const card of writes) {
      await tx.amuxWorkItem.create({ data: card });
    }
    const auditId = await writeHumanAudit(
      tx,
      input.session,
      input.request,
      "amux.board_import.consumed",
      row.id,
      countMetadata(manifest, bound, row.rawBodyDigest, signedDigest),
    );
    const consumed = await tx.amuxBoardImportApproval.updateMany({
      where: { id: row.id, status: "approved", outcomeUnknownAt: null, expiresAt: { gt: now } },
      data: { status: "consumed", consumedAt: now, authorizationAuditLogId: auditId },
    });
    if (consumed.count !== 1) throw new BoardImportError("conflict", 409, row.id);
    return {
      approvalId: row.id,
      status: "consumed" as const,
      created: writes.length,
      noOp: bound.noOp.length,
    };
  });
}
