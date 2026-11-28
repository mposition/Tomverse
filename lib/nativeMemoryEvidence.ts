import "server-only";

import type { Prisma } from "@prisma/client";
import { resolveConversationMemoryMode } from "@/lib/conversationMemoryMode";
import { externalContentDigest } from "@/lib/externalImportDigest";
import { prisma } from "@/lib/prisma";
import { chatExtractionAllowed } from "@/lib/projectWorkspaceCore";

/**
 * Evidence on Tomverse (native) messages, for project memory and for memory
 * extracted from ordinary Chat conversations (`projectId` null).
 *
 * A native message has no stored content digest, so the digest is computed
 * from the server's own copy with the same canonicalization imported content
 * uses; `evidenceDigest` means one thing across every source type. Verification
 * is at the write: the message must still exist, belong to this account, sit in
 * a conversation of the run's project that is not locked, and say what it said
 * when it was read.
 */

export const nativeMessageDigest = (content: string) => externalContentDigest(content);

export type NativeEvidenceRef = { externalMessageId: string; evidenceDigest: string };

export async function verifyNativeMessageEvidence(
    userId: string,
    projectId: string | null,
    refs: readonly NativeEvidenceRef[],
    client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<Array<{ messageId: string; outcome: "verified" | "not_found" | "digest_mismatch" | "out_of_scope"; role: "user" | "assistant" | null }>> {
    if (refs.length === 0) return [];
    const rows = await client.message.findMany({
        where: { id: { in: refs.map((ref) => ref.externalMessageId) } },
        select: {
            id: true,
            role: true,
            content: true,
            conversation: { select: { userId: true, projectId: true, password: true, temporaryExpiresAt: true } },
        },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return refs.map((ref) => {
        const row = byId.get(ref.externalMessageId);
        if (!row || row.conversation.userId !== userId) {
            return { messageId: ref.externalMessageId, outcome: "not_found" as const, role: null };
        }
        const role = row.role === "user" || row.role === "assistant" ? row.role : null;
        if (
            row.conversation.projectId !== projectId ||
            row.conversation.password !== null ||
            row.conversation.temporaryExpiresAt !== null
        ) {
            return { messageId: ref.externalMessageId, outcome: "out_of_scope" as const, role };
        }
        if (nativeMessageDigest(row.content) !== ref.evidenceDigest) {
            return { messageId: ref.externalMessageId, outcome: "digest_mismatch" as const, role };
        }
        return { messageId: ref.externalMessageId, outcome: "verified" as const, role };
    });
}

/**
 * The state-dependent half of "may this ordinary Chat conversation feed
 * memory": read once, here, for the enqueue, the worker's read and the commit,
 * so the three cannot drift. The operator switch is the enqueuer's concern
 * (`operatorEnabled`); the other two callers pass true and judge data only.
 */
export async function readChatExtractionGate(
    client: Prisma.TransactionClient | typeof prisma,
    input: { userId: string; conversationId: string; operatorEnabled: boolean }
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const [settings, conversation] = await Promise.all([
        client.userMemorySettings.findUnique({
            where: { userId: input.userId },
            select: { masterEnabled: true, defaultConversationMode: true },
        }),
        client.conversation.findFirst({
            where: { id: input.conversationId, userId: input.userId },
            select: {
                password: true,
                projectId: true,
                memoryMode: true,
                kind: true,
                productKey: true,
                temporaryExpiresAt: true,
                assistantProfileVersion: { select: { memoryPolicy: true } },
                continuationBridge: { select: { id: true } },
            },
        }),
    ]);
    if (!conversation) return { allowed: false, reason: "not_found" };
    const policy = conversation.assistantProfileVersion?.memoryPolicy;
    return chatExtractionAllowed({
        operatorEnabled: input.operatorEnabled,
        accountMemoryEnabled: settings?.masterEnabled ?? true,
        conversationMemoryOn:
            resolveConversationMemoryMode(conversation.memoryMode, settings?.defaultConversationMode ?? "on") === "on",
        conversationLocked: conversation.password !== null,
        temporary: conversation.temporaryExpiresAt !== null,
        inProject: conversation.projectId !== null,
        kind: conversation.kind,
        productKey: conversation.productKey,
        // A profile whose policy cannot be read is treated as "off": narrowing is the safe direction.
        profileUsesAccountMemory: conversation.assistantProfileVersion
            ? Boolean(policy && typeof policy === "object" && !Array.isArray(policy) &&
                  (policy as { useAccountMemory?: unknown }).useAccountMemory === true)
            : null,
        continuedFromImport: conversation.continuationBridge !== null,
    });
}
