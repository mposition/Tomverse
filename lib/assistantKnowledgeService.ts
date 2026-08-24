import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
    ASSISTANT_KNOWLEDGE_KEY_PREFIX,
    ASSISTANT_KNOWLEDGE_LIMITS,
    ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED,
    ASSISTANT_KNOWLEDGE_TYPES,
    ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE,
    KNOWLEDGE_SIGNATURE_SCAN_BYTES,
    knowledgeFileRefusal,
    knowledgeQuotaRefusal,
    knowledgeRemainingCapacity,
    knowledgeSignatureMatches,
    type KnowledgeRefusal,
    type KnowledgeUsage,
} from "@/lib/assistantKnowledgeLimits";
import { enqueueKnowledgeCleanupForFiles } from "@/lib/assistantKnowledgeLifecycle";
import { prisma } from "@/lib/prisma";
import {
    createR2UploadUrl,
    deleteR2Object,
    readOwnR2ObjectBytes,
    validateR2ObjectMetadata,
} from "@/lib/r2";

/**
 * Uploading, listing and deleting knowledge files (Release C, C2).
 *
 * docs/policy/external-conversation-import-and-memory.md §14.1, §14.2,
 * §18 (릴리스 C), §21.
 *
 * ## The upload shape, and why it is prepare/finalize
 *
 * A knowledge file is up to 32MiB, so the bytes go straight to R2 on a signed
 * URL rather than through a route handler. That is the same shape the
 * signed-in chat attachment already uses, and it means the server never holds
 * a 32MiB request body.
 *
 * It also means there is a window where an object exists and no row does. Two
 * things close it: `finalize` refuses an object whose metadata does not match
 * what `prepare` authorised, and the §14.2 orphan sweep takes anything that
 * was never claimed. Neither is optional — the first stops a caller storing
 * something other than what it asked to store, and the second is the only
 * thing that will ever collect an abandoned upload.
 *
 * ## What is checked when
 *
 * `prepare` judges the *claim*: type, extension, size, and whether the account
 * has room. Refusing here is what stops a user waiting through a 32MiB upload
 * to be told their quota was full before they started.
 *
 * `finalize` judges the *object*: it re-reads size and content type from R2,
 * reads the leading bytes for the signature, and computes the digest itself.
 * The client's claims are never carried forward — the digest in particular is
 * what a profile version's knowledge manifest records, so a client-supplied
 * one would let a caller decide what a past version is said to have contained.
 */

/** Everything a caller may be refused with, in one shape. */
export class AssistantKnowledgeError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string
    ) {
        super(message);
        this.name = "AssistantKnowledgeError";
    }
}

const refuse = (refusal: KnowledgeRefusal): never => {
    throw new AssistantKnowledgeError(
        refusal.code === ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED ? 409 : 422,
        refusal.code,
        refusal.detail
    );
};

/**
 * The profile, if this account owns it.
 *
 * Ownership is re-checked on every entry point rather than trusted from the
 * route's path: a profile id is not a capability, and §19's IDOR line is that
 * knowing an id must never be enough.
 */
const ownedProfile = async (profileId: string, userId: string) => {
    const profile = await prisma.assistantProfile.findFirst({
        where: { id: profileId, userId },
        select: { id: true },
    });
    if (!profile) {
        // 404 rather than 403: a profile the caller does not own is a profile
        // that, as far as they are entitled to know, does not exist.
        throw new AssistantKnowledgeError(
            404,
            "ASSISTANT_PROFILE_NOT_FOUND",
            "No such profile."
        );
    }
    return profile;
};

/**
 * What the account currently holds.
 *
 * Counted from the rows every time rather than kept as a running total on the
 * account. A denormalised counter and the rows disagreeing is a class of bug
 * that shows up as "I deleted files and it still says I am full", and there is
 * no volume here that makes four indexed counts expensive.
 *
 * A file that failed processing still counts against the object budget,
 * because its bytes are still stored until the sweep takes them, and it counts
 * against neither text budget, because it has no text.
 */
