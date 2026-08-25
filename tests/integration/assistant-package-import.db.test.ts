import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import {
    AssistantKnowledgeError,
    finalizeKnowledgeUpload,
    listKnowledgeFiles,
} from "@/lib/assistantKnowledgeService";
import {
    AssistantProfileImportError,
    cancelProfileImport,
    createProfileImport,
    publishProfileImport,
    readProfileImport,
} from "@/lib/assistantProfileImportService";
import {
    reclaimStaleUploadClaims,
    sweepExpiredProfileImports,
} from "@/lib/assistantProfileImportSweep";
import {
    AssistantProfileError,
    createAssistantProfile,
    publishAssistantProfileVersion,
    readAssistantProfile,
} from "@/lib/assistantProfileService";
import { prisma } from "@/lib/prisma";

/**
 * Importing a package, against a real database.
 *
 * What only a database settles here is the isolation. Every claim about it is
 * a claim about what a *different* code path sees: that the ordinary editor
 * cannot list a staged file, that the ordinary publish cannot name one, that
 * the ordinary finalize cannot turn an import's upload key into an ordinary
 * file, and that cancelling a merge leaves the profile it merged into
 * untouched. None of those can be checked by reading the import path.
 */

const reset = async () => {
    await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AssistantKnowledgeChunk",
      "AssistantKnowledgeUploadReservation",
      "AssistantKnowledgeFile",
      "AssistantKnowledgeCleanup",
      "AssistantProfileImport",
      "AssistantProfileVersion",
      "AssistantProfile",
      "Conversation"
    RESTART IDENTITY CASCADE
  `);
};

const createUser = () =>
    prisma.user.create({
        data: { email: `package-import-${randomUUID()}@example.test` },
    });

const identity = (name = "Imported") => ({
    name,
    icon: "📦",
    description: "Came from a package.",
});

const draft = (overrides: Record<string, unknown> = {}) => ({
    instructions: "Read the diff and report what would break.",
    modelIds: ["gpt-5-6-luna"],
    toolPolicy: { webSearch: false, deepResearch: false },
    memoryPolicy: { useAccountMemory: false },
    starters: [],
    knowledgeManifest: [],
    ...overrides,
});

const startImport = (userId: string, overrides: Record<string, unknown> = {}) =>
    createProfileImport({
        userId,
        mode: "create",
        identity: identity(),
        stagingManifest: { instructions: "Read the diff." },
        declared: {
            sourceKind: "agent-skill",
            sourceName: "code-reviewer",
            sourceUrl: null,
            previousProvenance: null,
        },
        ...overrides,
    } as Parameters<typeof createProfileImport>[0]);

/** A staged file, written directly: the upload path needs R2. */
const stageFile = (input: {
    userId: string;
    profileId: string;
    importId: string;
    status?: string;
}) =>
    prisma.assistantKnowledgeFile.create({
        data: {
            profileId: input.profileId,
            userId: input.userId,
            importId: input.importId,
            name: "style.md",
            mime: "text/markdown",
            bytes: 512,
            digest: `sha256-${randomUUID()}`,
            r2Key: `assistant-knowledge/${randomUUID()}`,
            processingStatus: input.status ?? "ready",
            // A file that is not ready has no chunks and no extracted text,
            // which the table's own CHECK enforces -- so the fixture has to
            // agree with it rather than describe a row that cannot exist.
            ...(input.status && input.status !== "ready"
                ? { chunkCount: 0 }
                : { extractedCharacters: 400, extractedBytes: 400, chunkCount: 1 }),
        },
    });

beforeEach(reset);
after(async () => {
    await reset();
    await prisma.$disconnect();
});

/* --------------------------------------------------------------- creating */

test("a create import owns a draft profile that cannot start a conversation", async () => {
    const user = await createUser();
    const started = await startImport(user.id);

    assert.equal(started.mode, "create");
    assert.equal(started.status, "staging");
    const profile = await prisma.assistantProfile.findUniqueOrThrow({
        where: { id: started.profileId },
    });
    assert.equal(profile.currentVersionId, null);
});

test("a merge import creates no profile and remembers both of the target's clocks", async () => {
    const user = await createUser();
    const target = await createAssistantProfile({
        userId: user.id,
        identity: identity("Existing"),
        firstVersion: draft(),
    });

    const before = await prisma.assistantProfile.count({ where: { userId: user.id } });
    const started = await startImport(user.id, {
        mode: "merge",
        targetProfileId: target.id,
    });
    const afterCount = await prisma.assistantProfile.count({
        where: { userId: user.id },
    });

    assert.equal(afterCount, before, "merge must not occupy a profile slot");
    assert.equal(started.profileId, target.id);
    assert.equal(started.expectedTargetRevision, 1);
    const row = await prisma.assistantProfileImport.findUniqueOrThrow({
        where: { id: started.id },
        select: { expectedTargetIdentityDigest: true },
    });
    // Identity does not consume a revision, so it needs a clock of its own.
    assert.ok(row.expectedTargetIdentityDigest);
});

test("two staging imports cannot share one profile", async () => {
    const user = await createUser();
    const target = await createAssistantProfile({
        userId: user.id,
        identity: identity("Existing"),
        firstVersion: draft(),
    });
    await startImport(user.id, { mode: "merge", targetProfileId: target.id });

    await assert.rejects(
        startImport(user.id, { mode: "merge", targetProfileId: target.id }),
        (error: unknown) =>
            error instanceof AssistantProfileImportError &&
            error.code === "ASSISTANT_PROFILE_IMPORT_IN_PROGRESS"
    );
});

test("somebody else's profile is not a merge target, and is not named as one", async () => {
    // The cross-account case for the *target*, which the test below covers only
    // for the import row. A staging run cannot check this without a second
    // account, so it is pinned here instead: the refusal is 404, not 403, so
    // the answer does not tell a stranger whether the id exists.
    const [mine, theirs] = await Promise.all([createUser(), createUser()]);
    const theirProfile = await createAssistantProfile({
        userId: theirs.id,
        identity: identity("Theirs"),
        firstVersion: draft(),
    });

    await assert.rejects(
        startImport(mine.id, { mode: "merge", targetProfileId: theirProfile.id }),
        (error: unknown) =>
            error instanceof AssistantProfileImportError && error.status === 404
    );

    // And nothing was staged against it on the way to refusing.
    assert.equal(
        await prisma.assistantProfileImport.count({
            where: { profileId: theirProfile.id },
        }),
        0
    );
});

test("an import belonging to somebody else is simply absent", async () => {
    const [mine, theirs] = await Promise.all([createUser(), createUser()]);
    const started = await startImport(theirs.id);
    await assert.rejects(
        readProfileImport({ userId: mine.id, importId: started.id }),
        (error: unknown) =>
            error instanceof AssistantProfileImportError && error.status === 404
    );
});

/* -------------------------------------------------------------- isolation */

test("a staged file is invisible to the ordinary editor", async () => {
    const user = await createUser();
    const started = await startImport(user.id);
    await stageFile({
        userId: user.id,
        profileId: started.profileId,
        importId: started.id,
    });

    const listed = await listKnowledgeFiles(user.id, started.profileId);
    assert.deepEqual(listed, []);

    // Both readers, because the editor screen uses the second one. This test
    // asserted only the first, and the profile read had no filter at all: a
    // staged file was drawn in the editor's knowledge list on staging while
    // its import was still under review.
    const profile = await readAssistantProfile(user.id, started.profileId);
    assert.deepEqual(profile.knowledgeFiles, []);

    // And the import's own view does see it, so the emptiness above is
    // isolation rather than the file failing to exist.
    const read = await readProfileImport({ userId: user.id, importId: started.id });
    assert.equal(read.files.length, 1);
});

test("the ordinary publish cannot name a staged file", async () => {
    const user = await createUser();
    const target = await createAssistantProfile({
        userId: user.id,
        identity: identity("Existing"),
        firstVersion: draft(),
    });
    const started = await startImport(user.id, {
        mode: "merge",
        targetProfileId: target.id,
    });
    const staged = await stageFile({
        userId: user.id,
        profileId: target.id,
        importId: started.id,
    });

    await assert.rejects(
        publishAssistantProfileVersion({
            userId: user.id,
            profileId: target.id,
            draft: draft({
                instructions: "Something else.",
                knowledgeManifest: [
                    { fileId: staged.id, name: "style.md", digest: "x" },
                ],
            }),
            expectedRevision: 1,
        }),
        (error: unknown) => error instanceof AssistantProfileError
    );
});

test("the ordinary publish is refused entirely while an import is staging", async () => {
    const user = await createUser();
    const target = await createAssistantProfile({
        userId: user.id,
        identity: identity("Existing"),
        firstVersion: draft(),
    });
    await startImport(user.id, { mode: "merge", targetProfileId: target.id });

    await assert.rejects(
        publishAssistantProfileVersion({
            userId: user.id,
            profileId: target.id,
            draft: draft({ instructions: "Something else." }),
            expectedRevision: 1,
        }),
        (error: unknown) =>
            error instanceof AssistantProfileError &&
            error.code === "ASSISTANT_PROFILE_IMPORT_IN_PROGRESS"
    );
});

test("the ordinary finalize refuses an upload key reserved for an import", async () => {
    const user = await createUser();
    const started = await startImport(user.id);
    const uploadKey = `assistant-knowledge/${randomUUID()}`;
    await prisma.assistantKnowledgeUploadReservation.create({
        data: {
            r2Key: uploadKey,
            userId: user.id,
            importId: started.id,
            profileId: started.profileId,
        },
    });

    await assert.rejects(
        finalizeKnowledgeUpload({
            userId: user.id,
            profileId: started.profileId,
            uploadKey,
            filename: "style.md",
            mime: "text/markdown",
        }),
        (error: unknown) =>
            error instanceof AssistantKnowledgeError &&
            error.status === 409 &&
            error.code === "ASSISTANT_KNOWLEDGE_KEY_RESERVED_FOR_IMPORT"
    );
});

test("somebody else's reserved key is refused as not theirs, not as in use", async () => {
    // A 409 would confirm the key exists and is being used, which is more than
    // a stranger is owed.
    const [mine, theirs] = await Promise.all([createUser(), createUser()]);
    const theirImport = await startImport(theirs.id);
    const mineProfile = await createAssistantProfile({
        userId: mine.id,
        identity: identity("Mine"),
    });
    const uploadKey = `assistant-knowledge/${randomUUID()}`;
    await prisma.assistantKnowledgeUploadReservation.create({
        data: {
            r2Key: uploadKey,
            userId: theirs.id,
            importId: theirImport.id,
            profileId: theirImport.profileId,
        },
    });

    await assert.rejects(
        finalizeKnowledgeUpload({
            userId: mine.id,
            profileId: mineProfile.id,
            uploadKey,
            filename: "style.md",
            mime: "text/markdown",
        }),
        (error: unknown) =>
            error instanceof AssistantKnowledgeError &&
            error.status === 403 &&
            error.code === "ASSISTANT_KNOWLEDGE_KEY_FORBIDDEN"
    );
});

/* ------------------------------------------------------------- publishing */

test("publishing promotes the kept files and discards the rest", async () => {
    const user = await createUser();
    const started = await startImport(user.id);
    const kept = await stageFile({
        userId: user.id,
        profileId: started.profileId,
        importId: started.id,
    });
    const dropped = await stageFile({
        userId: user.id,
        profileId: started.profileId,
        importId: started.id,
    });
    await prisma.assistantKnowledgeUploadReservation.create({
        data: {
            r2Key: `assistant-knowledge/${randomUUID()}`,
            userId: user.id,
            importId: started.id,
            profileId: started.profileId,
        },
    });

    const outcome = await publishProfileImport({
        userId: user.id,
        importId: started.id,
        approvedDigest: "sha256:approved",
        digestVersion: 1,
        keepFileIds: [kept.id],
        identity: identity(),
        draft: draft(),
    });
    assert.equal(outcome.outcome, "published");

    const promoted = await prisma.assistantKnowledgeFile.findUniqueOrThrow({
        where: { id: kept.id },
        select: { importId: true },
    });
    assert.equal(promoted.importId, null, "a kept file stops being staged");

    assert.equal(
        await prisma.assistantKnowledgeFile.count({ where: { id: dropped.id } }),
        0
    );
    // The bytes of a discarded file are queued before the row goes.
    assert.equal(await prisma.assistantKnowledgeCleanup.count(), 1);

    // The import row outlives the import, so nothing would ever cascade an
    // unused reservation away.
    assert.equal(
        await prisma.assistantKnowledgeUploadReservation.count({
            where: { importId: started.id },
        }),
        0
    );

    const row = await prisma.assistantProfileImport.findUniqueOrThrow({
        where: { id: started.id },
    });
    assert.equal(row.status, "published");
    assert.ok(row.versionId);
    assert.ok(row.userApprovedAt);

    // And now the promoted file is an ordinary one.
    const listed = await listKnowledgeFiles(user.id, started.profileId);
    assert.equal(listed.length, 1);
});

test("a document still processing stops the publish rather than being dropped", async () => {
    const user = await createUser();
    const started = await startImport(user.id);
    const pending = await stageFile({
        userId: user.id,
        profileId: started.profileId,
        importId: started.id,
        status: "pending",
    });

    const outcome = await publishProfileImport({
        userId: user.id,
        importId: started.id,
        approvedDigest: "sha256:approved",
        digestVersion: 1,
        keepFileIds: [pending.id],
        identity: identity(),
        draft: draft(),
    });
    assert.deepEqual(outcome, { outcome: "not_ready", pending: 1, failed: 0 });
    const row = await prisma.assistantProfileImport.findUniqueOrThrow({
        where: { id: started.id },
        select: { status: true },
    });
    assert.equal(row.status, "staging");
});

test("a rename during a merge is a stale publish, not a silent overwrite", async () => {
    const user = await createUser();
    const target = await createAssistantProfile({
        userId: user.id,
        identity: identity("Existing"),
        firstVersion: draft(),
    });
    const started = await startImport(user.id, {
        mode: "merge",
        targetProfileId: target.id,
    });

    // Identity is not in a version snapshot, so the revision the import
    // remembers cannot see this.
    await prisma.assistantProfile.update({
        where: { id: target.id },
        data: { name: "Renamed by somebody else" },
    });

    await assert.rejects(
        publishProfileImport({
            userId: user.id,
            importId: started.id,
            approvedDigest: "sha256:approved",
            digestVersion: 1,
            keepFileIds: [],
            identity: identity(),
            draft: draft({ instructions: "New instructions." }),
        }),
        (error: unknown) =>
            error instanceof AssistantProfileError &&
            error.code === "ASSISTANT_PROFILE_VERSION_STALE"
    );
});

/* ------------------------------------------------------------ cancelling */

test("cancelling a create import takes its draft profile", async () => {
    const user = await createUser();
    const started = await startImport(user.id);
    await stageFile({
        userId: user.id,
        profileId: started.profileId,
        importId: started.id,
    });

    const outcome = await cancelProfileImport({
        userId: user.id,
        importId: started.id,
    });
    assert.deepEqual(outcome, { outcome: "cancelled", deletedProfile: true });
    assert.equal(
        await prisma.assistantProfile.count({ where: { id: started.profileId } }),
        0
    );
    assert.equal(await prisma.assistantKnowledgeCleanup.count(), 1);
});

test("cancelling a merge import leaves the profile and its own files alone", async () => {
    const user = await createUser();
    const target = await createAssistantProfile({
        userId: user.id,
        identity: identity("Existing"),
        firstVersion: draft(),
    });
    const ordinary = await prisma.assistantKnowledgeFile.create({
        data: {
            profileId: target.id,
            userId: user.id,
            name: "existing.txt",
            mime: "text/plain",
            bytes: 10,
            digest: `sha256-${randomUUID()}`,
            r2Key: `assistant-knowledge/${randomUUID()}`,
            processingStatus: "ready",
        },
    });
    const started = await startImport(user.id, {
        mode: "merge",
        targetProfileId: target.id,
    });
    await stageFile({
        userId: user.id,
        profileId: target.id,
        importId: started.id,
    });

    const outcome = await cancelProfileImport({
        userId: user.id,
        importId: started.id,
    });
    assert.deepEqual(outcome, { outcome: "cancelled", deletedProfile: false });
    assert.equal(
        await prisma.assistantProfile.count({ where: { id: target.id } }),
        1
    );
    assert.equal(
        await prisma.assistantKnowledgeFile.count({ where: { id: ordinary.id } }),
        1
    );
    assert.equal(
        await prisma.assistantKnowledgeFile.count({ where: { profileId: target.id } }),
        1
    );
});

test("a create import whose profile got published is refused, not deleted", async () => {
    // The fail-closed condition doing its job: something published this draft
    // behind the import's back, and deleting the profile would take a
    // published assistant with it.
    const user = await createUser();
    const started = await startImport(user.id);
    const version = await prisma.assistantProfileVersion.create({
        data: {
            profileId: started.profileId,
            userId: user.id,
            revision: 1,
            instructions: "x",
            models: ["gpt-5-6-luna"],
            toolPolicy: { webSearch: false, deepResearch: false },
            memoryPolicy: { useAccountMemory: false },
            starters: [],
            knowledgeManifest: [],
            retrievalVersion: 1,
            promptFormatVersion: "assistant-profile-v1",
        },
    });
    await prisma.assistantProfile.update({
        where: { id: started.profileId },
        data: { currentVersionId: version.id },
    });

    await assert.rejects(
        cancelProfileImport({ userId: user.id, importId: started.id }),
        (error: unknown) =>
            error instanceof AssistantProfileImportError &&
            error.code === "ASSISTANT_PROFILE_IMPORT_CLEANUP_REFUSED"
    );
    assert.equal(
        await prisma.assistantProfile.count({ where: { id: started.profileId } }),
        1
    );
});

/* ---------------------------------------------------------------- sweeps */

test("the expiry sweep collects an import nobody came back to", async () => {
    const user = await createUser();
    const started = await startImport(user.id);
    const past = new Date(Date.now() - 60_000);
    await prisma.assistantProfileImport.update({
        where: { id: started.id },
        data: { idleExpiresAt: past },
    });

    const result = await sweepExpiredProfileImports(new Date());
    assert.equal(result.cancelled, 1);
    assert.equal(result.refused, 0);
    assert.equal(
        await prisma.assistantProfile.count({ where: { id: started.profileId } }),
        0
    );
});

test("the expiry sweep leaves an import its own cancel would refuse", async () => {
    const user = await createUser();
    const started = await startImport(user.id);
    const version = await prisma.assistantProfileVersion.create({
        data: {
            profileId: started.profileId,
            userId: user.id,
            revision: 1,
            instructions: "x",
            models: ["gpt-5-6-luna"],
            toolPolicy: { webSearch: false, deepResearch: false },
            memoryPolicy: { useAccountMemory: false },
            starters: [],
            knowledgeManifest: [],
            retrievalVersion: 1,
            promptFormatVersion: "assistant-profile-v1",
        },
    });
    await prisma.assistantProfile.update({
        where: { id: started.profileId },
        data: { currentVersionId: version.id },
    });
    await prisma.assistantProfileImport.update({
        where: { id: started.id },
        data: { idleExpiresAt: new Date(Date.now() - 60_000) },
    });

    const result = await sweepExpiredProfileImports(new Date());
    assert.equal(result.cancelled, 0);
    assert.equal(result.refused, 1);
    assert.equal(
        await prisma.assistantProfile.count({ where: { id: started.profileId } }),
        1
    );
});

test("a stale upload claim is released and the reservation kept", async () => {
    const user = await createUser();
    const started = await startImport(user.id);
    const uploadKey = `assistant-knowledge/${randomUUID()}`;
    await prisma.assistantKnowledgeUploadReservation.create({
        data: {
            r2Key: uploadKey,
            userId: user.id,
            importId: started.id,
            profileId: started.profileId,
            state: "finalizing",
            claimToken: randomUUID(),
            finalizingStartedAt: new Date(Date.now() - 60 * 60 * 1000),
        },
    });

    const result = await reclaimStaleUploadClaims(new Date());
    assert.equal(result.reclaimed, 1);
    const row = await prisma.assistantKnowledgeUploadReservation.findUniqueOrThrow(
        { where: { r2Key: uploadKey } }
    );
    // The key is still ours; only the claim was released.
    assert.equal(row.state, "pending");
    assert.equal(row.claimToken, null);
    assert.equal(row.finalizingStartedAt, null);
});

test("the claim columns cannot be left half-cleared", async () => {
    const user = await createUser();
    const started = await startImport(user.id);
    await assert.rejects(
        prisma.assistantKnowledgeUploadReservation.create({
            data: {
                r2Key: `assistant-knowledge/${randomUUID()}`,
                userId: user.id,
                importId: started.id,
                profileId: started.profileId,
                state: "pending",
                claimToken: randomUUID(),
            },
        })
    );
});
