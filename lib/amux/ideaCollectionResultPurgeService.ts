import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import {
  AMUX_V4_COLLECTION_RESULT_PURGE_ACTION,
  AMUX_V4_COLLECTION_RESULT_PURGE_SCOPE,
  AMUX_V4_COLLECTION_RESULT_PURGE_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR,
} from "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import {
  AMUX_V4_COLLECTION_RESULT_PURGE_BATCH_SIZE,
  AMUX_V4_COLLECTION_RESULT_PURGE_ENV,
  collectionResultPurgeEnabled,
} from "./ideaCollectionResultPurgeCore.ts";

const HASH = /^[a-f0-9]{64}$/;

export class AmuxCollectionResultPurgeError extends Error {
  constructor(readonly code: "purge_disabled" | "integrity_unavailable" |
    "outcome_unknown", readonly collectionRequestId?: string,
    readonly readBack?: "purged" | "not_purged" | "partial" | "unavailable") {
    super(code);
    this.name = "AmuxCollectionResultPurgeError";
  }
}

/** Audit lock precedes the request row, matching the result writer. A due
 * candidate is always rechecked under lock; no plaintext is read. */
export async function commitAmuxCollectionResultPurge(tx: Prisma.TransactionClient,
  collectionRequestId: string): Promise<"purged" | "skipped"> {
  await tx.$queryRaw`
    SELECT set_config('TimeZone', 'UTC', true) AS zone,
           set_config('statement_timeout', '3000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '5000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaCollectionRequest"
    WHERE "id" = ${collectionRequestId} FOR UPDATE
  `;
  if (locked.length !== 1) return "skipped";
  const row = await tx.amuxIdeaCollectionRequest.findUnique({
    where: { id: collectionRequestId },
    select: { id: true, requestId: true, previewId: true, state: true,
      resultCiphertext: true, resultKeyId: true, resultKeyVersion: true,
      resultDigest: true, resultDigestKeyId: true, resultPurgeAfter: true,
      resultPurgedAt: true, transitionAuditLogId: true },
  });
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxCollectionResultPurgeError("integrity_unavailable");
  }
  if (!row || !row.resultPurgeAfter || now < row.resultPurgeAfter ||
      row.resultPurgedAt !== null || row.resultCiphertext === null) return "skipped";
  if (!["preview_ready", "expired", "outcome_unknown"].includes(row.state) ||
      !row.resultKeyId || !row.resultKeyVersion || !row.resultDigest ||
      !HASH.test(row.resultDigest) || !row.resultDigestKeyId ||
      !row.transitionAuditLogId) {
    throw new AmuxCollectionResultPurgeError("integrity_unavailable");
  }
  const priorAudit = await tx.adminAuditLog.findUnique({
    where: { id: row.transitionAuditLogId },
    select: { entryHash: true, targetType: true, targetId: true },
  });
  if (!priorAudit?.entryHash || !HASH.test(priorAudit.entryHash) ||
      priorAudit.targetType !== AMUX_V4_COLLECTION_RESULT_PURGE_TARGET ||
      priorAudit.targetId !== row.id) {
    throw new AmuxCollectionResultPurgeError("integrity_unavailable");
  }
  const auditId = await writeSystemAuditLog({ tx,
    systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V4_COLLECTION_RESULT_PURGE_ACTION,
    targetType: AMUX_V4_COLLECTION_RESULT_PURGE_TARGET, targetId: row.id,
    summary: "Purged an expired encrypted AMUX v4 collection preview.",
    metadata: { collectionRequestId: row.id, requestId: row.requestId,
      previewId: row.previewId, resultDigest: row.resultDigest,
      resultDigestKeyId: row.resultDigestKeyId,
      previousAuditLogId: row.transitionAuditLogId },
  });
  const changed = await tx.$executeRaw`
    UPDATE "AmuxIdeaCollectionRequest"
    SET "resultCiphertext" = NULL, "resultKeyId" = NULL,
        "resultKeyVersion" = NULL, "resultPurgedAt" = ${now},
        "transitionAuditLogId" = ${auditId}, "updatedAt" = ${now}
    WHERE "id" = ${row.id} AND "resultCiphertext" IS NOT NULL
      AND "resultPurgedAt" IS NULL AND "resultPurgeAfter" <=
        (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3)
      AND "transitionAuditLogId" = ${row.transitionAuditLogId}
  `;
  if (changed !== 1) throw new AmuxCollectionResultPurgeError("integrity_unavailable");
  return "purged";
}

