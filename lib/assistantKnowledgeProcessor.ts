import "server-only";

import type { Prisma } from "@prisma/client";

import {
    ASSISTANT_KNOWLEDGE_LIMITS,
    ASSISTANT_KNOWLEDGE_OFFICE_TYPES,
    ASSISTANT_KNOWLEDGE_TEXT_TYPES,
    ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE,
    knowledgeExtractedTextRefusal,
} from "@/lib/assistantKnowledgeLimits";
import { chunkKnowledgeText } from "@/lib/assistantKnowledgeChunking";
import { knowledgeUsage } from "@/lib/assistantKnowledgeService";
import { lockAccountKnowledgeQuota } from "@/lib/assistantProfileImportLocks";
import { extractPdfTextSafely } from "@/lib/mediaSecurity";
import { parseOfficeSafely } from "@/lib/officeSecurity";
import { prisma } from "@/lib/prisma";
import { readOwnR2ObjectBytes } from "@/lib/r2";

/**
 * Turning a stored knowledge file into retrievable chunks (Release C, C2).
 *
 * docs/policy/external-conversation-import-and-memory.md §14.
 *
 * Extraction reuses the hardened readers the chat attachment path already
 * uses: `extractPdfTextSafely` runs pdf.js in a resource-limited worker, and
 * `parseOfficeSafely` refuses zip bombs and path traversal before it reads a
 * single entry. Writing a second extraction stack for this would have meant a
 * second one to keep hardened, and the first one is where the work went.
 *
 * ## Claiming, and why the claim is conditional
 *
 * A file is claimed by moving it `pending -> processing` with the previous
 * status in the WHERE clause. Two workers racing on the same row both issue
 * the update; exactly one changes a row, and the other sees zero and moves on.
 * That is the whole concurrency control — there is no lease and no heartbeat,
 * because unlike a memory extraction run this is bounded work on bytes that
 * are already stored, so the recovery for a worker that died is to reset the
 * row and try again rather than to resume anything.
 *
 * ## What a failure is
 *
 * A file that cannot be read, holds no text, or would take the account past
 * its text budget is `failed` with a code — not deleted. The owner uploaded
 * it and is entitled to see what happened to it, and the bytes stay until they
 * delete the row, at which point the §14.2 tombstone takes them.
 */

/** The one place a processing failure reason is named. */
export const KNOWLEDGE_FAILURE_CODES = {
    unreadable: "ASSISTANT_KNOWLEDGE_UNREADABLE",
    noText: "ASSISTANT_KNOWLEDGE_NO_TEXT",
    unsupported: ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE,
    quota: "ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED",
} as const;

export type KnowledgeProcessResult = {
    fileId: string;
    outcome: "ready" | "failed" | "skipped";
    failureCode?: string;
    chunkCount?: number;
};

/**
 * The text of one file.
 *
 * Text types are decoded strictly: a `.txt` that is not UTF-8 is refused
 * rather than mangled into replacement characters, because a document full of
 * U+FFFD indexes as nonsense and retrieves as nothing, which reads to the
 * owner as the file having been ignored.
 */
