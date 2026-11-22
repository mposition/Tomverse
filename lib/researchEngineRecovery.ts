import "server-only";

import { prisma } from "@/lib/prisma";
import { researchFundingAdapter, settleResearchSegmentIfReady } from "@/lib/researchEngineFunding";
import { researchEvidenceStore, researchNow } from "@/lib/researchEngineRuntime";
import {
  bindResearchFundingReservation, lockResearchRun, markResearchDispatchUnknown, markResearchFundingUnknown,
  RESEARCH_ITEM_MAX_ATTEMPTS, RESEARCH_SEGMENT_RESERVING_STALE_MS, releaseResearchFundingSegment,
} from "@/lib/researchEngineStore";
import { advanceResearchRun } from "@/lib/researchEngineWorker";

/**
 * Recovery-only maintenance for Research engine v2. It never claims a work
 * item, never calls a model, search or page reader, and never starts paid
 * work. Every row is processed in its own try/catch; a row that keeps failing
 * is quarantined (counted, then excluded from selection) so one poison row
 * cannot starve healthy runs that sort after it.
 */

export const RESEARCH_RECOVERY_QUARANTINE_AFTER = 3;
export const RESEARCH_UNKNOWN_SETTLEMENT_GRACE_MS = 15 * 60_000;

async function isolate(runId: string | null, work: () => Promise<unknown>) {
  try {
    await work();
    return true;
  } catch (error) {
    console.error(JSON.stringify({ event: "research_engine_recovery_row_failed", runId,
      code: (error as { code?: string }).code ?? (error instanceof Error ? error.name : "unknown") }));
    if (runId) {
      await prisma.researchPreviewRun.update({ where: { id: runId }, data: { recoveryFailureCount: { increment: 1 } } })
        .then((run) => run.recoveryFailureCount >= RESEARCH_RECOVERY_QUARANTINE_AFTER
          ? prisma.researchPreviewRun.update({ where: { id: runId }, data: { recoveryQuarantinedAt: researchNow() } }) : null)
        .catch(() => undefined);
    }
    return false;
  }
}

/** A worker died or lost its lease. A started dispatch becomes unknown; anything else is requeued. */
export async function recoverStaleResearchWorkItems(limit = 100) {
  const now = researchNow();
  const stale = await prisma.researchWorkItem.findMany({
    where: { status: "running", leaseExpiresAt: { lte: now }, run: { recoveryQuarantinedAt: null } },
    select: { id: true, runId: true }, orderBy: { leaseExpiresAt: "asc" }, take: limit,
  });
  let recovered = 0;
  for (const item of stale) {
    const ok = await isolate(item.runId, () => prisma.$transaction(async (tx) => {
      await lockResearchRun(tx, item.runId);
      const current = await tx.researchWorkItem.findUnique({ where: { id: item.id } });
      if (!current || current.status !== "running" || !current.leaseExpiresAt || current.leaseExpiresAt > researchNow()) return;
      const started = await tx.researchPreviewGeneration.findFirst({ where: { workItemId: item.id, status: "dispatch_started" } });
      if (started) {
        await markResearchDispatchUnknown(tx, started.id);
        if (started.fundingSegmentId) await markResearchFundingUnknown(tx, started.fundingSegmentId, { usageFromProvider: false, outcome: "failed", searchQueriesObserved: false });
        await tx.researchWorkItem.update({ where: { id: item.id }, data: { status: "attention", errorCode: "RESEARCH_OUTCOME_UNKNOWN",
          leaseOwner: null, leaseExpiresAt: null, completedAt: researchNow() } });
        return;
      }
      await tx.researchPreviewGeneration.updateMany({ where: { workItemId: item.id, status: "intent" }, data: { status: "dispatch_refused", stopReason: "dispatch_refused" } });
      const retry = current.attempts < RESEARCH_ITEM_MAX_ATTEMPTS;
      await tx.researchWorkItem.update({ where: { id: item.id }, data: { status: retry ? "queued" : "failed", errorCode: retry ? "RESEARCH_LEASE_EXPIRED" : "RESEARCH_ATTEMPTS_EXHAUSTED",
        leaseOwner: null, leaseExpiresAt: null, ...(retry ? {} : { completedAt: researchNow() }) } });
    }));
    if (ok) recovered += 1;
  }
  return recovered;
}

/** A crash between "room claimed" and "reservation bound" must neither leak a hold nor double count. */
export async function recoverStaleReservingSegments(limit = 100) {
  const cutoff = new Date(researchNow().getTime() - RESEARCH_SEGMENT_RESERVING_STALE_MS);
  const segments = await prisma.researchFundingSegment.findMany({ where: { status: "reserving", createdAt: { lte: cutoff } },
    include: { run: { select: { userId: true, recoveryQuarantinedAt: true } } }, take: limit, orderBy: { createdAt: "asc" } });
  let recovered = 0;
  for (const segment of segments) {
    if (!segment.run || !segment.runId || segment.run.recoveryQuarantinedAt) continue;
    const ok = await isolate(segment.runId, async () => {
      const reservation = await prisma.chatCreditReservation.findFirst({ where: { traceId: segment.id, status: "reserved" }, select: { id: true, reservedCredits: true } });
      if (reservation) {
        await bindResearchFundingReservation(segment.id, reservation.id, Math.min(reservation.reservedCredits, segment.reservedCredits));
        const funding = await researchFundingAdapter();
        await funding.settle({ userId: segment.run!.userId, reservationId: reservation.id, usage: { inputTokens: 0, outputTokens: 0,
          cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0, usageFromProvider: true, outcome: "failed", searchExecuted: false,
          searchQueryCount: 0, searchBackendRequestCount: 0, searchQueriesObserved: true } });
      }
      await releaseResearchFundingSegment(segment.id);
    });
    if (ok) recovered += 1;
  }
  return recovered;
}

