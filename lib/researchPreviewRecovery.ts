import "server-only";

import {
  readChatUsageReservationForSettlement,
  settleChatUsage,
} from "@/lib/chatSecurity";
import { prisma } from "@/lib/prisma";
import {
  expireResearchPreviewCheckpoints,
  markResearchPreviewRunSettled,
  parseResearchPreviewSettlementUsage,
  recoverStalePreparingResearchPreviewRun,
  recoverStaleResearchPreviewRun,
  researchPreviewRunsAwaitingSettlement,
  stalePreparingResearchPreviewRuns,
  staleResearchPreviewRuns,
} from "@/lib/researchPreviewRunStore";

/**
 * Settles a terminal run only after its recovery transaction has committed.
 * This preserves the canonical credit-account -> reservation lock order in
 * `settleChatUsage` and never nests the run recovery inside that lock.
 */
export async function settleStoredResearchPreviewRun(
  run: {
    id: string;
    userId: string;
    reservationId: string | null;
    settlementUsage: unknown;
  } | null
) {
  if (!run?.reservationId) return;
  const usage = parseResearchPreviewSettlementUsage(run.settlementUsage);
  if (!usage) return;
  try {
    const reservation = await readChatUsageReservationForSettlement(
      run.reservationId,
      run.userId
    );
    await settleChatUsage(reservation, usage);
    await markResearchPreviewRunSettled(run.id);
  } catch (error) {
    const durable = await prisma.chatCreditReservation.findUnique({
      where: { id: run.reservationId },
      select: { status: true },
    });
    if (durable && durable.status !== "reserved") {
      await markResearchPreviewRunSettled(run.id);
      return;
    }
    throw error;
  }
}

/**
 * A row recovery keeps failing on (an unreadable settlement payload, a run
 * whose recovery throws) is counted and, after three failures, quarantined so
 * the oldest-first selection stops returning it ahead of healthy rows. The
 * reservation itself is untouched; expiry reconciliation still owns it.
 */
async function recordResearchPreviewRecoveryFailure(runId: string) {
  const run = await prisma.researchPreviewRun.update({ where: { id: runId }, data: { recoveryFailureCount: { increment: 1 } },
    select: { recoveryFailureCount: true } }).catch(() => null);
  if (run && run.recoveryFailureCount >= 3) {
    await prisma.researchPreviewRun.update({ where: { id: runId }, data: { recoveryQuarantinedAt: new Date() } }).catch(() => undefined);
  }
}

export async function settlePendingResearchPreviewRuns(limit = 50) {
  const runs = await researchPreviewRunsAwaitingSettlement(limit);
  let settled = 0;
  for (const run of runs) {
    try {
      if (!parseResearchPreviewSettlementUsage(run.settlementUsage)) throw new Error("RESEARCH_SETTLEMENT_UNREADABLE");
      await settleStoredResearchPreviewRun(run);
      settled += 1;
    } catch {
      console.error(JSON.stringify({ event: "research_settlement_deferred", runId: run.id }));
      await recordResearchPreviewRecoveryFailure(run.id);
    }
  }
  return settled;
}

/**
 * Bounded, recovery-only maintenance. It neither claims queued work nor calls
 * the Research runner, model, search or page reader. Each state transition
 * commits before settlement acquires the shared credit-account lock.
 */
export async function recoverStaleResearchPreviewRuns(limit = 50) {
  const boundedLimit = Math.min(100, Math.max(1, limit));
  const preparing = await stalePreparingResearchPreviewRuns(boundedLimit);
  let recovered = 0;
  // Each run is isolated: one failing row no longer defers the rest of the batch.
  for (const run of preparing) {
    try {
      const outcome = await recoverStalePreparingResearchPreviewRun(run.id);
      if (outcome !== "unchanged") recovered += 1;
    } catch { await recordResearchPreviewRecoveryFailure(run.id); }
  }
  const runs = await staleResearchPreviewRuns(boundedLimit);
  for (const run of runs) {
    try {
      const outcome = await recoverStaleResearchPreviewRun(run.id);
      if (outcome !== "unchanged") recovered += 1;
    } catch { await recordResearchPreviewRecoveryFailure(run.id); }
  }
  recovered += await expireResearchPreviewCheckpoints(boundedLimit);
  await settlePendingResearchPreviewRuns(boundedLimit);
  return recovered;
}
