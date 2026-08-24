/**
 * The Tomverse native package manifest, and what "the same profile" means
 * across an export and an import (Slice 2).
 *
 * docs/policy/assistant-package-import.md §6.
 *
 * ## Two jobs, deliberately in one file
 *
 * The schema says what a native package may contain; `portableProfileEquals()`
 * says when two of them carry the same profile. They live together because the
 * second is the test of the first: a field the schema can hold and the
 * comparison ignores is a field the format does not really round-trip, and
 * that discrepancy should be visible in one place rather than discovered by a
 * failing export months later.
 *
 * ## Why the schema is strict, and what strictness does not buy
 *
 * `.strict()` refuses unknown keys, and §6.2 uses that to keep credential
 * fields out of the format: there is no `secrets`, no `auth`, no `headers`,
 * and no way to add one without editing this file. What it does not do is stop
 * a credential pasted into `instructions`, into a knowledge file, or into a
 * name -- those are strings the schema is supposed to accept. The boundary for
 * that is the scanner in `lib/assistantPackageSecretScan.ts`, and the two are
 * separate devices for separate problems.
 *
 * ## Why the declared provenance is a separate shape
 *
 * The server never sees the package (§8): the browser parses it and sends a
 * normalised manifest. So a package claiming to have come from an Agent Skill
 * is a claim, not an observation, and §6.5 keeps it in fields prefixed
 * `declared` that no decision reads. Putting it in the same object as the
 * profile content would invite exactly the reading this avoids.
 *
 * Pure: no Prisma, no R2, no clock, no network.
 */

import { z } from "zod";

import { ASSISTANT_PROFILE_LIMITS } from "@/lib/assistantProfileVersioning";
import { ASSISTANT_PACKAGE_LIMITS } from "@/lib/assistantPackageLimits";

/**
 * The version of this format. A whole number, ours to raise.
 *
 * §6.3: a lower version migrates or is refused, a higher one is always
 * refused, and an absent one means this is not a Tomverse package.
 */
export const ASSISTANT_PACKAGE_SCHEMA_VERSION = 1;

/** The manifest filename inside a `.tomverse-assistant.zip`. */
export const ASSISTANT_PACKAGE_MANIFEST_FILENAME = "assistant.json";

/** Where knowledge files sit inside the archive. */
export const ASSISTANT_PACKAGE_KNOWLEDGE_PREFIX = "knowledge/";

/**
 * What the server observed about its own handling. §6.5.
 *
 * One value today. It names the path the request took, not the format the
 * package was in -- which the server is not in a position to know.
 */
export const ASSISTANT_PACKAGE_INGEST_PATHS = [
    "normalized-package-manifest",
] as const;

export type AssistantPackageIngestPath =
    (typeof ASSISTANT_PACKAGE_INGEST_PATHS)[number];

/** What the *client* says the package came from. A claim (§6.5). */
export const ASSISTANT_PACKAGE_DECLARED_SOURCE_KINDS = [
    "agent-skill",
    "tomverse-native",
] as const;

export type AssistantPackageDeclaredSourceKind =
    (typeof ASSISTANT_PACKAGE_DECLARED_SOURCE_KINDS)[number];

/* ---------------------------------------------------------------- schema */

const trimmed = z.string().trim();

const knowledgeEntrySchema = z
    .object({
        /** Path inside the archive. Never used to build a filesystem path. */
        path: trimmed.min(1).max(400),
        name: trimmed.min(1).max(200),
        mime: trimmed.min(1).max(160),
        bytes: z.number().int().positive(),
        /** `sha256:<hex>`; compared, never used to fetch anything. */
        digest: trimmed.regex(/^sha256:[0-9a-f]{64}$/),
    })
    .strict();

const versionSchema = z
    .object({
        /**
         * One string, never an array. §6.2 and the report's §6.3: an array
         * makes ordering a policy, and then the file format decides a policy
         * nobody wrote down.
         */
        instructions: z.string().max(ASSISTANT_PACKAGE_LIMITS.maxInstructionCharacters),
        starters: z
            .array(trimmed.max(ASSISTANT_PROFILE_LIMITS.maxStarterCharacters))
            .max(ASSISTANT_PROFILE_LIMITS.maxStarters),
        /**
         * A request. Entitlement is decided at runtime, not here
         * (docs/policy/assistant-package-import.md §5.3).
         */
        modelIds: z
            .array(trimmed.min(1).max(120))
            .max(ASSISTANT_PROFILE_LIMITS.maxModels),
        toolPolicy: z
            .object({ webSearch: z.boolean(), deepResearch: z.boolean() })
            .strict(),
        memoryPolicy: z.object({ useAccountMemory: z.boolean() }).strict(),
        knowledge: z.array(knowledgeEntrySchema).max(ASSISTANT_PACKAGE_LIMITS.maxKnowledgeFiles),
    })
    .strict();

