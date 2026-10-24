import "server-only";

import { ApiSecurityError } from "@/lib/apiSecurity";
import { isMemoryExtractionEnabled } from "@/lib/appSettings";
import {
    MEMORY_EXTRACTION_EVAL_REGISTER,
    type MemoryExtractionEvalEntry,
} from "@/lib/memoryExtractionEvalRegister";
import {
    createMemoryExtractionRun,
    resolveEffectiveExtractionPair,
} from "@/lib/memoryExtractionService";
import { prisma } from "@/lib/prisma";

/**
 * Automatic memory extraction (owner decision 2026-10-24, policy §11).
 *
 * Importing conversations is the user's request to have them remembered, so
 * nobody picks a model or a selection and nobody confirms a price: a finished
 * import starts a run over the account's conversations that have not been
 * extracted yet, and the run is free to the account. What still bounds it is
 * the provider budget and the batch sub-budget (§3), checked when the run is
 * created and again at every chunk, the one-run-per-account rule, and the
 * account's memory switch.
 *
 * Two callers. The finished import starts its run straight away, and the
 * fifteen-minute dispatcher starts any that could not start then -- a run was
 * already open, the budget was spent, or the import predates this -- so a
 * refusal here is a delay, never a loss.
 */

/** Mirrors the most an import run plans at once; the rest waits its turn. */
export const AUTO_EXTRACTION_MAX_CONVERSATIONS = 500;

/**
 * A conversation in a failed run is tried again after this long, and not
 * after it has failed this many times: a provider outage should not cost the
 * account its memories, and a conversation that keeps failing should not keep
 * costing Tomverse a provider call every pass.
 */
export const AUTO_EXTRACTION_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
export const AUTO_EXTRACTION_MAX_FAILED_RUNS = 3;

/** Accounts the dispatcher starts runs for in one pass. */
export const AUTO_EXTRACTION_ACCOUNTS_PER_PASS = 5;

export type AutomaticExtractionStart =
    | { outcome: "started"; runId: string }
    | { outcome: "skipped"; reason: string };

type Options = {
    now?: Date;
    register?: readonly MemoryExtractionEvalEntry[];
    environment?: Record<string, string | undefined>;
};

/**
 * The pair automatic runs use: the first register entry that resolves. The
 * register lists the current pair first, so a revoked or expired one falls
 * back to the next approved pair rather than stopping extraction.
 */
async function automaticExtractionPair(
    register: readonly MemoryExtractionEvalEntry[]
) {
    for (const entry of register) {
        if (entry.status !== "approved") continue;
        try {
            await resolveEffectiveExtractionPair({
                extractionModelId: entry.extractionModelId,
                promptVersion: entry.promptVersion,
                register,
            });
            return {
                extractionModelId: entry.extractionModelId,
                promptVersion: entry.promptVersion,
            };
        } catch {
            // Revoked, expired or unpriced: try the next one.
        }
    }
    return null;
}

/**
 * The account's unlocked, finalized conversations no run has covered yet,
 * newest import first.
 *
 * "Covered" is any run that included the conversation, whatever its outcome,
 * except a failed one that is due a retry. A cancelled run counts: the user
 * cancelling, or deleting all their memories, is a reason not to extract the
 * same conversations again behind their back.
 */
async function conversationsAwaitingExtraction(
    userId: string | null,
    now: Date,
    limit: number
): Promise<Array<{ id: string; userId: string }>> {
    const retryBefore = new Date(now.getTime() - AUTO_EXTRACTION_RETRY_AFTER_MS);
    return prisma.$queryRaw<Array<{ id: string; userId: string }>>`
        SELECT c.id, c."userId"
        FROM "ExternalConversation" c
        WHERE (${userId}::text IS NULL OR c."userId" = ${userId})
          AND c.finalized = true
          AND c.password IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM "MemoryExtractionRun" r
              WHERE r."userId" = c."userId"
                AND r."sourceSelection" @> jsonb_build_array(c.id)
                AND (r.status <> 'failed' OR r."createdAt" > ${retryBefore})
          )
          AND (
              SELECT count(*) FROM "MemoryExtractionRun" r
              WHERE r."userId" = c."userId"
                AND r.status = 'failed'
                AND r."sourceSelection" @> jsonb_build_array(c.id)
          ) < ${AUTO_EXTRACTION_MAX_FAILED_RUNS}
        ORDER BY c."importedAt" DESC, c.id
        LIMIT ${limit}
    `;
}

