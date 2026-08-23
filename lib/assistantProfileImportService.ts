import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { ASSISTANT_PACKAGE_ADAPTER_VERSION } from "@/lib/assistantPackageAdapter";
import { ASSISTANT_PACKAGE_LIMITS } from "@/lib/assistantPackageLimits";
import { ASSISTANT_PACKAGE_INGEST_PATHS } from "@/lib/assistantPackageManifest";
import {
    ASSISTANT_KNOWLEDGE_KEY_PREFIX,
    ASSISTANT_KNOWLEDGE_LIMITS,
    ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE,
    KNOWLEDGE_SIGNATURE_SCAN_BYTES,
    knowledgeFileRefusal,
    knowledgeQuotaRefusal,
    knowledgeSignatureMatches,
    type KnowledgeRefusal,
} from "@/lib/assistantKnowledgeLimits";
import { enqueueKnowledgeCleanupForFiles } from "@/lib/assistantKnowledgeLifecycle";
import { knowledgeUsage } from "@/lib/assistantKnowledgeService";
import {
    ASSISTANT_PROFILE_IMPORT_LIMITS,
    computeImportExpiries,
    judgeCreateCleanup,
    type AssistantProfileImportMode,
} from "@/lib/assistantProfileImportCore";
import {
    lockAccountKnowledgeQuota,
    lockProfileImport,
} from "@/lib/assistantProfileImportLocks";
import {
    AssistantProfileError,
    publishAssistantProfileVersionInTx,
    type PublishOutcome,
} from "@/lib/assistantProfileService";
import {
    normalizeProfileIdentity,
    profileIdentityProblems,
    type AssistantProfileVersionDraft,
} from "@/lib/assistantProfileVersioning";
import { prisma } from "@/lib/prisma";
import {
    createR2UploadUrl,
    readOwnR2ObjectBytes,
    validateR2ObjectMetadata,
} from "@/lib/r2";

/**
 * Staging, uploading into and publishing an imported assistant package.
 *
 * docs/policy/assistant-package-import.md §5.4, §5.5, §5.6.
 *
 * ## What this module is for
 *
 * Everything before step 7 happens in the browser. This is step 7 and step 8:
 * the first server row, the files, and the publish. The ordinary profile
 * service still owns what a version *is* -- this never re-derives a revision
 * number or decides that a draft is unchanged, it calls
 * `publishAssistantProfileVersionInTx()` for both.
 *
 * ## Two modes, one column
 *
 * `create` makes a draft profile and owns it; cancelling takes it away.
 * `merge` stages into a profile that already exists and must never delete it.
 * `mode` is therefore the branch of every cleanup path, which is why the
 * database bounds its vocabulary and why the cleanup re-tests its
 * preconditions instead of trusting the column.
 *
 * ## Why staged files live on the target profile
 *
 * Because a version's manifest is resolved against the files *that profile*
 * holds, a file cannot be uploaded to one profile and published into another
 * -- it is not expressible. So `merge` stages into the target, and the
 * `importId` column is what keeps those files out of the ordinary editor until
 * the owner approves them.
 */

export class AssistantProfileImportError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string
    ) {
        super(message);
        this.name = "AssistantProfileImportError";
    }
}

const notFound: () => never = () => {
    // "Somebody else's" and "does not exist" are the same answer on purpose:
    // the query is scoped by userId, so there is no branch that could tell
    // them apart even if we wanted one.
    throw new AssistantProfileImportError(
        404,
        "ASSISTANT_PROFILE_IMPORT_NOT_FOUND",
        "No such import."
    );
};

const refuse: (refusal: KnowledgeRefusal) => never = (refusal) => {
    throw new AssistantProfileImportError(
        refusal.code === ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE ? 422 : 409,
        refusal.code,
        refusal.detail
    );
};

/* ---------------------------------------------------------------- creating */

export type CreateImportInput = {
    userId: string;
    mode: AssistantProfileImportMode;
    /** Required for `merge`; the draft's name for `create`. */
    targetProfileId?: string;
    identity: { name: string; icon: string | null; description: string | null };
    /** What the owner assembled in the wizard. Stored, not approved. */
    stagingManifest: Prisma.InputJsonValue;
    declared: {
        sourceKind: string | null;
        sourceName: string | null;
        sourceUrl: string | null;
        previousProvenance: Prisma.InputJsonValue | null;
    };
};