export const knowledgeUsage = async (
    userId: string,
    profileId: string
): Promise<KnowledgeUsage> => {
    const [filesInProfile, filesInAccount, objectBytes, extracted] =
        await Promise.all([
            prisma.assistantKnowledgeFile.count({ where: { userId, profileId } }),
            prisma.assistantKnowledgeFile.count({ where: { userId } }),
            prisma.assistantKnowledgeFile.aggregate({
                where: { userId },
                _sum: { bytes: true },
            }),
            // Raw because the sum is a COALESCE and Prisma's aggregate cannot
            // express one. The alternative -- two sums added up in JavaScript
            // -- would double-count every row that has both.
            prisma.$queryRaw<{ total: bigint | null }[]>`
                SELECT SUM(COALESCE("extractedBytes", "extractedCharacters"))::bigint AS total
                FROM "AssistantKnowledgeFile"
                WHERE "userId" = ${userId} AND "processingStatus" = 'ready'
            `,
        ]);
    return {
        filesInProfile,
        filesInAccount,
        objectBytesInAccount: objectBytes._sum.bytes ?? 0,
        // Bytes where they are known, characters where they are not.
        //
        // The ceiling is written in UTF-8 bytes, and until `extractedBytes`
        // existed this total was summed from `extractedCharacters` -- so a
        // Korean document, at roughly three bytes a character, counted about a
        // third of what it costs. New rows carry the real figure. Old rows
        // keep being counted the old way rather than being re-extracted, which
        // is a decision recorded in docs/policy/assistant-package-import.md
        // §10 rather than an oversight: re-reading every stored file in every
        // account would make quotas appear to fill overnight.
        extractedBytesInAccount: Number(extracted[0]?.total ?? 0),
    };
};

export const knowledgeCapacity = async (userId: string, profileId: string) => {
    await ownedProfile(profileId, userId);
    const usage = await knowledgeUsage(userId, profileId);
    return {
        limits: {
            maxFileBytes: ASSISTANT_KNOWLEDGE_LIMITS.maxFileBytes,
            maxFilesPerProfile: ASSISTANT_KNOWLEDGE_LIMITS.maxFilesPerProfile,
            maxFilesPerAccount: ASSISTANT_KNOWLEDGE_LIMITS.maxFilesPerAccount,
            maxObjectBytesPerAccount:
                ASSISTANT_KNOWLEDGE_LIMITS.maxObjectBytesPerAccount,
            maxExtractedBytesPerAccount:
                ASSISTANT_KNOWLEDGE_LIMITS.maxExtractedBytesPerAccount,
        },
        usage,
        remaining: knowledgeRemainingCapacity(usage),
        acceptedMediaTypes: Object.keys(ASSISTANT_KNOWLEDGE_TYPES),
        // Deliberately no file names and no content: this is the figure a
        // picker shows before a file is chosen, and it leaves the account.
        calculatedAt: new Date().toISOString(),
    };
};

/**
 * A random key under the knowledge prefix.
 *
 * Not derived from the filename or the account. A name-derived key leaks the
 * name to anything that can see a key, and lets two files with the same name
 * collide; an account-derived prefix would make the key a weak identifier for
 * the owner. Ownership is the row, not the path.
 */
const knowledgeKey = () => `${ASSISTANT_KNOWLEDGE_KEY_PREFIX}${randomUUID()}`;

export type PreparedKnowledgeUpload = {
    uploadKey: string;
    uploadUrl: string;
    uploadHeaders: Record<string, string>;
};

export const prepareKnowledgeUpload = async (input: {
    userId: string;
    profileId: string;
    filename: string;
    mime: string;
    bytes: number;
}): Promise<PreparedKnowledgeUpload> => {
    await ownedProfile(input.profileId, input.userId);

    const claimRefusal = knowledgeFileRefusal({
        filename: input.filename,
        mime: input.mime,
        bytes: input.bytes,
    });
    if (claimRefusal) refuse(claimRefusal);

    const usage = await knowledgeUsage(input.userId, input.profileId);
    const quotaRefusal = knowledgeQuotaRefusal({
        usage,
        incomingBytes: input.bytes,
    });
    if (quotaRefusal) refuse(quotaRefusal);

    const uploadKey = knowledgeKey();
    const uploadUrl = await createR2UploadUrl(uploadKey, input.mime, input.bytes);
    return {
        uploadKey,
        uploadUrl,
        uploadHeaders: { "Content-Type": input.mime },
    };
};

