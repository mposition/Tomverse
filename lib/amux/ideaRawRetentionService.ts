import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import {
  AMUX_V4_CONTENT_KEY_DELETE_ACTION,
  AMUX_V4_CONTENT_PURGE_ACTION,
  AMUX_V4_CONTENT_RETIREMENT_TARGET,
  AMUX_V4_IDEA_AUTO_CANCEL_ACTION,
  AMUX_V4_IDEA_AUTO_CANCEL_TARGET,
  AMUX_V4_IDEA_SYSTEM_ACTOR,
} from "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";
import { amuxContentUnitKeyId, deleteAmuxContentUnitKey,
  type AmuxContentKeyIdentity } from "./ideaKeyStore.ts";
import { AmuxIdeaAutoCancellationError,
  commitAmuxOverdueIdeaAnalysisCancellation } from
  "./ideaAnalysisAutoCancellationService.ts";
import { amuxIdeaHasActiveRetentionHold } from "./ideaRetentionHoldRead.ts";

const IDEA_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BATCH_SIZE = 8;
const TERMINAL_STATES = ["awaiting_owner", "completed", "cancelled"];
const UNFINISHED_STATES = ["submitted", "collecting", "awaiting_preview", "analyzing"];

export class AmuxIdeaRawRetentionError extends Error {
  constructor(readonly code: "integrity_unavailable" | "outcome_unknown" |
    "key_store_unavailable", readonly ideaId?: string,
    readonly readBack?: "purged" | "not_purged" | "partial" | "unavailable") {
    super(code);
    this.name = "AmuxIdeaRawRetentionError";
  }
}

function keyIdentity(ideaId: string): AmuxContentKeyIdentity {
  if (!IDEA_ID.test(ideaId)) throw new AmuxIdeaRawRetentionError("integrity_unavailable");
  return { ideaId, purpose: "idea_raw", subjectId: ideaId };
}

function retirementId(ideaId: string): string {
  return `${ideaId}:idea_raw:${ideaId}`;
}

async function dbNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  if (!(rows[0]?.now instanceof Date) || !Number.isFinite(rows[0].now.getTime())) {
    throw new AmuxIdeaRawRetentionError("integrity_unavailable");
  }
  return rows[0].now;
}

/** The audit and DB ciphertext purge are one transaction. No S3 call is made
 * under a DB lock. A durable retirement row then drives external key deletion. */
