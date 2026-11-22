import "server-only";

import { prisma } from "@/lib/prisma";
import { RESEARCH_ZERO_SETTLEMENT_USAGE, researchFundingAdapter, settleResearchSegmentIfReady } from "@/lib/researchEngineFunding";
import { researchEvidenceStore, researchNow } from "@/lib/researchEngineRuntime";
import {
  bindResearchFundingReservation, lockResearchRun, markResearchDispatchUnknown, markResearchFundingUnknown,
  RESEARCH_EVIDENCE_ABANDONED_SWEEP_MS, RESEARCH_ITEM_MAX_ATTEMPTS, RESEARCH_SEGMENT_RESERVING_STALE_MS, releaseUnboundResearchFundingSegment,
} from "@/lib/researchEngineStore";
import { advanceResearchRun, ensureResearchPrivateSourceGranted } from "@/lib/researchEngineWorker";

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
      // A slow worker may still bind its reservation and record a dispatch while
      // this runs. Every step below is conditional on the segment still being
      // unbound, so whichever bind lands first owns the segment; recovery never
      // releases a segment a worker has bound.
      const reservation = await prisma.chatCreditReservation.findFirst({ where: { traceId: segment.id, status: "reserved" }, select: { id: true, reservedCredits: true } });
      if (!reservation) {
        await releaseUnboundResearchFundingSegment(segment.id);
        return;
      }
      try {
        await bindResearchFundingReservation(segment.id, reservation.id, Math.min(reservation.reservedCredits, segment.reservedCredits));
      } catch (error) {
        if ((error as { code?: string }).code === "RESEARCH_FUNDING_BIND_CONFLICT") return; // the worker bound it first
        throw error;
      }
      // Recovery owns the hold now: the worker's own bind is refused, so nothing dispatches on it.
      const funding = await researchFundingAdapter();
      await funding.settle({ userId: segment.run!.userId, reservationId: reservation.id, usage: RESEARCH_ZERO_SETTLEMENT_USAGE });
      await prisma.researchFundingSegment.updateMany({ where: { id: segment.id, status: "reserved", reservationId: reservation.id },
        data: { status: "released", settledAt: null } });
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
      await funding.settle({ userId: segment.run!.userId, reservationId: segment.reservationId, usage: RESEARCH_ZERO_SETTLEMENT_USAGE }).catch((error: unknown) => {
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
      // The row is held while the object is deleted, so a version write cannot take
      // over a key whose object is being removed (it waits, then finds no row).
      const removed = await prisma.$transaction(async (tx) => {
        const held = await tx.$queryRaw<Array<{ id: string; reason: string }>>`SELECT "id", "reason" FROM "ResearchEvidenceObjectCleanup" WHERE "id" = ${row.id} FOR UPDATE SKIP LOCKED`;
        if (!held.length) return false;
        await store.delete(row.objectKey);
        if (held[0]!.reason === "write_pending") {
          // A write past its grace may still land after this delete. The row is
          // fenced (the writer can no longer take it over) and kept for one final
          // sweep, so an object that arrives late is still removed.
          await tx.researchEvidenceObjectCleanup.update({ where: { id: row.id },
            data: { reason: "write_abandoned", attempts: 0, nextAttemptAt: new Date(now.getTime() + RESEARCH_EVIDENCE_ABANDONED_SWEEP_MS) } });
        } else {
          await tx.researchEvidenceObjectCleanup.delete({ where: { id: row.id } });
        }
        return true;
      }, { timeout: 30_000 });
      if (removed) deleted += 1;
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

/**
 * Re-checks stored private sources against their originals, oldest check first.
 * Deleting or re-locking the original, or turning Memory off, after a run has
 * finished revokes the copy and queues its text for deletion without a model call.
 */
export async function revalidatePrivateResearchSources(limit = 100) {
  const sources = await prisma.researchSource.findMany({ where: { visibility: "private", status: { not: "revoked" } },
    orderBy: [{ revalidatedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }], take: limit,
    select: { id: true, sourceKey: true, run: { select: { id: true, userId: true, inputManifest: true } } } });
  let revoked = 0;
  for (const source of sources) {
    await isolate(source.run.id, async () => {
      if (await ensureResearchPrivateSourceGranted(source.run, source)) {
        await prisma.researchSource.update({ where: { id: source.id }, data: { revalidatedAt: researchNow() } });
      } else revoked += 1;
    });
  }
  return revoked;
}

export async function recoverResearchEngine(limit = 100) {
  return {
    revokedPrivateSources: await revalidatePrivateResearchSources(limit),
    staleItems: await recoverStaleResearchWorkItems(limit),
    staleSegments: await recoverStaleReservingSegments(limit),
    orphanedSegments: await releaseOrphanedResearchSegments(limit),
    settledSegments: await settlePendingResearchSegments(limit),
    advancedRuns: await advanceIdleResearchRuns(limit),
    cleanedObjects: await drainResearchEvidenceCleanup(limit * 2),
  };
}