/**
 * A digest over the identity fields that a version snapshot does not carry.
 *
 * `merge` needs its own clock for these: renaming a profile does not publish a
 * revision, so `expectedRevision` cannot see it change. Without this, two
 * people renaming and importing at the same time would each believe the other
 * had not moved.
 */
export const profileIdentityDigest = (identity: {
    name: string;
    icon: string | null;
    description: string | null;
}): string =>
    createHash("sha256")
        .update(JSON.stringify([identity.name, identity.icon, identity.description]))
        .digest("hex");

export async function createProfileImport(input: CreateImportInput) {
    const identity = normalizeProfileIdentity(input.identity);
    const problems = profileIdentityProblems(identity);
    if (problems.length > 0) {
        throw new AssistantProfileError(
            422,
            "ASSISTANT_PROFILE_INVALID",
            "The import could not be started.",
            problems
        );
    }

    const now = new Date();
    const expiries = computeImportExpiries({
        createdAt: now,
        lastUserActivityAt: now,
    });

    return prisma.$transaction(async (tx) => {
        if (input.mode === "merge") {
            const profileId = input.targetProfileId;
            if (!profileId) return notFound();
            await lockProfileImport(tx, profileId);
            const target = await tx.assistantProfile.findFirst({
                where: { id: profileId, userId: input.userId },
                select: {
                    id: true,
                    name: true,
                    icon: true,
                    description: true,
                    currentVersion: { select: { revision: true } },
                },
            });
            if (!target) return notFound();
            await assertNoOtherStagingImport(tx, profileId, null);
            return tx.assistantProfileImport.create({
                data: {
                    userId: input.userId,
                    mode: "merge",
                    profileId: target.id,
                    // Both clocks of the target, read now and compared at
                    // publish: the revision for what a version carries, the
                    // digest for what it does not.
                    expectedTargetRevision: target.currentVersion?.revision ?? null,
                    expectedTargetIdentityDigest: profileIdentityDigest({
                        name: target.name,
                        icon: target.icon,
                        description: target.description,
                    }),
                    stagingManifest: input.stagingManifest,
                    validatorVersion: ASSISTANT_PACKAGE_ADAPTER_VERSION,
                    ingestPath: ASSISTANT_PACKAGE_INGEST_PATHS[0],
                    declaredSourceKind: input.declared.sourceKind,
                    declaredSourceName: input.declared.sourceName,
                    declaredSourceUrl: input.declared.sourceUrl,
                    declaredPreviousProvenance:
                        input.declared.previousProvenance ?? undefined,
                    lastUserActivityAt: now,
                    idleExpiresAt: expiries.idleExpiresAt,
                    absoluteExpiresAt: expiries.absoluteExpiresAt,
                },
                select: IMPORT_SELECT,
            });
        }

        // `create`. The draft occupies a profile slot, which is the honest
        // cost of it being an ordinary profile row -- and the reason the
        // wizard shows remaining slots before it starts.
        const profileCount = await tx.assistantProfile.count({
            where: { userId: input.userId },
        });
        if (profileCount >= ASSISTANT_KNOWLEDGE_LIMITS.maxProfilesPerAccount) {
            throw new AssistantProfileImportError(
                409,
                "ASSISTANT_PROFILE_LIMIT_REACHED",
                "You have reached the assistant limit. Delete one to import another."
            );
        }
        const draft = await tx.assistantProfile.create({
            data: {
                userId: input.userId,
                name: identity.name,
                icon: identity.icon,
                description: identity.description,
            },
            select: { id: true },
        });
        return tx.assistantProfileImport.create({
            data: {
                userId: input.userId,
                mode: "create",
                profileId: draft.id,
                stagingManifest: input.stagingManifest,
                validatorVersion: ASSISTANT_PACKAGE_ADAPTER_VERSION,
                ingestPath: ASSISTANT_PACKAGE_INGEST_PATHS[0],
                declaredSourceKind: input.declared.sourceKind,
                declaredSourceName: input.declared.sourceName,
                declaredSourceUrl: input.declared.sourceUrl,
                declaredPreviousProvenance:
                    input.declared.previousProvenance ?? undefined,
                lastUserActivityAt: now,
                idleExpiresAt: expiries.idleExpiresAt,
                absoluteExpiresAt: expiries.absoluteExpiresAt,
            },
            select: IMPORT_SELECT,
        });
    });
}

