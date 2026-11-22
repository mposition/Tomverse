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

export async function settlePendingResearchPreviewRuns(limit = 50) {
  const runs = await researchPreviewRunsAwaitingSettlement(limit);
  let settled = 0;
  for (const run of runs) {
    try {
      await settleStoredResearchPreviewRun(run);
      settled += 1;
    } catch {
      console.error(JSON.stringify({ event: "research_settlement_deferred", runId: run.id }));
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
  for (const run of preparing) {
    const outcome = await recoverStalePreparingResearchPreviewRun(run.id);
    if (outcome !== "unchanged") recovered += 1;
  }
  const runs = await staleResearchPreviewRuns(boundedLimit);
  for (const run of runs) {
    const outcome = await recoverStaleResearchPreviewRun(run.id);
    if (outcome !== "unchanged") recovered += 1;
  }
  recovered += await expireResearchPreviewCheckpoints(boundedLimit);
  await settlePendingResearchPreviewRuns(boundedLimit);
  return recovered;
}
