import "server-only";
import { memoryConflictKey } from "@/lib/memoryConflictCore";

import type { Prisma } from "@prisma/client";
import { verifyExternalMessageEvidence } from "@/lib/memoryEvidenceValidation";
import type { ExtractionDecision } from "@/lib/memoryExtractionPipeline";
import {
    MEMORY_RETRIEVAL_VERSION,
    memoryRetrievalTerms,
} from "@/lib/memoryRetrievalTerms";
import { lockAccountMemoryItems } from "@/lib/memoryItemLock";
import { activeMemoryConflicts } from "@/lib/memoryService";
import { memoryStatementKey } from "@/lib/memoryValidatorCore";

/**
 * The storage step of an extraction chunk
 * (docs/policy/external-conversation-import-and-memory.md §8.3, §8.4, §11).
 *
 * `analyzeExtractionChunk()` decides what each candidate is; this decides what
 * the database ends up holding. The two are split because the analysis is a
 * pure function of the provider's answer and this is not: it runs inside the
 * chunk's transaction, it is idempotent, and it is the only place an
 * extraction-produced row is created.
 *
 * **There is no review queue** (owner decision 2026-10-24). A candidate the
 * validator accepts as standard and bulk-safe becomes an active memory here;
 * everything else -- sensitive, needing a judgement, rejected outright -- is
 * not stored at all. A credential or an injection payload does not become
 * safer by being kept (§8.4), and neither does a candidate nobody will ever be
 * shown for review.
 *
 * **The newer statement wins a topic.** An active memory the candidate
 * contradicts or duplicates (same conflict key, or the same kind and
 * statement) is compared by when the conversations said it: a candidate whose
 * evidence is at least as recent supersedes the older memories, and one whose
 * evidence is older is not stored. A memory the user wrote or edited is never
 * superseded by extraction -- the user's own words outrank an imported
 * conversation -- and a duplicate of an active memory adds nothing.
 *
 * **A retried chunk replaces its own rows.** A worker can die after this
 * transaction commits and before the chunk is reported, and §11's bounded
 * retry then re-runs that chunk. The delete below is scoped to this chunk and
 * to rows the user has not touched, so a retry never adds a second copy and
 * never takes back a memory the user pinned or edited.
 *
 * **Evidence is re-verified here, not only at analysis time.** The label map
 * the analysis used was built when the chunk was claimed; the provider call
 * happens after that, and a slice runs several chunks. A user who deletes the
 * imported conversation in between leaves candidates citing messages that no
 * longer exist — and because §8.4 requires existence, ownership and a matching
 * content digest to be established by the server, the check belongs at the
 * write rather than at the read that preceded it. Without it the evidence
 * insert fails its foreign key and takes the whole chunk down with an opaque
 * database error.
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
    /** Memories this attempt made active. */
    stored: number;
    /** Older active memories those replaced on the same topic. */
    superseded: number;
    /**
     * Candidates not stored because they were sensitive or needed a
     * judgement. Without a review queue nobody would ever be shown them.
     */
    withheld: number;
    /** Candidates the validator rejected outright, which are never stored. */
    discarded: number;
    /**
     * Candidates dropped because none of their evidence survived §8.4's
     * re-verification — the source was deleted, or its content digest moved.
     */
    unsourced: number;
    /**
     * Candidates not stored because an active memory already says the same,
     * says something newer, or was written by the user.
     */
    outranked: number;
    /** Rows from a previous attempt at this chunk that were replaced. */
    replaced: number;
};

/** When the source conversations said each message, as epoch milliseconds. */
async function evidenceTimes(
    tx: Prisma.TransactionClient,
    userId: string,
    messageIds: readonly string[]
): Promise<Map<string, number>> {
    if (messageIds.length === 0) return new Map();
    const rows = await tx.externalMessage.findMany({
        where: { id: { in: [...new Set(messageIds)] }, userId },
        select: {
            id: true,
            sourceTimestamp: true,
            conversation: {
                select: {
                    sourceUpdatedAt: true,
                    sourceCreatedAt: true,
                    importedAt: true,
                },
            },
        },
    });
    return new Map(
        rows.map((row) => [
            row.id,
            (
                row.sourceTimestamp ??
                row.conversation.sourceUpdatedAt ??
                row.conversation.sourceCreatedAt ??
                row.conversation.importedAt
            ).getTime(),
        ])
    );
}

const newest = (ids: readonly string[], times: Map<string, number>) =>
    Math.max(-Infinity, ...ids.map((id) => times.get(id) ?? -Infinity));

