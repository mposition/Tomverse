/**
 * Exporting a published assistant as a package (Slice 6).
 *
 * docs/policy/assistant-package-import.md §6.
 *
 * ## What is exported
 *
 * The profile's current published version, and the documents that version's
 * manifest names *and* the profile still holds. That intersection is not a
 * convenience: it is the same reading retrieval already uses, where a manifest
 * is the list of files a version was published with and the profile's files
 * are what exists now. A document deleted after publishing is not in an answer
 * the assistant gives today, so it is not in a package of what the assistant
 * is today either.
 *
 * The alternative -- refusing to export a version whose files are not all
 * present -- would make an ordinary act (deleting a document) permanently
 * un-exportable until the owner published again, and would do it in the name
 * of a fidelity the running assistant does not have.
 *
 * A profile with no published version cannot be exported. There is nothing to
 * describe: a draft is not a thing another tool could run.
 */

import { createHash } from "node:crypto";

import { AssistantProfileError, notFound } from "@/lib/assistantProfileService";
import { ASSISTANT_KNOWLEDGE_LIMITS } from "@/lib/assistantKnowledgeLimits";
import {
    assistantPackageFilename,
    buildAssistantPackage,
    type ExportKnowledgeDocument,
} from "@/lib/assistantPackageExport";
import type { AssistantPackageManifest } from "@/lib/assistantPackageManifest";
import {
    resolveKnowledgeManifest,
    type AssistantKnowledgeManifestEntry,
} from "@/lib/assistantProfileVersioning";
import { prisma } from "@/lib/prisma";
import { readOwnR2ObjectBytes } from "@/lib/r2";

const sha256Hex = async (input: string): Promise<string> =>
    createHash("sha256").update(input, "utf8").digest("hex");

const asStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];

export type ExportedPackage = {
    filename: string;
    zip: Uint8Array;
    manifest: AssistantPackageManifest;
    /** Named in the version's manifest but no longer held by the profile. */
    omittedDocuments: number;
};

/**
 * How a stored document's bytes are read.
 *
 * A port with a real default rather than a direct call, so the database half
 * of this -- ownership, which files a version's manifest resolves to, what a
 * deleted document does to the count -- can be exercised without a bucket.
 * Object storage is not what those questions are about.
 */
export type ExportObjectReader = (
    r2Key: string,
    options: { maxBytes: number }
) => Promise<Uint8Array>;

export async function exportAssistantProfilePackage(input: {
    userId: string;
    profileId: string;
    readObject?: ExportObjectReader;
}): Promise<ExportedPackage> {
    const readObject: ExportObjectReader =
        input.readObject ??
        (async (key, options) => new Uint8Array(await readOwnR2ObjectBytes(key, options)));
    const profile = await prisma.assistantProfile.findFirst({
        where: { id: input.profileId, userId: input.userId },
        select: {
            name: true,
            icon: true,
            description: true,
            currentVersion: {
                select: {
                    instructions: true,
                    models: true,
                    toolPolicy: true,
                    memoryPolicy: true,
                    starters: true,
                    knowledgeManifest: true,
                },
            },
        },
    });
    if (!profile) notFound();

    const version = profile.currentVersion;
    if (!version) {
        throw new AssistantProfileError(
            409,
            "ASSISTANT_PROFILE_NOT_PUBLISHED",
            "This assistant has no published revision to export."
        );
    }

    const manifest = version.knowledgeManifest as unknown as
        | AssistantKnowledgeManifestEntry[]
        | null;
    const manifestEntries = Array.isArray(manifest) ? manifest : [];

    // Ordinary files only. A document staged by an import under review is not
    // part of what this assistant is, and it has not been approved by anyone.
    const files = await prisma.assistantKnowledgeFile.findMany({
        where: {
            userId: input.userId,
            profileId: input.profileId,
            importId: null,
            id: { in: manifestEntries.map((entry) => entry.fileId) },
        },
        select: {
            id: true,
            name: true,
            mime: true,
            digest: true,
            bytes: true,
            r2Key: true,
            processingStatus: true,
        },
    });

    const resolved = resolveKnowledgeManifest(
        manifestEntries,
        files.map((file) => ({
            fileId: file.id,
            digest: file.digest,
            processed: file.processingStatus === "ready",
        }))
    );
    const availableIds = new Set(
        resolved.entries.filter((entry) => entry.available).map((entry) => entry.fileId)
    );

    const documents: ExportKnowledgeDocument[] = [];
    for (const entry of manifestEntries) {
        if (!availableIds.has(entry.fileId)) continue;
        const file = files.find((candidate) => candidate.id === entry.fileId);
        if (!file) continue;
        // Bounded by the same ceiling the upload path enforces: a stored
        // object larger than that is a row and an object that disagree, and
        // reading it into memory on the strength of the row would be trusting
        // the wrong one.
        const bytes = await readObject(file.r2Key, {
            maxBytes: ASSISTANT_KNOWLEDGE_LIMITS.maxFileBytes,
        });
        documents.push({
            name: file.name,
            mime: file.mime,
            bytes,
            digest: file.digest,
        });
    }

    // The claim this profile carries about where it came from, carried
    // forward as a claim. Only a published import counts: a staging one is a
    // proposal nobody has approved.
    const previous = await prisma.assistantProfileImport.findFirst({
        where: { userId: input.userId, profileId: input.profileId, status: "published" },
        orderBy: { serverReceivedAt: "desc" },
        select: {
            declaredSourceKind: true,
            declaredSourceName: true,
            declaredSourceUrl: true,
        },
    });

    const built = await buildAssistantPackage({
        identity: {
            name: profile.name,
            icon: profile.icon,
            description: profile.description,
        },
        version: {
            instructions: version.instructions,
            // Read defensively, as the manifest above is. These are JSON
            // columns: our own code only ever writes arrays into them, and a
            // row that says otherwise should produce a package with nothing in
            // that field rather than a request that throws.
            starters: asStringArray(version.starters),
            modelIds: asStringArray(version.models),
            toolPolicy: version.toolPolicy as unknown as {
                webSearch: boolean;
                deepResearch: boolean;
            },
            memoryPolicy: version.memoryPolicy as unknown as {
                useAccountMemory: boolean;
            },
        },
        knowledge: documents,
        declaredPreviousProvenance:
            previous &&
            (previous.declaredSourceKind !== null ||
                previous.declaredSourceName !== null ||
                previous.declaredSourceUrl !== null)
                ? {
                      sourceKind:
                          previous.declaredSourceKind === "agent-skill" ||
                          previous.declaredSourceKind === "tomverse-native"
                              ? previous.declaredSourceKind
                              : null,
                      sourceName: previous.declaredSourceName,
                      sourceUrl: previous.declaredSourceUrl,
                      // The server's clock is not a claim about the previous
                      // package, and inventing one here would put a fact in a
                      // field that is documented as holding none.
                      exportedAt: null,
                  }
                : null,
        sha256Hex,
    });

    if (built.outcome === "refused") {
        throw new AssistantProfileError(
            409,
            built.reason === "too_large"
                ? "ASSISTANT_PACKAGE_EXPORT_TOO_LARGE"
                : "ASSISTANT_PACKAGE_EXPORT_INVALID",
            built.reason === "too_large"
                ? "This assistant's documents are larger than a package can carry."
                : "The package could not be written."
        );
    }

    return {
        filename: assistantPackageFilename(profile.name),
        zip: built.zip,
        manifest: built.manifest,
        omittedDocuments: resolved.unavailableCount,
    };
}
