import "server-only";

import type { Prisma } from "@prisma/client";
import type { ExtractionDecision } from "@/lib/memoryExtractionPipeline";
import {
    MEMORY_RETRIEVAL_VERSION,
    memoryRetrievalTerms,
} from "@/lib/memoryRetrievalTerms";
import { memoryStatementKey } from "@/lib/memoryValidatorCore";

/**
 * The storage step of an extraction chunk (policy §8.3, §8.4, §11).
 *
 * `analyzeExtractionChunk()` decides what each candidate is; this decides what
 * the database ends up holding. The two are split because the analysis is a
 * pure function of the provider's answer and this is not: it runs inside the
 * chunk's transaction, it is idempotent, and it is the only place an
 * extraction-produced row is created.
 *
 * Three rules it exists to enforce.
 *
 * **A discarded candidate is not stored at all.** §8.4 is explicit: a
 * credential or an injection payload does not become safer by being kept for
 * review. `outcome: "discard"` writes nothing, so there is no row for a later
 * bug to resurrect and no evidence row pointing at the message it came from.
 *
 * **A retried chunk replaces its own rows.** A worker can die after the
 * provider answered and before the transaction committed, and §11's bounded
 * retry then re-runs that chunk. Without a key scoped to (run, chunk) the
 * second attempt adds a second copy of every candidate the first one stored,
 * and the user reviews the same statement twice with two evidence rows citing
 * the same message. The delete below is scoped to this chunk and to rows the
 * user has not touched -- an item they already approved or edited is theirs,
 * not the run's, and a retry must never take it back.
 *
 * **Nothing here is active.** Extraction proposes; only a human approves
 * (§8.1). Candidates land in `candidate`, demoted ones in
 * `manual_review_required`, and `approvedAt` stays null in both cases. The
 * conflict key is computed but not asserted: §8.3 resolves conflicts at
 * approval, where the user chooses, rather than by refusing to record a
 * proposal.
 */
export type PersistExtractionChunkInput = {
    userId: string;
    runId: string;
    chunkIndex: number;
    extractionModelId: string;
    promptVersion: string;
    decisions: readonly ExtractionDecision[];
    now?: Date;
};

export type PersistExtractionChunkResult = {
    /** Rows written by this attempt. */
    stored: number;
    /** Of those, the ones needing individual review. */
    individualReview: number;
    /** Candidates the validator rejected outright, which are never stored. */
    discarded: number;
    /** Rows from a previous attempt at this chunk that were replaced. */
    replaced: number;
};

const statusFor = (outcome: ExtractionDecision["outcome"]) =>
    outcome === "store_candidate" ? "candidate" : "manual_review_required";

export async function persistExtractionChunkDecisions(
    tx: Prisma.TransactionClient,
    input: PersistExtractionChunkInput
): Promise<PersistExtractionChunkResult> {
    const now = input.now ?? new Date();

    // Serialize this account's memory writes for the same reason every other
    // path does: conflict keys and the replace below both read rows they are
    // about to write.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"memory-items:" + input.userId}))`;

    // Only this chunk's own untouched proposals. `userEdited` and an approval
    // are both signals the row stopped being the run's to manage.
    const previous = await tx.memoryItem.deleteMany({
        where: {
            userId: input.userId,
            extractionRunId: input.runId,
            extractionChunkIndex: input.chunkIndex,
            status: { in: ["candidate", "manual_review_required"] },
            userEdited: false,
            approvedAt: null,
        },
    });

    const keep = input.decisions.filter(
        (decision) => decision.outcome !== "discard"
    );

    let individualReview = 0;
    for (const decision of keep) {
        const status = statusFor(decision.outcome);
        if (status === "manual_review_required") individualReview += 1;

        const statement = decision.candidate.statement;
        const item = await tx.memoryItem.create({
            data: {
                userId: input.userId,
                kind: decision.candidate.kind,
                statement,
                status,
                // The validator's disposition, not the model's claim: a
                // candidate that says "standard" about a sensitive statement
                // must not be able to opt itself out of individual review.
                sensitivity: decision.validation.sensitivity,
                confidence: decision.candidate.confidence,
                conflictKey: `${decision.candidate.kind}:${memoryStatementKey(statement)}`,
                userEdited: false,
                expiresAt: decision.candidate.expiresAt
                    ? new Date(decision.candidate.expiresAt)
                    : null,
                // Indexed at write time, never lazily at read time: a row that
                // is only indexed when something searches for it is a row that
                // is missing from the first search (§9).
                searchTerms: memoryRetrievalTerms(statement),
                retrievalVersion: MEMORY_RETRIEVAL_VERSION,
                extractionModelId: input.extractionModelId,
                promptVersion: input.promptVersion,
                extractionRunId: input.runId,
                extractionChunkIndex: input.chunkIndex,
                createdAt: now,
            },
            select: { id: true },
        });

        if (decision.candidate.evidence.length > 0) {
            await tx.memoryEvidence.createMany({
                data: decision.candidate.evidence.map((reference) => ({
                    memoryItemId: item.id,
                    userId: input.userId,
                    sourceType: "external_message",
                    externalMessageId: reference.externalMessageId,
                    // The server's own digest of the stored message, carried
                    // through from the label map. A digest the model supplied
                    // would attest to nothing.
                    evidenceDigest: reference.evidenceDigest,
                    createdAt: now,
                })),
            });
        }
    }

    return {
        stored: keep.length,
        individualReview,
        discarded: input.decisions.length - keep.length,
        replaced: previous.count,
    };
}
