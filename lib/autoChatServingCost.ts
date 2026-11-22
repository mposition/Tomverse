import "server-only";
import { prisma } from "@/lib/prisma";
import { resolvedAttemptCosts } from "@/lib/chatAttemptCostLedger";
import { summarizeChatServingCost, type ServingTraceRecord } from "@/lib/autoChatServingCostCore";

/** Recent picked Auto turns read for the report; reads only, nothing is written. */
const SERVING_COST_DAYS = 7;
// Each linked reservation is resolved by the ledger's own reader (two reads), so the window stays small.
const SERVING_COST_MAX_TRACES = 100;

/**
 * The serving-cost report of recent real Auto Chat turns, joined on the trace
 * id the existing records share (lib/autoChatServingCostCore.ts). Null when the
 * read fails; Admin then shows the report as unavailable.
 */
export async function readAutoChatServingCost(now = new Date()) {
    try {
        const since = new Date(now.getTime() - SERVING_COST_DAYS * 24 * 60 * 60_000);
        const decisions = await prisma.autoRouterDecision.findMany({
            where: { createdAt: { gte: since, lte: now } },
            orderBy: { createdAt: "desc" },
            take: SERVING_COST_MAX_TRACES,
            select: { traceId: true, pickedModelId: true, outcome: true, inputTokens: true, outputTokens: true },
        });
        const traceIds = [...new Set(decisions.map((decision) => decision.traceId))];
        const [reservations, runs, latency] = await Promise.all([
            prisma.chatCreditReservation.findMany({
                where: { traceId: { in: traceIds }, source: "chat" },
                select: { id: true, traceId: true, status: true, settledCredits: true },
            }),
            prisma.routingRun.findMany({ where: { traceId: { in: traceIds } }, select: { traceId: true } }),
            prisma.responseLatencySample.findMany({
                where: { id: { in: traceIds.map((traceId) => `${traceId}:server`) } },
                select: { id: true, timings: true },
            }),
        ]);
        const attemptsByReservation = new Map(
            await Promise.all(reservations.map(async (reservation) => [reservation.id, await resolvedAttemptCosts(reservation.id)] as const))
        );
        const runTraces = new Set(runs.map((run) => run.traceId));
        const firstContent = new Map(latency.map((sample) => {
            const value = (sample.timings as { firstContentMs?: unknown } | null)?.firstContentMs;
            return [sample.id.slice(0, -":server".length), typeof value === "number" && Number.isFinite(value) ? value : null] as const;
        }));
        // One record per trace: a retried turn's decisions share it, and its cost is counted once.
        const seen = new Set<string>();
        const records: ServingTraceRecord[] = decisions.flatMap((decision) => {
            if (seen.has(decision.traceId)) return [];
            seen.add(decision.traceId);
            const linked = reservations.filter((reservation) => reservation.traceId === decision.traceId);
            return [{
                traceId: decision.traceId,
                pickedModelId: decision.pickedModelId,
                outcome: decision.outcome,
                router: { inputTokens: decision.inputTokens, outputTokens: decision.outputTokens },
                reservations: linked.map(({ id, status, settledCredits }) => ({ id, status, settledCredits })),
                attempts: linked.flatMap((reservation) => (attemptsByReservation.get(reservation.id) ?? []).map((attempt) => ({
                    reservationId: reservation.id, modelId: attempt.modelId, outcome: attempt.outcome,
                    costMicroUsd: attempt.costMicroUsd, estimated: attempt.estimated,
                }))),
                routingRun: runTraces.has(decision.traceId),
                firstContentMs: firstContent.get(decision.traceId) ?? null,
            }];
        });
        return summarizeChatServingCost(records, { since: since.toISOString(), until: now.toISOString() });
    } catch {
        return null;
    }
}
