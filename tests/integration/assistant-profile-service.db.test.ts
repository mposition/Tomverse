import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import {
    AssistantProfileError,
    activeProfileVersion,
    createAssistantProfile,
    deleteAssistantProfile,
    listAssistantProfiles,
    publishAssistantProfileVersion,
    readAssistantProfile,
    updateAssistantProfileIdentity,
} from "@/lib/assistantProfileService";
import { ASSISTANT_PROFILE_LIMITS } from "@/lib/assistantProfileVersioning";
import { prisma } from "@/lib/prisma";

/**
 * Release C3a's service against a real database.
 *
 * The pure planner already decides revisions and staleness; what only a
 * database settles is whether the write path honours those decisions, whether
 * an owner boundary holds when a caller supplies somebody else's id, and
 * whether publishing is actually atomic — a version that exists but is not
 * current is a revision the owner can neither see nor use.
 */

const resetProfileData = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AssistantKnowledgeChunk",
      "AssistantKnowledgeFile",
      "AssistantKnowledgeCleanup",
      "AssistantProfileVersion",
      "AssistantProfile",
      "Conversation"
    RESTART IDENTITY CASCADE
  `);
};

const createUser = () =>
    prisma.user.create({
        data: { email: `profile-service-${randomUUID()}@example.test` },
    });

const identity = (name = "Helper") => ({
    name,
    icon: "🧭",
    description: "Answers scheduling questions.",
});

const draft = (overrides: Record<string, unknown> = {}) => ({
    instructions: "Answer in Korean, and prefer short examples.",
    modelIds: ["gpt-5-6-luna"],
    toolPolicy: { webSearch: false, deepResearch: false },
    memoryPolicy: { useAccountMemory: true },
    starters: ["오늘 일정 정리해줘"],
    knowledgeManifest: [],
    ...overrides,
});

const storeKnowledgeFile = (userId: string, profileId: string) =>
    prisma.assistantKnowledgeFile.create({
        data: {
            profileId,
            userId,
            name: "handbook.txt",
            mime: "text/plain",
            bytes: 1_024,
            digest: `sha256-${randomUUID()}`,
            r2Key: `assistant-knowledge/${randomUUID()}`,
            processingStatus: "ready",
            extractedCharacters: 500,
            chunkCount: 1,
        },
    });

beforeEach(resetProfileData);
after(async () => {
    await resetProfileData();
    await prisma.$disconnect();
});

/* ------------------------------------------------------- publish flow */

test("a profile starts unpublished and cannot start a conversation", async () => {
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: identity(),
    });
    assert.equal(profile.currentVersionId, null);
    assert.equal(await activeProfileVersion(user.id, profile.id), null);

    const [listed] = await listAssistantProfiles(user.id);
    assert.equal(listed.published, false);
    assert.equal(listed.currentRevision, null);
});

test("publishing moves the pointer and the version becomes active", async () => {
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: identity(),
    });
    const result = await publishAssistantProfileVersion({
        userId: user.id,
        profileId: profile.id,
        draft: draft(),
        expectedRevision: null,
    });
    assert.ok(result.outcome === "published");
    assert.equal(result.version.revision, 1);

    const active = await activeProfileVersion(user.id, profile.id);
    assert.equal(active?.id, result.version.id);
    assert.equal(active?.revision, 1);
    assert.equal(active?.promptFormatVersion, "assistant-profile-v1");
});

test("an edit publishes revision 2 and leaves revision 1 readable", async () => {
    // Policy: docs/policy/external-conversation-import-and-memory.md.
    // §14's whole point: a conversation pinned to revision 1 keeps saying what
    // it ran under.
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: identity(),
    });
    const first = await publishAssistantProfileVersion({
        userId: user.id,
        profileId: profile.id,
        draft: draft(),
        expectedRevision: null,
    });
    // `assert.ok` narrows the union, so the reads below are the compiler
    // agreeing that a published outcome carries a version rather than a cast.
    assert.ok(first.outcome === "published");
    const second = await publishAssistantProfileVersion({
        userId: user.id,
        profileId: profile.id,
        draft: draft({ instructions: "Answer in Korean, with longer examples." }),
        expectedRevision: 1,
    });
    assert.ok(second.outcome === "published");
    assert.equal(second.version.revision, 2);

    const original = await prisma.assistantProfileVersion.findUniqueOrThrow({
        where: { id: first.version.id },
        select: { instructions: true, revision: true },
    });
    assert.equal(original.revision, 1);
    assert.match(original.instructions, /short examples/);
});

test("republishing identical content writes no row", async () => {
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: identity(),
    });
    await publishAssistantProfileVersion({
        userId: user.id,
        profileId: profile.id,
        draft: draft(),
        expectedRevision: null,
    });
    const again = await publishAssistantProfileVersion({
        userId: user.id,
        profileId: profile.id,
        draft: draft(),
        expectedRevision: 1,
    });
    assert.ok(again.outcome === "unchanged");
    assert.equal(
        await prisma.assistantProfileVersion.count({
            where: { profileId: profile.id },
        }),
        1
    );
});

test("a stale editor is refused and writes nothing", async () => {
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: identity(),
    });
    await publishAssistantProfileVersion({
        userId: user.id,
        profileId: profile.id,
        draft: draft(),
        expectedRevision: null,
    });
    await publishAssistantProfileVersion({
        userId: user.id,
        profileId: profile.id,
        draft: draft({ instructions: "Second." }),
        expectedRevision: 1,
    });

    await assert.rejects(
        publishAssistantProfileVersion({
            userId: user.id,
            profileId: profile.id,
            draft: draft({ instructions: "From a tab that never saw revision 2." }),
            expectedRevision: 1,
        }),
        (error: unknown) =>
            error instanceof AssistantProfileError &&
            error.status === 409 &&
            error.code === "ASSISTANT_PROFILE_VERSION_STALE"
    );
    assert.equal(
        await prisma.assistantProfileVersion.count({
            where: { profileId: profile.id },
        }),
        2
    );
});

/* --------------------------------------------------------- the manifest */

test("a manifest may only name this profile's own files", async () => {
    // Otherwise a manifest is a place to write an id and have a later runtime
    // resolve it, which is the one thing §14 says a manifest may not do.
    const owner = await createUser();
    const stranger = await createUser();
    const profile = await createAssistantProfile({
        userId: owner.id,
        identity: identity(),
    });
    const otherProfile = await createAssistantProfile({
        userId: owner.id,
        identity: identity("Other"),
    });
    const strangerProfile = await createAssistantProfile({
        userId: stranger.id,
        identity: identity("Theirs"),
    });

    const own = await storeKnowledgeFile(owner.id, profile.id);
    const otherProfileFile = await storeKnowledgeFile(owner.id, otherProfile.id);
    const strangerFile = await storeKnowledgeFile(
        stranger.id,
        strangerProfile.id
    );

    // Only the id is load-bearing: the service replaces name and digest from
    // the rows, which the next test asserts.
    const entry = (fileId: string) => ({
        fileId,
        name: "ignored",
        digest: "ignored",
    });

    // The profile's own file is fine.
    const ok = await publishAssistantProfileVersion({
        userId: owner.id,
        profileId: profile.id,
        draft: draft({ knowledgeManifest: [entry(own.id)] }),
        expectedRevision: null,
    });
    assert.equal(ok.outcome, "published");

    // Another of the owner's profiles, and another account's, are both refused.
    for (const fileId of [otherProfileFile.id, strangerFile.id, "f-nonexistent"]) {
        await assert.rejects(
            publishAssistantProfileVersion({
                userId: owner.id,
                profileId: profile.id,
                draft: draft({
                    instructions: `naming ${fileId}`,
                    knowledgeManifest: [entry(fileId)],
                }),
                expectedRevision: 1,
            }),
            (error: unknown) =>
                error instanceof AssistantProfileError && error.status === 422,
            `${fileId} was accepted into the manifest`
        );
    }
});

test("the stored manifest carries the row's digest, not the client's", async () => {
    // The digest is what `resolveKnowledgeManifest()` compares a past version
    // against. If a caller could supply it, a caller could decide what a past
    // version is said to have contained -- and a client that simply got it
    // wrong would make every entry of that version read as unavailable.
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: identity(),
    });
    const file = await storeKnowledgeFile(user.id, profile.id);

    await publishAssistantProfileVersion({
        userId: user.id,
        profileId: profile.id,
        draft: draft({
            knowledgeManifest: [
                { fileId: file.id, name: "a name the client chose", digest: "sha256-lie" },
            ],
        }),
        expectedRevision: null,
    });

    const active = await activeProfileVersion(user.id, profile.id);
    assert.deepEqual(active!.knowledgeManifest, [
        { fileId: file.id, name: file.name, digest: file.digest },
    ]);
});

test("republishing the same file selection creates no revision", async () => {
    // The manifest is resolved before the planner compares drafts. Resolving
    // it afterwards would leave the planner comparing blank digests against
    // stored ones, so every Save would publish a revision that changed
    // nothing -- and every one of those is a snapshot a conversation could pin
    // to.
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: identity(),
    });
    const file = await storeKnowledgeFile(user.id, profile.id);
    const withFile = draft({
        knowledgeManifest: [{ fileId: file.id, name: "x", digest: "y" }],
    });

    await publishAssistantProfileVersion({
        userId: user.id,
        profileId: profile.id,
        draft: withFile,
        expectedRevision: null,
    });
    const again = await publishAssistantProfileVersion({
        userId: user.id,
        profileId: profile.id,
        draft: withFile,
        expectedRevision: 1,
    });
    assert.ok(again.outcome === "unchanged");
    assert.equal(
        await prisma.assistantProfileVersion.count({
            where: { profileId: profile.id },
        }),
        1
    );
});

/* ----------------------------------------------------- owner boundaries */

test("every entry point refuses another account's profile as not found", async () => {
    // 404 rather than 403: a profile the caller does not own is, as far as
    // they are entitled to know, one that does not exist.
    const owner = await createUser();
    const stranger = await createUser();
    const profile = await createAssistantProfile({
        userId: owner.id,
        identity: identity(),
    });

    const notFound = (error: unknown) =>
        error instanceof AssistantProfileError && error.status === 404;

    await assert.rejects(readAssistantProfile(stranger.id, profile.id), notFound);
    await assert.rejects(
        updateAssistantProfileIdentity({
            userId: stranger.id,
            profileId: profile.id,
            identity: identity("Renamed"),
        }),
        notFound
    );
    await assert.rejects(
        publishAssistantProfileVersion({
            userId: stranger.id,
            profileId: profile.id,
            draft: draft(),
            expectedRevision: null,
        }),
        notFound
    );
    await assert.rejects(
        deleteAssistantProfile({ userId: stranger.id, profileId: profile.id }),
        notFound
    );
    await assert.rejects(activeProfileVersion(stranger.id, profile.id), notFound);

    // And nothing about it changed.
    const still = await readAssistantProfile(owner.id, profile.id);
    assert.equal(still.name, "Helper");
});

test("a rename cannot reach a version's behaviour", async () => {
    // The signature has no field for instructions, so this asserts the shape
    // rather than a filter -- a PATCH that could edit them would be the
    // retroactive change the version table exists to prevent.
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: identity(),
    });
    await publishAssistantProfileVersion({
        userId: user.id,
        profileId: profile.id,
        draft: draft(),
        expectedRevision: null,
    });
    await updateAssistantProfileIdentity({
        userId: user.id,
        profileId: profile.id,
        identity: identity("Renamed"),
    });

    const active = await activeProfileVersion(user.id, profile.id);
    assert.match(active!.instructions, /short examples/);
    assert.equal(active!.revision, 1);
    assert.equal(
        (await readAssistantProfile(user.id, profile.id)).name,
        "Renamed"
    );
});

/* ------------------------------------------------------------- deletion */

test("deleting a profile tombstones its knowledge bytes and unpins conversations", async () => {
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: identity(),
    });
    const file = await storeKnowledgeFile(user.id, profile.id);
    const published = await publishAssistantProfileVersion({
        userId: user.id,
        profileId: profile.id,
        draft: draft(),
        expectedRevision: null,
    });
    assert.ok(published.outcome === "published");
    const conversation = await prisma.conversation.create({
        data: {
            userId: user.id,
            title: "Pinned",
            assistantProfileVersionId: published.version.id,
        },
    });

    await deleteAssistantProfile({ userId: user.id, profileId: profile.id });

    assert.equal(
        await prisma.assistantProfile.count({ where: { id: profile.id } }),
        0
    );
    assert.equal(
        await prisma.assistantKnowledgeFile.count({ where: { id: file.id } }),
        0
    );
    // The bytes are queued, not deleted here: §14.2's DB-first order.
    const tombstone = await prisma.assistantKnowledgeCleanup.findUniqueOrThrow({
        where: { r2Key: file.r2Key },
        select: { reason: true, completedAt: true },
    });
    assert.equal(tombstone.reason, "profile_deleted");
    assert.equal(tombstone.completedAt, null);

    const survivor = await prisma.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
        select: { assistantProfileVersionId: true },
    });
    assert.equal(survivor.assistantProfileVersionId, null);
});

/* ---------------------------------------------------------------- quota */

test("the account profile ceiling is enforced", async () => {
    const user = await createUser();
    for (let index = 0; index < 20; index += 1) {
        await createAssistantProfile({
            userId: user.id,
            identity: identity(`Profile ${index}`),
        });
    }
    await assert.rejects(
        createAssistantProfile({ userId: user.id, identity: identity("One more") }),
        (error: unknown) =>
            error instanceof AssistantProfileError &&
            error.status === 409 &&
            error.code === "ASSISTANT_PROFILE_QUOTA_EXCEEDED"
    );
});

/* ------------------------------------------- transactional first version */

/**
 * The state these tests exist to make unreachable: a profile row with no
 * current version. It listed, it offered itself in the picker, and it could
 * not start a conversation — and every abandoned create left one behind.
 */

test("a create carrying a first version publishes revision 1 with it", async () => {
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: identity("Ready to use"),
        firstVersion: draft(),
    });

    const active = await activeProfileVersion(user.id, profile.id);
    assert.ok(active, "a created profile must have a version to pin to");
    assert.equal(active.revision, 1);
    assert.equal(
        active.instructions,
        "Answer in Korean, and prefer short examples."
    );

    // The pointer, not just the row: a version that exists and is not current
    // is exactly the unusable state this replaces.
    const stored = await prisma.assistantProfile.findUniqueOrThrow({
        where: { id: profile.id },
        select: { currentVersionId: true },
    });
    assert.equal(stored.currentVersionId, active.id);
});

test("a version naming no model stores an empty list and stays readable", async () => {
    // Policy §14.0a. The empty list has to survive the round trip as itself:
    // a write path that turned it back into the account's default would put
    // the pin this removed straight back, and one that stored `null` would
    // make every reader guess which of the two it meant.
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: identity("Follows the account"),
        firstVersion: draft({ modelIds: [] }),
    });

    const active = await activeProfileVersion(user.id, profile.id);
    assert.ok(active, "a created profile must have a version to pin to");
    assert.deepEqual(active.models, []);

    const read = await readAssistantProfile(user.id, profile.id);
    assert.deepEqual(read.currentVersion?.models, []);

    // And it is reachable from the other direction: an assistant that named a
    // model can stop naming one, which is what the editor's two radios do.
    const withModel = await createAssistantProfile({
        userId: user.id,
        identity: identity("Named one, then stopped"),
        firstVersion: draft({ modelIds: ["gpt-5-6-luna"] }),
    });
    const published = await publishAssistantProfileVersion({
        userId: user.id,
        profileId: withModel.id,
        expectedRevision: 1,
        draft: draft({ modelIds: [] }),
    });
    assert.equal(published.outcome, "published");
    assert.deepEqual(
        (await activeProfileVersion(user.id, withModel.id))?.models,
        []
    );
});

test("a create with no first version still makes an identity-only profile", async () => {
    // The two-step flow is still a legitimate call and this is the only test
    // that says so: removing the optional path would break the existing API.
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: identity("Draft only"),
    });
    assert.equal(await activeProfileVersion(user.id, profile.id), null);
});

test("a first version that fails validation leaves no profile behind", async () => {
    const user = await createUser();
    await assert.rejects(
        createAssistantProfile({
            userId: user.id,
            identity: identity("Never stored"),
            firstVersion: draft({
                // Over the ceiling. An empty list is valid now (§14.0a), so
                // the invalid draft this test needs is the other end.
                modelIds: Array.from(
                    { length: ASSISTANT_PROFILE_LIMITS.maxModels + 1 },
                    (_, index) => `model-${index}`
                ),
            }),
        }),
        (error: unknown) =>
            error instanceof AssistantProfileError &&
            error.status === 422 &&
            error.code === "ASSISTANT_PROFILE_INVALID"
    );

    // The point of the assertion: not that the call failed, but that it left
    // nothing. A rejected create that still wrote the identity row would look
    // identical to the caller and be the very state being removed.
    assert.deepEqual(await listAssistantProfiles(user.id), []);
});

test("a first version does not consume the account ceiling twice", async () => {
    const user = await createUser();
    for (let index = 0; index < 20; index += 1) {
        await createAssistantProfile({
            userId: user.id,
            identity: identity(`Profile ${index}`),
            firstVersion: draft(),
        });
    }
    await assert.rejects(
        createAssistantProfile({
            userId: user.id,
            identity: identity("One more"),
            firstVersion: draft(),
        }),
        (error: unknown) =>
            error instanceof AssistantProfileError &&
            error.status === 409 &&
            error.code === "ASSISTANT_PROFILE_QUOTA_EXCEEDED"
    );
    assert.equal((await listAssistantProfiles(user.id)).length, 20);
});

test("editing a profile created this way keeps the version contract", async () => {
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: identity("Editable"),
        firstVersion: draft(),
    });

    // Publishing from revision 1 gives revision 2, and publishing from a
    // revision that is no longer current is still refused as stale. A create
    // that wrote its version outside the planner could have left a revision
    // number the publish path disagreed with.
    const published = await publishAssistantProfileVersion({
        userId: user.id,
        profileId: profile.id,
        draft: draft({ instructions: "Answer in English." }),
        expectedRevision: 1,
    });
    assert.equal(published.outcome, "published");
    assert.equal(
        published.outcome === "published" ? published.version.revision : null,
        2
    );

    await assert.rejects(
        publishAssistantProfileVersion({
            userId: user.id,
            profileId: profile.id,
            draft: draft({ instructions: "Answer in French." }),
            expectedRevision: 1,
        }),
        (error: unknown) =>
            error instanceof AssistantProfileError && error.status === 409
    );
});

test("a conversation pinned at creation stays on that revision after an edit", async () => {
    // §14's version pinning, exercised through the new create path: the
    // profile a conversation started under must not change under it.
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: identity("Pinned"),
        firstVersion: draft(),
    });
    const pinned = await activeProfileVersion(user.id, profile.id);
    assert.ok(pinned);

    const conversation = await prisma.conversation.create({
        data: {
            userId: user.id,
            title: "Pinned conversation",
            assistantProfileVersionId: pinned.id,
        },
        select: { id: true },
    });

    await publishAssistantProfileVersion({
        userId: user.id,
        profileId: profile.id,
        draft: draft({ instructions: "Completely different instructions." }),
        expectedRevision: 1,
    });

    const after = await prisma.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
        select: { assistantProfileVersionId: true },
    });
    assert.equal(
        after.assistantProfileVersionId,
        pinned.id,
        "publishing a new revision moved a conversation that was pinned"
    );
});
