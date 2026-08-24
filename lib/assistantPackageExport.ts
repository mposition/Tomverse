/**
 * Writing a Tomverse assistant package (Slice 6).
 *
 * docs/policy/assistant-package-import.md §6.
 *
 * The mirror of `lib/assistantPackageArchive.ts`, and deliberately the same
 * shape of module: everything is decided from values passed in, nothing here
 * reads a database, a bucket or a clock. What it produces is bytes and a
 * manifest, and the round-trip test can therefore feed those straight back
 * into the reader without a server between them.
 *
 * ## What goes in the archive
 *
 * `assistant.json` at the root and the documents under `knowledge/`. The
 * manifest names each document by the owner's name for it and by a path that
 * is unique by construction -- two documents may legitimately share a name,
 * and the reader refuses duplicate and case-colliding paths, so a package that
 * used the name as the path would be a package we could not read back.
 *
 * ## What does not go in it
 *
 * No storage key, no URL, no internal id. A document leaves as its bytes and
 * not as a location, which is the whole difference between a package and a
 * link to somebody's bucket.
 */

import { zipSync } from "fflate";

import { ASSISTANT_KNOWLEDGE_TYPES } from "@/lib/assistantKnowledgeLimits";
import { ASSISTANT_PACKAGE_ADAPTER_VERSION } from "@/lib/assistantPackageAdapter";
import {
    ASSISTANT_PACKAGE_KNOWLEDGE_PREFIX,
    ASSISTANT_PACKAGE_MANIFEST_FILENAME,
    ASSISTANT_PACKAGE_SCHEMA_VERSION,
    assistantPackageManifestSchema,
    packageDigestPayload,
    type AssistantPackageManifest,
} from "@/lib/assistantPackageManifest";
import { ASSISTANT_PACKAGE_LIMITS } from "@/lib/assistantPackageLimits";

/** The application name written into every package this produces. */
export const ASSISTANT_PACKAGE_PRODUCER = "tomverse";

/** The version of the digest payload's shape. */
export const ASSISTANT_PACKAGE_DIGEST_VERSION = 1;

export const ASSISTANT_PACKAGE_FILE_SUFFIX = ".tomverse-assistant.zip";

/** 1980-01-01T00:00:00Z, the earliest moment a ZIP entry can be stamped with. */
const ZIP_EPOCH_MS = 315_532_800_000;

export type ExportKnowledgeDocument = {
    /** The owner's name for it. Carried in the manifest, never as the path. */
    name: string;
    mime: string;
    bytes: Uint8Array;
    /** `sha256:<hex>` of those bytes, as the profile already recorded it. */
    digest: string;
};

export type BuildPackageInput = {
    identity: { name: string; icon: string | null; description: string | null };
    version: {
        instructions: string;
        starters: readonly string[];
        modelIds: readonly string[];
        toolPolicy: { webSearch: boolean; deepResearch: boolean };
        memoryPolicy: { useAccountMemory: boolean };
    };
    knowledge: readonly ExportKnowledgeDocument[];
    /**
     * What this profile was imported from, if it was. A claim carried forward
     * as a claim -- nothing here was ever verified, and §6.5 keeps it in a
     * field no decision reads.
     */
    declaredPreviousProvenance: AssistantPackageManifest["declaredPreviousProvenance"];
    sha256Hex: (input: string) => Promise<string>;
};

export type BuildPackageResult =
    | { outcome: "built"; manifest: AssistantPackageManifest; zip: Uint8Array }
    | { outcome: "refused"; reason: "too_large" | "manifest_invalid" };

/** Everything but the extension, reduced to characters a path can hold. */
const slug = (name: string): string => {
    const base = name.replace(/\.[^.]*$/u, "");
    const cleaned = base
        .normalize("NFKD")
        .replace(/[^A-Za-z0-9._-]+/gu, "-")
        .replace(/-+/gu, "-")
        .replace(/^[-.]+|[-.]+$/gu, "")
        .slice(0, 60);
    // A name written entirely in a script this strips is not a broken name --
    // it is a name that cannot be a path, and the manifest still carries it.
    return cleaned === "" ? "document" : cleaned;
};

/**
 * The extension to write the document under.
 *
 * The owner's own, when the media type accepts it, so `notes.log` comes back
 * as `notes.log` rather than as `notes.txt`. Otherwise the media type's first,
 * because the reader decides what may become knowledge by extension and a
 * document it cannot recognise is a document that would not come back at all.
 */
