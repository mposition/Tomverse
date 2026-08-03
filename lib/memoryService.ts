import "server-only";

import type { Prisma } from "@prisma/client";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { manualEvidenceDigest } from "@/lib/memoryEvidenceValidation";
import {
    memoryStatementKey,
    validateMemoryCandidate,
    type MemoryEvidenceInput,
    type MemoryValidationResult,
} from "@/lib/memoryValidatorCore";
import { prisma } from "@/lib/prisma";

/**
 * Memory CRUD and review (Release B, slice B3).
 *
 * docs/policy/external-conversation-import-and-memory.md §8, §21.
 *
 * Every mutation re-runs the deterministic validator over what is actually
 * stored — never over what a client or an extraction model claimed. Human
 * review can approve a *demoted* candidate (that is what individual review
 * is for), but it can never approve one the validator hard-rejects: a
 * credential or an injection payload does not become safe because someone
 * clicked approve (§8.4).
 */

const REVIEWABLE_STATUSES = ["candidate", "manual_review_required"] as const;

const acquireUserMemoryLock = (
    tx: Prisma.TransactionClient,
    userId: string
) =>
    tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"memory-items:" + userId}))`;

type StoredEvidence = {
    id: string;
    sourceType: string;
    manualContent: string | null;
    externalMessage: {
        role: string;
        externalConversationId: string;
    } | null;
};

const evidenceInputs = (
    evidences: readonly StoredEvidence[]
): MemoryEvidenceInput[] =>
    evidences.map((evidence) => ({
        sourceType:
            evidence.sourceType as MemoryEvidenceInput["sourceType"],
        role:
            evidence.externalMessage?.role === "user" ||
            evidence.externalMessage?.role === "assistant"
                ? evidence.externalMessage.role
                : null,
    }));

const assertNotHardRejected = (result: MemoryValidationResult) => {
    if (result.disposition === "rejected") {
        // The violation codes are state names from the validator, safe to
        // return; the statement itself is never echoed into an error.
        throw new ApiSecurityError(
            422,
            "MEMORY_VALIDATION_FAILED",
            `Validation failed: ${result.violations.join(", ")}`
        );
    }
};

async function loadOwnedMemory(userId: string, memoryId: string) {
    const item = await prisma.memoryItem.findUnique({
        where: { id: memoryId },
        include: {
            evidences: {
                select: {
                    id: true,
                    sourceType: true,
                    manualContent: true,
                    externalMessage: {
                        select: { role: true, externalConversationId: true },
                    },
                },
            },
        },
    });
    if (!item || item.userId !== userId) {
        throw new ApiSecurityError(404, "NOT_FOUND", "Memory not found.");
    }
    return item;
}

const serializeMemory = (
    item: Awaited<ReturnType<typeof loadOwnedMemory>>
) => ({
    id: item.id,
    kind: item.kind,
    statement: item.statement,
    status: item.status,
    sensitivity: item.sensitivity,
    confidence: item.confidence,
    importance: item.importance,
    pinned: item.pinned,
    conflictKey: item.conflictKey,
    revision: item.revision,
    userEdited: item.userEdited,
    expiresAt: item.expiresAt?.toISOString() ?? null,
    suspendedReason: item.suspendedReason,
    extractionModelId: item.extractionModelId,
    promptVersion: item.promptVersion,
    createdAt: item.createdAt.toISOString(),
    approvedAt: item.approvedAt?.toISOString() ?? null,
    evidence: item.evidences.map((evidence) => ({
        id: evidence.id,
        sourceType: evidence.sourceType,
        manualContent: evidence.manualContent,
        externalConversationId:
            evidence.externalMessage?.externalConversationId ?? null,
    })),
});

export type SerializedMemory = ReturnType<typeof serializeMemory>;

export async function listMemories(
    userId: string,
    {
        status,
        kind,
        offset = 0,
        limit = 50,
    }: { status?: string; kind?: string; offset?: number; limit?: number } = {}
) {
    const where: Prisma.MemoryItemWhereInput = {
        userId,
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
    };
    const [total, items] = await Promise.all([
        prisma.memoryItem.count({ where }),
        prisma.memoryItem.findMany({
            where,
            orderBy: [{ pinned: "desc" }, { createdAt: "desc" }, { id: "desc" }],
            skip: offset,
            take: limit,
            include: {
                evidences: {
                    select: {
                        id: true,
                        sourceType: true,
                        manualContent: true,
                        externalMessage: {
                            select: {
                                role: true,
                                externalConversationId: true,
                            },
                        },
                    },
                },
            },
        }),
    ]);
    return {
        total,
        offset,
        limit,
        memories: items.map(serializeMemory),
    };
}

/**
 * Blocks activation when another *active* item holds the same conflict key
 * (§8.3): values in one group are never auto-overwritten. The caller may
 * resolve by superseding the existing item, which happens in the same
 * transaction as the activation.
 */
async function assertNoActiveConflict(
    tx: Prisma.TransactionClient,
    userId: string,
    conflictKey: string | null,
    excludeId: string | null,
    resolveConflict: "supersede_existing" | undefined
) {
    if (!conflictKey) return;
    const conflicting = await tx.memoryItem.findFirst({
        where: {
            userId,
            conflictKey,
            status: "active",
            ...(excludeId ? { id: { not: excludeId } } : {}),
        },
        select: { id: true },
    });
    if (!conflicting) return;
    if (resolveConflict === "supersede_existing") {
        await tx.memoryItem.update({
            where: { id: conflicting.id },
            data: { status: "superseded" },
        });
        return;
    }
    throw new ApiSecurityError(
        409,
        "MEMORY_ITEM_CONFLICT",
        "Another active memory holds the same key."
    );
}

/**
 * User-authored memory (§21 POST /api/memories). The author's intent *is*
 * the approval, so an accepted statement activates immediately; anything the
 * validator would park for review is returned to the author to rewrite
 * instead of being stored in a state they would immediately re-approve.
 */
export async function createManualMemory(input: {
    userId: string;
    kind: string;
    statement: string;
    sensitivity?: "standard" | "sensitive";
    expiresAt?: string | null;
    groundsText: string;
    resolveConflict?: "supersede_existing";
}) {
    const statement = input.statement.normalize("NFC").trim();
    const grounds = input.groundsText.normalize("NFC").trim();
    if (grounds.length === 0 || grounds.length > 2_000) {
        throw new ApiSecurityError(
            422,
            "MEMORY_VALIDATION_FAILED",
            "Validation failed: MEMORY_EVIDENCE_REQUIRED"
        );
    }
    const result = validateMemoryCandidate({
        kind: input.kind,
        statement,
        confidence: 1,
        sensitivity: input.sensitivity,
        expiresAt: input.expiresAt ?? null,
        evidence: [{ sourceType: "manual" }],
    });
    assertNotHardRejected(result);
    if (result.disposition === "manual_review_required") {
        // Self-review is meaningless — send it back for a declarative rewrite.
        throw new ApiSecurityError(
            422,
            "MEMORY_VALIDATION_FAILED",
            `Validation failed: ${result.violations.join(", ")}`
        );
    }

    const conflictKey = `${input.kind}:${memoryStatementKey(statement)}`;
    return prisma.$transaction(async (tx) => {
        await acquireUserMemoryLock(tx, input.userId);
        await assertNoActiveConflict(
            tx,
            input.userId,
            conflictKey,
            null,
            input.resolveConflict
        );
        const item = await tx.memoryItem.create({
            data: {
                userId: input.userId,
                kind: input.kind,
                statement,
                status: "active",
                sensitivity: result.sensitivity,
                confidence: 1,
                conflictKey,
                userEdited: true,
                expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
                approvedAt: new Date(),
            },
        });
        await tx.memoryEvidence.create({
            data: {
                memoryItemId: item.id,
                userId: input.userId,
                sourceType: "manual",
                manualContent: grounds,
                evidenceDigest: manualEvidenceDigest(grounds),
            },
        });
        return item.id;
    });
}

export async function approveMemory(input: {
    userId: string;
    memoryId: string;
    resolveConflict?: "supersede_existing";
}) {
    const item = await loadOwnedMemory(input.userId, input.memoryId);
    if (!(REVIEWABLE_STATUSES as readonly string[]).includes(item.status)) {
        throw new ApiSecurityError(
            409,
            "MEMORY_ITEM_STATE",
            "The memory is not awaiting review."
        );
    }
    // Re-validate what is stored. A demoted disposition is approvable — that
    // is what this individual review is — but a hard reject never is.
    const result = validateMemoryCandidate({
        kind: item.kind,
        statement: item.statement,
        confidence: item.confidence,
        sensitivity: item.sensitivity as "standard" | "sensitive",
        expiresAt: item.expiresAt?.toISOString() ?? null,
        evidence: evidenceInputs(item.evidences),
    });
    assertNotHardRejected(result);

    await prisma.$transaction(async (tx) => {
        await acquireUserMemoryLock(tx, input.userId);
        await assertNoActiveConflict(
            tx,
            input.userId,
            item.conflictKey,
            item.id,
            input.resolveConflict
        );
        const updated = await tx.memoryItem.updateMany({
            where: {
                id: item.id,
                status: { in: [...REVIEWABLE_STATUSES] },
            },
            data: {
                status: "active",
                sensitivity: result.sensitivity,
                approvedAt: new Date(),
            },
        });
        if (updated.count !== 1) {
            throw new ApiSecurityError(
                409,
                "MEMORY_ITEM_STATE",
                "The memory changed during review."
            );
        }
    });
}

export async function rejectMemory(userId: string, memoryId: string) {
    const item = await loadOwnedMemory(userId, memoryId);
    if (!(REVIEWABLE_STATUSES as readonly string[]).includes(item.status)) {
        throw new ApiSecurityError(
            409,
            "MEMORY_ITEM_STATE",
            "The memory is not awaiting review."
        );
    }
    await prisma.memoryItem.updateMany({
        where: { id: item.id, status: { in: [...REVIEWABLE_STATUSES] } },
        data: { status: "rejected" },
    });
}

/**
 * Edit re-validates and bumps the revision (§8.3). An edited active memory
 * stays active only when the edit is cleanly accepted; a demoted result
 * parks it back in review rather than leaving a flagged statement live.
 */
export async function editMemory(input: {
    userId: string;
    memoryId: string;
    statement?: string;
    expiresAt?: string | null;
    sensitivity?: "standard" | "sensitive";
}) {
    const item = await loadOwnedMemory(input.userId, input.memoryId);
    if (
        item.status !== "active" &&
        !(REVIEWABLE_STATUSES as readonly string[]).includes(item.status)
    ) {
        throw new ApiSecurityError(
            409,
            "MEMORY_ITEM_STATE",
            "The memory cannot be edited in its current state."
        );
    }
    const statement = (input.statement ?? item.statement)
        .normalize("NFC")
        .trim();
    const expiresAt =
        input.expiresAt === undefined
            ? (item.expiresAt?.toISOString() ?? null)
            : input.expiresAt;
    const result = validateMemoryCandidate({
        kind: item.kind,
        statement,
        confidence: item.confidence,
        sensitivity: input.sensitivity ?? (item.sensitivity as "standard"),
        expiresAt,
        evidence: evidenceInputs(item.evidences),
    });
    assertNotHardRejected(result);

    const stayActive =
        item.status === "active" && result.disposition === "accepted";
    await prisma.memoryItem.update({
        where: { id: item.id },
        data: {
            statement,
            sensitivity: result.sensitivity,
            expiresAt: expiresAt ? new Date(expiresAt) : null,
            revision: { increment: 1 },
            userEdited: true,
            conflictKey: `${item.kind}:${memoryStatementKey(statement)}`,
            ...(stayActive
                ? {}
                : item.status === "active"
                  ? { status: "manual_review_required", approvedAt: null }
                  : {}),
        },
    });
}

export async function setMemoryPinned(
    userId: string,
    memoryId: string,
    pinned: boolean
) {
    const item = await loadOwnedMemory(userId, memoryId);
    if (item.status !== "active") {
        throw new ApiSecurityError(
            409,
            "MEMORY_ITEM_STATE",
            "Only active memories can be pinned."
        );
    }
    await prisma.memoryItem.update({
        where: { id: item.id },
        data: { pinned },
    });
}

/** Hard delete: the row and its evidence go together (§13.1 user delete). */
export async function deleteMemory(userId: string, memoryId: string) {
    const item = await loadOwnedMemory(userId, memoryId);
    await prisma.memoryItem.delete({ where: { id: item.id } });
    return { outcome: "deleted" as const };
}

/**
 * §8.4 bulk approval: standard-sensitivity candidates whose stored content
 * re-validates as cleanly accepted AND bulk-safe. Demoted, sensitive and
 * conflicting candidates are skipped — individually reviewable, never
 * silently included.
 */
export async function bulkApproveMemories(userId: string) {
    const candidates = await prisma.memoryItem.findMany({
        where: { userId, status: "candidate", sensitivity: "standard" },
        include: {
            evidences: {
                select: {
                    id: true,
                    sourceType: true,
                    manualContent: true,
                    externalMessage: {
                        select: { role: true, externalConversationId: true },
                    },
                },
            },
        },
        orderBy: { createdAt: "asc" },
    });

    let approved = 0;
    let skipped = 0;
    for (const item of candidates) {
        const result = validateMemoryCandidate({
            kind: item.kind,
            statement: item.statement,
            confidence: item.confidence,
            sensitivity: "standard",
            expiresAt: item.expiresAt?.toISOString() ?? null,
            evidence: evidenceInputs(item.evidences),
        });
        if (result.disposition !== "accepted" || !result.bulkSafe) {
            skipped += 1;
            continue;
        }
        try {
            await prisma.$transaction(async (tx) => {
                await acquireUserMemoryLock(tx, userId);
                await assertNoActiveConflict(
                    tx,
                    userId,
                    item.conflictKey,
                    item.id,
                    undefined
                );
                await tx.memoryItem.updateMany({
                    where: { id: item.id, status: "candidate" },
                    data: { status: "active", approvedAt: new Date() },
                });
            });
            approved += 1;
        } catch (error) {
            if (
                error instanceof ApiSecurityError &&
                error.code === "MEMORY_ITEM_CONFLICT"
            ) {
                skipped += 1;
                continue;
            }
            throw error;
        }
    }
    return { approved, skipped };
}

export async function getMemorySettings(userId: string) {
    const settings = await prisma.userMemorySettings.findUnique({
        where: { userId },
    });
    return {
        masterEnabled: settings?.masterEnabled ?? true,
        styleEnabled: settings?.styleEnabled ?? true,
        defaultConversationMode: settings?.defaultConversationMode ?? "on",
    };
}

export async function putMemorySettings(
    userId: string,
    input: {
        masterEnabled: boolean;
        styleEnabled: boolean;
        defaultConversationMode: "on" | "off";
    }
) {
    await prisma.userMemorySettings.upsert({
        where: { userId },
        create: { userId, ...input },
        update: input,
    });
    return getMemorySettings(userId);
}
