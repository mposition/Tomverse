import "server-only";

import { prisma } from "@/lib/prisma";
import {
    buildShadowReport,
    type ShadowReport,
} from "@/lib/routingShadowReport";

/**
 * The shadow routing report, read from the database for the Admin Console.
 *
 * The analysis itself lives in `lib/routingShadowReport.ts` and is shared with
 * `npm run report:routing-shadow`, so the console and the command line cannot
 * disagree about what a number means. What is here is the query and the window.
 *
 * Content-free at the query layer, not merely in the response shape. The
 * `select` names the columns the report reads and no others, so a column added
 * to `RoutingRun` later does not arrive in an admin payload by default -- the
 * same discipline `lib/memoryMetrics.ts` applies for §22.
 */

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 180;
/**
 * A ceiling on rows read, not on rows that exist. A console page must not be
 * able to pull an unbounded scan, and the report is an aggregate: the newest
 * rows in the window are the ones a reader is asking about.
 */
const MAX_ROWS = 50_000;

export type RoutingShadowReport = ShadowReport & {
    windowDays: number;
    since: string;
    /** True when the row cap was reached, so the window is not fully covered. */
    truncated: boolean;
};

export async function getRoutingShadowReport({
    windowDays,
    now = new Date(),
}: { windowDays?: number; now?: Date } = {}): Promise<RoutingShadowReport> {
    const days = Number.isFinite(windowDays)
        ? Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.floor(windowDays!)))
        : DEFAULT_WINDOW_DAYS;
    const since = new Date(now.getTime() - days * 86_400_000);

    const rows = await prisma.routingRun.findMany({
        where: { mode: "shadow", createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: MAX_ROWS,
        select: {
            taskProfileVersion: true,
            candidateFilterVersion: true,
            selectionVersion: true,
            profileKind: true,
            plan: true,
            selectedModelId: true,
            selectionReason: true,
            userSelectedModelId: true,
            eligibleCount: true,
            rejectedByReason: true,
            decisionMicros: true,
        },
    });

    const report = buildShadowReport(
        rows.map((row) => ({
            ...row,
            // A Json column is `unknown` until something says otherwise, and a
            // malformed value must not take the whole report down.
            rejectedByReason:
                row.rejectedByReason && typeof row.rejectedByReason === "object"
                    ? (row.rejectedByReason as Record<string, number>)
                    : {},
        }))
    );

    return {
        ...report,
        windowDays: days,
        since: since.toISOString(),
        // Stated rather than hidden: a reader comparing two windows needs to
        // know when one of them stopped early.
        truncated: rows.length >= MAX_ROWS,
    };
}