const extensionFor = (name: string, mime: string): string => {
    const accepted = ASSISTANT_KNOWLEDGE_TYPES[mime];
    if (!accepted || accepted.length === 0) return "txt";
    const own = name.includes(".")
        ? (name.split(".").pop() ?? "").toLowerCase()
        : "";
    return accepted.includes(own) ? own : accepted[0];
};

/**
 * The archive path for one document.
 *
 * The index is what makes it unique, and it is there rather than a
 * de-duplicating suffix because two documents sharing a name is ordinary: the
 * reader refuses duplicate and case-colliding paths, so uniqueness has to be a
 * property of how the path is built rather than something to check afterwards.
 */
export const exportKnowledgePath = (
    index: number,
    document: { name: string; mime: string }
): string =>
    `${ASSISTANT_PACKAGE_KNOWLEDGE_PREFIX}${index + 1}-${slug(document.name)}.${extensionFor(document.name, document.mime)}`;

export async function buildAssistantPackage(
    input: BuildPackageInput
): Promise<BuildPackageResult> {
    const total = input.knowledge.reduce(
        (sum, document) => sum + document.bytes.byteLength,
        0
    );
    // The same ceiling the reader applies, and for the reason that makes it
    // one decision rather than two: a package this app would refuse to open is
    // a package this app has no business producing.
    if (total > ASSISTANT_PACKAGE_LIMITS.maxTotalInflatedBytes) {
        return { outcome: "refused", reason: "too_large" };
    }

    const entries = input.knowledge.map((document, index) => ({
        document,
        path: exportKnowledgePath(index, document),
    }));

    const withoutDigest = {
        schemaVersion: ASSISTANT_PACKAGE_SCHEMA_VERSION,
        producedBy: {
            app: ASSISTANT_PACKAGE_PRODUCER,
            adapterVersion: ASSISTANT_PACKAGE_ADAPTER_VERSION,
        },
        profile: {
            name: input.identity.name,
            icon: input.identity.icon,
            description: input.identity.description,
        },
        version: {
            instructions: input.version.instructions,
            starters: [...input.version.starters],
            modelIds: [...input.version.modelIds],
            toolPolicy: { ...input.version.toolPolicy },
            memoryPolicy: { ...input.version.memoryPolicy },
            knowledge: entries.map((entry) => ({
                path: entry.path,
                name: entry.document.name,
                mime: entry.document.mime,
                bytes: entry.document.bytes.byteLength,
                digest: entry.document.digest,
            })),
        },
        declaredPreviousProvenance: input.declaredPreviousProvenance,
        digestVersion: ASSISTANT_PACKAGE_DIGEST_VERSION,
    };

    const manifest: AssistantPackageManifest = {
        ...withoutDigest,
        packageDigest: `sha256:${await input.sha256Hex(packageDigestPayload(withoutDigest))}`,
    };

    // Parsed with the reader's own schema before it is written. A package that
    // fails the check on the way out is a package that would fail on the way
    // in, and finding that out here costs one parse rather than a support
    // thread about a file that will not open.
    const parsed = assistantPackageManifestSchema.safeParse(manifest);
    if (!parsed.success) return { outcome: "refused", reason: "manifest_invalid" };

    const files: Record<string, Uint8Array> = {
        [ASSISTANT_PACKAGE_MANIFEST_FILENAME]: new TextEncoder().encode(
            `${JSON.stringify(manifest, null, 2)}\n`
        ),
    };
    for (const entry of entries) files[entry.path] = entry.document.bytes;

    // A fixed timestamp: the same profile exported twice produces the same
    // bytes, which is what lets a digest of the archive mean anything and what
    // keeps a re-export out of a diff when nothing changed. It is 1980 rather
    // than the epoch because a ZIP timestamp cannot express a date before
    // then -- fflate refuses one outright.
    const zip = zipSync(files, { level: 6, mtime: ZIP_EPOCH_MS });

    if (zip.byteLength > ASSISTANT_PACKAGE_LIMITS.maxContainerBytes) {
        return { outcome: "refused", reason: "too_large" };
    }
    return { outcome: "built", manifest, zip };
}

/**
 * The download's filename.
 *
 * Built from the profile's name and then reduced to the same character set as
 * a path inside the archive: this string goes into a `Content-Disposition`
 * header, where a quote or a newline is not a cosmetic problem.
 */
export const assistantPackageFilename = (profileName: string): string =>
    `${slug(profileName)}${ASSISTANT_PACKAGE_FILE_SUFFIX}`;
