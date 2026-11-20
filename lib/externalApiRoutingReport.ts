import "server-only";
import { prisma } from "@/lib/prisma";
import { summarizeCodingRouting, type CodingRoutingReport } from "@/lib/externalApiRoutingReportCore";

/** Enough for the report on a busy day; past it, the newest rows are read. */
const REPORT_MAX_ROWS = 20_000;

/**
 * The coding routing report over the last `days` days, from the external API
 * request receipts (content-free). Read by Admin › Routing, by the daily
 * optimizer run's log line, and by the coding optimizer as pre-cycle evidence.
 */
export async function readCodingRoutingReport(days: number, now = new Date()): Promise<CodingRoutingReport> {
    const since = new Date(now.getTime() - days * 24 * 60 * 60_000);
    // Smart Adaptive requests only: a busy day of requests naming a model
    // cannot push them out of the read. Those are counted on their own.
    const window = { createdAt: { gte: since, lte: now } };
    const namedRequests = await prisma.externalApiRequest.count({ where: { ...window, routedBy: null } });
    const rows = await prisma.externalApiRequest.findMany({
        where: { ...window, routedBy: { not: null } },
        orderBy: { createdAt: "desc" },
        take: REPORT_MAX_ROWS,
        select: {
            createdAt: true,
            modelId: true,
            protocol: true,
            routedBy: true,
            routedHeld: true,
            routeConversation: true,
            errorCode: true,
            finishReason: true,
            reservation: { select: { status: true, reservedCredits: true, settledCredits: true } },
        },
    });
    const report = summarizeCodingRouting(
        rows.map((row) => ({
            createdAt: row.createdAt,
            modelId: row.modelId,
            protocol: row.protocol,
            routedBy: row.routedBy,
            routedHeld: row.routedHeld,
            routeConversation: row.routeConversation,
            errorCode: row.errorCode,
            finishReason: row.finishReason,
            // A reservation still held counts what it holds; a settled one what it charged.
            credits: row.reservation
                ? row.reservation.status === "reserved"
                    ? row.reservation.reservedCredits
                    : row.reservation.settledCredits
                : null,
        })),
        { since, until: now }
    );
    // More Smart Adaptive requests than were read: the counts are of the newest only.
    return { ...report, namedRequests, truncated: rows.length >= REPORT_MAX_ROWS };
}
