import "server-only";

import type { Prisma } from "@prisma/client";
import { ApiSecurityError } from "@/lib/apiSecurity";
import {
    EXTERNAL_IMPORT_DIGEST_VERSION,
    externalContentDigest,
    externalConversationDigest,
    externalConversationStableId,
    externalImportDigest,
    externalMessageDedupDigest,
    externalMessageStableId,
    type ExternalImportProvider,
    type ExternalMessageRole,
} from "@/lib/externalImportDigest";
import {
    EXTERNAL_IMPORT_STORAGE_LIMITS,
    countCodePoints,
    externalImportQuotaExceeded,
    planExternalMessageTruncation,
    truncateExternalMessageContent,
    utf8ByteLength,
} from "@/lib/externalImportLimits";
import { recordExternalImportCounter } from "@/lib/externalImportMetrics";
import { prisma } from "@/lib/prisma";

/**
 * Server side of the external import lifecycle (Release A, slice A1b).
 *
 * docs/policy/external-conversation-import-and-memory.md §5.3–§5.5, §18.
 *
 * Nothing the client claims is trusted here: every digest is recomputed from
 * the received normalized content, every quota is re-checked against the
 * database under the per-account advisory lock, and the batch/finalize
 * ledgers make retries idempotent without ever storing content twice.
 *
 * Raw archives never reach this module — batches carry normalized text only,
 * and the pre-truncation original of an oversized message is digested and
 * truncated inside the request, with the unretained part discarded when the
 * request ends (§5.4).
 */

const LIMITS = EXTERNAL_IMPORT_STORAGE_LIMITS;

