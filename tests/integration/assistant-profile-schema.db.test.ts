import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { prisma } from "@/lib/prisma";

/**
 * Release C storage invariants (slice C1) against a real database.
 *
 * docs/policy/external-conversation-import-and-memory.md §14, §20 (릴리스 C),
 * §43. `lib/assistantProfileVersioning.ts` decides what the next snapshot
 * should be; this file is about what the database refuses regardless of what
 * the application layer believed — the half that still holds when a second
 * writer, a retry, or a future code path gets it wrong.
 *
 * Four things are settled here:
 *   - a revision number is unique per profile, so two editors publishing from
 *     the same revision cannot both succeed;
 *   - a revision is 1-based and positive, so "the newest revision" is never
 *     ambiguous;
 *   - deleting a profile takes its versions with it, and deleting the account
 *     takes the profiles;
 *   - a conversation pinned to a version survives that version's disappearance
 *     as an unpinned conversation, not as a broken row or a deleted one.
 */

const resetProfileData = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AssistantProfileVersion",
      "AssistantProfile",
      "Conversation"
    RESTART IDENTITY CASCADE
  `);
};

const createUser = () =>
    prisma.user.create({
        data: { email: `assistant-profile-${randomUUID()}@example.test` },
    });

const createProfile = (userId: string) =>
    prisma.assistantProfile.create({ data: { userId, name: "Helper" } });

const versionData = (profileId: string, userId: string, revision: number) => ({
    profileId,
    userId,
    revision,
    instructions: "Answer in Korean.",
    models: ["gpt-5-6-luna"],
    toolPolicy: { webSearch: false, deepResearch: false },
    memoryPolicy: { useAccountMemory: true },
    starters: [],
    knowledgeManifest: [],
    retrievalVersion: 1,
    promptFormatVersion: "assistant-profile-v1",
});

beforeEach(resetProfileData);
after(async () => {
    await resetProfileData();
    await prisma.$disconnect();
});

test("two publishes of the same revision cannot both win", async () => {
    const user = await createUser();
    const profile = await createProfile(user.id);
    await prisma.assistantProfileVersion.create({
        data: versionData(profile.id, user.id, 1),
    });

    // This is the shape of a stale editor that got past the application check
    // -- two tabs reading revision 0 at the same moment, both computing 1.
    await assert.rejects(
        prisma.assistantProfileVersion.create({
            data: versionData(profile.id, user.id, 1),
        }),
        /Unique constraint|P2002/
    );

    // The same revision number under a *different* profile is fine: the
    // uniqueness is per profile, not global.
    const other = await createProfile(user.id);
    await prisma.assistantProfileVersion.create({
        data: versionData(other.id, user.id, 1),
    });
});

test("a revision below 1 is refused by the database", async () => {
    const user = await createUser();
    const profile = await createProfile(user.id);
    for (const revision of [0, -1]) {
        await assert.rejects(
            prisma.assistantProfileVersion.create({
                data: versionData(profile.id, user.id, revision),
            }),
            /revision_positive|constraint/i,
            `revision ${revision} was accepted`
        );
    }
});

test("a retrieval version below 1 is refused", async () => {
    const user = await createUser();
    const profile = await createProfile(user.id);
    await assert.rejects(
        prisma.assistantProfileVersion.create({
            data: { ...versionData(profile.id, user.id, 1), retrievalVersion: 0 },
        }),
        /retrievalVersion_positive|constraint/i
    );
});

test("only one profile may point at a given version", async () => {
    const user = await createUser();
    const profile = await createProfile(user.id);
    const version = await prisma.assistantProfileVersion.create({
        data: versionData(profile.id, user.id, 1),
    });
    await prisma.assistantProfile.update({
        where: { id: profile.id },
        data: { currentVersionId: version.id },
    });
    const other = await createProfile(user.id);
    await assert.rejects(
        prisma.assistantProfile.update({
            where: { id: other.id },
            data: { currentVersionId: version.id },
        }),
        /Unique constraint|P2002/
    );
});

test("deleting a profile removes its versions; deleting the account removes the profiles", async () => {
    const user = await createUser();
    const profile = await createProfile(user.id);
    const version = await prisma.assistantProfileVersion.create({
        data: versionData(profile.id, user.id, 1),
    });
    await prisma.assistantProfile.update({
        where: { id: profile.id },
        data: { currentVersionId: version.id },
    });

    await prisma.assistantProfile.delete({ where: { id: profile.id } });
    assert.equal(
        await prisma.assistantProfileVersion.count({
            where: { profileId: profile.id },
        }),
        0
    );

    const second = await createProfile(user.id);
    await prisma.assistantProfileVersion.create({
        data: versionData(second.id, user.id, 1),
    });
    await prisma.user.delete({ where: { id: user.id } });
    assert.equal(await prisma.assistantProfile.count({ where: { userId: user.id } }), 0);
    assert.equal(
        await prisma.assistantProfileVersion.count({ where: { profileId: second.id } }),
        0
    );
});

test("a conversation pinned to a deleted profile survives, unpinned", async () => {
    // §14 makes deleting a profile a deletion request. The conversation is
    // separate user data and stays readable; it simply stops naming a profile.
    const user = await createUser();
    const profile = await createProfile(user.id);
    const version = await prisma.assistantProfileVersion.create({
        data: versionData(profile.id, user.id, 1),
    });
    const conversation = await prisma.conversation.create({
        data: {
            userId: user.id,
            title: "Pinned",
            assistantProfileVersionId: version.id,
        },
    });

    await prisma.assistantProfile.delete({ where: { id: profile.id } });

    const after = await prisma.conversation.findUnique({
        where: { id: conversation.id },
        select: { id: true, assistantProfileVersionId: true },
    });
    assert.ok(after, "the conversation was deleted with the profile");
    assert.equal(after.assistantProfileVersionId, null);
});

test("a version is reachable by its own owner column, not only through its profile", async () => {
    // The account export and the data-domain registry both read ownership off
    // this column. A version whose owner had to be derived by joining the
    // profile is a row the export would miss the day somebody writes the query
    // the obvious way.
    const owner = await createUser();
    const stranger = await createUser();
    const profile = await createProfile(owner.id);
    await prisma.assistantProfileVersion.create({
        data: versionData(profile.id, owner.id, 1),
    });

    assert.equal(
        await prisma.assistantProfileVersion.count({ where: { userId: owner.id } }),
        1
    );
    assert.equal(
        await prisma.assistantProfileVersion.count({ where: { userId: stranger.id } }),
        0
    );

    // Deleting the account reaches the versions through this column as well as
    // through the profile, so neither path alone is what makes the cascade
    // true.
    await prisma.user.delete({ where: { id: owner.id } });
    assert.equal(
        await prisma.assistantProfileVersion.count({ where: { userId: owner.id } }),
        0
    );
});

test("an existing conversation is unpinned, which is what every row before release C is", async () => {
    const user = await createUser();
    const conversation = await prisma.conversation.create({
        data: { userId: user.id, title: "Ordinary" },
    });
    assert.equal(
        (
            await prisma.conversation.findUniqueOrThrow({
                where: { id: conversation.id },
                select: { assistantProfileVersionId: true },
            })
        ).assistantProfileVersionId,
        null
    );
});
