import "server-only";

import type { Prisma } from "@prisma/client";
import { ApiSecurityError } from "@/lib/apiSecurity";
import { enqueueKnowledgeCleanupForFiles } from "@/lib/assistantKnowledgeLifecycle";
import { lockAccountMemoryItems } from "@/lib/memoryItemLock";
import { settleExtractionRunCredits } from "@/lib/memoryExtractionCredits";
import { lockCreditAccount } from "@/lib/creditDebt";
import { prisma } from "@/lib/prisma";
import {
    PROJECT_LIMITS,
    projectDeletionMatches,
    type ProjectDeletionSummary,
    type ProjectMemoryScope,
    type ProjectTurnScope,
} from "@/lib/projectWorkspaceCore";

/**
 * Project workspace, database half: settings with optimistic revision,
 * archive, explicit deletion and the source-membership bookkeeping that keeps
 * one project's memories out of every other context.
 */

type Client = Prisma.TransactionClient | typeof prisma;

const PROJECT_SELECT = {
    id: true,
    userId: true,
    name: true,
    description: true,
    instructions: true,
    contextEnabled: true,
    memoryScope: true,
    autoMemoryEnabled: true,
    revision: true,
    archivedAt: true,
    createdAt: true,
    updatedAt: true,
} as const;

type ProjectRow = Prisma.ConversationProjectGetPayload<{ select: typeof PROJECT_SELECT }>;

export const toProjectTurnScope = (row: ProjectRow): ProjectTurnScope => ({
    projectId: row.id,
    name: row.name,
    revision: row.revision,
    contextEnabled: row.contextEnabled,
    archived: row.archivedAt !== null,
    memoryScope: row.memoryScope === "project_and_personal" ? "project_and_personal" : "project_only",
    autoMemoryEnabled: row.autoMemoryEnabled,
    instructions: row.instructions,
});

const notFound = () => new ApiSecurityError(404, "PROJECT_NOT_FOUND", "Project not found.");

export async function loadOwnedProject(userId: string, projectId: string, client: Client = prisma) {
    const row = await client.conversationProject.findFirst({
        where: { id: projectId, userId },
        select: PROJECT_SELECT,
    });
    if (!row) throw notFound();
    return row;
}

/**
 * The project scope of a conversation, read from the server's own record.
 * A request never names the project its turn runs in.
 */
export async function resolveConversationProjectScope(
    userId: string,
    conversationId: string | null | undefined,
    client: Client = prisma
): Promise<ProjectTurnScope | null> {
    if (!conversationId) return null;
    const row = await client.conversation.findFirst({
        where: { id: conversationId, userId },
        select: { project: { select: PROJECT_SELECT } },
    });
    if (!row?.project || row.project.userId !== userId) return null;
    return toProjectTurnScope(row.project);
}

/** For a conversation that does not exist yet: the project the create call names. */
export async function resolveProjectScopeById(
    userId: string,
    projectId: string | null | undefined,
    client: Client = prisma
): Promise<ProjectTurnScope | null> {
    if (!projectId) return null;
    const row = await client.conversationProject.findFirst({ where: { id: projectId, userId }, select: PROJECT_SELECT });
    return row ? toProjectTurnScope(row) : null;
}

export async function projectCounts(userId: string, projectId: string, client: Client = prisma) {
    const [conversations, materials, memories, readyMaterials, failedMaterials] = await Promise.all([
        client.conversation.count({ where: { userId, projectId } }),
        client.assistantKnowledgeFile.count({ where: { userId, projectId } }),
        client.memoryItem.count({ where: { userId, projectId } }),
        client.assistantKnowledgeFile.count({ where: { userId, projectId, processingStatus: "ready" } }),
        client.assistantKnowledgeFile.count({ where: { userId, projectId, processingStatus: "failed" } }),
    ]);
    return { conversations, materials, memories, readyMaterials, failedMaterials };
}

export const serializeProject = (row: ProjectRow, counts?: { conversations: number; materials?: number; memories?: number }) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    contextEnabled: row.contextEnabled,
    memoryScope: row.memoryScope as ProjectMemoryScope,
    autoMemoryEnabled: row.autoMemoryEnabled,
    revision: row.revision,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    conversationCount: counts?.conversations ?? 0,
    materialCount: counts?.materials ?? 0,
    memoryCount: counts?.memories ?? 0,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
});

export type SerializedProject = ReturnType<typeof serializeProject>;