/**
 * Turns an uploaded object into a pending row.
 *
 * Everything the client says is re-derived here. The one thing it is trusted
 * for is which key it uploaded to, and that is bounded: the key must be one of
 * ours by prefix, and it must not already belong to a row.
 */
export const finalizeKnowledgeUpload = async (input: {
    userId: string;
    profileId: string;
    uploadKey: string;
    filename: string;
    mime: string;
}) => {
    await ownedProfile(input.profileId, input.userId);

    if (!input.uploadKey.startsWith(ASSISTANT_KNOWLEDGE_KEY_PREFIX)) {
        throw new AssistantKnowledgeError(
            403,
            "ASSISTANT_KNOWLEDGE_KEY_FORBIDDEN",
            "That is not a knowledge upload key."
        );
    }

    // An import's key, sent to the ordinary path.
    //
    // Nothing above would notice: the key is ours by prefix, no row claims it
    // yet, and the profile is the caller's own. So the file would be created
    // with no import holding it -- ordinary, listable, publishable -- and the
    // isolation the import relies on would be gone in one request. The
    // reservation is the only thing that knows this key was issued for
    // something else.
    const reservation = await prisma.assistantKnowledgeUploadReservation.findUnique({
        where: { r2Key: input.uploadKey },
        select: { userId: true },
    });
    if (reservation) {
        if (reservation.userId !== input.userId) {
            // Somebody else's key. The same answer their own file would get,
            // deliberately: a 409 here would confirm that the key exists and
            // is in use.
            throw new AssistantKnowledgeError(
                403,
                "ASSISTANT_KNOWLEDGE_KEY_FORBIDDEN",
                "That is not a knowledge upload key."
            );
        }
        // The caller's own key, but another flow is using it. Not a 403: this
        // is their file, and being told it is not theirs is a worse answer
        // than being told where it already is.
        //
        // The object is left alone. We did issue this key, but the request
        // naming it is not the one it was issued to, and deleting on the
        // strength of that is how a published file loses its bytes.
        throw new AssistantKnowledgeError(
            409,
            "ASSISTANT_KNOWLEDGE_KEY_RESERVED_FOR_IMPORT",
            "That upload belongs to an import you are still reviewing."
        );
    }

    const existing = await prisma.assistantKnowledgeFile.findUnique({
        where: { r2Key: input.uploadKey },
        select: { id: true, userId: true, importId: true },
    });
    if (existing) {
        // A retried finalize of the caller's own upload is the same request
        // twice and answers with the same row. Somebody else's key is not.
        if (existing.userId !== input.userId) {
            throw new AssistantKnowledgeError(
                403,
                "ASSISTANT_KNOWLEDGE_KEY_FORBIDDEN",
                "That is not a knowledge upload key."
            );
        }
        if (existing.importId !== null) {
            // The import already finalised this key, so its reservation is
            // gone and the check above found nothing -- but the row it made is
            // still staged. Returning it here would hand a file under review
            // to the path that is not allowed to see one.
            throw new AssistantKnowledgeError(
                409,
                "ASSISTANT_KNOWLEDGE_KEY_RESERVED_FOR_IMPORT",
                "That upload belongs to an import you are still reviewing."
            );
        }
        return prisma.assistantKnowledgeFile.findUniqueOrThrow({
            where: { id: existing.id },
        });
    }

    // Size and content type come from R2, not from the request. A mismatch
    // deletes the object -- it is not what was authorised, so there is nothing
    // to keep.
    let metadata: { size: number };
    try {
        metadata = await validateR2ObjectMetadata(input.uploadKey, {
            maxBytes: ASSISTANT_KNOWLEDGE_LIMITS.maxFileBytes,
            expectedContentType: input.mime,
        });
    } catch {
        throw new AssistantKnowledgeError(
            422,
            ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE,
            "The uploaded file did not match what was authorised."
        );
    }

    const bytes = await readOwnR2ObjectBytes(input.uploadKey, {
        maxBytes: ASSISTANT_KNOWLEDGE_LIMITS.maxFileBytes,
    });

    const failUpload = async (refusal: KnowledgeRefusal): Promise<never> => {
        // No row was written, so there is no tombstone to enqueue and the
        // orphan sweep would take this in a day. Deleting now is the same
        // outcome sooner, and it keeps a refused upload from occupying quota
        // it was never granted.
        await deleteR2Object(input.uploadKey).catch(() => undefined);
        return refuse(refusal);
    };

    const claimRefusal = knowledgeFileRefusal({
        filename: input.filename,
        mime: input.mime,
        bytes: metadata.size,
        leadingBytes: bytes.subarray(0, KNOWLEDGE_SIGNATURE_SCAN_BYTES),
    });
    if (claimRefusal) await failUpload(claimRefusal);

    if (!knowledgeSignatureMatches(input.mime, bytes)) {
        await failUpload({
            code: ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE,
            detail: `the file does not begin like ${input.mime}`,
        });
    }

    // Re-checked against the object's real size, which `prepare` only had a
    // claim about. Two uploads racing on the last of a quota both pass
    // `prepare`; this is where the second one loses.
    const usage = await knowledgeUsage(input.userId, input.profileId);
    const quotaRefusal = knowledgeQuotaRefusal({
        usage,
        incomingBytes: metadata.size,
    });
    if (quotaRefusal) await failUpload(quotaRefusal);

    const digest = createHash("sha256").update(bytes).digest("hex");

    return prisma.assistantKnowledgeFile.create({
        data: {
            profileId: input.profileId,
            userId: input.userId,
            name: input.filename,
            mime: input.mime,
            bytes: metadata.size,
            digest,
            r2Key: input.uploadKey,
            processingStatus: "pending",
        },
    });
};