export async function commitAmuxDueRawIdeaPurge(tx: Prisma.TransactionClient,
  ideaId: string): Promise<"purged" | "skipped"> {
  const identity = keyIdentity(ideaId);
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission" WHERE "id" = ${ideaId} FOR UPDATE
  `;
  if (locked.length !== 1) return "skipped";
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: ideaId },
    select: { id: true, state: true, rawCiphertext: true, rawKeyId: true,
      rawKeyVersion: true, rawDigest: true, rawDigestKeyId: true,
      rawPurgeAfter: true, rawPurgedAt: true,
      analysisCompletedAt: true, cancelledAt: true } });
  const now = await dbNow(tx);
  if (!idea || idea.rawPurgedAt !== null || idea.rawCiphertext === null ||
      !idea.rawPurgeAfter || now < idea.rawPurgeAfter ||
      !TERMINAL_STATES.includes(idea.state)) return "skipped";
  if (await amuxIdeaHasActiveRetentionHold(tx, ideaId, now)) return "skipped";
  if ((!idea.analysisCompletedAt && !idea.cancelledAt) ||
      idea.rawKeyId !== amuxContentUnitKeyId(identity) ||
      idea.rawKeyVersion !== 1 || !idea.rawDigest || !idea.rawDigestKeyId) {
    throw new AmuxIdeaRawRetentionError("integrity_unavailable", ideaId);
  }
  const auditId = await writeSystemAuditLog({ tx,
    systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V4_CONTENT_PURGE_ACTION,
    targetType: AMUX_V4_CONTENT_RETIREMENT_TARGET,
    targetId: retirementId(ideaId),
    summary: "Purged a due AMUX v4 idea body and queued its external key for deletion.",
    metadata: { ideaId, purpose: identity.purpose, subjectId: identity.subjectId,
      rawDigest: idea.rawDigest, rawDigestKeyId: idea.rawDigestKeyId,
      rawPurgeAfter: idea.rawPurgeAfter.toISOString() },
  });
  const changed = await tx.amuxIdeaSubmission.updateMany({
    where: { id: ideaId, rawCiphertext: { not: null }, rawPurgedAt: null,
      rawPurgeAfter: { lte: now }, state: { in: TERMINAL_STATES } },
    data: { rawCiphertext: null, rawKeyId: null, rawKeyVersion: null,
      rawPurgedAt: now },
  });
  if (changed.count !== 1) {
    throw new AmuxIdeaRawRetentionError("integrity_unavailable", ideaId);
  }
  await tx.amuxIdeaContentKeyRetirement.create({ data: {
    ideaId, purpose: identity.purpose, subjectId: identity.subjectId,
    bodyPurgedAt: now, purgeAuditLogId: auditId,
  } });
  return "purged";
}

/** An uncertain COMMIT must be read back before any key is deleted. */
export async function readAmuxRawIdeaPurgeOutcome(ideaId: string): Promise<
  "purged" | "not_purged" | "partial"> {
  const identity = keyIdentity(ideaId);
  const [idea, retirement] = await Promise.all([
    prisma.amuxIdeaSubmission.findUnique({ where: { id: ideaId },
      select: { rawCiphertext: true, rawKeyId: true, rawKeyVersion: true,
        rawPurgedAt: true } }),
    prisma.amuxIdeaContentKeyRetirement.findUnique({
      where: { ideaId_purpose_subjectId: identity },
      select: { bodyPurgedAt: true, purgeAuditLogId: true },
    }),
  ]);
  if (!idea) return "partial";
  if (idea.rawCiphertext !== null && idea.rawPurgedAt === null && !retirement) {
    return "not_purged";
  }
  if (idea.rawCiphertext !== null || idea.rawKeyId !== null ||
      idea.rawKeyVersion !== null || idea.rawPurgedAt === null ||
      !retirement || !retirement.purgeAuditLogId ||
      retirement.bodyPurgedAt.getTime() !== idea.rawPurgedAt.getTime()) {
    return "partial";
  }
  const audit = await prisma.adminAuditLog.findUnique({
    where: { id: retirement.purgeAuditLogId },
    select: { action: true, targetType: true, targetId: true, entryHash: true },
  });
  return audit?.action === AMUX_V4_CONTENT_PURGE_ACTION &&
    audit.targetType === AMUX_V4_CONTENT_RETIREMENT_TARGET &&
    audit.targetId === retirementId(ideaId) &&
    typeof audit.entryHash === "string" ? "purged" : "partial";
}

async function commitVerifiedRawKeyDeletion(tx: Prisma.TransactionClient,
  ideaId: string): Promise<"deleted" | "already_deleted"> {
  const identity = keyIdentity(ideaId);
  await tx.$queryRaw`
    SELECT set_config('statement_timeout', '5000', true) AS statement_limit,
           set_config('idle_in_transaction_session_timeout', '10000', true) AS idle_limit
  `;
  await takeAuditChainLock(tx);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxIdeaSubmission" WHERE "id" = ${ideaId} FOR UPDATE
  `;
  if (locked.length !== 1) throw new AmuxIdeaRawRetentionError("integrity_unavailable", ideaId);
  await tx.$queryRaw`
    SELECT "ideaId" FROM "AmuxIdeaContentKeyRetirement"
    WHERE "ideaId" = ${ideaId} AND "purpose" = 'idea_raw'
      AND "subjectId" = ${ideaId} FOR UPDATE
  `;
  const row = await tx.amuxIdeaContentKeyRetirement.findUnique({
    where: { ideaId_purpose_subjectId: identity },
  });
  const idea = await tx.amuxIdeaSubmission.findUnique({ where: { id: ideaId },
    select: { rawCiphertext: true, rawPurgedAt: true } });
  if (!row || !idea || idea.rawCiphertext !== null ||
      idea.rawPurgedAt?.getTime() !== row.bodyPurgedAt.getTime()) {
    throw new AmuxIdeaRawRetentionError("integrity_unavailable", ideaId);
  }
  if (row.keyDeletedAt !== null && row.keyDeleteAuditLogId !== null) {
    return "already_deleted";
  }
  if (row.keyDeletedAt !== null || row.keyDeleteAuditLogId !== null) {
    throw new AmuxIdeaRawRetentionError("integrity_unavailable", ideaId);
  }
  const now = await dbNow(tx);
  const auditId = await writeSystemAuditLog({ tx,
    systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
    action: AMUX_V4_CONTENT_KEY_DELETE_ACTION,
    targetType: AMUX_V4_CONTENT_RETIREMENT_TARGET,
    targetId: retirementId(ideaId),
    summary: "Verified deletion of an AMUX v4 idea content key.",
    metadata: { ideaId, purpose: identity.purpose,
      subjectId: identity.subjectId, purgeAuditLogId: row.purgeAuditLogId },
  });
  const changed = await tx.amuxIdeaContentKeyRetirement.updateMany({
    where: { ideaId, purpose: identity.purpose, subjectId: identity.subjectId,
      keyDeletedAt: null, keyDeleteAuditLogId: null },
    data: { keyDeletedAt: now, keyDeleteAuditLogId: auditId },
  });
  if (changed.count !== 1) {
    throw new AmuxIdeaRawRetentionError("integrity_unavailable", ideaId);
  }
  return "deleted";
}