export async function listProjects(userId: string) {
    const rows = await prisma.conversationProject.findMany({
        where: { userId },
        orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
        select: {
            ...PROJECT_SELECT,
            _count: { select: { conversations: true, knowledgeFiles: true, memoryItems: true } },
        },
    });
    return rows.map((row) =>
        serializeProject(row, {
            conversations: row._count.conversations,
            materials: row._count.knowledgeFiles,
            memories: row._count.memoryItems,
        })
    );
}

export async function getProjectDetail(userId: string, projectId: string) {
    const row = await loadOwnedProject(userId, projectId);
    const counts = await projectCounts(userId, projectId);
    return { ...serializeProject(row, counts), readyMaterialCount: counts.readyMaterials, failedMaterialCount: counts.failedMaterials };
}

export type ProjectSettingsInput = {
    name?: string;
    description?: string;
    instructions?: string;
    contextEnabled?: boolean;
    memoryScope?: ProjectMemoryScope;
    autoMemoryEnabled?: boolean;
    archived?: boolean;
};

const assertSettingLengths = (input: ProjectSettingsInput) => {
    if (input.name !== undefined && (input.name.trim().length < 1 || input.name.trim().length > PROJECT_LIMITS.maxNameLength)) {
        throw new ApiSecurityError(422, "PROJECT_NAME_INVALID", "Project name must be 1-32 characters.");
    }
    if (input.description !== undefined && input.description.length > PROJECT_LIMITS.maxDescriptionLength) {
        throw new ApiSecurityError(422, "PROJECT_DESCRIPTION_TOO_LONG", "Description is too long.");
    }
    if (input.instructions !== undefined && input.instructions.length > PROJECT_LIMITS.maxInstructionsLength) {
        throw new ApiSecurityError(422, "PROJECT_INSTRUCTIONS_TOO_LONG", "Instructions are too long.");
    }
};

/**
 * A new workspace states its context choice explicitly. The folder-era create
 * call that sends only a name keeps creating a folder (context off).
 */
export async function createProject(userId: string, input: ProjectSettingsInput & { name: string }) {
    assertSettingLengths(input);
    const count = await prisma.conversationProject.count({ where: { userId } });
    if (count >= PROJECT_LIMITS.maxProjectsPerAccount) {
        throw new ApiSecurityError(409, "PROJECT_LIMIT_REACHED", "Project limit reached.");
    }
    try {
        const row = await prisma.conversationProject.create({
            data: {
                userId,
                name: input.name.trim(),
                description: input.description?.trim() ?? "",
                instructions: input.instructions ?? "",
                contextEnabled: input.contextEnabled ?? false,
                memoryScope: input.memoryScope ?? "project_only",
                autoMemoryEnabled: input.autoMemoryEnabled ?? false,
            },
            select: PROJECT_SELECT,
        });
        return serializeProject(row, { conversations: 0 });
    } catch (error) {
        if (isUniqueViolation(error)) throw new ApiSecurityError(409, "PROJECT_NAME_TAKEN", "A project with this name already exists.");
        throw error;
    }
}

const isUniqueViolation = (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002";

/**
 * Settings change. Anything beyond a rename needs `expectedRevision`, so two
 * tabs cannot silently overwrite each other's instructions. The folder-era
 * name-only PATCH keeps working without it.
 */
export async function updateProject(
    userId: string,
    projectId: string,
    input: ProjectSettingsInput & { expectedRevision?: number }
) {
    assertSettingLengths(input);
    const settingKeys = (["description", "instructions", "contextEnabled", "memoryScope", "autoMemoryEnabled", "archived"] as const)
        .filter((key) => input[key] !== undefined);
    if (settingKeys.length > 0 && input.expectedRevision === undefined) {
        throw new ApiSecurityError(428, "PROJECT_REVISION_REQUIRED", "expectedRevision is required to change project settings.");
    }
    const current = await loadOwnedProject(userId, projectId);
    if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
        throw new ApiSecurityError(409, "PROJECT_REVISION_CONFLICT", "The project changed. Reload and try again.");
    }
    const data: Prisma.ConversationProjectUpdateManyMutationInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.description !== undefined) data.description = input.description.trim();
    if (input.instructions !== undefined) data.instructions = input.instructions;
    if (input.contextEnabled !== undefined) data.contextEnabled = input.contextEnabled;
    if (input.memoryScope !== undefined) data.memoryScope = input.memoryScope;
    if (input.autoMemoryEnabled !== undefined) data.autoMemoryEnabled = input.autoMemoryEnabled;
    if (input.archived !== undefined) data.archivedAt = input.archived ? (current.archivedAt ?? new Date()) : null;
    data.revision = { increment: 1 };
    try {
        const updated = await prisma.conversationProject.updateMany({
            where: { id: projectId, userId, revision: current.revision },
            data,
        });
        if (updated.count !== 1) {
            throw new ApiSecurityError(409, "PROJECT_REVISION_CONFLICT", "The project changed. Reload and try again.");
        }
    } catch (error) {
        if (isUniqueViolation(error)) throw new ApiSecurityError(409, "PROJECT_NAME_TAKEN", "A project with this name already exists.");
        throw error;
    }
    if (input.archived === true || input.autoMemoryEnabled === false || input.contextEnabled === false) {
        // No new native extraction for an archived or switched-off project.
        await cancelNativeExtractionRuns({ userId, projectId });
    }
    return getProjectDetail(userId, projectId);
}

