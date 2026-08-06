import "server-only";

import type { Prisma } from "@prisma/client";
import { ApiSecurityError } from "@/lib/apiSecurity";
import {
    ConversationLockError,
    hasResourceUnlockGrant,
} from "@/lib/conversationLock";
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
    computeExternalImportExpiries,
    countCodePoints,
    externalImportQuotaExceeded,
    planExternalMessageTruncation,
    truncateExternalMessageContent,
    utf8ByteLength,
} from "@/lib/externalImportLimits";
import { recordExternalImportCounter } from "@/lib/externalImportMetrics";
import { recordMemoryCounter } from "@/lib/memoryMetrics";
import {
    SOURCE_DELETE_SUSPENDED_STATUS,
    planSourceDeletion,
    summarizeSourceDeletionImpact,
    type MemoryDeletionFacts,
    type SourceDeletionDisposition,
    type SourceDeletionImpact,
} from "@/lib/memorySourceDeletion";
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

/**
 * The two TTLs of §5.5 expressed as instants, plus the one that actually
 * bites. Computed on the server so the client never has to add 24h to a
 * timestamp itself and disagree about which limit applies.
 *
 * `preview_ready` is subject to exactly the same clocks as `staging`: sealing
 * declares the upload complete, it does not buy the import more life.
 */
export const externalImportExpiries = computeExternalImportExpiries;

/** Statuses that hold un-finalized staged rows and expire on the §5.5 clocks. */
const OPEN_IMPORT_STATUSES = ["staging", "preview_ready"] as const;

const isOpenImportStatus = (status: string): boolean =>
    (OPEN_IMPORT_STATUSES as readonly string[]).includes(status);

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
            updatedAt: true,
            completedAt: true,
        },
    });
    const now = new Date();
    return rows.map((row) => {
        const open = isOpenImportStatus(row.status);
        const expiries = open ? externalImportExpiries(row) : null;
        return {
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
            // Enough for the management screen to tell the three unfinished
            // shapes apart without a second round trip: a sealed import that
            // can be resumed, a partial upload that cannot, and one whose TTL
            // has already run out. Expired work is shown as expired, never
            // quietly hidden (§5.5).
            expiresAt: expiries?.effectiveExpiresAt ?? null,
            expired: open ? isStagingExpired(row, now) : false,
            resumable: row.status === "preview_ready" && !isStagingExpired(row, now),
        };
    });
}

/**
 * Finalized conversations for the account-private viewer (§21). Rows carry
 * `externalStableId` so the client can group immutable snapshots of the same
 * source lineage and present the latest one first (§4.2). Staged rows never
 * appear here (§5.5).
 */
export async function listExternalConversations(
    userId: string,
    { offset = 0, limit = 50 }: { offset?: number; limit?: number } = {}
) {
    const [total, rows] = await Promise.all([
        prisma.externalConversation.count({
            where: { userId, finalized: true },
        }),
        prisma.externalConversation.findMany({
            where: { userId, finalized: true },
            orderBy: [{ importedAt: "desc" }, { id: "desc" }],
            skip: offset,
            take: limit,
            select: {
                id: true,
                importId: true,
                provider: true,
                title: true,
                externalStableId: true,
                messageCount: true,
                contentBytes: true,
                sourceCreatedAt: true,
                sourceUpdatedAt: true,
                importedAt: true,
                password: true,
            },
        }),
    ]);
    return {
        total,
        offset,
        limit,
        conversations: rows.map((row) => ({
            id: row.id,
            importId: row.importId,
            provider: row.provider,
            title: row.title,
            externalStableId: row.externalStableId,
            messageCount: row.messageCount,
            contentBytes: asSafeNumber(row.contentBytes),
            sourceCreatedAt: row.sourceCreatedAt?.toISOString() ?? null,
            sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
            importedAt: row.importedAt.toISOString(),
            // Whether a lock is set, never the hash (§7). The owner needs the
            // list to say which snapshots will ask for a password before they
            // open one; nothing else about the lock belongs in a list.
            locked: row.password != null,
        })),
    };
}