/** A missing S3 key is a successful read-back, not a reason to restore a DB
 * body. An ambiguous object-store result stops this tick without blind retry. */
export async function retirePurgedAmuxRawIdeaKey(ideaId: string,
  deleteKey: typeof deleteAmuxContentUnitKey = deleteAmuxContentUnitKey): Promise<
  "deleted" | "already_deleted"> {
  const identity = keyIdentity(ideaId);
  if (await readAmuxRawIdeaPurgeOutcome(ideaId) !== "purged") {
    throw new AmuxIdeaRawRetentionError("integrity_unavailable", ideaId);
  }
  const row = await prisma.amuxIdeaContentKeyRetirement.findUnique({
    where: { ideaId_purpose_subjectId: identity },
    select: { keyDeletedAt: true },
  });
  if (row?.keyDeletedAt) return "already_deleted";
  try { await deleteKey(identity); }
  catch { throw new AmuxIdeaRawRetentionError("key_store_unavailable", ideaId); }
  let callbackReturned = false;
  try {
    return await prisma.$transaction(async (tx) => {
      const result = await commitVerifiedRawKeyDeletion(tx, ideaId);
      callbackReturned = true;
      return result;
    }, { maxWait: 3_000, timeout: 12_000 });
  } catch {
    if (!callbackReturned) {
      const reread = await prisma.amuxIdeaContentKeyRetirement.findUnique({
        where: { ideaId_purpose_subjectId: identity },
        select: { keyDeletedAt: true, keyDeleteAuditLogId: true },
      }).catch(() => null);
      if (reread?.keyDeletedAt && reread.keyDeleteAuditLogId) return "already_deleted";
    }
    throw new AmuxIdeaRawRetentionError("outcome_unknown", ideaId);
  }
}

/** Each tick is bounded; pending key retirements go first so a transient S3
 * outage cannot be hidden behind newly due DB purges. */