const IMPORT_SELECT = {
    id: true,
    mode: true,
    profileId: true,
    status: true,
    stagingManifest: true,
    candidateDigest: true,
    approvedDigest: true,
    userApprovedAt: true,
    expectedTargetRevision: true,
    idleExpiresAt: true,
    absoluteExpiresAt: true,
    createdAt: true,
} satisfies Prisma.AssistantProfileImportSelect;

/**
 * One staging import per profile at a time.
 *
 * Two would each stage files the other cannot see and then both try to publish
 * from the same starting revision; the second would fail as stale, having
 * already stored everything.
 */
async function assertNoOtherStagingImport(
    tx: Prisma.TransactionClient,
    profileId: string,
    exceptImportId: string | null
): Promise<void> {
    const other = await tx.assistantProfileImport.findFirst({
        where: {
            profileId,
            status: "staging",
            ...(exceptImportId ? { id: { not: exceptImportId } } : {}),
        },
        select: { id: true },
    });
    if (other) {
        throw new AssistantProfileImportError(
            409,
            "ASSISTANT_PROFILE_IMPORT_IN_PROGRESS",
            "An import is already being reviewed for this assistant."
        );
    }
}

/* ------------------------------------------------------------ reading it */

/** The import, scoped by owner and still staging. */
async function loadStagingImport(
    client: Prisma.TransactionClient,
    input: { userId: string; importId: string }
) {
    const found = await client.assistantProfileImport.findFirst({
        where: { id: input.importId, userId: input.userId, status: "staging" },
        select: {
            id: true,
            mode: true,
            profileId: true,
            expectedTargetRevision: true,
            expectedTargetIdentityDigest: true,
            candidateDigest: true,
            approvedDigest: true,
        },
    });
    if (!found) notFound();
    return found;
}

/** The owner did something. Only these events move the idle clock. */
async function touchImport(
    tx: Prisma.TransactionClient,
    importId: string,
    createdAt?: Date
): Promise<void> {
    const now = new Date();
    const row =
        createdAt ??
        (
            await tx.assistantProfileImport.findUniqueOrThrow({
                where: { id: importId },
                select: { createdAt: true },
            })
        ).createdAt;
    const expiries = computeImportExpiries({
        createdAt: row,
        lastUserActivityAt: now,
    });
    await tx.assistantProfileImport.update({
        where: { id: importId },
        data: {
            lastUserActivityAt: now,
            idleExpiresAt: expiries.idleExpiresAt,
            absoluteExpiresAt: expiries.absoluteExpiresAt,
        },
    });
}

/**
 * What the wizard watches during step 7.
 *
 * Per-file status and nothing else: whether a document is ready is what the
 * screen needs, and its name is already on that screen because the owner chose
 * it. Content, digests and storage keys are not here for the reason §9 keeps
 * them out of every response.
 */
export async function readProfileImport(input: {
    userId: string;
    importId: string;
}) {
    const found = await prisma.assistantProfileImport.findFirst({
        where: { id: input.importId, userId: input.userId },
        select: IMPORT_SELECT,
    });
    if (!found) return notFound();

    const files = await prisma.assistantKnowledgeFile.findMany({
        where: { importId: found.id },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            name: true,
            mime: true,
            bytes: true,
            processingStatus: true,
            failureCode: true,
            createdAt: true,
        },
    });

    return {
        ...found,
        files,
        // Derived rather than stored: "all of them are ready" is a question
        // about the files, and a copy of the answer on the import row would be
        // one more thing that can disagree with them.
        ready: files.every((file) => file.processingStatus === "ready"),
    };
}

/* ------------------------------------------------------------- uploading */

const importKnowledgeKey = () =>
    `${ASSISTANT_KNOWLEDGE_KEY_PREFIX}${randomUUID()}`;

