import "server-only";

import type { Prisma } from "@prisma/client";
import { externalContentDigest } from "@/lib/externalImportDigest";
import { prisma } from "@/lib/prisma";

/**
 * DB-bound half of the §8.4 validator (Release B, slice B1): evidence
 * existence, ownership and content-digest re-verification. The pure checks
 * live in lib/memoryValidatorCore.ts; nothing here trusts an ID or a digest
 * a client (or an extraction model) merely claims.
 *
 * Used by the B2 extraction pipeline and the B3 review APIs; shipped with
 * the schema so the two halves of the validator land and get tested as one
 * contract.
 */

export type ExternalEvidenceRef = {
    externalMessageId: string;
    /** The digest the candidate claims for this source (§8.5). */
    evidenceDigest: string;
};

export type ExternalEvidenceVerification = {
    externalMessageId: string;
    outcome: "verified" | "not_found" | "digest_mismatch";
    /** Role of the verified source message, for the §8.2 user-role rule. */
    role: "user" | "assistant" | null;
};

/**
 * Verifies external-message evidence for one owner. A message that does not
 * exist and one owned by someone else are the same outcome — a cross-user
 * probe must not learn that an ID is real (the Release A convention).
 *
 * The digest comparison is against the message's stored `contentDigest`:
 * evidence pinned to content that has since changed identity (different
 * snapshot, different truncation) reads as a mismatch, never silently
 * re-attaches (§8.4 "content digest 일치").
 *
 * Takes a client so a caller inside a transaction verifies against the same
 * snapshot it is about to write in. Verifying on the global client and then
 * writing in a transaction would answer a question about a moment that has
 * already passed.
 */
export async function verifyExternalMessageEvidence(
    userId: string,
    refs: readonly ExternalEvidenceRef[],
    client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<ExternalEvidenceVerification[]> {
    if (refs.length === 0) return [];
    const rows = await client.externalMessage.findMany({
        where: {
            id: { in: refs.map((ref) => ref.externalMessageId) },
            userId,
        },
        select: { id: true, role: true, contentDigest: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return refs.map((ref) => {
        const row = byId.get(ref.externalMessageId);
        if (!row) {
            return {
                externalMessageId: ref.externalMessageId,
                outcome: "not_found" as const,
                role: null,
            };
        }
        const role = row.role === "user" || row.role === "assistant"
            ? row.role
            : null;
        if (row.contentDigest !== ref.evidenceDigest) {
            return {
                externalMessageId: ref.externalMessageId,
                outcome: "digest_mismatch" as const,
                role,
            };
        }
        return {
            externalMessageId: ref.externalMessageId,
            outcome: "verified" as const,
            role,
        };
    });
}

/**
 * Digest for manual evidence (§8.5 as amended): the user-entered grounds
 * text digested with the same canonicalization as imported content, so
 * `evidenceDigest` means one thing across every sourceType.
 */
export function manualEvidenceDigest(groundsText: string): string {
    return externalContentDigest(groundsText);
}