/** Cancels pending/running native extraction runs, refunding their reservations. */
export async function cancelNativeExtractionRuns(input: {
    userId: string;
    projectId?: string;
    conversationIds?: string[];
    tx?: Prisma.TransactionClient;
}) {
    const run = async (tx: Prisma.TransactionClient) => {
        await lockCreditAccount(tx, input.userId);
        const where: Prisma.MemoryExtractionRunWhereInput = {
            userId: input.userId,
            sourceKind: "native",
            status: { in: ["pending", "running"] },
            ...(input.projectId ? { projectId: input.projectId } : {}),
            ...(input.conversationIds ? { sourceConversationId: { in: input.conversationIds } } : {}),
        };
        const active = await tx.memoryExtractionRun.findMany({ where, select: { id: true }, orderBy: { id: "asc" } });
        if (active.length === 0) return 0;
        await tx.$queryRaw`SELECT id FROM "MemoryExtractionRun" WHERE id = ANY(${active.map((r) => r.id)}::text[]) ORDER BY id FOR UPDATE`;
        const cancelled = await tx.memoryExtractionRun.updateMany({
            where: { id: { in: active.map((r) => r.id) }, status: { in: ["pending", "running"] } },
            data: { status: "cancelled", leaseExpiresAt: null },
        });
        for (const { id } of active) {
            const completed = await tx.memoryExtractionChunk.count({ where: { runId: id, status: "completed" } });
            await settleExtractionRunCredits(tx, { runId: id, outcome: "cancelled", chunksCharged: completed });
        }
        return cancelled.count;
    };
    return input.tx ? run(input.tx) : prisma.$transaction(run);
}

export async function projectDeletionSummary(userId: string, projectId: string, client: Client = prisma): Promise<ProjectDeletionSummary> {
    const row = await loadOwnedProject(userId, projectId, client);
    const counts = await projectCounts(userId, projectId, client);
    return { conversations: counts.conversations, materials: counts.materials, memories: counts.memories, revision: row.revision };
}

/**
 * Deletes a project. Conversations are always kept and leave the project; the
 * project's own materials and memories are deleted. A project that holds any
 * material or memory is deleted only with a confirmation that echoes the
 * summary the user saw, so the folder-era bare DELETE can never take them.
 */
