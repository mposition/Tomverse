import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { exportAssistantProfilePackage } from "@/lib/assistantProfileExportService";
import {
    AssistantProfileError,
    createAssistantProfile,
    publishAssistantProfileVersion,
} from "@/lib/assistantProfileService";
import { prisma } from "@/lib/prisma";

/**
 * Exporting an assistant, against a real database.
 *
 * What only a database settles is which documents end up in the package. The
 * version's manifest is a list of file ids recorded at publish time and the
 * profile's files are what exists now, so "what this assistant is today" is an
 * intersection -- and the interesting cases are all about rows that are in one
 * side and not the other: a document deleted after publishing, one staged by
 * an import nobody has approved, one belonging to somebody else.
 *
 * Object storage is not part of any of those questions, so the byte reader is
 * injected. The writer itself is checked against real bytes in
 * tests/assistantPackageRoundTrip.test.mjs.
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
        data: { email: `package-export-${randomUUID()}@example.test` },
    });

const CONTENT = "Prefer short sentences.";
const CONTENT_BYTES = new TextEncoder().encode(CONTENT);
const CONTENT_DIGEST = `sha256:${createHash("sha256").update(CONTENT).digest("hex")}`;

/** Stands in for the bucket. The bytes are the same for every document. */
const readObject = async () => CONTENT_BYTES;

const addFile = (input: {
    userId: string;
    profileId: string;
    name?: string;
    importId?: string | null;
    status?: string;
}) =>
    prisma.assistantKnowledgeFile.create({
        data: {
            profileId: input.profileId,
            userId: input.userId,
            importId: input.importId ?? null,
            name: input.name ?? "style.md",
            mime: "text/markdown",
            bytes: CONTENT_BYTES.byteLength,
            digest: CONTENT_DIGEST,
            r2Key: `assistant-knowledge/${randomUUID()}`,
            processingStatus: input.status ?? "ready",
            ...(input.status && input.status !== "ready"
                ? {}
                : { extractedCharacters: CONTENT.length, chunkCount: 1 }),
        },
    });

const publish = (input: {
    userId: string;
    profileId: string;
    fileIds?: string[];
    expectedRevision?: number | null;
}) =>
    publishAssistantProfileVersion({
        userId: input.userId,
        profileId: input.profileId,
        expectedRevision: input.expectedRevision ?? null,
        draft: {
            instructions: "Read the diff and report what would break.",
            modelIds: ["gpt-5-6-luna"],
            toolPolicy: { webSearch: false, deepResearch: false },
            memoryPolicy: { useAccountMemory: false },
            starters: ["What changed?"],
            knowledgeManifest: (input.fileIds ?? []).map((fileId) => ({
                fileId,
                name: "",
                digest: "",
            })),
        },
    });

beforeEach(reset);
after(async () => {
    await reset();
    await prisma.$disconnect();
});

test("a published profile exports as a package describing that version", async () => {
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: { name: "Reviewer", icon: "R", description: "Reviews diffs." },
    });
    const file = await addFile({ userId: user.id, profileId: profile.id });
    await publish({ userId: user.id, profileId: profile.id, fileIds: [file.id] });

    const exported = await exportAssistantProfilePackage({
        userId: user.id,
        profileId: profile.id,
        readObject,
    });

    assert.equal(exported.manifest.profile.name, "Reviewer");
    assert.equal(exported.manifest.version.knowledge.length, 1);
    assert.equal(exported.manifest.version.knowledge[0].name, "style.md");
    assert.equal(exported.manifest.version.knowledge[0].digest, CONTENT_DIGEST);
    assert.equal(exported.omittedDocuments, 0);
    assert.ok(exported.zip.byteLength > 0);
    assert.ok(exported.filename.endsWith(".tomverse-assistant.zip"));
});

test("a document deleted after publishing is left out and counted", async () => {
    // The version still names it; the profile no longer holds it. A package
    // that claimed to carry it would be describing an assistant that does not
    // exist -- the running one cannot retrieve it either.
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: { name: "Reviewer", icon: null, description: null },
    });
    const kept = await addFile({ userId: user.id, profileId: profile.id, name: "a.md" });
    const removed = await addFile({
        userId: user.id,
        profileId: profile.id,
        name: "b.md",
    });
    await publish({
        userId: user.id,
        profileId: profile.id,
        fileIds: [kept.id, removed.id],
    });
    await prisma.assistantKnowledgeFile.delete({ where: { id: removed.id } });

    const exported = await exportAssistantProfilePackage({
        userId: user.id,
        profileId: profile.id,
        readObject,
    });
    assert.deepEqual(
        exported.manifest.version.knowledge.map((entry) => entry.name),
        ["a.md"]
    );
    assert.equal(exported.omittedDocuments, 1);
});