export type PreparedImportUpload = {
    uploadKey: string;
    uploadUrl: string;
    uploadHeaders: Record<string, string>;
};

/**
 * Authorises one upload and records that we issued the key.
 *
 * The reservation is written in the same transaction as the checks, so a key
 * only exists once it is accounted for. The URL is created afterwards: an
 * object nobody uploaded to costs nothing, while a reservation for a key that
 * was never issued would refuse a finalize the owner is entitled to.
 */
export async function prepareImportKnowledgeUpload(input: {
    userId: string;
    importId: string;
    filename: string;
    mime: string;
    bytes: number;
}): Promise<PreparedImportUpload> {
    const claimRefusal = knowledgeFileRefusal({
        filename: input.filename,
        mime: input.mime,
        bytes: input.bytes,
    });
    if (claimRefusal) refuse(claimRefusal);

    const uploadKey = importKnowledgeKey();
    const mime = input.mime;

    const profileId = await prisma.$transaction(async (tx) => {
        const found = await loadStagingImport(tx, input);
        await lockProfileImport(tx, found.profileId);
        await lockAccountKnowledgeQuota(tx, input.userId);

        const staged = await tx.assistantKnowledgeFile.count({
            where: { importId: found.id },
        });
        if (staged >= ASSISTANT_PACKAGE_LIMITS.maxKnowledgeFiles) {
            throw new AssistantProfileImportError(
                409,
                "ASSISTANT_PACKAGE_KNOWLEDGE_LIMIT_REACHED",
                "This import already holds as many documents as it may bring."
            );
        }

        const usage = await knowledgeUsage(input.userId, found.profileId);
        const quotaRefusal = knowledgeQuotaRefusal({
            usage,
            incomingBytes: input.bytes,
        });
        if (quotaRefusal) refuse(quotaRefusal);

        await tx.assistantKnowledgeUploadReservation.create({
            data: {
                r2Key: uploadKey,
                userId: input.userId,
                importId: found.id,
                profileId: found.profileId,
            },
        });
        await touchImport(tx, found.id);
        return found.profileId;
    });

    void profileId;
    const uploadUrl = await createR2UploadUrl(uploadKey, mime, input.bytes);
    return { uploadKey, uploadUrl, uploadHeaders: { "Content-Type": mime } };
}

/**
 * Turns an uploaded object into a staged file.
 *
 * The claim is a compare-and-set on the reservation rather than a lock, and
 * the token is what makes a late retry harmless: a request whose claim was
 * reclaimed for being stale finds its token gone and changes nothing.
 *
 * R2 is read between the claim and the write because it cannot be read inside
 * a transaction, which is the same shape the ordinary finalize has and the
 * same reason the reservation exists at all.
 */