/** Exact-ID, content-free recovery after an uncertain COMMIT. */
export async function readAmuxCollectionResultPurgeOutcome(collectionRequestId: string) {
  const row = await prisma.amuxIdeaCollectionRequest.findUnique({
    where: { id: collectionRequestId },
    select: { id: true, requestId: true, previewId: true,
      resultCiphertext: true, resultKeyId: true, resultKeyVersion: true,
      resultDigest: true, resultDigestKeyId: true, resultPurgedAt: true,
      transitionAuditLogId: true },
  });
  if (!row) return "partial" as const;
  if (row.resultCiphertext !== null && row.resultPurgedAt === null) {
    return "not_purged" as const;
  }
  if (row.resultCiphertext !== null || row.resultKeyId !== null ||
      row.resultKeyVersion !== null || row.resultPurgedAt === null ||
      !row.transitionAuditLogId || !row.resultDigest || !row.resultDigestKeyId) {
    return "partial" as const;
  }
  const audit = await prisma.adminAuditLog.findUnique({
    where: { id: row.transitionAuditLogId },
    select: { action: true, actorUserId: true, targetType: true,
      targetId: true, entryHash: true, metadata: true },
  });
  const m = audit?.metadata && typeof audit.metadata === "object" &&
    !Array.isArray(audit.metadata) ? audit.metadata as Record<string, unknown> : null;
  if (!audit?.entryHash || !HASH.test(audit.entryHash) ||
      audit.action !== AMUX_V4_COLLECTION_RESULT_PURGE_ACTION ||
      audit.actorUserId !== null ||
      audit.targetType !== AMUX_V4_COLLECTION_RESULT_PURGE_TARGET ||
      audit.targetId !== row.id || !m ||
      m.systemActor !== AMUX_V4_IDEA_SYSTEM_ACTOR ||
      m.actorScope !== AMUX_V4_COLLECTION_RESULT_PURGE_SCOPE ||
      m.collectionRequestId !== row.id || m.requestId !== row.requestId ||
      m.previewId !== row.previewId || m.resultDigest !== row.resultDigest ||
      m.resultDigestKeyId !== row.resultDigestKeyId) return "partial" as const;
  return "purged" as const;
}

/** A bounded tick stops on an uncertain result. Its caller must not repeat
 * the tick automatically after outcome_unknown. */
export async function purgeDueAmuxCollectionResults() {
  if (!collectionResultPurgeEnabled(process.env[AMUX_V4_COLLECTION_RESULT_PURGE_ENV])) {
    throw new AmuxCollectionResultPurgeError("purge_disabled");
  }
  if (adminAuditIntegrityKeys(process.env).length === 0) {
    throw new AmuxCollectionResultPurgeError("integrity_unavailable");
  }
  const nowRows = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = nowRows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new AmuxCollectionResultPurgeError("integrity_unavailable");
  }
  const candidates = await prisma.amuxIdeaCollectionRequest.findMany({
    where: { resultCiphertext: { not: null }, resultPurgedAt: null,
      resultPurgeAfter: { lte: now } },
    orderBy: [{ resultPurgeAfter: "asc" }, { id: "asc" }],
    take: AMUX_V4_COLLECTION_RESULT_PURGE_BATCH_SIZE,
    select: { id: true },
  });
  let purged = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    let callbackReturned = false;
    try {
      const result = await prisma.$transaction(async (tx) => {
        const outcome = await commitAmuxCollectionResultPurge(tx, candidate.id);
        callbackReturned = true;
        return outcome;
      }, { maxWait: 3_000, timeout: 12_000 });
      if (result === "purged") purged += 1;
      else skipped += 1;
    } catch (error) {
      if (!callbackReturned && error instanceof AmuxCollectionResultPurgeError &&
          error.code === "integrity_unavailable") throw error;
      let readBack: AmuxCollectionResultPurgeError["readBack"] = "unavailable";
      try { readBack = await readAmuxCollectionResultPurgeOutcome(candidate.id); }
      catch { /* A failed read is not evidence that the write rolled back. */ }
      throw new AmuxCollectionResultPurgeError("outcome_unknown", candidate.id,
        readBack);
    }
  }
  return { purged, skipped, scanned: candidates.length,
    batchLimit: AMUX_V4_COLLECTION_RESULT_PURGE_BATCH_SIZE };
}
