import "server-only";

import type { Prisma } from "@prisma/client";
import { externalContentDigest } from "@/lib/externalImportDigest";
import { prisma } from "@/lib/prisma";

/**
 * Evidence on Tomverse (native) messages, for project memory.
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
    projectId: string,
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
            conversation: { select: { userId: true, projectId: true, password: true } },
        },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return refs.map((ref) => {
        const row = byId.get(ref.externalMessageId);
        if (!row || row.conversation.userId !== userId) {
            return { messageId: ref.externalMessageId, outcome: "not_found" as const, role: null };
        }
        const role = row.role === "user" || row.role === "assistant" ? row.role : null;
        if (row.conversation.projectId !== projectId || row.conversation.password !== null) {
            return { messageId: ref.externalMessageId, outcome: "out_of_scope" as const, role };
        }
        if (nativeMessageDigest(row.content) !== ref.evidenceDigest) {
            return { messageId: ref.externalMessageId, outcome: "digest_mismatch" as const, role };
        }
        return { messageId: ref.externalMessageId, outcome: "verified" as const, role };
    });
}