/**
 * The §7.1 read gate, in the service rather than in the routes.
 *
 * `request` is a required parameter of every function that reaches snapshot
 * content, not an optional one, so a reader added later cannot forget it and
 * quietly serve a locked conversation. It reuses the existing 423
 * `CONVERSATION_LOCKED` contract rather than minting a code: §7 requires
 * compatibility with the conversation lock, and the §18 error table is
 * settled.
 *
 * Deletion is deliberately *not* gated, which is where this departs from the
 * native conversation routes. What §7.1 protects is content — reading the
 * evidence, and reaching it through a new chat — and a delete exposes
 * neither. Gating it would trade that non-benefit for a real harm: §13.1
 * gives the owner an unconditional right to delete their imported data and
 * §15 forbids leaving imported data beyond its owner's reach, and a forgotten
 * lock password would do exactly that, permanently.
 */
const assertExternalConversationUnlocked = (
    request: Request,
    userId: string,
    row: { id: string; password: string | null }
) => {
    if (
        hasResourceUnlockGrant(
            "external_conversation",
            request,
            userId,
            row.id,
            row.password
        )
    ) {
        return;
    }
    throw new ConversationLockError(
        423,
        "CONVERSATION_LOCKED",
        "Conversation is locked."
    );
};

/**
 * One finalized conversation with a page of its messages, for the read-only
 * viewer. Content leaves this function as the stored plain text — rendering
 * it inertly (never as HTML) is the viewer's contract (§4, §19).
 */
export async function getExternalConversation(
    userId: string,
    conversationId: string,
    {
        request,
        offset = 0,
        limit = 100,
    }: { request: Request; offset?: number; limit?: number }
) {
    const row = await prisma.externalConversation.findUnique({
        where: { id: conversationId },
    });
    // One 404 for "does not exist", "not yours" and "not finalized": a
    // cross-user probe must not learn that the ID is real, and staging rows
    // stay invisible outside their wizard run.
    if (!row || row.userId !== userId || !row.finalized) {
        throw new ApiSecurityError(404, "NOT_FOUND", "Conversation not found.");
    }
    assertExternalConversationUnlocked(request, userId, row);
    const messages = await prisma.externalMessage.findMany({
        where: { externalConversationId: row.id },
        orderBy: { ordinal: "asc" },
        skip: offset,
        take: limit,
        select: {
            id: true,
            role: true,
            ordinal: true,
            content: true,
            sourceModelLabel: true,
            sourceTimestamp: true,
            truncated: true,
            originalCharacterCount: true,
            retainedCharacterCount: true,
        },
    });
    return {
        id: row.id,
        importId: row.importId,
        provider: row.provider,
        title: row.title,
        externalStableId: row.externalStableId,
        sourceModelLabels: Array.isArray(row.sourceModelLabels)
            ? (row.sourceModelLabels as string[])
            : [],
        sourceCreatedAt: row.sourceCreatedAt?.toISOString() ?? null,
        sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
        importedAt: row.importedAt.toISOString(),
        // Reaching here means the grant was accepted, so this says "a lock is
        // set and you are past it" -- which is what lets the viewer offer to
        // change or remove it (§7).
        locked: row.password != null,
        messageTotal: row.messageCount,
        offset,
        limit,
        messages: messages.map((message) => ({
            id: message.id,
            role: message.role,
            ordinal: message.ordinal,
            content: message.content,
            sourceModelLabel: message.sourceModelLabel,
            sourceTimestamp: message.sourceTimestamp?.toISOString() ?? null,
            truncated: message.truncated,
            originalCharacterCount: message.originalCharacterCount,
            retainedCharacterCount: message.retainedCharacterCount,
        })),
    };
}

/**
 * Deletes one finalized snapshot (§4.2: earlier snapshots of a lineage are
 * individually deletable). The parent import's counters are corrected in the
 * same transaction so the history rows stay truthful; `duplicateCount` is a
 * record of what the import run itself skipped and is left alone.
 */
/**
 * Statuses a suspension is meaningful for (§8.3).
 *
 * A memory that is already rejected, superseded or expired is out of
 * retrieval by definition, and overwriting its status with
 * `suspended_by_source_delete` would replace the true reason it left with a
 * different one. Those rows keep the status they have.
 */
const SUSPENDABLE_MEMORY_STATUSES = [
    "active",
    "candidate",
    "manual_review_required",
] as const;

const NO_MEMORY_IMPACT = {
    derivedCount: 0,
    userTouchedCount: 0,
    keptCount: 0,
    deletedMemories: 0,
    suspendedMemories: 0,
} as const;

