import "server-only";

import { prisma } from "@/lib/prisma";
import { SAVED_PROMPT_LIMITS, type SavedPrompt } from "@/lib/savedPromptsCore";

/**
 * The account's saved prompts (prisma `SavedPrompt`). Every statement is
 * scoped by `userId`, so another account's id is simply "not found".
 * Deleting the account deletes them by cascade.
 */

export class SavedPromptLimitReached extends Error {
    constructor() {
        super(`An account can keep ${SAVED_PROMPT_LIMITS.count} saved prompts.`);
        this.name = "SavedPromptLimitReached";
    }
}

const SELECT = { id: true, title: true, body: true, updatedAt: true } as const;

const toPublic = (row: { id: string; title: string; body: string; updatedAt: Date }): SavedPrompt => ({
    id: row.id,
    title: row.title,
    body: row.body,
    updatedAt: row.updatedAt.toISOString(),
});

export async function listSavedPrompts(userId: string): Promise<SavedPrompt[]> {
    const rows = await prisma.savedPrompt.findMany({
        where: { userId },
        orderBy: [{ sortOrder: "desc" }, { id: "asc" }],
        take: SAVED_PROMPT_LIMITS.count,
        select: SELECT,
    });
    return rows.map(toPublic);
}

/**
 * The count is checked under a per-account advisory lock, so two saves at the
 * same moment cannot both take the last slot.
 */
export async function createSavedPrompt(userId: string, input: { title: string; body: string }): Promise<SavedPrompt> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`saved-prompts:${userId}`}))`;
        const [count, top] = await Promise.all([
            tx.savedPrompt.count({ where: { userId } }),
            tx.savedPrompt.findFirst({ where: { userId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } }),
        ]);
        if (count >= SAVED_PROMPT_LIMITS.count) throw new SavedPromptLimitReached();
        const row = await tx.savedPrompt.create({
            data: { userId, title: input.title, body: input.body, sortOrder: (top?.sortOrder ?? -1) + 1 },
            select: SELECT,
        });
        return toPublic(row);
    });
}

export async function updateSavedPrompt(
    userId: string,
    id: string,
    patch: { title?: string; body?: string }
): Promise<SavedPrompt | null> {
    const updated = await prisma.savedPrompt.updateMany({ where: { id, userId }, data: patch });
    if (updated.count === 0) return null;
    const row = await prisma.savedPrompt.findFirst({ where: { id, userId }, select: SELECT });
    return row ? toPublic(row) : null;
}

export async function deleteSavedPrompt(userId: string, id: string): Promise<boolean> {
    const deleted = await prisma.savedPrompt.deleteMany({ where: { id, userId } });
    return deleted.count > 0;
}