/**
 * A bound hold whose worker died before recording any dispatch intent. Released
 * under the run lock only when still intent-free, so a live worker's later
 * beginResearchDispatch is refused instead of dispatching on a refunded hold.
 */
export async function releaseOrphanedResearchSegments(limit = 100) {
  const cutoff = new Date(researchNow().getTime() - RESEARCH_SEGMENT_RESERVING_STALE_MS * 2);
  const segments = await prisma.researchFundingSegment.findMany({ where: { status: "reserved", createdAt: { lte: cutoff },
    generations: { none: {} }, run: { recoveryQuarantinedAt: null } }, include: { run: { select: { userId: true } } }, take: limit, orderBy: { createdAt: "asc" } });
  let released = 0;
  for (const segment of segments) {
    const ok = await isolate(segment.runId, async () => {
      const claimed = await prisma.$transaction(async (tx) => {
        await lockResearchRun(tx, segment.runId!);
        await tx.$queryRaw`SELECT "id" FROM "ResearchFundingSegment" WHERE "id" = ${segment.id} FOR UPDATE`;
        const current = await tx.researchFundingSegment.findUnique({ where: { id: segment.id }, include: { generations: { select: { id: true } } } });
        if (!current || current.status !== "reserved" || current.generations.length) return false;
        await tx.researchFundingSegment.update({ where: { id: segment.id }, data: { status: "released" } });
        return true;
      });
      if (!claimed || !segment.reservationId) return;
      const funding = await researchFundingAdapter();
      // Nothing dispatched on this hold; refund it. A failure leaves it to expiry, which reads "released" as zero.
      await funding.settle({ userId: segment.run!.userId, reservationId: segment.reservationId, usage: { inputTokens: 0, outputTokens: 0,
        cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0, usageFromProvider: true, outcome: "failed", searchExecuted: false,
        searchQueryCount: 0, searchBackendRequestCount: 0, searchQueriesObserved: true } }).catch((error: unknown) => {
        console.error(JSON.stringify({ event: "research_engine_orphan_settle_deferred", segmentId: segment.id, code: (error as { code?: string }).code ?? "unknown" }));
      });
    });
    if (ok) released += 1;
  }
  return released;
}

/** Settles every segment whose dispatches are terminal; unknown ones only after a grace period. */
export async function settlePendingResearchSegments(limit = 100) {
  const graceCutoff = new Date(researchNow().getTime() - RESEARCH_UNKNOWN_SETTLEMENT_GRACE_MS);
  const segments = await prisma.researchFundingSegment.findMany({
    where: { OR: [{ status: "reserved" }, { status: "unknown", updatedAt: { lte: graceCutoff } }], run: { recoveryQuarantinedAt: null } },
    select: { id: true, runId: true }, orderBy: { createdAt: "asc" }, take: limit,
  });
  let settled = 0;
  for (const segment of segments) {
    let done = false;
    const ok = await isolate(segment.runId, async () => { done = await settleResearchSegmentIfReady(segment.id); });
    if (ok && done) settled += 1;
  }
  return settled;
}

export async function drainResearchEvidenceCleanup(limit = 200) {
  // Deleted or revoked private text must eventually go: a failing row backs off
  // but is never dropped from the queue, so a long storage outage still drains.
  // Rows inserted by the deletion trigger carry the database clock.
  const now = new Date(Math.max(researchNow().getTime(), Date.now()));
  const rows = await prisma.researchEvidenceObjectCleanup.findMany({ where: { nextAttemptAt: { lte: now } },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }], take: limit });
  const store = await researchEvidenceStore();
  let deleted = 0;
  for (const row of rows) {
    try {
      await store.delete(row.objectKey);
      await prisma.researchEvidenceObjectCleanup.delete({ where: { id: row.id } });
      deleted += 1;
    } catch {
      const backoffMs = Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(row.attempts, 12));
      await prisma.researchEvidenceObjectCleanup.update({ where: { id: row.id },
        data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + backoffMs) } }).catch(() => undefined);
    }
  }
  return deleted;
}

/** Re-runs deterministic advancement for active runs with nothing running (e.g. after a crash between commits). */
export async function advanceIdleResearchRuns(limit = 100) {
  const runs = await prisma.researchPreviewRun.findMany({
    where: { engineVersion: 2, recoveryQuarantinedAt: null, workItems: { none: { status: "running" } },
      OR: [{ status: { in: ["planning", "queued", "running", "finalizing"] } },
        // A budget stop waits for the user; past its deadline it is finished with existing evidence.
        { status: "awaiting_input", lastErrorCode: "RESEARCH_RUN_BUDGET_REACHED", runDeadlineAt: { lte: researchNow() } }] },
    select: { id: true }, orderBy: { updatedAt: "asc" }, take: limit,
  });
  let advanced = 0;
  for (const run of runs) if (await isolate(run.id, () => advanceResearchRun(run.id))) advanced += 1;
  return advanced;
}

export async function recoverResearchEngine(limit = 100) {
  return {
    staleItems: await recoverStaleResearchWorkItems(limit),
    staleSegments: await recoverStaleReservingSegments(limit),
    orphanedSegments: await releaseOrphanedResearchSegments(limit),
    settledSegments: await settlePendingResearchSegments(limit),
    advancedRuns: await advanceIdleResearchRuns(limit),
    cleanedObjects: await drainResearchEvidenceCleanup(limit * 2),
  };
}