export async function finalizeImportKnowledgeUpload(input: {
    userId: string;
    importId: string;
    uploadKey: string;
    filename: string;
    mime: string;
}) {
    if (!input.uploadKey.startsWith(ASSISTANT_KNOWLEDGE_KEY_PREFIX)) {
        throw new AssistantProfileImportError(
            403,
            "ASSISTANT_KNOWLEDGE_KEY_FORBIDDEN",
            "That is not a knowledge upload key."
        );
    }

    const claimToken = randomUUID();
    const claimed = await prisma.$transaction(async (tx) => {
        const found = await loadStagingImport(tx, input);

        // An already-finalised key. Answered from the row rather than by
        // redoing the work, and refused outright if it belongs to a different
        // import -- moving a file between imports is not something a retry
        // should be able to do.
        const existing = await tx.assistantKnowledgeFile.findUnique({
            where: { r2Key: input.uploadKey },
            select: { id: true, userId: true, importId: true, profileId: true },
        });
        if (existing) {
            if (
                existing.userId !== input.userId ||
                existing.importId !== found.id ||
                existing.profileId !== found.profileId
            ) {
                throw new AssistantProfileImportError(
                    409,
                    "ASSISTANT_KNOWLEDGE_KEY_CONFLICT",
                    "That upload has already been used."
                );
            }
            return { kind: "already" as const, fileId: existing.id };
        }

        const reservation = await tx.assistantKnowledgeUploadReservation.findUnique(
            { where: { r2Key: input.uploadKey } }
        );
        if (
            !reservation ||
            reservation.userId !== input.userId ||
            reservation.importId !== found.id
        ) {
            // Not a key we issued for this import. The object is left where it
            // is: deleting on the strength of a request that names a key is
            // how a published file loses its bytes.
            throw new AssistantProfileImportError(
                404,
                "ASSISTANT_KNOWLEDGE_UPLOAD_NOT_RESERVED",
                "That upload was not prepared for this import."
            );
        }

        const stale =
            reservation.finalizingStartedAt !== null &&
            Date.now() - reservation.finalizingStartedAt.getTime() >
                ASSISTANT_PROFILE_IMPORT_LIMITS.reservationClaimStaleMs;
        if (reservation.state === "finalizing" && !stale) {
            throw new AssistantProfileImportError(
                409,
                "ASSISTANT_KNOWLEDGE_UPLOAD_IN_PROGRESS",
                "That upload is already being finished."
            );
        }

        // Conditional on the state we just read, so two requests that both saw
        // a claimable reservation cannot both take it.
        const taken = await tx.assistantKnowledgeUploadReservation.updateMany({
            where: {
                r2Key: input.uploadKey,
                state: reservation.state,
                claimToken: reservation.claimToken,
            },
            data: {
                state: "finalizing",
                claimToken,
                finalizingStartedAt: new Date(),
            },
        });
        if (taken.count !== 1) {
            throw new AssistantProfileImportError(
                409,
                "ASSISTANT_KNOWLEDGE_UPLOAD_IN_PROGRESS",
                "That upload is already being finished."
            );
        }
        return {
            kind: "claimed" as const,
            profileId: found.profileId,
            importId: found.id,
        };
    });

    if (claimed.kind === "already") {
        return prisma.assistantKnowledgeFile.findUniqueOrThrow({
            where: { id: claimed.fileId },
        });
    }

    const release = async () => {
        // Only if the claim is still ours. A stale reclaim may have handed it
        // to somebody else while we were reading R2.
        await prisma.assistantKnowledgeUploadReservation
            .updateMany({
                where: { r2Key: input.uploadKey, claimToken },
                data: { state: "pending", claimToken: null, finalizingStartedAt: null },
            })
            .catch(() => undefined);
    };

    let metadata: { size: number };
    let bytes: Buffer;
    try {
        metadata = await validateR2ObjectMetadata(input.uploadKey, {
            maxBytes: ASSISTANT_KNOWLEDGE_LIMITS.maxFileBytes,
            expectedContentType: input.mime,
        });
        bytes = await readOwnR2ObjectBytes(input.uploadKey, {
            maxBytes: ASSISTANT_KNOWLEDGE_LIMITS.maxFileBytes,
        });
    } catch {
        await release();
        throw new AssistantProfileImportError(
            422,
            ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE,
            "The uploaded file did not match what was authorised."
        );
    }

    const fileRefusal = knowledgeFileRefusal({
        filename: input.filename,
        mime: input.mime,
        bytes: metadata.size,
        leadingBytes: bytes.subarray(0, KNOWLEDGE_SIGNATURE_SCAN_BYTES),
    });
    if (fileRefusal) {
        await release();
        refuse(fileRefusal);
    }
    if (!knowledgeSignatureMatches(input.mime, bytes)) {
        await release();
        refuse({
            code: ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE,
            detail: `the file does not begin like ${input.mime}`,
        });
    }

    const digest = createHash("sha256").update(bytes).digest("hex");

    const outcome = await prisma.$transaction(async (tx) => {
        await lockProfileImport(tx, claimed.profileId);
        await lockAccountKnowledgeQuota(tx, input.userId);

        // Re-judged against the object's real size under the lock, which is
        // where two uploads racing on the last of a quota are separated.
        const usage = await knowledgeUsage(input.userId, claimed.profileId);
        const quotaRefusal = knowledgeQuotaRefusal({
            usage,
            incomingBytes: metadata.size,
        });
        // Returned rather than thrown: throwing would roll back the release
        // below and leave the reservation claimed by a request that is over.
        if (quotaRefusal) return { kind: "refused" as const, refusal: quotaRefusal };

        const file = await tx.assistantKnowledgeFile.create({
            data: {
                profileId: claimed.profileId,
                userId: input.userId,
                importId: claimed.importId,
                name: input.filename,
                mime: input.mime,
                bytes: metadata.size,
                digest,
                r2Key: input.uploadKey,
                processingStatus: "pending",
            },
        });
        // The reservation's whole job is done the moment a row exists.
        await tx.assistantKnowledgeUploadReservation.deleteMany({
            where: { r2Key: input.uploadKey, claimToken },
        });
        await touchImport(tx, claimed.importId);
        return { kind: "created" as const, file };
    });

    if (outcome.kind === "refused") {
        await release();
        return refuse(outcome.refusal);
    }
    return outcome.file;
}

