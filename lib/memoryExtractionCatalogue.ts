import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Read-only run views for the memory settings screen
 * (docs/policy/external-conversation-import-and-memory.md §11, §21). Kept out of
 * lib/memoryExtractionService.ts on purpose: nothing here decides anything.
 */

export type MemoryExtractionRunSummary = {
    id: string;
    status: string;
    extractionModelId: string;
    promptVersion: string;
    chunkTotal: number;
    chunkCompleted: number;
    createdAt: string;
    completedAt: string | null;
};

const ACTIVE_STATUSES = ["pending", "running"] as const;

/**
 * Recent runs, newest first, plus whichever one is still open, so the
 * settings screen can say that memories are still being organised.
 */
export async function listMemoryExtractionRuns(
    userId: string,
    { limit = 10 }: { limit?: number } = {}
): Promise<{
    runs: MemoryExtractionRunSummary[];
    activeRunId: string | null;
}> {
    const rows = await prisma.memoryExtractionRun.findMany({
        where: { userId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
        select: {
            id: true,
            status: true,
            extractionModelId: true,
            promptVersion: true,
            chunkTotal: true,
            chunkCompleted: true,
            createdAt: true,
            completedAt: true,
        },
    });
    // Read separately rather than scanning the page: an account that started
    // many runs could push its open one past `limit`, and a missed active run
    // is the one mistake this view must not make.
    const active = await prisma.memoryExtractionRun.findFirst({
        where: { userId, status: { in: [...ACTIVE_STATUSES] } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
    });
    return {
        runs: rows.map((row) => ({
            id: row.id,
            status: row.status,
            extractionModelId: row.extractionModelId,
            promptVersion: row.promptVersion,
            chunkTotal: row.chunkTotal,
            chunkCompleted: row.chunkCompleted,
            createdAt: row.createdAt.toISOString(),
            completedAt: row.completedAt?.toISOString() ?? null,
        })),
        activeRunId: active?.id ?? null,
    };
}
