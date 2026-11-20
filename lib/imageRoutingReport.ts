import "server-only";
import { prisma } from "@/lib/prisma";
import { summarizeImageRouting, type ImageRoutingReport } from "@/lib/imageRoutingReportCore";

/** Enough for a busy day; past it, the newest rows are read. */
const REPORT_MAX_ROWS = 20_000;

/**
 * The image routing report over the last `days` days (content-free): read by
 * Admin › Routing, logged by every daily optimizer run, and read by the image
 * optimizer as pre-cycle evidence.
 */
export async function readImageRoutingReport(days: number, now = new Date()): Promise<ImageRoutingReport> {
    const since = new Date(now.getTime() - days * 24 * 60 * 60_000);
    const [decisions, generations] = await Promise.all([
        prisma.imageRoutingDecision.findMany({
            where: { createdAt: { gte: since, lte: now } },
            orderBy: { createdAt: "desc" },
            take: REPORT_MAX_ROWS,
            select: { source: true, outcome: true, imageModelId: true, preset: true, edit: true, followUp: true, modelFallback: true, groupId: true },
        }),
        prisma.imageGeneration.findMany({
            where: { createdAt: { gte: since, lte: now } },
            orderBy: { createdAt: "desc" },
            take: REPORT_MAX_ROWS,
            select: {
                id: true,
                modelId: true,
                preset: true,
                status: true,
                failurePhase: true,
                attemptNumber: true,
                startedAt: true,
                completedAt: true,
                signals: { select: { kind: true } },
            },
        }),
    ]);
    const costs = await prisma.imageCreditReservation.findMany({
        where: { generationId: { in: generations.map((row) => row.id) }, settledAt: { not: null } },
        select: { generationId: true, settledCostMicroUsd: true },
    });
    const costByGeneration = new Map(costs.map((row) => [row.generationId, Number(row.settledCostMicroUsd)]));
    return summarizeImageRouting(
        decisions.map(({ groupId, ...row }) => ({ ...row, linked: groupId !== null })),
        generations.map(({ id, signals, ...row }) => ({
            ...row,
            costMicroUsd: costByGeneration.get(id) ?? null,
            signals: signals.map((signal) => signal.kind),
        })),
        { since, until: now }
    );
}
