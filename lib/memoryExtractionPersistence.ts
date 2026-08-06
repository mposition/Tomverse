import "server-only";

import type { Prisma } from "@prisma/client";
import { verifyExternalMessageEvidence } from "@/lib/memoryEvidenceValidation";
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
 *
 * **Evidence is re-verified here, not only at analysis time.** The label map
 * the analysis used was built when the chunk was claimed; the provider call
 * happens after that, and a slice runs several chunks. A user who deletes the
 * imported conversation in between leaves candidates citing messages that no
 * longer exist — and because §8.4 requires existence, ownership and a matching
 * content digest to be established by the server, the check belongs at the
 * write rather than at the read that preceded it. Without it the evidence
 * insert fails its foreign key and takes the whole chunk down with an opaque
 * database error, so a user tidying up their imports turns a running
 * extraction into a failing one.
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
    /**
     * Candidates dropped because none of their evidence survived §8.4's
     * re-verification — the source was deleted, or its content digest moved.
     * Distinct from `discarded`, which is the validator judging the statement:
     * these candidates may well have been fine, and there is simply nothing
     * left to ground them in.
     */
    unsourced: number;
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

    // One query for the whole chunk rather than one per candidate: the same
    // message is normally cited by several of them, and the answer depends on
    // the (id, digest) pair alone, so a shared set answers all of them.
    const refKey = (reference: {
        externalMessageId: string;
        evidenceDigest: string;
    }) => `${reference.externalMessageId} ${reference.evidenceDigest}`;
    const refs = [
        ...new Map(
            keep
                .flatMap((decision) => decision.candidate.evidence)
                .map((reference) => [
                    refKey(reference),
                    {
                        externalMessageId: reference.externalMessageId,
                        evidenceDigest: reference.evidenceDigest,
                    },
                ])
        ).values(),
    ];
    const outcomes = await verifyExternalMessageEvidence(input.userId, refs, tx);
    // Keyed by the pair rather than by the id: a digest mismatch and a missing
    // message are different outcomes, and a set of ids alone could not carry
    // the difference.
    const verified = new Set(
        refs
            .filter((_, index) => outcomes[index]?.outcome === "verified")
            .map(refKey)
    );

    let individualReview = 0;
    let stored = 0;
    let unsourced = 0;
    for (const decision of keep) {
        // A candidate keeps the references that still verify. Losing one of
        // several is not a reason to drop the rest: the statement is still
        // grounded in what remains.
        const evidence = decision.candidate.evidence.filter((reference) =>
            verified.has(refKey(reference))
        );
        if (evidence.length === 0) {
            // §8.2 requires evidence, so an ungrounded candidate is not stored
            // at all rather than stored bare. Storing it and letting §13.1's
            // source-delete flow clean it up afterwards would be the same
            // outcome by a longer route -- and the evidence insert could not
            // have succeeded anyway.
            unsourced += 1;
            continue;
        }

        const status = statusFor(decision.outcome);
        if (status === "manual_review_required") individualReview += 1;
        stored += 1;

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

        await tx.memoryEvidence.createMany({
            data: evidence.map((reference) => ({
                memoryItemId: item.id,
                userId: input.userId,
                sourceType: "external_message",
                externalMessageId: reference.externalMessageId,
                // The server's own digest of the stored message, re-checked
                // against the row just above. A digest the model supplied
                // would attest to nothing.
                evidenceDigest: reference.evidenceDigest,
                createdAt: now,
            })),
        });
    }

    return {
        stored,
        individualReview,
        discarded: input.decisions.length - keep.length,
        unsourced,
        replaced: previous.count,
    };
}
