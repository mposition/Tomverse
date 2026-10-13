import "server-only";

import { prisma } from "@/lib/prisma";
import { buildAdaptiveStatistics } from "@/lib/adaptiveStatisticsCore";

const MAX_ROWS = 10_000;

/** Actual product executions only. Every select is content-free and bounded. */
export async function getAdaptiveStatisticsReport(days: 7 | 30, now = new Date()) {
  const since = new Date(now.getTime() - days * 86_400_000);
  const [refinerResult, routerResult, unattributedAutoRuns] = await Promise.all([
    prisma.promptRefinerProductExecutionReceipt.findMany({
      where: { completedAt: { gte: since, lte: now } },
      orderBy: { completedAt: "desc" },
      take: MAX_ROWS + 1,
      select: {
        outcome: true,
        failureCode: true,
        preparationLatencyMs: true,
        actualCostMicroUsd: true,
        inputTokens: true,
        outputTokens: true,
        productContext: { select: { mode: true } },
        dispositions: { select: { outcome: true } },
      },
    }),
    prisma.routingRun.findMany({
      where: {
        mode: "auto",
        createdAt: { gte: since, lte: now },
        OR: [{ productKey: "chat" }, { productKey: null, plan: "Guest" }],
      },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS + 1,
      select: {
        plan: true,
        reservationId: true,
        estimatedInputTokens: true,
        profileKind: true,
        selectionPolicyVersion: true,
        selectionReason: true,
        eligibleCount: true,
        rejectedByReason: true,
        initialModelId: true,
        finalModelId: true,
        rerouteCount: true,
        fallbackState: true,
        settlementOutcome: true,
        decisionMicros: true,
        totalLatencyMs: true,
        firstTokenMs: true,
        routingAttempts: { select: { outcome: true, failureLayer: true } },
      },
    }),
    prisma.routingRun.count({
      where: {
        mode: "auto",
        createdAt: { gte: since, lte: now },
        productKey: null,
        plan: { not: "Guest" },
      },
    }),
  ]);
  const refinerTruncated = refinerResult.length > MAX_ROWS;
  const autoRouterTruncated = routerResult.length > MAX_ROWS;
  const refiner = refinerResult.slice(0, MAX_ROWS);
  const router = routerResult.slice(0, MAX_ROWS);
  const reservationIds = [...new Set(router.flatMap((row) => row.reservationId === null ? [] : [row.reservationId]))];
  const usageResult = reservationIds.length === 0 ? [] : await prisma.chatAttemptUsage.findMany({
    where: { reservationId: { in: reservationIds } },
    take: MAX_ROWS * 3 + 1,
    select: {
      reservationId: true,
      costMicroUsd: true,
      costSource: true,
      inputTokens: true,
      outputTokens: true,
      adjustments: { select: { costDeltaMicroUsd: true } },
    },
  });
  const providerUsageTruncated = usageResult.length > MAX_ROWS * 3;
  return {
    observedAt: now.toISOString(),
    since: since.toISOString(),
    windowDays: days,
    coverage: {
      refinerTruncated,
      autoRouterTruncated,
      providerUsageTruncated,
      // Neither receipt table is the denominator for all Chat sends.
      allChatTurns: null,
      // Pre-dispatch Auto refusals may have no RoutingRun.
      allAutoRequests: null,
      unattributedAutoRuns,
    },
    ...buildAdaptiveStatistics(refiner, router, usageResult.slice(0, MAX_ROWS * 3)),
  };
}