/* -------------------------------------------------------------- publishing */

export type ImportPublishOutcome =
    | (PublishOutcome & { importId: string })
    | { outcome: "not_ready"; pending: number; failed: number };

/**
 * Approves the import and publishes the version, in one transaction.
 *
 * One transaction because the alternative has a state in it that nothing can
 * recover from: the version created and current, and the import still
 * `staging` -- which the expiry sweep would then collect, deleting a published
 * profile in `create` mode.
 *
 * All or nothing over the files, too. A file still processing or failed stops
 * the publish rather than being quietly dropped, because a manifest that
 * silently lost a document is the failure the whole loss report exists to
 * prevent.
 */
export async function publishProfileImport(input: {
    userId: string;
    importId: string;
    /** The digest of what the owner confirmed on screen. */
    approvedDigest: string;
    digestVersion: number;
    /** Which staged files to keep. Anything else is discarded. */
    keepFileIds: readonly string[];
    draft: AssistantProfileVersionDraft;
    identity: { name: string; icon: string | null; description: string | null };
}): Promise<ImportPublishOutcome> {
    return prisma.$transaction(async (tx) => {
        const found = await loadStagingImport(tx, input);
        await lockProfileImport(tx, found.profileId);

        if (found.mode === "merge") {
            const target = await tx.assistantProfile.findFirstOrThrow({
                where: { id: found.profileId },
                select: { name: true, icon: true, description: true },
            });
            const digest = profileIdentityDigest(target);
            if (
                found.expectedTargetIdentityDigest !== null &&
                found.expectedTargetIdentityDigest !== digest
            ) {
                // Identity is not in a version snapshot, so the revision check
                // below cannot see it move. Without this, a rename during the
                // import is silently overwritten by whatever the wizard read.
                throw new AssistantProfileError(
                    409,
                    "ASSISTANT_PROFILE_VERSION_STALE",
                    "This assistant changed while you were importing. Reload before publishing again."
                );
            }
        }

        const staged = await tx.assistantKnowledgeFile.findMany({
            where: { importId: found.id },
            select: { id: true, processingStatus: true },
        });
        const keep = new Set(input.keepFileIds);
        const kept = staged.filter((file) => keep.has(file.id));
        const pending = kept.filter(
            (file) => file.processingStatus === "pending" || file.processingStatus === "processing"
        ).length;
        const failed = kept.filter((file) => file.processingStatus === "failed").length;
        if (pending > 0 || failed > 0) {
            return { outcome: "not_ready" as const, pending, failed };
        }

        // Promotion: the kept files stop belonging to the import and become
        // ordinary files of the profile. Everything else the import staged is
        // dropped, with its bytes queued for deletion first.
        const discarded = staged.filter((file) => !keep.has(file.id));
        if (discarded.length > 0) {
            const ids = discarded.map((file) => file.id);
            await enqueueKnowledgeCleanupForFiles(
                tx,
                { id: { in: ids } },
                "file_deleted"
            );
            await tx.assistantKnowledgeFile.deleteMany({ where: { id: { in: ids } } });
        }
        await tx.assistantKnowledgeFile.updateMany({
            where: { importId: found.id, id: { in: [...keep] } },
            data: { importId: null },
        });

        // Reservations nobody used. The import row survives publication as
        // provenance, so no cascade would ever reach these.
        await tx.assistantKnowledgeUploadReservation.deleteMany({
            where: { importId: found.id },
        });

        const identity = normalizeProfileIdentity(input.identity);
        const problems = profileIdentityProblems(identity);
        if (problems.length > 0) {
            throw new AssistantProfileError(
                422,
                "ASSISTANT_PROFILE_INVALID",
                "The profile could not be published.",
                problems
            );
        }
        await tx.assistantProfile.update({
            where: { id: found.profileId },
            data: {
                name: identity.name,
                icon: identity.icon,
                description: identity.description,
            },
        });

        const published = await publishAssistantProfileVersionInTx(tx, {
            userId: input.userId,
            profileId: found.profileId,
            draft: input.draft,
            expectedRevision: found.expectedTargetRevision,
            // The files were promoted a moment ago, so the manifest resolves
            // them as ordinary files of this profile.
            importId: null,
        });

        // `unchanged` is a real answer here: a merge whose package proposes
        // exactly what the profile already publishes. The import is still
        // finished -- it just does not get a revision of its own, and the
        // version it names is the one that was already current.
        const versionId =
            published.outcome === "published"
                ? published.version.id
                : (
                      await tx.assistantProfile.findFirstOrThrow({
                          where: { id: found.profileId },
                          select: { currentVersionId: true },
                      })
                  ).currentVersionId;

        await tx.assistantProfileImport.update({
            where: { id: found.id },
            data: {
                status: "published",
                approvedDigest: input.approvedDigest,
                digestVersion: input.digestVersion,
                userApprovedAt: new Date(),
                versionId,
            },
        });

        return { ...published, importId: found.id };
    });
}