/**
 * The memories a source delete would strand, with the facts §13.1 classifies
 * on. Must run *before* the rows go: once the cascade removes the evidence,
 * nothing records which memories came from what.
 */
async function memoriesFacingSourceDeletion(
    tx: Prisma.TransactionClient,
    userId: string,
    doomedConversationIds: string[]
): Promise<(MemoryDeletionFacts & { status: string })[]> {
    if (doomedConversationIds.length === 0) return [];
    const doomed = new Set(doomedConversationIds);

    const affected = await tx.memoryEvidence.findMany({
        where: {
            userId,
            externalMessage: {
                externalConversationId: { in: doomedConversationIds },
            },
        },
        select: { memoryItemId: true },
        distinct: ["memoryItemId"],
    });
    if (affected.length === 0) return [];

    const memoryIds = affected.map((row) => row.memoryItemId);
    const items = await tx.memoryItem.findMany({
        where: { id: { in: memoryIds }, userId },
        select: {
            id: true,
            status: true,
            userEdited: true,
            evidences: {
                select: {
                    sourceType: true,
                    externalMessage: {
                        select: { externalConversationId: true },
                    },
                },
            },
        },
    });

    return items.map((item) => ({
        id: item.id,
        status: item.status,
        userEdited: item.userEdited,
        // Manual grounds and evidence from conversations that are staying are
        // both survivors; only evidence inside the doomed set disappears.
        hasSurvivingEvidence: item.evidences.some(
            (evidence) =>
                evidence.externalMessage === null ||
                !doomed.has(evidence.externalMessage.externalConversationId)
        ),
    }));
}

async function applySourceDeletionToMemories(
    tx: Prisma.TransactionClient,
    userId: string,
    doomedConversationIds: string[],
    dispositions: {
        derived?: SourceDeletionDisposition;
        userTouched?: SourceDeletionDisposition;
    }
): Promise<SourceDeletionImpact & { deletedMemories: number; suspendedMemories: number }> {
    const memories = await memoriesFacingSourceDeletion(
        tx,
        userId,
        doomedConversationIds
    );
    const plan = planSourceDeletion({
        memories,
        derivedDisposition: dispositions.derived,
        userTouchedDisposition: dispositions.userTouched,
    });

    let deletedMemories = 0;
    if (plan.deleteIds.length > 0) {
        const removed = await tx.memoryItem.deleteMany({
            where: { id: { in: plan.deleteIds }, userId },
        });
        deletedMemories = removed.count;
    }
    let suspendedMemories = 0;
    if (plan.suspendIds.length > 0) {
        const suspended = await tx.memoryItem.updateMany({
            where: {
                id: { in: plan.suspendIds },
                userId,
                status: { in: [...SUSPENDABLE_MEMORY_STATUSES] },
            },
            data: {
                status: SOURCE_DELETE_SUSPENDED_STATUS,
                suspendedReason: SOURCE_DELETE_SUSPENDED_STATUS,
            },
        });
        suspendedMemories = suspended.count;
    }
    // Counted here because the rows this describes are gone or changed by
    // the time anything could aggregate them (§22).
    if (deletedMemories > 0) {
        void recordMemoryCounter("source_delete_memory_deleted", deletedMemories);
    }
    if (suspendedMemories > 0) {
        void recordMemoryCounter(
            "source_delete_memory_suspended",
            suspendedMemories
        );
    }
    return {
        ...summarizeSourceDeletionImpact(memories),
        deletedMemories,
        suspendedMemories,
    };
}

/**
 * What deleting this source would do to the account's memories, so the
 * confirmation states it before the user commits rather than after (§13.1).
 */
export async function previewExternalSourceDeletion(
    userId: string,
    scope: { importId: string } | { conversationId: string }
): Promise<SourceDeletionImpact> {
    const conversationIds = await conversationIdsForScope(prisma, userId, scope);
    const memories = await memoriesFacingSourceDeletion(
        prisma,
        userId,
        conversationIds
    );
    return summarizeSourceDeletionImpact(memories);
}

async function conversationIdsForScope(
    tx: Prisma.TransactionClient | typeof prisma,
    userId: string,
    scope: { importId: string } | { conversationId: string }
): Promise<string[]> {
    if ("conversationId" in scope) {
        const row = await tx.externalConversation.findFirst({
            where: { id: scope.conversationId, userId },
            select: { id: true },
        });
        return row ? [row.id] : [];
    }
    const rows = await tx.externalConversation.findMany({
        where: { importId: scope.importId, userId },
        select: { id: true },
    });
    return rows.map((row) => row.id);
}

