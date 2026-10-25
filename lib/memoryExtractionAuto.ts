import "server-only";

import { Prisma } from "@prisma/client";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { isMemoryExtractionEnabled } from "@/lib/appSettings";
import { ChatAccessError } from "@/lib/chatSecurity";
import {
    MEMORY_EXTRACTION_EVAL_REGISTER,
    type MemoryExtractionEvalEntry,
} from "@/lib/memoryExtractionEvalRegister";
import { MEMORY_EXTRACTION_PROMPT_VERSION } from "@/lib/memoryExtractionPrompt";
import {
    createMemoryExtractionRun,
    resolveEffectiveExtractionPair,
} from "@/lib/memoryExtractionService";
import { prisma } from "@/lib/prisma";

/**
 * Automatic memory extraction (owner decision 2026-10-24,
 * docs/policy/external-conversation-import-and-memory.md §11).
 *
 * Importing conversations is the user's request to have them remembered, so
 * nobody picks a model or a selection and nobody confirms a price: a finished
 * import starts a run over the account's conversations that have not been
 * extracted yet, and the run is free to the account. What still bounds it is
 * the provider budget and the batch sub-budget (the same document's §3),
 * checked when the run is
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
 * The pair automatic runs use: an approved entry for the prompt this build
 * actually sends. The worker always builds the shipped prompt, so a run
 * recorded under an older prompt version would send one prompt and label
 * its memories with another; when the current pair is revoked or expired,
 * extraction stops rather than falling back.
 */
async function automaticExtractionPair(
    register: readonly MemoryExtractionEvalEntry[]
) {
    for (const entry of register) {
        if (entry.status !== "approved") continue;
        if (entry.promptVersion !== MEMORY_EXTRACTION_PROMPT_VERSION) continue;
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
const awaitingExtraction = (now: Date) => {
    const retryBefore = new Date(now.getTime() - AUTO_EXTRACTION_RETRY_AFTER_MS);
    return Prisma.sql`
        c.finalized = true
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
    `;
};

async function conversationsAwaitingExtraction(
    userId: string,
    now: Date,
    limit: number
): Promise<Array<{ id: string }>> {
    return prisma.$queryRaw<Array<{ id: string }>>`
        SELECT c.id
        FROM "ExternalConversation" c
        WHERE c."userId" = ${userId} AND ${awaitingExtraction(now)}
        ORDER BY c."importedAt" DESC, c.id
        LIMIT ${limit}
    `;
}

/**
 * Accounts that are waiting and could start a run now, most recent import
 * first. Accounts that cannot start -- an open run, memory turned off, an
 * account restricted or being deleted -- are left out here rather than
 * skipped one by one, so a handful of them can never fill every pass and
 * keep the other accounts waiting. The restriction test mirrors
 * lib/userOperationalSecurity.ts; the run creation still enforces it.
 */
async function accountsAwaitingExtraction(
    now: Date,
    limit: number
): Promise<string[]> {
    const rows = await prisma.$queryRaw<Array<{ userId: string }>>`
        SELECT c."userId"
        FROM "ExternalConversation" c
        JOIN "User" u ON u.id = c."userId"
        LEFT JOIN "UserMemorySettings" s ON s."userId" = c."userId"
        WHERE ${awaitingExtraction(now)}
          AND COALESCE(s."masterEnabled", true)
          AND (u."accountStatus" = 'active'
               OR (u."accountStatus" = 'suspended'
                   AND u."accountSuspendedUntil" IS NOT NULL
                   AND u."accountSuspendedUntil" <= ${now}))
          AND (u."aiUsageRestricted" = false
               OR (u."aiUsageRestrictedUntil" IS NOT NULL
                   AND u."aiUsageRestrictedUntil" <= ${now}))
          AND NOT EXISTS (
              SELECT 1 FROM "MemoryExtractionRun" r
              WHERE r."userId" = c."userId" AND r.status IN ('pending', 'running')
          )
        GROUP BY c."userId"
        ORDER BY max(c."importedAt") DESC, c."userId"
        LIMIT ${limit}
    `;
    return rows.map((row) => row.userId);
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
        // restricted account. None is a server failure, so each is reported
        // with its code rather than raised.
        if (error instanceof ApiSecurityError || error instanceof ChatAccessError) {
            return { outcome: "skipped", reason: error.code };
        }
        throw error;
    }
}

/**
 * The dispatcher's half: start runs for accounts whose imported
 * conversations are still waiting, a few accounts per pass.
 */
export async function startAwaitingAutomaticExtractions(
    options: Options & { maxAccounts?: number } = {}
): Promise<number> {
    const now = options.now ?? new Date();
    if (!(await isMemoryExtractionEnabled())) return 0;
    const maxAccounts = options.maxAccounts ?? AUTO_EXTRACTION_ACCOUNTS_PER_PASS;
    const accounts = await accountsAwaitingExtraction(now, maxAccounts);
    let started = 0;
    for (const userId of accounts) {
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