test("a document staged by an import is not in the package", async () => {
    // Nobody has approved it, and it is not part of what this assistant is.
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: { name: "Reviewer", icon: null, description: null },
    });
    const published = await addFile({
        userId: user.id,
        profileId: profile.id,
        name: "a.md",
    });
    await publish({ userId: user.id, profileId: profile.id, fileIds: [published.id] });

    const imported = await prisma.assistantProfileImport.create({
        data: {
            userId: user.id,
            mode: "merge",
            profileId: profile.id,
            validatorVersion: "assistant-package-v1",
            ingestPath: "normalized-package-manifest",
            idleExpiresAt: new Date(Date.now() + 3_600_000),
            absoluteExpiresAt: new Date(Date.now() + 7_200_000),
        },
    });
    const staged = await addFile({
        userId: user.id,
        profileId: profile.id,
        name: "staged.md",
        importId: imported.id,
    });

    // Even if the manifest somehow named it, the query that reads files
    // excludes anything an import is holding. The entries carry the real
    // digests because that is what makes a manifest entry resolvable at all --
    // a fixture with blank ones would exclude both files and pass for the
    // wrong reason.
    await prisma.assistantProfileVersion.updateMany({
        where: { profileId: profile.id },
        data: {
            knowledgeManifest: [
                { fileId: published.id, name: "a.md", digest: CONTENT_DIGEST },
                { fileId: staged.id, name: "staged.md", digest: CONTENT_DIGEST },
            ],
        },
    });

    const exported = await exportAssistantProfilePackage({
        userId: user.id,
        profileId: profile.id,
        readObject,
    });
    assert.deepEqual(
        exported.manifest.version.knowledge.map((entry) => entry.name),
        ["a.md"]
    );
    assert.equal(exported.omittedDocuments, 1);
});

test("a profile with no published revision cannot be exported", async () => {
    // There is nothing to describe: a draft is not something another tool
    // could run.
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: { name: "Draft", icon: null, description: null },
    });
    await assert.rejects(
        exportAssistantProfilePackage({
            userId: user.id,
            profileId: profile.id,
            readObject,
        }),
        (error: unknown) =>
            error instanceof AssistantProfileError &&
            error.code === "ASSISTANT_PROFILE_NOT_PUBLISHED"
    );
});

test("somebody else's profile is not found rather than refused", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const profile = await createAssistantProfile({
        userId: owner.id,
        identity: { name: "Reviewer", icon: null, description: null },
    });
    await publish({ userId: owner.id, profileId: profile.id });

    await assert.rejects(
        exportAssistantProfilePackage({
            userId: stranger.id,
            profileId: profile.id,
            readObject,
        }),
        (error: unknown) =>
            error instanceof AssistantProfileError &&
            error.code === "ASSISTANT_PROFILE_NOT_FOUND"
    );
});

test("a profile that came from an import carries the claim forward", async () => {
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: { name: "Reviewer", icon: null, description: null },
    });
    await publish({ userId: user.id, profileId: profile.id });
    await prisma.assistantProfileImport.create({
        data: {
            userId: user.id,
            mode: "create",
            profileId: profile.id,
            status: "published",
            validatorVersion: "assistant-package-v1",
            ingestPath: "normalized-package-manifest",
            declaredSourceKind: "agent-skill",
            declaredSourceName: "code-reviewer",
            declaredSourceUrl: "https://example.test/skill",
            idleExpiresAt: new Date(),
            absoluteExpiresAt: new Date(),
        },
    });

    const exported = await exportAssistantProfilePackage({
        userId: user.id,
        profileId: profile.id,
        readObject,
    });
    assert.equal(
        exported.manifest.declaredPreviousProvenance?.sourceName,
        "code-reviewer"
    );
    // The server's clock is not a claim about the previous package.
    assert.equal(exported.manifest.declaredPreviousProvenance?.exportedAt, null);
});

test("a staging import's claim is not carried forward", async () => {
    // A proposal nobody approved is not this profile's history.
    const user = await createUser();
    const profile = await createAssistantProfile({
        userId: user.id,
        identity: { name: "Reviewer", icon: null, description: null },
    });
    await publish({ userId: user.id, profileId: profile.id });
    await prisma.assistantProfileImport.create({
        data: {
            userId: user.id,
            mode: "merge",
            profileId: profile.id,
            status: "staging",
            validatorVersion: "assistant-package-v1",
            ingestPath: "normalized-package-manifest",
            declaredSourceName: "not-approved",
            idleExpiresAt: new Date(Date.now() + 3_600_000),
            absoluteExpiresAt: new Date(Date.now() + 7_200_000),
        },
    });

    const exported = await exportAssistantProfilePackage({
        userId: user.id,
        profileId: profile.id,
        readObject,
    });
    assert.equal(exported.manifest.declaredPreviousProvenance, null);
});