const identitySchema = z
    .object({
        name: trimmed.min(1).max(ASSISTANT_PROFILE_LIMITS.maxNameCharacters),
        icon: trimmed.max(ASSISTANT_PROFILE_LIMITS.maxIconCharacters).nullable(),
        description: trimmed
            .max(ASSISTANT_PROFILE_LIMITS.maxDescriptionCharacters)
            .nullable(),
    })
    .strict();

/**
 * The past the package claims for itself. Display only (§6.5).
 *
 * `sourceUrl` is a string the owner typed. Nothing fetches it, and §1.1 makes
 * that a prohibition rather than an omission.
 */
const declaredProvenanceSchema = z
    .object({
        sourceKind: z.enum(ASSISTANT_PACKAGE_DECLARED_SOURCE_KINDS).nullable(),
        sourceName: trimmed.max(200).nullable(),
        sourceUrl: trimmed.max(2000).nullable(),
        exportedAt: trimmed.max(40).nullable(),
    })
    .strict();

export const assistantPackageManifestSchema = z
    .object({
        schemaVersion: z.number().int().positive(),
        producedBy: z
            .object({ app: trimmed.max(60), adapterVersion: trimmed.max(60) })
            .strict(),
        profile: identitySchema,
        version: versionSchema,
        declaredPreviousProvenance: declaredProvenanceSchema.nullable(),
        /** Over everything but this field. Compared, never trusted alone. */
        packageDigest: trimmed.regex(/^sha256:[0-9a-f]{64}$/),
        digestVersion: z.number().int().positive(),
    })
    .strict();

export type AssistantPackageManifest = z.infer<typeof assistantPackageManifestSchema>;

/* ------------------------------------------------------- version handling */

export type ManifestVersionVerdict =
    | { outcome: "accept"; migratedFrom: null }
    | { outcome: "migrate"; migratedFrom: number }
    | { outcome: "refuse"; reason: "absent" | "too_new" | "unmigratable" };

/**
 * §6.3, as a decision rather than a parse.
 *
 * Refusing a newer version is the part worth stating: tolerating it would mean
 * importing the subset we recognise and silently dropping the rest, which is
 * the failure the whole loss report exists to prevent -- except invisible.
 */
export function judgeManifestVersion(raw: unknown): ManifestVersionVerdict {
    const version =
        typeof raw === "object" && raw !== null && "schemaVersion" in raw
            ? (raw as { schemaVersion: unknown }).schemaVersion
            : undefined;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
        return { outcome: "refuse", reason: "absent" };
    }
    if (version > ASSISTANT_PACKAGE_SCHEMA_VERSION) {
        return { outcome: "refuse", reason: "too_new" };
    }
    if (version === ASSISTANT_PACKAGE_SCHEMA_VERSION) {
        return { outcome: "accept", migratedFrom: null };
    }
    // No older version has existed yet, so there is nothing to migrate from
    // and nothing to pretend about. When one does, it gets an explicit
    // migration here and this branch names it.
    return { outcome: "refuse", reason: "unmigratable" };
}

/* ------------------------------------------------------- portable profile */

/**
 * A profile reduced to what the format is supposed to carry.
 *
 * Storage identity is not in here on purpose. A re-import issues new file
 * ids -- docs/policy/external-conversation-import-and-memory.md §14 is
 * explicit that re-uploading the same bytes is a different file -- so a
 * comparison keyed on ids answers "is this the same row", when the question
 * is "did the format lose anything".
 */
export type PortableProfile = {
    name: string;
    icon: string | null;
    description: string | null;
    instructions: string;
    /** Order is meaning: the first model is the default. */
    modelIds: readonly string[];
    /** Order is meaning: this is display order. */
    starters: readonly string[];
    toolPolicy: { webSearch: boolean; deepResearch: boolean };
    memoryPolicy: { useAccountMemory: boolean };
    /** Compared as a multiset of (name, digest). Order and ids are not content. */
    knowledge: readonly { name: string; digest: string }[];
};

const collapse = (value: string): string => value.replace(/\s+/gu, " ").trim();
const block = (value: string): string => value.replace(/\r\n?/gu, "\n").trim();

/**
 * The normalisation both sides apply before comparing.
 *
 * It mirrors what `normalizeProfileIdentity` and `normalizeProfileVersionDraft`
 * already do to a stored draft, because comparing a normalised value against an
 * unnormalised one reports a difference that only exists in whitespace.
 */
export function normalizePortableProfile(profile: PortableProfile): PortableProfile {
    const icon = profile.icon === null ? null : collapse(profile.icon);
    const description =
        profile.description === null ? null : collapse(profile.description);
    return {
        name: collapse(profile.name),
        icon: icon === "" ? null : icon,
        description: description === "" ? null : description,
        instructions: block(profile.instructions),
        modelIds: [...new Set(profile.modelIds.map((id) => id.trim()))].filter(
            (id) => id !== ""
        ),
        starters: profile.starters.map(collapse).filter((starter) => starter !== ""),
        toolPolicy: { ...profile.toolPolicy },
        memoryPolicy: { ...profile.memoryPolicy },
        knowledge: profile.knowledge.map((entry) => ({
            name: collapse(entry.name),
            digest: entry.digest.trim(),
        })),
    };
}

