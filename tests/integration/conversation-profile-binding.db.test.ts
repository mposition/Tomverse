import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { ASSISTANT_PROFILES_FLAG_KEY } from "@/lib/assistantProfileAccess";
import { ASSISTANT_PROMPT_FORMAT_VERSION } from "@/lib/assistantProfileVersioning";
import {
    ConversationProfileError,
    readConversationProfile,
    resolveProfileBinding,
} from "@/lib/conversationProfileService";
import { prisma } from "@/lib/prisma";

/**
 * Release C4's pinning against a real database.
 *
 * The planner already decides what should happen. What only a database
 * settles is which rows the resolver reads: that a profile belonging to
 * another account is invisible rather than forbidden, that "the current
 * version" is read at bind time rather than remembered, and that a
 * conversation left on an older revision still reports which one it is on
 * after the owner publishes past it.
 */

const MODEL_ID = "gpt-5-6-luna";

const reset = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AssistantProfileVersion",
      "AssistantProfile",
      "Conversation"
    RESTART IDENTITY CASCADE
  `);
    await prisma.appSetting.deleteMany({
        where: { key: ASSISTANT_PROFILES_FLAG_KEY },
    });
};

const setFlag = (value: boolean) =>
    prisma.appSetting.upsert({
        where: { key: ASSISTANT_PROFILES_FLAG_KEY },
        create: { key: ASSISTANT_PROFILES_FLAG_KEY, value: String(value) },
        update: { value: String(value) },
    });

const createUser = () =>
    prisma.user.create({
        data: { email: `conv-profile-${randomUUID()}@example.test` },
    });

const publishRevision = async (input: {
    userId: string;
    profileId: string;
    revision: number;
    modelIds?: string[];
    starters?: string[];
}) => {
    const version = await prisma.assistantProfileVersion.create({
        data: {
            profileId: input.profileId,
            userId: input.userId,
            revision: input.revision,
            instructions: `Revision ${input.revision} instructions.`,
            models: input.modelIds ?? [MODEL_ID],
            toolPolicy: { webSearch: false, deepResearch: false },
            memoryPolicy: { useAccountMemory: false },
            starters: input.starters ?? [],
            knowledgeManifest: [],
            retrievalVersion: 1,
            promptFormatVersion: ASSISTANT_PROMPT_FORMAT_VERSION,
        },
    });
    await prisma.assistantProfile.update({
        where: { id: input.profileId },
        data: { currentVersionId: version.id },
    });
    return version;
};

const createProfile = async (userId: string, name = "Scheduler") => {
    const profile = await prisma.assistantProfile.create({
        data: { userId, name, icon: "🧭" },
    });
    const version = await publishRevision({
        userId,
        profileId: profile.id,
        revision: 1,
        starters: ["오늘 일정 정리해줘"],
    });
    return { profile, version };
};

beforeEach(async () => {
    await reset();
    await setFlag(true);
});
after(async () => {
    await reset();
    await prisma.$disconnect();
});

test("binding reads the profile's current version at bind time", async () => {
    const user = await createUser();
    const { profile, version } = await createProfile(user.id);

    const plan = await resolveProfileBinding({
        userId: user.id,
        requestedProfileId: profile.id,
        boundProfileId: null,
    });

    assert.equal(plan.outcome, "bind");
    if (plan.outcome !== "bind") return;
    assert.equal(plan.profileVersionId, version.id);
    assert.equal(plan.revision, 1);
    assert.deepEqual([...plan.modelIds], [MODEL_ID]);
});

test("another account's profile is not found, not forbidden", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const { profile } = await createProfile(owner.id);

    await assert.rejects(
        () =>
            resolveProfileBinding({
                userId: stranger.id,
                requestedProfileId: profile.id,
                boundProfileId: null,
            }),
        (error: unknown) =>
            error instanceof ConversationProfileError &&
            error.status === 404 &&
            error.code === "ASSISTANT_PROFILE_NOT_FOUND"
    );
});

test("a profile that has never published is refused", async () => {
    const user = await createUser();
    const profile = await prisma.assistantProfile.create({
        data: { userId: user.id, name: "Draft" },
    });

    await assert.rejects(
        () =>
            resolveProfileBinding({
                userId: user.id,
                requestedProfileId: profile.id,
                boundProfileId: null,
            }),
        (error: unknown) =>
            error instanceof ConversationProfileError &&
            error.status === 409 &&
            error.code === "ASSISTANT_PROFILE_NO_ACTIVE_VERSION"
    );
});

test("the flag refuses a bind but never traps an existing one", async () => {
    const user = await createUser();
    const { profile } = await createProfile(user.id);
    await setFlag(false);

    await assert.rejects(
        () =>
            resolveProfileBinding({
                userId: user.id,
                requestedProfileId: profile.id,
                boundProfileId: null,
            }),
        (error: unknown) =>
            error instanceof ConversationProfileError && error.status === 403
    );

    // Detaching still works: a rollout control must not leave an account with
    // conversations it cannot take the assistant off.
    assert.deepEqual(
        await resolveProfileBinding({
            userId: user.id,
            requestedProfileId: null,
            boundProfileId: profile.id,
        }),
        { outcome: "detach" }
    );
});

/* ------------------------------------------------- what a screen reads */

test("a bound conversation reports its revision and its starters", async () => {
    const user = await createUser();
    const { profile, version } = await createProfile(user.id);

    const summary = await readConversationProfile({
        userId: user.id,
        profileVersionId: version.id,
    });

    assert.equal(summary?.profileId, profile.id);
    assert.equal(summary?.name, "Scheduler");
    assert.equal(summary?.icon, "🧭");
    assert.equal(summary?.revision, 1);
    assert.equal(summary?.latestRevision, 1);
    assert.equal(summary?.status, "current");
    assert.deepEqual(summary?.starters, ["오늘 일정 정리해줘"]);
});

test("publishing past a conversation leaves it on its own revision", async () => {
    // §14's whole point: the conversation keeps answering under the revision
    // it started with, and the screen is told a newer one exists rather than
    // being moved onto it.
    const user = await createUser();
    const { profile, version } = await createProfile(user.id);
    await publishRevision({
        userId: user.id,
        profileId: profile.id,
        revision: 2,
    });

    const summary = await readConversationProfile({
        userId: user.id,
        profileVersionId: version.id,
    });

    assert.equal(summary?.revision, 1);
    assert.equal(summary?.latestRevision, 2);
    assert.equal(summary?.status, "superseded");
    // The pinned version's own starters, not the new revision's.
    assert.deepEqual(summary?.starters, ["오늘 일정 정리해줘"]);
});

test("re-binding the same profile moves the pin forward", async () => {
    const user = await createUser();
    const { profile } = await createProfile(user.id);
    const next = await publishRevision({
        userId: user.id,
        profileId: profile.id,
        revision: 2,
    });

    const plan = await resolveProfileBinding({
        userId: user.id,
        requestedProfileId: profile.id,
        boundProfileId: profile.id,
    });

    assert.equal(plan.outcome, "bind");
    if (plan.outcome !== "bind") return;
    assert.equal(plan.profileVersionId, next.id);
    assert.equal(plan.revision, 2);
});

test("a version another account owns is never summarised", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const { version } = await createProfile(owner.id);

    assert.equal(
        await readConversationProfile({
            userId: stranger.id,
            profileVersionId: version.id,
        }),
        null
    );
});

test("deleting the profile leaves the conversation readable and unbound", async () => {
    // The column is SetNull on delete, so a deleted profile is an absent
    // binding rather than a dangling id -- and the conversation survives.
    const user = await createUser();
    const { profile, version } = await createProfile(user.id);
    const conversation = await prisma.conversation.create({
        data: {
            userId: user.id,
            title: "Planning",
            assistantProfileVersionId: version.id,
        },
    });

    await prisma.assistantProfile.delete({ where: { id: profile.id } });

    const row = await prisma.conversation.findUnique({
        where: { id: conversation.id },
        select: { assistantProfileVersionId: true },
    });
    assert.equal(row?.assistantProfileVersionId, null);
    assert.equal(
        await readConversationProfile({
            userId: user.id,
            profileVersionId: row?.assistantProfileVersionId ?? null,
        }),
        null
    );
});