export async function deleteProject(
    userId: string,
    projectId: string,
    confirmation?: { revision: number; materials: number; memories: number }
) {
    const summary = await projectDeletionSummary(userId, projectId);
    const contextual = summary.materials > 0 || summary.memories > 0;
    if (contextual && !confirmation) {
        throw Object.assign(
            new ApiSecurityError(409, "PROJECT_DELETE_CONFIRMATION_REQUIRED", "This project holds materials or memories."),
            { details: summary }
        );
    }
    if (confirmation && !projectDeletionMatches(confirmation, summary)) {
        throw Object.assign(
            new ApiSecurityError(409, "PROJECT_DELETE_STALE", "The project changed while you were confirming."),
            { details: summary }
        );
    }
    return prisma.$transaction(async (tx) => {
        // Lock order: credit account (run cancel refunds), then the memory lock,
        // then the project row itself. FOR UPDATE conflicts with the KEY SHARE
        // lock every insert of a material or memory takes on its project
        // through the foreign key, so a material created concurrently either
        // committed before this lock (and is counted below) or waits and then
        // fails on the deleted row -- it is never deleted unconfirmed.
        await cancelNativeExtractionRuns({ userId, projectId, tx });
        await lockAccountMemoryItems(tx, userId);
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM "ConversationProject" WHERE id = ${projectId} AND "userId" = ${userId} FOR UPDATE
        `;
        if (locked.length === 0) throw notFound();
        const current = await projectDeletionSummary(userId, projectId, tx);
        if ((current.materials > 0 || current.memories > 0) && (!confirmation || !projectDeletionMatches(confirmation, current))) {
            // Re-checked under the locks: a material or memory added after the
            // first check is never deleted without being confirmed.
            throw Object.assign(
                new ApiSecurityError(409, "PROJECT_DELETE_STALE", "The project changed while you were confirming."),
                { details: current }
            );
        }
        await enqueueKnowledgeCleanupForFiles(tx, { userId, projectId }, "project_deleted");
        const materials = await tx.assistantKnowledgeFile.deleteMany({ where: { userId, projectId } });
        const memories = await tx.memoryItem.deleteMany({ where: { userId, projectId } });
        const conversations = await tx.conversation.updateMany({ where: { userId, projectId }, data: { projectId: null } });
        await tx.conversationProject.delete({ where: { id: projectId } });
        return {
            deleted: true as const,
            detachedConversations: conversations.count,
            deletedMaterials: materials.count,
            deletedMemories: memories.count,
        };
    });
}

// ----------------------------------------------------- source membership

export const NATIVE_SOURCE_LEFT_PROJECT = "native_source_left_project";
export const NATIVE_SOURCE_LOCKED = "native_source_locked";
export const NATIVE_SOURCE_DELETED = "native_source_deleted";

/**
 * Re-decides every project memory that cites native messages, after a
 * conversation moved, was locked or unlocked. A memory stays usable in its
 * project only while at least one of its grounds is still a user-reachable
 * message of a conversation in the same project (or a manual ground the user
 * wrote). Moving a conversation never widens where a memory is used.
 */
export async function reconcileNativeEvidence(
    tx: Prisma.TransactionClient,
    userId: string,
    projectIds: readonly (string | null)[],
    now = new Date()
) {
    const ids = [...new Set(projectIds.filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return { suspended: 0, restored: 0 };
    await lockAccountMemoryItems(tx, userId);
    const rows = await tx.memoryItem.findMany({
        where: {
            userId,
            projectId: { in: ids },
            status: { in: ["active", "suspended_by_source_lock", "suspended_by_source_delete"] },
            evidences: { some: { sourceType: "tomverse_message" } },
        },
        select: {
            id: true,
            status: true,
            projectId: true,
            expiresAt: true,
            suspendedReason: true,
            evidences: {
                select: {
                    sourceType: true,
                    tomverseMessage: { select: { conversation: { select: { userId: true, projectId: true, password: true } } } },
                },
            },
        },
    });
    let suspended = 0;
    let restored = 0;
    for (const row of rows) {
        const reachable = row.evidences.some((evidence) => {
            if (evidence.sourceType === "manual") return true;
            const conversation = evidence.tomverseMessage?.conversation;
            return Boolean(conversation && conversation.userId === userId && conversation.projectId === row.projectId && conversation.password === null);
        });
        const locked = row.evidences.some((evidence) => evidence.tomverseMessage?.conversation?.password != null);
        if (row.status === "active" && !reachable) {
            await tx.memoryItem.update({
                where: { id: row.id },
                data: locked
                    ? { status: "suspended_by_source_lock", suspendedReason: NATIVE_SOURCE_LOCKED, revision: { increment: 1 } }
                    : { status: "suspended_by_source_delete", suspendedReason: NATIVE_SOURCE_LEFT_PROJECT, revision: { increment: 1 } },
            });
            suspended += 1;
        } else if (
            row.status !== "active" && reachable &&
            (row.suspendedReason === NATIVE_SOURCE_LOCKED || row.suspendedReason === NATIVE_SOURCE_LEFT_PROJECT)
        ) {
            const expired = row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime();
            await tx.memoryItem.update({
                where: { id: row.id },
                data: expired
                    ? { status: "expired", suspendedReason: null, revision: { increment: 1 } }
                    : { status: "active", suspendedReason: null, revision: { increment: 1 } },
            });
            restored += 1;
        }
    }
    return { suspended, restored };
}

/**
 * Before conversations are deleted: a project memory whose only grounds are in
 * them is deleted when it was derived, and suspended when the user edited or
 * pinned it (the same split the external source deletion uses).
 */
export async function applyNativeSourceDeletion(
    tx: Prisma.TransactionClient,
    userId: string,
    conversationIds: readonly string[]
) {
    if (conversationIds.length === 0) return { deleted: 0, suspended: 0 };
    await cancelNativeExtractionRuns({ userId, conversationIds: [...conversationIds], tx });
    await lockAccountMemoryItems(tx, userId);
    const rows = await tx.memoryItem.findMany({
        where: {
            userId,
            evidences: { some: { tomverseMessage: { conversationId: { in: [...conversationIds] } } } },
        },
        select: {
            id: true,
            userEdited: true,
            pinned: true,
            evidences: { select: { sourceType: true, tomverseMessage: { select: { conversationId: true } } } },
        },
    });
    const doomed = new Set(conversationIds);
    let deleted = 0;
    let suspended = 0;
    for (const row of rows) {
        const survives = row.evidences.some((evidence) =>
            evidence.sourceType === "manual" ||
            (evidence.tomverseMessage && !doomed.has(evidence.tomverseMessage.conversationId))
        );
        if (survives) continue;
        if (row.userEdited || row.pinned) {
            await tx.memoryItem.update({
                where: { id: row.id },
                data: { status: "suspended_by_source_delete", suspendedReason: NATIVE_SOURCE_DELETED, revision: { increment: 1 } },
            });
            suspended += 1;
        } else {
            await tx.memoryItem.delete({ where: { id: row.id } });
            deleted += 1;
        }
    }
    return { deleted, suspended };
}

/**
 * Applies a conversation change that affects project memory grounds -- a
 * move between projects, a lock or an unlock -- in the same transaction as
 * the re-decision of every memory citing it, so no request can read a
 * memory grounded in a conversation that has already moved or been locked.
 * Lock order matches run creation: credit account, conversation row, runs,
 * then the memory lock.
 */
export async function updateConversationWithProjectGrounds<T>(input: {
    userId: string;
    conversationId: string;
    fromProjectId: string | null;
    update: (tx: Prisma.TransactionClient) => Promise<T & { projectId: string | null }>;
}): Promise<T & { projectId: string | null }> {
    return prisma.$transaction(async (tx) => {
        await lockCreditAccount(tx, input.userId);
        const updated = await input.update(tx);
        await cancelNativeExtractionRuns({ userId: input.userId, conversationIds: [input.conversationId], tx });
        await reconcileNativeEvidence(tx, input.userId, [input.fromProjectId, updated.projectId]);
        return updated;
    });
}

/**
 * A conversation changed project (or left one). Running native extraction for
 * it is cancelled, and every memory citing it is re-decided in both projects.
 */
export async function onConversationProjectChanged(input: {
    userId: string;
    conversationId: string;
    fromProjectId: string | null;
    toProjectId: string | null;
}) {
    if (input.fromProjectId === input.toProjectId) return;
    await prisma.$transaction(async (tx) => {
        await cancelNativeExtractionRuns({ userId: input.userId, conversationIds: [input.conversationId], tx });
        await reconcileNativeEvidence(tx, input.userId, [input.fromProjectId, input.toProjectId]);
    });
}

/** A conversation was locked or unlocked. */
export async function onConversationLockChanged(input: { userId: string; conversationId: string; projectId: string | null }) {
    if (!input.projectId) return;
    await prisma.$transaction(async (tx) => {
        await cancelNativeExtractionRuns({ userId: input.userId, conversationIds: [input.conversationId], tx });
        await reconcileNativeEvidence(tx, input.userId, [input.projectId]);
    });
}

/** Owner check for a conversation being added to a project; refuses archived targets. */
export async function assertProjectAcceptsConversations(userId: string, projectId: string, client: Client = prisma) {
    const row = await loadOwnedProject(userId, projectId, client);
    if (row.archivedAt) throw new ApiSecurityError(409, "PROJECT_ARCHIVED", "Restore the project before adding conversations.");
    return row;
}

/**
 * Before individual messages are deleted (a model's history is cleared): a
 * project memory left with no grounds outside them follows the same
 * delete-or-suspend split as a deleted conversation.
 */
export async function applyNativeMessageDeletion(
    tx: Prisma.TransactionClient,
    userId: string,
    messageIds: readonly string[]
) {
    if (messageIds.length === 0) return { deleted: 0, suspended: 0 };
    await lockAccountMemoryItems(tx, userId);
    const doomed = new Set(messageIds);
    const rows = await tx.memoryItem.findMany({
        where: { userId, evidences: { some: { tomverseMessageId: { in: [...messageIds] } } } },
        select: { id: true, userEdited: true, pinned: true, evidences: { select: { sourceType: true, tomverseMessageId: true } } },
    });
    let deleted = 0;
    let suspended = 0;
    for (const row of rows) {
        const survives = row.evidences.some((evidence) =>
            evidence.sourceType === "manual" || (evidence.tomverseMessageId !== null && !doomed.has(evidence.tomverseMessageId))
        );
        if (survives) continue;
        if (row.userEdited || row.pinned) {
            await tx.memoryItem.update({
                where: { id: row.id },
                data: { status: "suspended_by_source_delete", suspendedReason: NATIVE_SOURCE_DELETED, revision: { increment: 1 } },
            });
            suspended += 1;
        } else {
            await tx.memoryItem.delete({ where: { id: row.id } });
            deleted += 1;
        }
    }
    return { deleted, suspended };
}