/* ------------------------------------------------------------- cancelling */

export type CancelOutcome =
    | { outcome: "cancelled"; deletedProfile: boolean }
    | { outcome: "refused"; reasons: string[] };

/**
 * Cancels an import and takes back what it staged.
 *
 * `create` deletes its draft profile, and only after every precondition still
 * holds. `merge` deletes the files this import staged and nothing else -- the
 * profile it was merging into is somebody's work.
 */
export async function cancelProfileImport(input: {
    userId: string;
    importId: string;
}): Promise<CancelOutcome> {
    return prisma.$transaction(async (tx) => {
        const found = await loadStagingImport(tx, input);
        await lockProfileImport(tx, found.profileId);

        // Tombstones first, always: bytes are never deleted ahead of the rows
        // that name them.
        await enqueueKnowledgeCleanupForFiles(
            tx,
            { importId: found.id },
            "profile_deleted"
        );

        if (found.mode !== "create") {
            await tx.assistantKnowledgeFile.deleteMany({
                where: { importId: found.id },
            });
            await tx.assistantProfileImport.delete({ where: { id: found.id } });
            return { outcome: "cancelled" as const, deletedProfile: false };
        }

        const profile = await tx.assistantProfile.findFirstOrThrow({
            where: { id: found.profileId },
            select: { id: true, currentVersionId: true },
        });
        const [versionCount, otherImports] = await Promise.all([
            tx.assistantProfileVersion.count({ where: { profileId: profile.id } }),
            tx.assistantProfileImport.count({
                where: { profileId: profile.id, id: { not: found.id } },
            }),
        ]);
        const verdict = judgeCreateCleanup({
            importStatus: "staging",
            importMode: found.mode,
            importProfileId: found.profileId,
            profileId: profile.id,
            profileCurrentVersionId: profile.currentVersionId,
            profileVersionCount: versionCount,
            otherImportsForProfile: otherImports,
        });
        if (verdict.outcome === "refuse") {
            // Nothing is deleted, including the tombstones queued above --
            // this whole function is one transaction, so the refusal rolls
            // them back with everything else.
            throw new AssistantProfileImportError(
                409,
                "ASSISTANT_PROFILE_IMPORT_CLEANUP_REFUSED",
                `This import cannot be cancelled automatically: ${verdict.reasons.join(", ")}.`
            );
        }

        // The profile cascade takes the import row, its files and their chunks.
        await tx.assistantProfile.delete({ where: { id: profile.id } });
        return { outcome: "cancelled" as const, deletedProfile: true };
    });
}