/**
 * Starts a free run over the account's conversations that are waiting for
 * extraction. Never throws for an expected refusal: each is a `skipped`
 * outcome, and the dispatcher tries again on its next pass.
 */
export async function startAutomaticMemoryExtraction(
    userId: string,
    options: Options = {}
): Promise<AutomaticExtractionStart> {
    const now = options.now ?? new Date();
    const register = options.register ?? MEMORY_EXTRACTION_EVAL_REGISTER;
    if (!(await isMemoryExtractionEnabled())) {
        return { outcome: "skipped", reason: "feature_disabled" };
    }
    const settings = await prisma.userMemorySettings.findUnique({
        where: { userId },
        select: { masterEnabled: true },
    });
    // Memory turned off means nothing is remembered, including from imports.
    // Turning it back on lets the next pass pick the conversations up.
    if (settings && !settings.masterEnabled) {
        return { outcome: "skipped", reason: "memory_off" };
    }
    const pair = await automaticExtractionPair(register);
    if (!pair) return { outcome: "skipped", reason: "no_approved_pair" };

    const awaiting = await conversationsAwaitingExtraction(
        userId,
        now,
        AUTO_EXTRACTION_MAX_CONVERSATIONS
    );
    if (awaiting.length === 0) {
        return { outcome: "skipped", reason: "nothing_to_extract" };
    }
    try {
        const run = await createMemoryExtractionRun({
            userId,
            ...pair,
            selectedConversationIds: awaiting.map((row) => row.id),
            register,
            now,
            environment: options.environment,
        });
        return { outcome: "started", runId: run.id };
    } catch (error) {
        // An open run, a spent budget, a snapshot locked a moment ago or a
        // restricted account. All of them resolve without the user doing
        // anything, so they are reported, not raised.
        if (error instanceof ApiSecurityError) {
            return { outcome: "skipped", reason: error.code };
        }
        throw error;
    }
}

/**
 * The dispatcher's half: start runs for accounts whose imported
 * conversations are still waiting, a few accounts per pass. Accounts with an
 * open run are left to finish it first.
 */
export async function startAwaitingAutomaticExtractions(
    options: Options & { maxAccounts?: number } = {}
): Promise<number> {
    const now = options.now ?? new Date();
    if (!(await isMemoryExtractionEnabled())) return 0;
    const maxAccounts = options.maxAccounts ?? AUTO_EXTRACTION_ACCOUNTS_PER_PASS;
    // Over-fetched rows so a handful of accounts with many conversations do
    // not hide every other account behind them.
    const rows = await conversationsAwaitingExtraction(null, now, maxAccounts * 50);
    const accounts = [...new Set(rows.map((row) => row.userId))];
    let started = 0;
    for (const userId of accounts) {
        if (started >= maxAccounts) break;
        const open = await prisma.memoryExtractionRun.count({
            where: { userId, status: { in: ["pending", "running"] } },
        });
        if (open > 0) continue;
        try {
            const result = await startAutomaticMemoryExtraction(userId, options);
            if (result.outcome === "started") started += 1;
        } catch (error) {
            console.error(
                JSON.stringify({
                    event: "memory_extraction_auto_start_failed",
                    errorName: error instanceof Error ? error.name : "UnknownError",
                })
            );
        }
    }
    return started;
}
