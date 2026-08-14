import "server-only";

import type { Prisma } from "@prisma/client";
import { enqueueKnowledgeCleanupForFiles } from "@/lib/assistantKnowledgeLifecycle";
// `maxProfilesPerAccount` is a profile figure that §14.1 settled in the same
// approved table as the knowledge quotas, so it lives with them. Imported
// rather than copied: two constants for one approved number is how they drift.
import { ASSISTANT_KNOWLEDGE_LIMITS } from "@/lib/assistantKnowledgeLimits";
import {
    ASSISTANT_PROMPT_FORMAT_VERSION,
    ASSISTANT_RETRIEVAL_VERSION,
    normalizeProfileIdentity,
    planProfileVersionPublish,
    profileIdentityProblems,
    type AssistantProfileIdentityDraft,
    type AssistantProfileVersionDraft,
} from "@/lib/assistantProfileVersioning";
import { prisma } from "@/lib/prisma";

/**
 * Creating, editing and publishing assistant profiles (Release C, C3a).
 *
 * docs/policy/external-conversation-import-and-memory.md §14, §18 (릴리스 C),
 * §21, §43.
 *
 * The division of labour is the same one C1 set up and is worth keeping:
 * `lib/assistantProfileVersioning.ts` decides *what the next snapshot should
 * be* — including whether there should be one at all — and this module does
 * the reading and writing. Nothing here re-derives a revision number or
 * re-implements the staleness rule; it calls the planner and acts on the
 * answer.
 */

export class AssistantProfileError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        /** Field-level problems, when the refusal is a validation one. */
        public readonly problems?: { field: string; reason: string }[]
    ) {
        super(message);
        this.name = "AssistantProfileError";
    }
}

/**
 * A function declaration rather than an arrow, so TypeScript narrows the
 * caller's `profile` after `if (!profile) notFound();`. An arrow typed
 * `(): never` does not do that, and the alternative is a `throw` repeated at
 * every call site.
 */
function notFound(): never {
    // 404 rather than 403 throughout: a profile the caller does not own is,
    // as far as they are entitled to know, a profile that does not exist.
    throw new AssistantProfileError(
        404,
        "ASSISTANT_PROFILE_NOT_FOUND",
        "No such profile."
    );
}

/** The shape the owner's own screens read. Never another account's. */
const PROFILE_SELECT = {
    id: true,
    name: true,
    icon: true,
    description: true,
    currentVersionId: true,
    createdAt: true,
    updatedAt: true,
} satisfies Prisma.AssistantProfileSelect;

const VERSION_SELECT = {
    id: true,
    revision: true,
    instructions: true,
    models: true,
    toolPolicy: true,
    memoryPolicy: true,
    starters: true,
    knowledgeManifest: true,
    retrievalVersion: true,
    promptFormatVersion: true,
    createdAt: true,
} satisfies Prisma.AssistantProfileVersionSelect;

export const listAssistantProfiles = async (userId: string) => {
    const profiles = await prisma.assistantProfile.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        select: {
            ...PROFILE_SELECT,
            currentVersion: { select: { revision: true, createdAt: true } },
            _count: { select: { versions: true, knowledgeFiles: true } },
        },
    });
    return profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        icon: profile.icon,
        description: profile.description,
        // A profile with no published version is a draft that cannot start a
        // conversation. Reported as its own state rather than as revision 0,
        // so a screen does not have to infer it from a null.
        published: profile.currentVersionId != null,
        currentRevision: profile.currentVersion?.revision ?? null,
        publishedAt: profile.currentVersion?.createdAt ?? null,
        versionCount: profile._count.versions,
        knowledgeFileCount: profile._count.knowledgeFiles,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
    }));
};