/**
 * Multiset key for one knowledge entry.
 *
 * JSON rather than a separator: a name may contain whatever the owner typed,
 * and any character picked as a delimiter is a character that makes two
 * different pairs produce one key.
 */
const knowledgeKey = (entry: { name: string; digest: string }): string =>
    JSON.stringify([entry.name, entry.digest]);

const sameMultiset = (
    a: readonly { name: string; digest: string }[],
    b: readonly { name: string; digest: string }[]
): boolean => {
    if (a.length !== b.length) return false;
    const counts = new Map<string, number>();
    for (const entry of a) {
        const key = knowledgeKey(entry);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const entry of b) {
        const key = knowledgeKey(entry);
        const left = counts.get(key);
        if (left === undefined || left === 0) return false;
        counts.set(key, left - 1);
    }
    return true;
};

/**
 * The round-trip contract of §6.4.
 *
 * Knowledge is a multiset because two files may legitimately share a name, and
 * because the stored manifest is ordered by file id -- which a re-import
 * reissues, so any order-sensitive comparison would fail on content that is
 * identical.
 *
 * Deliberately NOT merged with `draftsEqual()`. That function decides whether
 * an edit is worth a revision and therefore has to look at file ids: deleting a
 * file and re-uploading the same bytes is a real change to a profile. This one
 * decides whether the format lost anything. One predicate cannot answer both
 * without being wrong about one of them.
 */
export function portableProfileEquals(
    left: PortableProfile,
    right: PortableProfile
): boolean {
    const a = normalizePortableProfile(left);
    const b = normalizePortableProfile(right);
    return (
        a.name === b.name &&
        a.icon === b.icon &&
        a.description === b.description &&
        a.instructions === b.instructions &&
        a.modelIds.length === b.modelIds.length &&
        a.modelIds.every((id, index) => id === b.modelIds[index]) &&
        a.starters.length === b.starters.length &&
        a.starters.every((starter, index) => starter === b.starters[index]) &&
        a.toolPolicy.webSearch === b.toolPolicy.webSearch &&
        a.toolPolicy.deepResearch === b.toolPolicy.deepResearch &&
        a.memoryPolicy.useAccountMemory === b.memoryPolicy.useAccountMemory &&
        sameMultiset(a.knowledge, b.knowledge)
    );
}

/** A manifest read as a `PortableProfile`. */
export function manifestToPortableProfile(
    manifest: AssistantPackageManifest
): PortableProfile {
    return normalizePortableProfile({
        name: manifest.profile.name,
        icon: manifest.profile.icon,
        description: manifest.profile.description,
        instructions: manifest.version.instructions,
        modelIds: manifest.version.modelIds,
        starters: manifest.version.starters,
        toolPolicy: manifest.version.toolPolicy,
        memoryPolicy: manifest.version.memoryPolicy,
        knowledge: manifest.version.knowledge.map((entry) => ({
            name: entry.name,
            digest: entry.digest,
        })),
    });
}

/**
 * The bytes a package digest covers.
 *
 * Every field except the digest itself, in a fixed order, so two runs over the
 * same content produce the same string. JSON.stringify of the object would not
 * do: key order there is insertion order, which is whatever the producer
 * happened to build.
 */
export function packageDigestPayload(
    manifest: Omit<AssistantPackageManifest, "packageDigest">
): string {
    const profile = normalizePortableProfile({
        name: manifest.profile.name,
        icon: manifest.profile.icon,
        description: manifest.profile.description,
        instructions: manifest.version.instructions,
        modelIds: manifest.version.modelIds,
        starters: manifest.version.starters,
        toolPolicy: manifest.version.toolPolicy,
        memoryPolicy: manifest.version.memoryPolicy,
        knowledge: manifest.version.knowledge.map((entry) => ({
            name: entry.name,
            digest: entry.digest,
        })),
    });
    return [
        `schemaVersion=${manifest.schemaVersion}`,
        `digestVersion=${manifest.digestVersion}`,
        `name=${profile.name}`,
        `icon=${profile.icon ?? ""}`,
        `description=${profile.description ?? ""}`,
        `instructions=${profile.instructions}`,
        `modelIds=${profile.modelIds.join(",")}`,
        `starters=${JSON.stringify(profile.starters)}`,
        `webSearch=${profile.toolPolicy.webSearch}`,
        `deepResearch=${profile.toolPolicy.deepResearch}`,
        `useAccountMemory=${profile.memoryPolicy.useAccountMemory}`,
        `knowledge=${JSON.stringify([...profile.knowledge].map(knowledgeKey).sort())}`,
    ].join("\n");
}