/**
 * The owner's view of one profile's files. No keys, no digests.
 *
 * `importId: null` is the isolation, not a filter for tidiness. A file staged
 * for an import under review must not appear in the ordinary editor, because
 * anything the editor can list is something the editor can publish -- and that
 * would put a file into a version before the owner had approved the import it
 * came from.
 */
export const listKnowledgeFiles = async (userId: string, profileId: string) => {
    await ownedProfile(profileId, userId);
    return prisma.assistantKnowledgeFile.findMany({
        where: { userId, profileId, importId: null },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            name: true,
            mime: true,
            bytes: true,
            processingStatus: true,
            failureCode: true,
            extractedCharacters: true,
            chunkCount: true,
            createdAt: true,
            processedAt: true,
        },
    });
};

/**
 * Deletes one file: rows first, bytes afterwards (§14.2).
 *
 * The tombstone is written in the same transaction as the delete, so a crash
 * between them cannot leave a chunk pointing at bytes that are gone — the
 * failure mode is a tombstone for an object that no longer has a row, which is
 * exactly what the sweep is for.
 */
export const deleteKnowledgeFile = async (input: {
    userId: string;
    profileId: string;
    fileId: string;
}) => {
    await ownedProfile(input.profileId, input.userId);
    const file = await prisma.assistantKnowledgeFile.findFirst({
        where: {
            id: input.fileId,
            userId: input.userId,
            profileId: input.profileId,
            // The same isolation the list applies. A staged file belongs to
            // the import that is holding it: removing it from here would leave
            // that import's manifest naming a file that no longer exists, and
            // the import has its own way to drop a file.
            importId: null,
        },
        select: { id: true },
    });
    if (!file) {
        throw new AssistantKnowledgeError(
            404,
            "ASSISTANT_KNOWLEDGE_FILE_NOT_FOUND",
            "No such knowledge file."
        );
    }

    await prisma.$transaction(async (tx) => {
        await enqueueKnowledgeCleanupForFiles(
            tx,
            { id: file.id },
            "file_deleted"
        );
        await tx.assistantKnowledgeFile.delete({ where: { id: file.id } });
    });

    return { deleted: true };
};