const extractText = async (file: {
    mime: string;
    r2Key: string;
}): Promise<string> => {
    const bytes = await readOwnR2ObjectBytes(file.r2Key, {
        maxBytes: ASSISTANT_KNOWLEDGE_LIMITS.maxFileBytes,
    });

    if (ASSISTANT_KNOWLEDGE_TEXT_TYPES.has(file.mime)) {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
    if (file.mime === "application/pdf") {
        return extractPdfTextSafely(
            Buffer.from(bytes),
            ASSISTANT_KNOWLEDGE_LIMITS.maxExtractedCodePoints
        );
    }
    if (ASSISTANT_KNOWLEDGE_OFFICE_TYPES.has(file.mime)) {
        return parseOfficeSafely(
            Buffer.from(bytes),
            file.mime,
            ASSISTANT_KNOWLEDGE_LIMITS.maxExtractedCodePoints
        );
    }
    // Unreachable while the allowlist and this switch agree, which
    // `check:enum-constraints`-style vigilance does not cover -- so it throws
    // rather than returning "" and producing a file that is ready and empty.
    throw new Error(`no extractor for ${file.mime}`);
};

const markFailed = async (fileId: string, failureCode: string) => {
    await prisma.assistantKnowledgeFile.update({
        where: { id: fileId },
        data: {
            processingStatus: "failed",
            failureCode,
            chunkCount: 0,
            processedAt: new Date(),
        },
    });
};

/**
 * Processes one claimed file.
 *
 * The commit is a transaction over three writes that have to agree: the old
 * chunks go, the new ones arrive, and the file's counters and status move
 * together. A partial commit here would be the one state the CHECK constraints
 * exist to forbid — a `ready` file whose `chunkCount` does not match its rows.
 */
const processClaimedFile = async (file: {
    id: string;
    userId: string;
    profileId: string;
    mime: string;
    r2Key: string;
}): Promise<KnowledgeProcessResult> => {
    let text: string;
    try {
        text = await extractText(file);
    } catch {
        // Nothing about the file's contents is logged, and no parser message
        // reaches the owner -- a code and a sentence, as the guest attachment
        // path does it.
        await markFailed(file.id, KNOWLEDGE_FAILURE_CODES.unreadable);
        return {
            fileId: file.id,
            outcome: "failed",
            failureCode: KNOWLEDGE_FAILURE_CODES.unreadable,
        };
    }

    const chunks = chunkKnowledgeText(text);
    if (chunks.length === 0) {
        await markFailed(file.id, KNOWLEDGE_FAILURE_CODES.noText);
        return {
            fileId: file.id,
            outcome: "failed",
            failureCode: KNOWLEDGE_FAILURE_CODES.noText,
        };
    }

    const extractedCharacters = [...text].length;
    const extractedBytes = Buffer.byteLength(text, "utf8");

    // The account ceiling is decided and consumed in one transaction, under
    // the account lock.
    //
    // It used to be decided out here and consumed in the transaction below,
    // which meant two extractions running for the same account read the same
    // total and both passed. Nothing upstream helps: the finalize path's lock
    // is not held here, because extraction happens after that request has
    // returned. This is the only place the figure it guards actually moves.
    const refusal = await prisma.$transaction(async (tx) => {
        await lockAccountKnowledgeQuota(tx, file.userId);
        const usage = await knowledgeUsage(file.userId, file.profileId);
        const decision = knowledgeExtractedTextRefusal({
            extractedBytesInAccount: usage.extractedBytesInAccount,
            incomingExtractedBytes: extractedBytes,
            extractedCodePoints: extractedCharacters,
        });
        // Returned rather than thrown, so a refusal is not a rollback. The
        // caller marks the file failed afterwards; throwing here would undo
        // the read and leave the reason nowhere.
        if (decision) return decision;
        await writeChunks(tx, {
            file,
            chunks,
            extractedCharacters,
            extractedBytes,
        });
        return null;
    });

    if (refusal) {
        await markFailed(
            file.id,
            refusal.code === ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE
                ? KNOWLEDGE_FAILURE_CODES.unsupported
                : KNOWLEDGE_FAILURE_CODES.quota
        );
        return {
            fileId: file.id,
            outcome: "failed",
            failureCode: refusal.code,
        };
    }

    return { fileId: file.id, outcome: "ready", chunkCount: chunks.length };
};

/** The two writes that make a processed file retrievable. */
const writeChunks = async (
    tx: Prisma.TransactionClient,
    input: {
        file: { id: string; userId: string };
        chunks: ReturnType<typeof chunkKnowledgeText>;
        extractedCharacters: number;
        extractedBytes: number;
    }
) => {
    const { file, chunks } = input;
    {
        await tx.assistantKnowledgeChunk.deleteMany({ where: { fileId: file.id } });
        await tx.assistantKnowledgeChunk.createMany({
            data: chunks.map((chunk) => ({
                fileId: file.id,
                userId: file.userId,
                ordinal: chunk.ordinal,
                content: chunk.content,
                searchTerms: chunk.searchTerms,
                retrievalVersion: chunk.retrievalVersion,
                sourceMetadata: chunk.sourceMetadata,
            })),
        });
        await tx.assistantKnowledgeFile.update({
            where: { id: file.id },
            data: {
                processingStatus: "ready",
                failureCode: null,
                extractedCharacters: input.extractedCharacters,
                // Stored rather than recomputed. It was already measured to
                // decide the refusal above, and the account total is summed
                // from this column -- throwing it away is what made that total
                // count characters as if they were bytes.
                extractedBytes: input.extractedBytes,
                chunkCount: chunks.length,
                retrievalVersion: chunks[0].retrievalVersion,
                processedAt: new Date(),
            },
        });
    }
};

/**
 * Claims one file and processes it.
 *
 * Returns `skipped` when the conditional claim changed no row, which is what a
 * second worker sees. Exported so a route can drive one file immediately after
 * finalize instead of waiting for the sweep — the owner is looking at the
 * screen, and a file that says "pending" for fifteen minutes reads as broken.
 */
export const processKnowledgeFile = async (
    fileId: string
): Promise<KnowledgeProcessResult> => {
    const claimed = await prisma.assistantKnowledgeFile.updateMany({
        where: { id: fileId, processingStatus: "pending" },
        data: { processingStatus: "processing" },
    });
    if (claimed.count === 0) return { fileId, outcome: "skipped" };

    const file = await prisma.assistantKnowledgeFile.findUniqueOrThrow({
        where: { id: fileId },
        select: {
            id: true,
            userId: true,
            profileId: true,
            mime: true,
            r2Key: true,
        },
    });
    try {
        return await processClaimedFile(file);
    } catch (error) {
        // A throw that escapes `processClaimedFile` is a bug rather than a bad
        // file, but the row must not be left claimed either way: `processing`
        // is a state nothing recovers from, because the reclaim below only
        // looks at how long it has been there.
        await markFailed(fileId, KNOWLEDGE_FAILURE_CODES.unreadable).catch(
            () => undefined
        );
        console.error("Assistant knowledge processing failed:", {
            fileId,
            error,
        });
        return {
            fileId,
            outcome: "failed",
            failureCode: KNOWLEDGE_FAILURE_CODES.unreadable,
        };
    }
};

/**
 * How long a file may sit in `processing` before it is assumed abandoned.
 *
 * Extraction is bounded work -- the PDF worker has its own timeout and the
 * office reader is bounded by the archive limits -- so anything still claimed
 * after this lost its worker rather than being slow.
 */
export const KNOWLEDGE_PROCESSING_STALE_MS = 10 * 60 * 1000;

export type KnowledgeProcessingSweepResult = {
    reclaimed: number;
    processed: number;
    ready: number;
    failed: number;
};

/**
 * The recovery driver, run from `cleanupExpiredData`.
 *
 * Reclaiming alone is not enough and the memory extraction slice learned that
 * the hard way: a row moved back to `pending` becomes claimable and then waits
 * for a request that may never come. So this reclaims *and* processes, which
 * is what actually guarantees an upload finishes.
 */
export const processPendingKnowledgeFiles = async (
    now = new Date(),
    limit = 10
): Promise<KnowledgeProcessingSweepResult> => {
    const reclaimed = await prisma.assistantKnowledgeFile.updateMany({
        where: {
            processingStatus: "processing",
            updatedAt: { lt: new Date(now.getTime() - KNOWLEDGE_PROCESSING_STALE_MS) },
        },
        data: { processingStatus: "pending" },
    });

    const pending = await prisma.assistantKnowledgeFile.findMany({
        where: { processingStatus: "pending" },
        orderBy: { createdAt: "asc" },
        take: limit,
        select: { id: true },
    });

    let ready = 0;
    let failed = 0;
    for (const file of pending) {
        const result = await processKnowledgeFile(file.id);
        if (result.outcome === "ready") ready += 1;
        if (result.outcome === "failed") failed += 1;
    }

    return {
        reclaimed: reclaimed.count,
        processed: pending.length,
        ready,
        failed,
    };
};