export async function purgeDueAmuxRawIdeas() {
  const pending = await prisma.amuxIdeaContentKeyRetirement.findMany({
    where: { purpose: "idea_raw", keyDeletedAt: null },
    orderBy: [{ bodyPurgedAt: "asc" }, { ideaId: "asc" }],
    take: BATCH_SIZE, select: { ideaId: true },
  });
  let keysDeleted = 0;
  for (const row of pending) {
    await retirePurgedAmuxRawIdeaKey(row.ideaId);
    keysDeleted += 1;
  }
  const now = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  if (!(now[0]?.now instanceof Date)) {
    throw new AmuxIdeaRawRetentionError("integrity_unavailable");
  }
  const due = await prisma.amuxIdeaSubmission.findMany({
    where: { rawCiphertext: { not: null }, rawPurgedAt: null,
      rawPurgeAfter: { lte: now[0].now }, state: { in: TERMINAL_STATES },
      retentionHolds: { none: { releasedAt: null,
        expiresAt: { gt: now[0].now } } } },
    orderBy: [{ rawPurgeAfter: "asc" }, { id: "asc" }],
    take: BATCH_SIZE - pending.length, select: { id: true },
  });
  let bodiesPurged = 0;
  for (const row of due) {
    let callbackReturned = false;
    try {
      const result = await prisma.$transaction(async (tx) => {
        const result = await commitAmuxDueRawIdeaPurge(tx, row.id);
        callbackReturned = true;
        return result;
      }, { maxWait: 3_000, timeout: 12_000 });
      if (result === "purged") {
        bodiesPurged += 1;
        await retirePurgedAmuxRawIdeaKey(row.id);
        keysDeleted += 1;
      }
    } catch (error) {
      if (error instanceof AmuxIdeaRawRetentionError &&
          error.code === "key_store_unavailable") throw error;
      const readBack = await readAmuxRawIdeaPurgeOutcome(row.id)
        .catch(() => "unavailable" as const);
      if (readBack === "purged" && !callbackReturned) {
        // The DB may have committed. The next tick will retire the durable key
        // record; this tick never repeats the uncertain purge operation.
      }
      throw new AmuxIdeaRawRetentionError("outcome_unknown", row.id, readBack);
    }
  }
  return { bodiesPurged, keysDeleted, scanned: pending.length + due.length,
    batchLimit: BATCH_SIZE };
}

export async function cancelOverdueAmuxIdeaAnalyses() {
  const now = await prisma.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  if (!(now[0]?.now instanceof Date)) {
    throw new AmuxIdeaRawRetentionError("integrity_unavailable");
  }
  const due = await prisma.amuxIdeaSubmission.findMany({
    where: { state: { in: UNFINISHED_STATES },
      analysisCompletedAt: null, cancelledAt: null,
      analysisDeadlineAt: { lte: now[0].now } },
    orderBy: [{ analysisDeadlineAt: "asc" }, { id: "asc" }],
    take: BATCH_SIZE, select: { id: true },
  });
  let cancelled = 0;
  for (const row of due) {
    try {
      await prisma.$transaction((tx) =>
        commitAmuxOverdueIdeaAnalysisCancellation(tx, row.id),
      { maxWait: 3_000, timeout: 12_000 });
      cancelled += 1;
    } catch (error) {
      if (error instanceof AmuxIdeaAutoCancellationError &&
          error.code === "not_due") continue;
      const [idea, audit] = await Promise.all([
        prisma.amuxIdeaSubmission.findUnique({ where: { id: row.id },
          select: { state: true, cancelledAt: true } }).catch(() => null),
        prisma.adminAuditLog.findFirst({ where: {
          action: AMUX_V4_IDEA_AUTO_CANCEL_ACTION,
          targetType: AMUX_V4_IDEA_AUTO_CANCEL_TARGET,
          targetId: row.id }, select: { entryHash: true } }).catch(() => null),
      ]);
      if (idea?.state === "cancelled" && idea.cancelledAt && audit?.entryHash) {
        // A completed read-back is evidence; do not repeat the write.
        cancelled += 1;
        continue;
      }
      throw new AmuxIdeaRawRetentionError("outcome_unknown", row.id,
        idea?.state === "cancelled" ? "partial" : "unavailable");
    }
  }
  return { cancelled, scanned: due.length, batchLimit: BATCH_SIZE };
}