export const createAssistantProfile = async (input: {
    userId: string;
    identity: AssistantProfileIdentityDraft;
}) => {
    const identity = normalizeProfileIdentity(input.identity);
    const problems = profileIdentityProblems(identity);
    if (problems.length > 0) {
        throw new AssistantProfileError(
            422,
            "ASSISTANT_PROFILE_INVALID",
            "The profile could not be saved.",
            problems
        );
    }

    const count = await prisma.assistantProfile.count({
        where: { userId: input.userId },
    });
    if (count >= ASSISTANT_KNOWLEDGE_LIMITS.maxProfilesPerAccount) {
        throw new AssistantProfileError(
            409,
            "ASSISTANT_PROFILE_QUOTA_EXCEEDED",
            `This account already has ${ASSISTANT_KNOWLEDGE_LIMITS.maxProfilesPerAccount} profiles.`
        );
    }

    return prisma.assistantProfile.create({
        data: {
            userId: input.userId,
            name: identity.name,
            icon: identity.icon,
            description: identity.description,
        },
        select: PROFILE_SELECT,
    });
};

/** One profile with its published version and its version history. */
export const readAssistantProfile = async (
    userId: string,
    profileId: string
) => {
    const profile = await prisma.assistantProfile.findFirst({
        where: { id: profileId, userId },
        select: {
            ...PROFILE_SELECT,
            currentVersion: { select: VERSION_SELECT },
            versions: {
                orderBy: { revision: "desc" },
                take: 50,
                select: { id: true, revision: true, createdAt: true },
            },
            knowledgeFiles: {
                orderBy: { createdAt: "asc" },
                select: {
                    id: true,
                    name: true,
                    mime: true,
                    bytes: true,
                    processingStatus: true,
                    failureCode: true,
                    chunkCount: true,
                    createdAt: true,
                },
            },
        },
    });
    if (!profile) notFound();
    return profile;
};

/**
 * Renames or re-describes a profile. Identity only.
 *
 * Deliberately cannot touch instructions, models, tools, memory policy or
 * starters: those are a version's, and changing one has to publish a revision
 * so the conversations pinned to the old one keep saying what they ran under
 * (§43). A PATCH that could edit them would be exactly the retroactive change
 * the version table exists to prevent.
 */
export const updateAssistantProfileIdentity = async (input: {
    userId: string;
    profileId: string;
    identity: AssistantProfileIdentityDraft;
}) => {
    const existing = await prisma.assistantProfile.findFirst({
        where: { id: input.profileId, userId: input.userId },
        select: { id: true },
    });
    if (!existing) notFound();

    const identity = normalizeProfileIdentity(input.identity);
    const problems = profileIdentityProblems(identity);
    if (problems.length > 0) {
        throw new AssistantProfileError(
            422,
            "ASSISTANT_PROFILE_INVALID",
            "The profile could not be saved.",
            problems
        );
    }

    return prisma.assistantProfile.update({
        where: { id: input.profileId },
        data: {
            name: identity.name,
            icon: identity.icon,
            description: identity.description,
        },
        select: PROFILE_SELECT,
    });
};

export type PublishOutcome =
    | { outcome: "published"; version: { id: string; revision: number } }
    | { outcome: "unchanged"; revision: number };

/**
 * Publishes a new version, or reports that nothing changed.
 *
 * The write is one transaction over an insert and a pointer move, because a
 * version that exists and is not current is a revision the owner cannot see
 * and cannot use — and the `(profileId, revision)` unique index means two
 * concurrent publishes from the same revision race there, with the loser
 * getting a conflict rather than a second row.
 */