export async function deleteExternalConversationSnapshot(
    userId: string,
    conversationId: string,
    dispositions: {
        derived?: SourceDeletionDisposition;
        userTouched?: SourceDeletionDisposition;
    } = {}
) {
    return prisma.$transaction(async (tx) => {
        const row = await tx.externalConversation.findUnique({
            where: { id: conversationId },
        });
        if (!row || row.userId !== userId || !row.finalized) {
            throw new ApiSecurityError(
                404,
                "NOT_FOUND",
                "Conversation not found."
            );
        }
        const truncatedMessages = await tx.externalMessage.count({
            where: { externalConversationId: row.id, truncated: true },
        });
        // Before the delete, not after: the cascade takes the evidence rows
        // with the messages, and afterwards nothing records which memories
        // came from this conversation (§13.1).
        const memoryImpact = await applySourceDeletionToMemories(
            tx,
            userId,
            [row.id],
            dispositions
        );
        await tx.externalConversation.delete({ where: { id: row.id } });
        await tx.externalImport.updateMany({
            where: { id: row.importId },
            data: {
                conversationCount: { decrement: 1 },
                messageCount: { decrement: row.messageCount },
                normalizedBytes: { decrement: row.contentBytes },
                truncationCount: { decrement: truncatedMessages },
            },
        });
        return { outcome: "deleted" as const, memory: memoryImpact };
    });
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
        // Per-conversation truncation counts, so a resumed confirmation
        // screen can name the conversations that get shortened exactly as the
        // wizard's own review did (§5.4) rather than only the import total.
        const truncatedByConversation = new Map<string, number>();
        if (staged.length > 0) {
            const grouped = await tx.externalMessage.groupBy({
                by: ["externalConversationId"],
                where: {
                    externalConversationId: {
                        in: staged.map((conversation) => conversation.id),
                    },
                    truncated: true,
                },
                _count: { _all: true },
            });
            for (const entry of grouped) {
                truncatedByConversation.set(
                    entry.externalConversationId,
                    entry._count._all
                );
            }
        }
        const open = isOpenImportStatus(row.status);
        return {
            id: row.id,
            provider: row.provider,
            status: row.status,
            failureCode: row.failureCode,
            digestVersion: row.digestVersion,
            parserVersion: row.parserVersion,
            lastBatchSequence: row.lastBatchSequence,
            ...(open ? externalImportExpiries(row) : {}),
            expired: open ? isStagingExpired(row) : false,
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
                truncatedMessageCount:
                    truncatedByConversation.get(conversation.id) ?? 0,
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
            if (row.status === "preview_ready") {
                // Sealing declares the upload finished (§ seal contract), so
                // appending after it would splice a second selection into a
                // set the client has already been shown and verified.
                throw new ApiSecurityError(
                    409,
                    "EXTERNAL_IMPORT_SELECTION_CHANGED",
                    "The upload for this import was already sealed."
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

/**
 * Seals a staging import: the client declares that its upload is complete,
 * and the server checks that declaration against what it actually stored.
 *
 * What seal does and does not mean (§5.5, seal contract):
 *
 *   * it confirms two things only — the client sent every batch it meant to,
 *     and the staged result the client is holding matches the server's rows.
 *     That is what makes a later resume safe: a partially uploaded import can
 *     never be mistaken for a complete one;
 *   * it does **not** freeze the finalize selection. Finalize still accepts
 *     any subset of the sealed set, and the import digest is recomputed from
 *     whatever subset is finalized — never replayed from the sealed digest.
 *
 * The server does not know, and must not assume it knows, what the whole
 * export contained or what the user originally ticked. The contract is
 * "client declares completion, server cross-checks its own state" — every
 * declared value below is compared against a row the server wrote itself.
 *
 * Idempotency needs no extra column: staged rows, `lastBatchSequence` and
 * `duplicateCount` are all frozen once the status is `preview_ready`, so
 * re-running the same verification against an already-sealed import either
 * passes identically (200 replay) or fails as a conflicting declaration.
 */
export async function sealExternalImport(input: {
    userId: string;
    importId: string;
    finalSequence: number;
    expectedStagedConversationIds: string[];
    expectedDuplicateCount: number;
}) {
    return prisma.$transaction(async (tx) => {
        const row = await loadOwnedImport(tx, input.userId, input.importId, {
            forUpdate: true,
        });

        if (row.status === "completed") {
            throw new ApiSecurityError(
                409,
                "EXTERNAL_IMPORT_ALREADY_FINALIZED",
                "Import is already finalized."
            );
        }
        if (row.status !== "staging" && row.status !== "preview_ready") {
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

        const mismatch = (message: string) =>
            new ApiSecurityError(
                409,
                "EXTERNAL_IMPORT_SELECTION_CHANGED",
                message
            );

        if (row.lastBatchSequence !== input.finalSequence) {
            throw mismatch(
                "The declared final batch does not match the accepted batches."
            );
        }
        if (row.duplicateCount !== input.expectedDuplicateCount) {
            throw mismatch(
                "The declared duplicate count does not match the staged result."
            );
        }

        const staged = await tx.externalConversation.findMany({
            where: { importId: row.id, userId: input.userId, finalized: false },
            select: {
                id: true,
                title: true,
                conversationDigest: true,
                externalStableId: true,
                messageCount: true,
                contentBytes: true,
                sourceCreatedAt: true,
                sourceUpdatedAt: true,
            },
            orderBy: { importedAt: "asc" },
        });

        const declared = new Set(input.expectedStagedConversationIds);
        if (declared.size !== input.expectedStagedConversationIds.length) {
            throw mismatch("The declared staged ids contain duplicates.");
        }
        if (declared.size !== staged.length) {
            throw mismatch(
                "The declared staged conversation count does not match the stored rows."
            );
        }
        for (const conversation of staged) {
            if (!declared.has(conversation.id)) {
                throw mismatch(
                    "The declared staged ids do not match the stored rows."
                );
            }
        }

        if (row.status === "staging") {
            await tx.externalImport.update({
                where: { id: row.id },
                data: { status: "preview_ready" },
            });
        }

        // Read the row back so the returned deadlines reflect the `updatedAt`
        // this transaction just moved, not the pre-seal one.
        const sealedRow = await tx.externalImport.findUniqueOrThrow({
            where: { id: row.id },
            select: { createdAt: true, updatedAt: true },
        });

        return {
            idempotentReplay: row.status === "preview_ready",
            status: "preview_ready" as const,
            updatedAt: sealedRow.updatedAt.toISOString(),
            ...externalImportExpiries(sealedRow),
            duplicateCount: row.duplicateCount,
            truncatedMessageCount: row.truncationCount,
            // Digest of the WHOLE sealed set. Finalizing a subset recomputes
            // its own digest — this value must never be replayed as the
            // expectedImportDigest of a narrowed selection.
            sealedSelectionDigest: externalImportDigest(
                staged.map((conversation) => conversation.conversationDigest)
            ),
            conversations: staged.map((conversation) => ({
                id: conversation.id,
                title: conversation.title,
                conversationDigest: conversation.conversationDigest,
                externalStableId: conversation.externalStableId,
                messageCount: conversation.messageCount,
                contentBytes: asSafeNumber(conversation.contentBytes),
                sourceCreatedAt:
                    conversation.sourceCreatedAt?.toISOString() ?? null,
                sourceUpdatedAt:
                    conversation.sourceUpdatedAt?.toISOString() ?? null,
            })),
        };
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
        // `preview_ready` finalizes exactly like `staging`. Seal fixed that
        // the upload is complete, not what gets saved, so a subset of the
        // sealed set is a normal finalize — and old browser sessions that
        // never sealed keep working from `staging` for the whole TTL window.
        if (row.status !== "staging" && row.status !== "preview_ready") {
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

export async function deleteExternalImport(
    userId: string,
    importId: string,
    dispositions: {
        derived?: SourceDeletionDisposition;
        userTouched?: SourceDeletionDisposition;
    } = {}
) {
    return prisma.$transaction(async (tx) => {
        const row = await loadOwnedImport(tx, userId, importId, {
            forUpdate: true,
        });
        // A sealed-but-unfinalized import is cancelled exactly like an
        // unsealed one: seal is a completeness statement about the upload,
        // not a commitment to save anything (§5.5).
        if (isOpenImportStatus(row.status)) {
            // No memory can be derived from this branch's rows: extraction
            // only ever selects finalized conversations, and these are the
            // ones that never got there.
            await tx.externalConversation.deleteMany({
                where: { importId: row.id, finalized: false },
            });
            await tx.externalImport.update({
                where: { id: row.id },
                data: { status: "cancelled" },
            });
            // Reported as zeros rather than omitted: "cancelling touched no
            // memory" is a fact the caller should be able to state, and a
            // uniform shape spares every caller a narrowing branch.
            return { outcome: "cancelled" as const, memory: NO_MEMORY_IMPACT };
        }
        // Completed (or failed/cancelled) imports delete whole: the FK
        // cascade removes every conversation and message (§13.1). The
        // memories derived from them are decided first, for the same reason
        // as the single-conversation path — after the cascade there is
        // nothing left to attribute them to.
        const doomedConversationIds = await conversationIdsForScope(
            tx,
            userId,
            { importId: row.id }
        );
        const memoryImpact = await applySourceDeletionToMemories(
            tx,
            userId,
            doomedConversationIds,
            dispositions
        );
        await tx.externalImport.delete({ where: { id: row.id } });
        return { outcome: "deleted" as const, memory: memoryImpact };
    });
}

/**
 * Yields every finalized conversation with its full messages, in stable
 * order, for the account export download (§21). Paged so the route can
 * stream a response that may approach the 50MB account quota without ever
 * materializing it whole.
 */
export async function* iterateExternalExportConversations(userId: string) {
    const pageSize = 20;
    let cursor: { importedAt: Date; id: string } | null = null;
    for (;;) {
        const rows: Array<{
            id: string;
            provider: string;
            title: string;
            externalStableId: string;
            sourceModelLabels: unknown;
            conversationDigest: string;
            digestVersion: number;
            sourceCreatedAt: Date | null;
            sourceUpdatedAt: Date | null;
            importedAt: Date;
        }> = await prisma.externalConversation.findMany({
            where: {
                userId,
                finalized: true,
                ...(cursor
                    ? {
                          OR: [
                              { importedAt: { lt: cursor.importedAt } },
                              {
                                  importedAt: cursor.importedAt,
                                  id: { lt: cursor.id },
                              },
                          ],
                      }
                    : {}),
            },
            orderBy: [{ importedAt: "desc" }, { id: "desc" }],
            take: pageSize,
            select: {
                id: true,
                provider: true,
                title: true,
                externalStableId: true,
                sourceModelLabels: true,
                conversationDigest: true,
                digestVersion: true,
                sourceCreatedAt: true,
                sourceUpdatedAt: true,
                importedAt: true,
            },
        });
        if (rows.length === 0) return;
        for (const row of rows) {
            const messages = await prisma.externalMessage.findMany({
                where: { externalConversationId: row.id },
                orderBy: { ordinal: "asc" },
                select: {
                    role: true,
                    ordinal: true,
                    content: true,
                    contentDigest: true,
                    originalContentDigest: true,
                    sourceModelLabel: true,
                    sourceTimestamp: true,
                    truncated: true,
                    originalCharacterCount: true,
                    retainedCharacterCount: true,
                },
            });
            yield {
                provider: row.provider,
                title: row.title,
                externalStableId: row.externalStableId,
                conversationDigest: row.conversationDigest,
                digestVersion: row.digestVersion,
                sourceModelLabels: Array.isArray(row.sourceModelLabels)
                    ? (row.sourceModelLabels as string[])
                    : [],
                sourceCreatedAt: row.sourceCreatedAt?.toISOString() ?? null,
                sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
                importedAt: row.importedAt.toISOString(),
                messages: messages.map((message) => ({
                    role: message.role,
                    ordinal: message.ordinal,
                    content: message.content,
                    contentDigest: message.contentDigest,
                    originalContentDigest: message.originalContentDigest,
                    sourceModelLabel: message.sourceModelLabel,
                    sourceTimestamp:
                        message.sourceTimestamp?.toISOString() ?? null,
                    truncated: message.truncated,
                    originalCharacterCount: message.originalCharacterCount,
                    retainedCharacterCount: message.retainedCharacterCount,
                })),
            };
        }
        const last = rows[rows.length - 1];
        cursor = { importedAt: last.importedAt, id: last.id };
    }
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
            // Both open statuses expire on the same clocks: sealing an import
            // does not extend its life (§5.5).
            status: { in: [...OPEN_IMPORT_STATUSES] },
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
