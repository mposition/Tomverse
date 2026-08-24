import "server-only";

import {
    summarizePackageImportEvents,
    type PackageImportMetrics,
} from "@/lib/assistantPackageImportMetricsCore";
import { prisma } from "@/lib/prisma";

/**
 * The query behind `lib/assistantPackageImportMetricsCore.ts` (Slice 7).
 *
 * docs/policy/assistant-package-import.md §9.
 *
 * Only the four event names, and only their two selected columns. A wider
 * select would pull the rest of the event ledger into a report that has no use
 * for it.
 */

const WINDOW_DAYS = 30;

export async function getAssistantPackageImportMetrics(): Promise<PackageImportMetrics> {
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await prisma.productAnalyticsEvent.findMany({
        where: {
            occurredAt: { gte: since },
            eventName: {
                in: [
                    "assistant_package_import_step_entered",
                    "assistant_package_import_step_abandoned",
                    "assistant_package_import_warning",
                    "assistant_package_import_completed",
                ],
            },
        },
        select: { eventName: true, properties: true },
    });
    return { windowDays: WINDOW_DAYS, ...summarizePackageImportEvents(rows) };
}