export const publishAssistantProfileVersion = async (input: {
    userId: string;
    profileId: string;
    draft: AssistantProfileVersionDraft;
    /** The revision the editor started from; null when publishing the first. */
    expectedRevision: number | null;
}): Promise<PublishOutcome> => {
    const profile = await prisma.assistantProfile.findFirst({
        where: { id: input.profileId, userId: input.userId },
        select: {
            id: true,
            currentVersion: { select: VERSION_SELECT },
        },
    });
    if (!profile) notFound();

    const current = profile.currentVersion;
    const plan = planProfileVersionPublish({
        state: {
            currentRevision: current?.revision ?? null,
            currentDraft: current
                ? {
                      instructions: current.instructions,
                      modelIds: current.models as unknown as string[],
                      toolPolicy:
                          current.toolPolicy as unknown as AssistantProfileVersionDraft["toolPolicy"],
                      memoryPolicy:
                          current.memoryPolicy as unknown as AssistantProfileVersionDraft["memoryPolicy"],
                      starters: current.starters as unknown as string[],
                      // Prisma types a Json column as JsonValue, which has no
                      // overlap with the draft's shape; the double cast is the
                      // only way to say "this column holds what we wrote".
                      knowledgeManifest:
                          current.knowledgeManifest as unknown as AssistantProfileVersionDraft["knowledgeManifest"],
                  }
                : null,
        },
        draft: input.draft,
        expectedRevision: input.expectedRevision,
    });

    if (plan.outcome === "stale") {
        throw new AssistantProfileError(
            409,
            plan.code,
            "This profile changed while you were editing it. Reload before publishing again."
        );
    }
    if (plan.outcome === "invalid") {
        throw new AssistantProfileError(
            422,
            "ASSISTANT_PROFILE_INVALID",
            "The profile could not be published.",
            plan.problems
        );
    }
    if (plan.outcome === "unchanged") {
        return { outcome: "unchanged", revision: plan.revision };
    }

    // Every file the manifest names must be one of this profile's own, and
    // must exist right now. A manifest is otherwise a place to write an id
    // and have a later runtime resolve it -- which is the one thing §14 says
    // a manifest may not do.
    const manifestIds = plan.draft.knowledgeManifest.map((entry) => entry.fileId);
    if (manifestIds.length > 0) {
        const owned = await prisma.assistantKnowledgeFile.findMany({
            where: {
                id: { in: manifestIds },
                userId: input.userId,
                profileId: input.profileId,
            },
            select: { id: true },
        });
        if (owned.length !== manifestIds.length) {
            throw new AssistantProfileError(
                422,
                "ASSISTANT_PROFILE_INVALID",
                "The profile could not be published.",
                [
                    {
                        field: "knowledgeManifest",
                        reason: "names a file this profile does not have",
                    },
                ]
            );
        }
    }

    const version = await prisma.$transaction(async (tx) => {
        const created = await tx.assistantProfileVersion.create({
            data: {
                profileId: input.profileId,
                userId: input.userId,
                revision: plan.revision,
                instructions: plan.draft.instructions,
                models: [...plan.draft.modelIds],
                toolPolicy: { ...plan.draft.toolPolicy },
                memoryPolicy: { ...plan.draft.memoryPolicy },
                starters: [...plan.draft.starters],
                knowledgeManifest: plan.draft.knowledgeManifest.map((entry) => ({
                    ...entry,
                })),
                retrievalVersion: ASSISTANT_RETRIEVAL_VERSION,
                promptFormatVersion: ASSISTANT_PROMPT_FORMAT_VERSION,
            },
            select: { id: true, revision: true },
        });
        await tx.assistantProfile.update({
            where: { id: input.profileId },
            data: { currentVersionId: created.id },
        });
        return created;
    });

    return { outcome: "published", version };
};

/**
 * Deletes a profile, its versions, its knowledge rows and the bytes behind
 * them.
 *
 * The cascade takes the rows; the tombstone is what gets R2 emptied, and it is
 * written in the same transaction for §14.2's reason — bytes are never deleted
 * ahead of the database. Conversations pinned to a deleted version survive
 * unpinned, which the schema's `SetNull` already guarantees and a DB test
 * pins.
 */
export const deleteAssistantProfile = async (input: {
    userId: string;
    profileId: string;
}) => {
    const profile = await prisma.assistantProfile.findFirst({
        where: { id: input.profileId, userId: input.userId },
        select: { id: true },
    });
    if (!profile) notFound();

    await prisma.$transaction(async (tx) => {
        await enqueueKnowledgeCleanupForFiles(
            tx,
            { profileId: input.profileId },
            "profile_deleted"
        );
        await tx.assistantProfile.delete({ where: { id: input.profileId } });
    });

    return { deleted: true };
};

/**
 * The version a conversation should pin to when it starts under this profile.
 *
 * Returns null when the profile has no published version. The caller refuses
 * the turn rather than starting one against a draft — `decideProfileRuntime`
 * carries that as `no_active_version`.
 */
export const activeProfileVersion = async (
    userId: string,
    profileId: string
) => {
    const profile = await prisma.assistantProfile.findFirst({
        where: { id: profileId, userId },
        select: { currentVersion: { select: VERSION_SELECT } },
    });
    if (!profile) notFound();
    return profile.currentVersion ?? null;
};
