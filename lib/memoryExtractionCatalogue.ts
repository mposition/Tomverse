import "server-only";

import {
    MEMORY_EXTRACTION_EVAL_REGISTER,
    type MemoryExtractionEvalEntry,
} from "@/lib/memoryExtractionEvalRegister";
import { resolveEffectiveExtractionPair } from "@/lib/memoryExtractionService";
import { getModelUsageCredits, type ModelTier } from "@/lib/models";
import { prisma } from "@/lib/prisma";

/**
 * Read-only views the launch screen needs (policy §11, §12.1, §21).
 *
 * Kept out of lib/memoryExtractionService.ts on purpose: nothing here decides
 * anything. The catalogue asks `resolveEffectiveExtractionPair()` — the single
 * §12.1 authority — once per register entry and reports what survived, so the
 * list can never disagree with what a create request would accept.
 *
 * The expected answer today is an empty list. No pair has an eval approval
 * yet, so the screen shows the fail-closed state rather than an inert control
 * (§12.4).
 */

export type AvailableExtractionPair = {
    extractionModelId: string;
    promptVersion: string;
    /** Catalogue name, so the screen shows the same label as the model picker. */
    modelName: string;
    /** Entitlement figure per chunk; the estimate multiplies it by chunk count. */
    creditsPerChunk: number;
};

export async function listAvailableExtractionPairs(
    plan: ModelTier | "Guest",
    register: readonly MemoryExtractionEvalEntry[] = MEMORY_EXTRACTION_EVAL_REGISTER
): Promise<AvailableExtractionPair[]> {
    const available: AvailableExtractionPair[] = [];
    for (const entry of register) {
        try {
            const { model } = await resolveEffectiveExtractionPair({
                extractionModelId: entry.extractionModelId,
                promptVersion: entry.promptVersion,
                plan,
                register,
            });
            available.push({
                extractionModelId: entry.extractionModelId,
                promptVersion: entry.promptVersion,
                modelName: model.name,
                creditsPerChunk: getModelUsageCredits(model),
            });
        } catch {
            // Unapproved, revoked, unpriced or above this plan. Which one is an
            // operational detail the §18 error code deliberately withholds, and
            // an absent row says the only thing the user can act on.
        }
    }
    return available;
}

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
 * Recent runs, newest first, plus whichever one is still open.
 *
 * The active run is what stops the screen from offering a second start: the
 * server enforces one run per account under an advisory lock and answers 409
 * MEMORY_EXTRACTION_ALREADY_RUNNING, and this is how the screen states that
 * before the user commits to a selection.
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