/** Serializes quota decisions per account, like assertConversationCapacity. */
const acquireAccountImportLock = (
    tx: Prisma.TransactionClient,
    userId: string
) =>
    tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"external-import:" + userId}))`;

export type NormalizedBatchMessage = {
    rawExternalMessageId: string;
    role: ExternalMessageRole;
    ordinal: number;
    content: string;
    sourceModelLabel?: string | null;
    sourceTimestamp?: Date | null;
};

export type NormalizedBatchConversation = {
    rawExternalConversationId: string;
    title: string;
    sourceModelLabels?: string[] | null;
    sourceCreatedAt?: Date | null;
    sourceUpdatedAt?: Date | null;
    messages: NormalizedBatchMessage[];
};

export type BatchConversationResult = {
    rawExternalConversationId: string;
    outcome: "staged" | "duplicate";
    stagedConversationId?: string;
    conversationDigest: string;
    truncatedMessageCount: number;
};

const stagingDeadlines = (now: Date) => ({
    idleBefore: new Date(now.getTime() - LIMITS.stagingIdleTtlMs),
    createdBefore: new Date(now.getTime() - LIMITS.stagingAbsoluteMaxLifetimeMs),
});

const isStagingExpired = (
    row: { createdAt: Date; updatedAt: Date },
    now = new Date()
) => {
    const { idleBefore, createdBefore } = stagingDeadlines(now);
    return row.updatedAt < idleBefore || row.createdAt < createdBefore;
};

const asSafeNumber = (value: bigint | number | null | undefined): number => {
    const numeric = Number(value ?? 0);
    if (!Number.isSafeInteger(numeric)) {
        throw new ApiSecurityError(
            500,
            "EXTERNAL_IMPORT_INTERNAL",
            "External import accounting overflow."
        );
    }
    return numeric;
};

async function loadOwnedImport(
    tx: Prisma.TransactionClient,
    userId: string,
    importId: string,
    { forUpdate = false }: { forUpdate?: boolean } = {}
) {
    if (forUpdate) {
        // Row lock so concurrent batch posts to one import serialize instead
        // of both reading the same ledger sequence.
        await tx.$queryRaw`SELECT id FROM "ExternalImport" WHERE id = ${importId} FOR UPDATE`;
    }
    const row = await tx.externalImport.findUnique({ where: { id: importId } });
    // One 404 for both "does not exist" and "not yours": a cross-user probe
    // must not learn that the ID is real.
    if (!row || row.userId !== userId) {
        throw new ApiSecurityError(404, "NOT_FOUND", "Import not found.");
    }
    return row;
}

async function expireStagingImport(
    tx: Prisma.TransactionClient,
    importId: string
) {
    await tx.externalConversation.deleteMany({
        where: { importId, finalized: false },
    });
    await tx.externalImport.update({
        where: { id: importId },
        data: { status: "failed", failureCode: "EXTERNAL_IMPORT_STAGING_EXPIRED" },
    });
}

/** Finalized-only usage; staging is transient and finalize re-checks it. */
async function finalizedUsage(
    tx: Prisma.TransactionClient,
    userId: string
) {
    const [conversations, aggregate] = await Promise.all([
        tx.externalConversation.count({ where: { userId, finalized: true } }),
        tx.externalConversation.aggregate({
            where: { userId, finalized: true },
            _sum: { messageCount: true, contentBytes: true },
        }),
    ]);
    return {
        conversations,
        messages: asSafeNumber(aggregate._sum.messageCount),
        bytes: asSafeNumber(aggregate._sum.contentBytes),
    };
}

export async function getExternalImportCapacity(userId: string) {
    const usage = await prisma.$transaction((tx) => finalizedUsage(tx, userId));
    return {
        limits: {
            maxNormalizedTextBytes: LIMITS.maxNormalizedTextBytesPerAccount,
            maxExternalConversations: LIMITS.maxExternalConversationsPerAccount,
            maxExternalMessages: LIMITS.maxExternalMessagesPerAccount,
            maxStoredMessageCodePoints: LIMITS.maxStoredMessageCodePoints,
            maxInboundMessageCodePoints: LIMITS.maxInboundMessageCodePoints,
        },
        usage: {
            normalizedTextBytes: usage.bytes,
            externalConversations: usage.conversations,
            externalMessages: usage.messages,
        },
        remaining: {
            normalizedTextBytes: Math.max(
                0,
                LIMITS.maxNormalizedTextBytesPerAccount - usage.bytes
            ),
            externalConversations: Math.max(
                0,
                LIMITS.maxExternalConversationsPerAccount - usage.conversations
            ),
            externalMessages: Math.max(
                0,
                LIMITS.maxExternalMessagesPerAccount - usage.messages
            ),
        },
        generatedAt: new Date().toISOString(),
    };
}

export function createExternalImport(input: {
    userId: string;
    provider: ExternalImportProvider;
    parserVersion: string;
    clientFingerprint?: string | null;
}) {
    return prisma.externalImport.create({
        data: {
            userId: input.userId,
            provider: input.provider,
            status: "staging",
            parserVersion: input.parserVersion,
            clientFingerprint: input.clientFingerprint ?? null,
            digestVersion: EXTERNAL_IMPORT_DIGEST_VERSION,
        },
    });
}

/**
 * Import history for the settings page. Import rows only — staged
 * conversation payloads stay out of every general listing (§5.5); the
 * per-import status endpoint is the one place staged titles appear, for the
 * owner, during an active wizard run.
 *
 * Available while the feature flag is off, like DELETE: after a rollback the
 * owner must still be able to find what they imported in order to delete it
 * (§15).
 */
export async function listExternalImports(userId: string) {
    const rows = await prisma.externalImport.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
            id: true,
            provider: true,
            status: true,
            failureCode: true,
            conversationCount: true,
            messageCount: true,
            normalizedBytes: true,
            truncationCount: true,
            duplicateCount: true,
            createdAt: true,
            completedAt: true,
        },
    });
    return rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        status: row.status,
        failureCode: row.failureCode,
        conversationCount: row.conversationCount,
        messageCount: row.messageCount,
        normalizedBytes: asSafeNumber(row.normalizedBytes),
        truncationCount: row.truncationCount,
        duplicateCount: row.duplicateCount,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
    }));
}

export async function getExternalImportStatus(userId: string, importId: string) {
    return prisma.$transaction(async (tx) => {
        const row = await loadOwnedImport(tx, userId, importId);
        const staged = await tx.externalConversation.findMany({
            where: { importId, userId },
            select: {
                id: true,
                title: true,
                conversationDigest: true,
                externalStableId: true,
                messageCount: true,
                contentBytes: true,
                finalized: true,
                sourceCreatedAt: true,
                sourceUpdatedAt: true,
            },
            orderBy: { importedAt: "asc" },
        });
        return {
            id: row.id,
            provider: row.provider,
            status: row.status,
            failureCode: row.failureCode,
            digestVersion: row.digestVersion,
            parserVersion: row.parserVersion,
            counts: {
                conversations: row.conversationCount,
                messages: row.messageCount,
                normalizedBytes: asSafeNumber(row.normalizedBytes),
                truncatedMessages: row.truncationCount,
                duplicatesSkipped: row.duplicateCount,
            },
            createdAt: row.createdAt.toISOString(),
            completedAt: row.completedAt?.toISOString() ?? null,
            conversations: staged.map((conversation) => ({
                id: conversation.id,
                title: conversation.title,
                conversationDigest: conversation.conversationDigest,
                externalStableId: conversation.externalStableId,
                messageCount: conversation.messageCount,
                contentBytes: asSafeNumber(conversation.contentBytes),
                finalized: conversation.finalized,
                sourceCreatedAt:
                    conversation.sourceCreatedAt?.toISOString() ?? null,
                sourceUpdatedAt:
                    conversation.sourceUpdatedAt?.toISOString() ?? null,
            })),
        };
    });
}

export async function appendExternalImportBatch(input: {
    userId: string;
    importId: string;
    sequence: number;
    batchDigest: string;
    conversations: NormalizedBatchConversation[];
}) {
    return prisma.$transaction(async (tx) => {
        const row = await loadOwnedImport(tx, input.userId, input.importId, {
            forUpdate: true,
        });

        if (row.status !== "staging") {
            if (row.status === "completed") {
                throw new ApiSecurityError(
                    409,
                    "EXTERNAL_IMPORT_ALREADY_FINALIZED",
                    "Import is already finalized."
                );
            }
            throw new ApiSecurityError(
                410,
                "EXTERNAL_IMPORT_STAGING_EXPIRED",
                "Import staging is no longer active."
            );
        }
        if (isStagingExpired(row)) {
            await expireStagingImport(tx, row.id);
            throw new ApiSecurityError(
                410,
                "EXTERNAL_IMPORT_STAGING_EXPIRED",
                "Import staging has expired."
            );
        }

        // Batch ledger (§5.5): a resend of the last batch is idempotent, a
        // different payload under the same sequence is a conflict, anything
        // else is out of order.
        if (input.sequence === row.lastBatchSequence) {
            if (input.batchDigest === row.lastBatchDigest) {
                return { idempotentReplay: true as const, results: [] };
            }
            throw new ApiSecurityError(
                409,
                "EXTERNAL_IMPORT_BATCH_CONFLICT",
                "A different payload was already accepted for this batch sequence."
            );
        }
        if (input.sequence !== row.lastBatchSequence + 1) {
            throw new ApiSecurityError(
                409,
                "EXTERNAL_IMPORT_BATCH_OUT_OF_ORDER",
                "Batch sequence is out of order."
            );
        }

        const results: BatchConversationResult[] = [];
        let stagedConversations = 0;
        let stagedMessages = 0;
        let stagedBytes = 0;
        let truncatedMessages = 0;
        let duplicates = 0;

        for (const conversation of input.conversations) {
            const ordinals = new Set<number>();
            for (const message of conversation.messages) {
                if (ordinals.has(message.ordinal)) {
                    throw new ApiSecurityError(
                        422,
                        "EXTERNAL_IMPORT_PAYLOAD_UNSAFE",
                        "Duplicate message ordinal in a conversation."
                    );
                }
                ordinals.add(message.ordinal);
            }

            const preparedMessages = conversation.messages.map((message) => {
                const codePoints = countCodePoints(message.content);
                const plan = planExternalMessageTruncation(codePoints);
                if (plan.kind === "exceeds_inbound_limit") {
                    // The client must exclude the whole conversation instead
                    // of sending it (§5.3); receiving one anyway is a broken
                    // or hostile client, not a skippable item.
                    throw new ApiSecurityError(
                        422,
                        "EXTERNAL_IMPORT_PAYLOAD_UNSAFE",
                        "A message exceeds the inbound size limit."
                    );
                }
                const sourceDigest = externalContentDigest(message.content);
                if (plan.kind === "store_verbatim") {
                    return {
                        message,
                        content: message.content,
                        contentDigest: sourceDigest,
                        originalContentDigest: null as string | null,
                        truncated: false,
                        originalCharacterCount: null as number | null,
                        retainedCharacterCount: null as number | null,
                        dedupDigest: externalMessageDedupDigest({
                            provider: row.provider as ExternalImportProvider,
                            rawExternalConversationId:
                                conversation.rawExternalConversationId,
                            role: message.role,
                            ordinal: message.ordinal,
                            sourceContentDigest: sourceDigest,
                        }),
                    };
                }
                const truncatedResult = truncateExternalMessageContent(
                    message.content,
                    plan
                );
                return {
                    message,
                    content: truncatedResult.content,
                    contentDigest: externalContentDigest(truncatedResult.content),
                    originalContentDigest: sourceDigest,
                    truncated: true,
                    originalCharacterCount: codePoints,
                    retainedCharacterCount: truncatedResult.retainedCharacterCount,
                    dedupDigest: externalMessageDedupDigest({
                        provider: row.provider as ExternalImportProvider,
                        rawExternalConversationId:
                            conversation.rawExternalConversationId,
                        role: message.role,
                        ordinal: message.ordinal,
                        // Truncation approval must not change source identity.
                        sourceContentDigest: sourceDigest,
                    }),
                };
            });

            const ordered = [...preparedMessages].sort(
                (a, b) => a.message.ordinal - b.message.ordinal
            );
            const conversationDigest = externalConversationDigest({
                provider: row.provider as ExternalImportProvider,
                rawExternalConversationId: conversation.rawExternalConversationId,
                orderedMessageDedupDigests: ordered.map(
                    (prepared) => prepared.dedupDigest
                ),
            });

            const existing = await tx.externalConversation.findUnique({
                where: {
                    userId_conversationDigest: {
                        userId: input.userId,
                        conversationDigest,
                    },
                },
                select: { id: true },
            });
            if (existing) {
                duplicates += 1;
                results.push({
                    rawExternalConversationId:
                        conversation.rawExternalConversationId,
                    outcome: "duplicate",
                    conversationDigest,
                    truncatedMessageCount: 0,
                });
                continue;
            }

            const bytes = ordered.reduce(
                (total, prepared) => total + utf8ByteLength(prepared.content),
                0
            );
            const stagedRow = await tx.externalConversation.create({
                data: {
                    userId: input.userId,
                    importId: row.id,
                    provider: row.provider,
                    externalStableId: externalConversationStableId({
                        provider: row.provider as ExternalImportProvider,
                        userId: input.userId,
                        rawExternalConversationId:
                            conversation.rawExternalConversationId,
                    }),
                    title: conversation.title,
                    sourceModelLabels: conversation.sourceModelLabels ?? undefined,
                    sourceCreatedAt: conversation.sourceCreatedAt ?? null,
                    sourceUpdatedAt: conversation.sourceUpdatedAt ?? null,
                    conversationDigest,
                    digestVersion: EXTERNAL_IMPORT_DIGEST_VERSION,
                    messageCount: ordered.length,
                    contentBytes: BigInt(bytes),
                },
            });
            await tx.externalMessage.createMany({
                data: ordered.map((prepared) => ({
                    userId: input.userId,
                    externalConversationId: stagedRow.id,
                    externalStableId: externalMessageStableId({
                        provider: row.provider as ExternalImportProvider,
                        userId: input.userId,
                        rawExternalConversationId:
                            conversation.rawExternalConversationId,
                        rawExternalMessageId:
                            prepared.message.rawExternalMessageId,
                    }),
                    role: prepared.message.role,
                    content: prepared.content,
                    contentDigest: prepared.contentDigest,
                    originalContentDigest: prepared.originalContentDigest,
                    digestVersion: EXTERNAL_IMPORT_DIGEST_VERSION,
                    sourceModelLabel: prepared.message.sourceModelLabel ?? null,
                    sourceTimestamp: prepared.message.sourceTimestamp ?? null,
                    ordinal: prepared.message.ordinal,
                    truncated: prepared.truncated,
                    originalCharacterCount: prepared.originalCharacterCount,
                    retainedCharacterCount: prepared.retainedCharacterCount,
                })),
            });

            const conversationTruncated = ordered.filter(
                (prepared) => prepared.truncated
            ).length;
            stagedConversations += 1;
            stagedMessages += ordered.length;
            stagedBytes += bytes;
            truncatedMessages += conversationTruncated;
            results.push({
                rawExternalConversationId: conversation.rawExternalConversationId,
                outcome: "staged",
                stagedConversationId: stagedRow.id,
                conversationDigest,
                truncatedMessageCount: conversationTruncated,
            });
        }

        // Staging may not grow past what could ever finalize: the account
        // caps bound staged + finalized rows together, so an abandoned
        // staging run cannot park unbounded content until the TTL sweep.
        await acquireAccountImportLock(tx, input.userId);
        const [allConversations, allAggregate] = await Promise.all([
            tx.externalConversation.count({ where: { userId: input.userId } }),
            tx.externalConversation.aggregate({
                where: { userId: input.userId },
                _sum: { messageCount: true, contentBytes: true },
            }),
        ]);
        if (
            externalImportQuotaExceeded(
                {
                    conversations: allConversations,
                    messages: asSafeNumber(allAggregate._sum.messageCount),
                    bytes: asSafeNumber(allAggregate._sum.contentBytes),
                },
                { conversations: 0, messages: 0, bytes: 0 }
            )
        ) {
            throw new ApiSecurityError(
                409,
                "EXTERNAL_IMPORT_QUOTA_EXCEEDED",
                "External import storage quota exceeded."
            );
        }

        await tx.externalImport.update({
            where: { id: row.id },
            data: {
                lastBatchSequence: input.sequence,
                lastBatchDigest: input.batchDigest,
                conversationCount: { increment: stagedConversations },
                messageCount: { increment: stagedMessages },
                normalizedBytes: { increment: BigInt(stagedBytes) },
                truncationCount: { increment: truncatedMessages },
                duplicateCount: { increment: duplicates },
            },
        });

        return { idempotentReplay: false as const, results };
    });
}

export async function finalizeExternalImport(input: {
    userId: string;
    importId: string;
    idempotencyKey: string;
    selectedConversationIds: string[];
    expectedImportDigest?: string | null;
}) {
    return prisma.$transaction(async (tx) => {
        const row = await loadOwnedImport(tx, input.userId, input.importId, {
            forUpdate: true,
        });

        if (row.status === "completed") {
            // §5.5 finalize idempotency: same key + same digest replays the
            // stored success; anything else is an explicit state conflict.
            if (
                row.finalizeIdempotencyKey === input.idempotencyKey &&
                (!input.expectedImportDigest ||
                    input.expectedImportDigest === row.importDigest)
            ) {
                return {
                    idempotentReplay: true as const,
                    importDigest: row.importDigest,
                    finalizedConversations: row.conversationCount,
                    finalizedMessages: row.messageCount,
                };
            }
            throw new ApiSecurityError(
                409,
                row.finalizeIdempotencyKey === input.idempotencyKey
                    ? "EXTERNAL_IMPORT_BATCH_CONFLICT"
                    : "EXTERNAL_IMPORT_ALREADY_FINALIZED",
                "Import is already finalized."
            );
        }
        if (row.status !== "staging") {
            throw new ApiSecurityError(
                410,
                "EXTERNAL_IMPORT_STAGING_EXPIRED",
                "Import staging is no longer active."
            );
        }
        if (isStagingExpired(row)) {
            await expireStagingImport(tx, row.id);
            throw new ApiSecurityError(
                410,
                "EXTERNAL_IMPORT_STAGING_EXPIRED",
                "Import staging has expired."
            );
        }

        const selected = await tx.externalConversation.findMany({
            where: {
                id: { in: input.selectedConversationIds },
                importId: row.id,
                userId: input.userId,
                finalized: false,
            },
            select: {
                id: true,
                conversationDigest: true,
                messageCount: true,
                contentBytes: true,
            },
        });
        if (
            selected.length !== new Set(input.selectedConversationIds).size ||
            selected.length === 0
        ) {
            throw new ApiSecurityError(
                409,
                "EXTERNAL_IMPORT_SELECTION_CHANGED",
                "The selection no longer matches the staged conversations."
            );
        }

        const importDigest = externalImportDigest(
            selected.map((conversation) => conversation.conversationDigest)
        );
        if (
            input.expectedImportDigest &&
            input.expectedImportDigest !== importDigest
        ) {
            throw new ApiSecurityError(
                409,
                "EXTERNAL_IMPORT_SELECTION_CHANGED",
                "The selection digest does not match the staged content."
            );
        }

        // Quota is decided here, all-or-nothing, serialized per account so
        // two concurrent finalizes cannot add up past the cap (§5.3).
        await acquireAccountImportLock(tx, input.userId);
        const usage = await finalizedUsage(tx, input.userId);
        const selectedMessages = selected.reduce(
            (total, conversation) => total + conversation.messageCount,
            0
        );
        const selectedBytes = selected.reduce(
            (total, conversation) =>
                total + asSafeNumber(conversation.contentBytes),
            0
        );
        if (
            externalImportQuotaExceeded(usage, {
                conversations: selected.length,
                messages: selectedMessages,
                bytes: selectedBytes,
            })
        ) {
            throw new ApiSecurityError(
                409,
                "EXTERNAL_IMPORT_QUOTA_EXCEEDED",
                "External import storage quota exceeded."
            );
        }

        await tx.externalConversation.updateMany({
            where: { id: { in: selected.map((conversation) => conversation.id) } },
            data: { finalized: true },
        });
        await tx.externalConversation.deleteMany({
            where: { importId: row.id, finalized: false },
        });
        await tx.externalImport.update({
            where: { id: row.id },
            data: {
                status: "completed",
                importDigest,
                finalizeIdempotencyKey: input.idempotencyKey,
                conversationCount: selected.length,
                messageCount: selectedMessages,
                normalizedBytes: BigInt(selectedBytes),
                completedAt: new Date(),
            },
        });

        return {
            idempotentReplay: false as const,
            importDigest,
            finalizedConversations: selected.length,
            finalizedMessages: selectedMessages,
        };
    });
}

export async function deleteExternalImport(userId: string, importId: string) {
    return prisma.$transaction(async (tx) => {
        const row = await loadOwnedImport(tx, userId, importId, {
            forUpdate: true,
        });
        if (row.status === "staging") {
            await tx.externalConversation.deleteMany({
                where: { importId: row.id, finalized: false },
            });
            await tx.externalImport.update({
                where: { id: row.id },
                data: { status: "cancelled" },
            });
            return { outcome: "cancelled" as const };
        }
        // Completed (or failed/cancelled) imports delete whole: the FK
        // cascade removes every conversation and message (§13.1).
        await tx.externalImport.delete({ where: { id: row.id } });
        return { outcome: "deleted" as const };
    });
}

/**
 * Staging TTL sweep (§5.5), run from the 15-minute maintenance cycle. Lazy
 * checks in batch/finalize are the primary guard; this clears content whose
 * owner never came back.
 */
export async function reconcileExpiredExternalImportStaging(now = new Date()) {
    const { idleBefore, createdBefore } = stagingDeadlines(now);
    const stale = await prisma.externalImport.findMany({
        where: {
            status: "staging",
            OR: [
                { updatedAt: { lt: idleBefore } },
                { createdAt: { lt: createdBefore } },
            ],
        },
        select: { id: true },
    });
    for (const row of stale) {
        await prisma.$transaction(async (tx) => {
            await expireStagingImport(tx, row.id);
        });
    }
    if (stale.length > 0) {
        // §22 staging-cleanup metric. A counter rather than a row aggregate:
        // the expired rows stay owner-deletable, so only the counter survives.
        await recordExternalImportCounter("staging_expired", stale.length, now);
    }
    return { expiredImports: stale.length };
}