/**
 * Whether the candidate may take its topic from the active memories it
 * conflicts with, superseding them. False when one of them is the user's own,
 * says the same thing already, or rests on newer evidence.
 */
async function candidateWinsTopic(
    tx: Prisma.TransactionClient,
    userId: string,
    candidate: { kind: string; statement: string; messageIds: string[] },
    conflicts: readonly { id: string; kind: string; statement: string }[]
): Promise<boolean> {
    const statementKey = memoryStatementKey(candidate.statement);
    if (
        conflicts.some(
            (row) =>
                row.kind === candidate.kind &&
                memoryStatementKey(row.statement) === statementKey
        )
    ) {
        return false;
    }
    const conflictIds = conflicts.map((row) => row.id);
    const userOwned = await tx.memoryItem.count({
        where: {
            id: { in: conflictIds },
            OR: [{ extractionRunId: null }, { userEdited: true }],
        },
    });
    if (userOwned > 0) return false;
    const cited = await tx.memoryEvidence.findMany({
        where: {
            memoryItemId: { in: conflictIds },
            externalMessageId: { not: null },
        },
        select: { externalMessageId: true },
    });
    const citedIds = cited.flatMap((row) =>
        row.externalMessageId ? [row.externalMessageId] : []
    );
    const times = await evidenceTimes(tx, userId, [
        ...candidate.messageIds,
        ...citedIds,
    ]);
    return newest(candidate.messageIds, times) >= newest(citedIds, times);
}

export async function persistExtractionChunkDecisions(
    tx: Prisma.TransactionClient,
    input: PersistExtractionChunkInput
): Promise<PersistExtractionChunkResult> {
    const now = input.now ?? new Date();

    // Serialize this account's memory writes for the same reason every other
    // path does: conflict checks and the replace below both read rows they are
    // about to write. An imported source deletion takes the same lock before it
    // classifies memories, so a memory committed here is either seen by that
    // classification or finds its evidence already gone (lib/memoryItemLock.ts).
    await lockAccountMemoryItems(tx, input.userId);

    // Only this chunk's own untouched rows. An edit and a pin are both signals
    // the row stopped being the run's to manage.
    const previous = await tx.memoryItem.deleteMany({
        where: {
            userId: input.userId,
            extractionRunId: input.runId,
            extractionChunkIndex: input.chunkIndex,
            userEdited: false,
            pinned: false,
        },
    });

    const keep = input.decisions.filter(
        (decision) =>
            decision.outcome === "store_candidate" && decision.validation.bulkSafe
    );
    const discarded = input.decisions.filter(
        (decision) => decision.outcome === "discard"
    ).length;

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

    let stored = 0;
    let superseded = 0;
    let unsourced = 0;
    let outranked = 0;
    for (const decision of keep) {
        // A candidate keeps the references that still verify. Losing one of
        // several is not a reason to drop the rest: the statement is still
        // grounded in what remains.
        const evidence = decision.candidate.evidence.filter((reference) =>
            verified.has(refKey(reference))
        );
        if (evidence.length === 0) {
            // §8.2 requires evidence, so an ungrounded candidate is not stored
            // at all rather than stored bare.
            unsourced += 1;
            continue;
        }

        const { kind, statement } = decision.candidate;
        const conflictKey = memoryConflictKey(
            kind,
            statement,
            decision.candidate.canonicalKey
        );
        const conflicts = await activeMemoryConflicts(tx, input.userId, {
            kind,
            statement,
            conflictKey,
        });
        if (conflicts.length > 0) {
            const wins = await candidateWinsTopic(
                tx,
                input.userId,
                {
                    kind,
                    statement,
                    messageIds: evidence.map((reference) => reference.externalMessageId),
                },
                conflicts
            );
            if (!wins) {
                outranked += 1;
                continue;
            }
            const replaced = await tx.memoryItem.updateMany({
                where: {
                    userId: input.userId,
                    id: { in: conflicts.map((row) => row.id) },
                    status: "active",
                },
                data: { status: "superseded", revision: { increment: 1 } },
            });
            superseded += replaced.count;
        }

        stored += 1;
        const item = await tx.memoryItem.create({
            data: {
                userId: input.userId,
                kind,
                statement,
                status: "active",
                approvedAt: now,
                // The validator's disposition, not the model's claim; only a
                // standard, bulk-safe candidate reaches this line.
                sensitivity: decision.validation.sensitivity,
                confidence: decision.candidate.confidence,
                conflictKey,
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
        superseded,
        withheld: input.decisions.length - keep.length - discarded,
        discarded,
        unsourced,
        outranked,
        replaced: previous.count,
    };
}
