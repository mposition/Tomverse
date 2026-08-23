/**
 * Turning an opened package into the thing the owner reviews (Slice 3).
 *
 * docs/policy/assistant-package-import.md §5, §8.
 *
 * ## Why this is not in the worker
 *
 * The worker's whole job is to be off the main thread. Everything it decides
 * is here instead, so the decisions can be tested by handing this function a
 * few byte arrays rather than by standing up a `Worker` and a `File` -- and so
 * that a reader looking for what an import actually does is not reading
 * message plumbing to find it.
 *
 * ## The review is a proposal, not an import
 *
 * Nothing here writes, uploads or decides. Every field arrives as a
 * `ProposedField` carrying whether it was taken automatically or wants a look,
 * every dropped thing is named in the loss report, and the owner's approval is
 * a later step. §8 is the reason the shape matters: the browser is not a
 * security boundary, so this output is a claim the server re-checks, and a
 * claim that hides what it dropped is the one thing the server cannot re-check.
 *
 * Isomorphic: hashing and the byte reader are injected. No Prisma, no R2, no
 * clock, no network.
 */

import {
    ASSISTANT_PACKAGE_ADAPTER_VERSION,
    convertSkillPackage,
    parseSkillDocument,
    type ConversionLoss,
    type ProposedField,
} from "@/lib/assistantPackageAdapter";
import {
    ASSISTANT_PACKAGE_LIMITS,
    type AssistantPackageRefusalCode,
    type AssistantPackageSkipReason,
} from "@/lib/assistantPackageLimits";
import {
    ASSISTANT_PACKAGE_KNOWLEDGE_PREFIX,
    assistantPackageManifestSchema,
    judgeManifestVersion,
    type AssistantPackageDeclaredSourceKind,
} from "@/lib/assistantPackageManifest";
import {
    collectUrlHosts,
    isTextScannable,
    scanAssistantPackage,
    type AssistantPackageSecretFinding,
    type Sha256Hex,
} from "@/lib/assistantPackageSecretScan";
import type { PackageEntryRole, PackagePlan, PackageZipEntry } from "@/lib/assistantPackageArchive";

/** One file the owner may choose to bring across. */
export type ReviewKnowledgeCandidate = {
    /** Path inside the container. Identifies the entry; never becomes a path. */
    path: string;
    /** The basename, which is what the owner sees and what gets stored. */
    name: string;
    bytes: number;
    /** `sha256:<hex>` over the inflated bytes. */
    digest: string;
    /** Whether this file's text was available to the secret scanner. */
    scannedAsText: boolean;
};

export type AssistantPackageReview = {
    /** What the package turned out to be, as observed here -- not as claimed. */
    kind: "agent-skill" | "tomverse-native";
    adapterVersion: string;
    identity: {
        name: ProposedField<string>;
        icon: ProposedField<string | null>;
        description: ProposedField<string | null>;
    };
    instructions: ProposedField<string>;
    starters: ProposedField<string[]>;
    modelIds: ProposedField<string[]>;
    toolPolicy: ProposedField<{ webSearch: boolean; deepResearch: boolean }>;
    memoryPolicy: ProposedField<{ useAccountMemory: boolean }>;
    knowledgeCandidates: ReviewKnowledgeCandidate[];
    /** Everything the target cannot hold, named. */
    losses: ConversionLoss[];
    /** Everything read past, under its own reason. */
    skips: { path: string; reason: AssistantPackageSkipReason }[];
    /** A6. Hosts the instructions point at, never the URLs. */
    instructionUrls: { count: number; hosts: string[] };
    /** A5. Findings, without the text that produced them. */
    secretFindings: AssistantPackageSecretFinding[];
    /** §6.5. What the package says about itself. Display only. */
    declaredProvenance: {
        sourceKind: AssistantPackageDeclaredSourceKind | null;
        sourceName: string | null;
        sourceUrl: string | null;
        exportedAt: string | null;
    } | null;
};

export type ReviewResult =
    | { outcome: "review"; review: AssistantPackageReview }
    | {
          outcome: "refused";
          code: AssistantPackageRefusalCode;
          /** Machine-readable. Never an entry path or file content (§9). */
          cause: string;
      };

/** The inflated bytes of every entry the plan chose, keyed by path. */
export type InflatedEntries = ReadonlyMap<string, Uint8Array>;

/**
 * Decoded text, or `null` when the bytes are not valid UTF-8.
 *
 * Fatal on purpose. Replacing an undecodable byte with U+FFFD produces a
 * string that looks like content and is not, and the chat attachment policy
 * already settled that this is an error rather than something to recover from.
 */
const decodeText = (bytes: Uint8Array): string | null => {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
};

const basename = (path: string): string => path.split("/").pop() ?? path;

const roleEntries = (plan: PackagePlan, role: PackageEntryRole): PackageZipEntry[] =>
    plan.reads.filter((read) => read.role === role).map((read) => read.entry);

const automatic = <T,>(value: T): ProposedField<T> => ({
    value,
    disposition: "automatic",
    note: null,
});

const needsReview = <T,>(value: T, note: string): ProposedField<T> => ({
    value,
    disposition: "needs_review",
    note,
});

/**
 * The review, from a plan and the bytes it selected.
 *
 * Which package this is comes from what the container holds, not from what it
 * says: a manifest at the root makes it native, a `SKILL.md` makes it an Agent
 * Skill, and neither makes it something this cannot open. A package carrying
 * both is native, because the manifest is the more specific claim and the
 * skill document is what a native export writes for other tools to read.
 */
export async function buildPackageReview(input: {
    plan: PackagePlan;
    entries: InflatedEntries;
    sha256Hex: Sha256Hex;
}): Promise<ReviewResult> {
    const { plan, entries, sha256Hex } = input;

    if (plan.packageRefusal) {
        return {
            outcome: "refused",
            code: plan.packageRefusal.code,
            cause: plan.packageRefusal.cause,
        };
    }

    const manifestEntry = roleEntries(plan, "manifest")[0];
    const skillEntry = roleEntries(plan, "skill_document")[0];
    if (manifestEntry) {
        return buildNativeReview({ plan, entries, sha256Hex, manifestEntry });
    }
    if (skillEntry) {
        return buildSkillReview({ plan, entries, sha256Hex, skillEntry });
    }
    return {
        outcome: "refused",
        code: "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED",
        cause: "no_manifest_or_skill_document",
    };
}

/* ------------------------------------------------------------ Agent Skill */

async function buildSkillReview(input: {
    plan: PackagePlan;
    entries: InflatedEntries;
    sha256Hex: Sha256Hex;
    skillEntry: PackageZipEntry;
}): Promise<ReviewResult> {
    const { plan, entries, sha256Hex, skillEntry } = input;
    const raw = entries.get(skillEntry.path);
    if (!raw) {
        return {
            outcome: "refused",
            code: "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED",
            cause: "skill_document_missing",
        };
    }
    const source = decodeText(raw);
    if (source === null) {
        return {
            outcome: "refused",
            code: "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED",
            cause: "skill_document_not_utf8",
        };
    }

    const parse = parseSkillDocument(source);
    if (parse.outcome === "invalid") {
        return {
            outcome: "refused",
            code: "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED",
            cause: parse.reason,
        };
    }

    const knowledgeEntries = roleEntries(plan, "knowledge");
    const conversion = convertSkillPackage({
        frontmatter: parse.frontmatter,
        body: parse.body,
        inventory: {
            skillDocument: skillEntry.path,
            knowledgeCandidates: knowledgeEntries.map((entry) => ({
                path: entry.path,
                name: basename(entry.path),
            })),
            scriptPaths: plan.skips
                .filter((skip) => skip.reason === "executable_script")
                .map((skip) => skip.path),
            // Scripts are already named in their own loss line, and a
            // directory entry is not a file anyone shipped as content.
            // Counting either here would report the same files twice under
            // two different headings.
            skippedCount: plan.skips.filter(
                (skip) =>
                    skip.reason !== "executable_script" && skip.reason !== "directory"
            ).length,
        },
    });

    if (conversion.refusals.length > 0) {
        return {
            outcome: "refused",
            code: conversion.refusals[0].code,
            cause: conversion.refusals[0].code,
        };
    }

    const candidates = await describeCandidates(
        conversion.knowledgeCandidates.map((candidate) => candidate.path),
        knowledgeEntries,
        entries,
        sha256Hex
    );

    const secretFindings = await scanAssistantPackage(
        {
            name: conversion.identity.name.value,
            description: conversion.identity.description.value,
            instructions: conversion.instructions.value,
            starters: conversion.starters.value,
            knowledge: scannableTexts(candidates, entries),
        },
        sha256Hex
    );

    return {
        outcome: "review",
        review: {
            kind: "agent-skill",
            adapterVersion: ASSISTANT_PACKAGE_ADAPTER_VERSION,
            identity: {
                name: conversion.identity.name,
                // An Agent Skill has no icon field, so there is nothing to
                // propose and nothing lost -- the profile's own default applies.
                icon: automatic(null),
                description: conversion.identity.description,
            },
            instructions: conversion.instructions,
            starters: conversion.starters,
            modelIds: conversion.modelIds,
            toolPolicy: conversion.toolPolicy,
            memoryPolicy: conversion.memoryPolicy,
            knowledgeCandidates: candidates,
            losses: conversion.losses,
            skips: plan.skips,
            instructionUrls: conversion.instructionUrls,
            secretFindings,
            declaredProvenance: null,
        },
    };
}

/* ---------------------------------------------------------------- native */

async function buildNativeReview(input: {
    plan: PackagePlan;
    entries: InflatedEntries;
    sha256Hex: Sha256Hex;
    manifestEntry: PackageZipEntry;
}): Promise<ReviewResult> {
    const { plan, entries, sha256Hex, manifestEntry } = input;
    const raw = entries.get(manifestEntry.path);
    if (!raw) {
        return {
            outcome: "refused",
            code: "ASSISTANT_PACKAGE_MANIFEST_INVALID",
            cause: "manifest_missing",
        };
    }
    const text = decodeText(raw);
    if (text === null) {
        return {
            outcome: "refused",
            code: "ASSISTANT_PACKAGE_MANIFEST_INVALID",
            cause: "manifest_not_utf8",
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return {
            outcome: "refused",
            code: "ASSISTANT_PACKAGE_MANIFEST_INVALID",
            cause: "manifest_not_json",
        };
    }

    // The version is judged before the schema, so a package from a later
    // Tomverse is told it is from a later Tomverse rather than told its fields
    // are wrong -- which is what a strict schema would say about every one of
    // them.
    const verdict = judgeManifestVersion(parsed);
    if (verdict.outcome === "refuse") {
        return {
            outcome: "refused",
            code:
                verdict.reason === "absent"
                    ? "ASSISTANT_PACKAGE_MANIFEST_INVALID"
                    : "ASSISTANT_PACKAGE_SCHEMA_VERSION_UNSUPPORTED",
            cause: verdict.reason,
        };
    }

    const manifest = assistantPackageManifestSchema.safeParse(parsed);
    if (!manifest.success) {
        return {
            outcome: "refused",
            code: "ASSISTANT_PACKAGE_MANIFEST_INVALID",
            cause: "schema",
        };
    }

    // `packageDigest` is required by the schema and deliberately not verified
    // here. A producer who changed the content can recompute it, so it proves
    // nothing about intent; refusing on it would only reject an owner who
    // hand-fixed a typo in their own export. What is verified is each
    // knowledge digest, because that one says the manifest and the bytes in
    // the same container disagree, which no honest export produces.
    const knowledgeEntries = roleEntries(plan, "knowledge");
    const byPath = new Map(knowledgeEntries.map((entry) => [entry.path, entry]));
    const candidates: ReviewKnowledgeCandidate[] = [];
    for (const declared of manifest.data.version.knowledge) {
        if (!declared.path.startsWith(ASSISTANT_PACKAGE_KNOWLEDGE_PREFIX)) {
            return {
                outcome: "refused",
                code: "ASSISTANT_PACKAGE_MANIFEST_INVALID",
                cause: "knowledge_path_outside_prefix",
            };
        }
        const entry = byPath.get(declared.path);
        const bytes = entry ? entries.get(entry.path) : undefined;
        if (!entry || !bytes) {
            return {
                outcome: "refused",
                code: "ASSISTANT_PACKAGE_MANIFEST_INVALID",
                cause: "knowledge_entry_missing",
            };
        }
        const digest = `sha256:${await sha256Hex(bytes)}`;
        if (digest !== declared.digest) {
            // The manifest is the thing the owner is shown; a manifest that
            // describes bytes the container does not hold describes a package
            // that was edited after it was written.
            return {
                outcome: "refused",
                code: "ASSISTANT_PACKAGE_MANIFEST_INVALID",
                cause: "knowledge_digest_mismatch",
            };
        }
        candidates.push({
            path: declared.path,
            name: declared.name,
            bytes: bytes.length,
            digest,
            scannedAsText: isTextScannable(declared.name),
        });
    }

    if (candidates.length > ASSISTANT_PACKAGE_LIMITS.maxKnowledgeFiles) {
        return {
            outcome: "refused",
            code: "ASSISTANT_PACKAGE_MANIFEST_INVALID",
            cause: "knowledge_over_limit",
        };
    }

    const version = manifest.data.version;
    const secretFindings = await scanAssistantPackage(
        {
            name: manifest.data.profile.name,
            description: manifest.data.profile.description,
            instructions: version.instructions,
            starters: version.starters,
            knowledge: scannableTexts(candidates, entries),
        },
        sha256Hex
    );

    const losses: ConversionLoss[] = [];
    const unlisted = knowledgeEntries.filter(
        (entry) => !candidates.some((candidate) => candidate.path === entry.path)
    );
    if (unlisted.length > 0) {
        // Not a refusal: an extra document in the container is not a lie about
        // the profile. It is reported because the owner would otherwise see a
        // file count that does not match the archive they built.
        losses.push({
            kind: "skipped_entries",
            detail: `${unlisted.length} file(s) in the container are not listed in the manifest and were not offered.`,
        });
    }

    return {
        outcome: "review",
        review: {
            kind: "tomverse-native",
            adapterVersion: manifest.data.producedBy.adapterVersion,
            identity: {
                // A native package was written by this app from a profile the
                // owner already approved, so nothing here is a guess. The name
                // still wants a look because two profiles may not share one.
                name: needsReview(
                    manifest.data.profile.name,
                    "Names are not unique; confirm or change it."
                ),
                icon: automatic(manifest.data.profile.icon),
                description: automatic(manifest.data.profile.description),
            },
            instructions: automatic(version.instructions),
            starters: automatic([...version.starters]),
            // Still not chosen for the owner: the models a package names may
            // not be models this account can use, and §5.3 puts entitlement at
            // runtime rather than here.
            modelIds: needsReview(
                [...version.modelIds],
                "Confirm the models this profile should start with."
            ),
            toolPolicy: automatic(version.toolPolicy),
            memoryPolicy: automatic(version.memoryPolicy),
            knowledgeCandidates: candidates,
            losses,
            skips: plan.skips,
            // A6 applies here too. A native package is still a file that came
            // from outside this account, and "we wrote the format" is not a
            // reason to stop telling the owner where its instructions point.
            instructionUrls: collectUrlHosts(version.instructions),
            secretFindings,
            declaredProvenance: manifest.data.declaredPreviousProvenance,
        },
    };
}

/* ---------------------------------------------------------------- helpers */

async function describeCandidates(
    paths: readonly string[],
    knowledgeEntries: readonly PackageZipEntry[],
    entries: InflatedEntries,
    sha256Hex: Sha256Hex
): Promise<ReviewKnowledgeCandidate[]> {
    const byPath = new Map(knowledgeEntries.map((entry) => [entry.path, entry]));
    const described: ReviewKnowledgeCandidate[] = [];
    for (const path of paths) {
        const entry = byPath.get(path);
        const bytes = entry ? entries.get(path) : undefined;
        if (!entry || !bytes) continue;
        const name = basename(path);
        described.push({
            path,
            name,
            bytes: bytes.length,
            digest: `sha256:${await sha256Hex(bytes)}`,
            scannedAsText: isTextScannable(name),
        });
    }
    return described;
}

/**
 * The text of the candidates the scanner can read.
 *
 * A file whose bytes are not valid UTF-8 is dropped here rather than decoded
 * leniently: scanning replacement characters finds nothing and reports
 * nothing, which is worse than not scanning, because it looks like a clean
 * result.
 */
function scannableTexts(
    candidates: readonly ReviewKnowledgeCandidate[],
    entries: InflatedEntries
): { name: string; text: string }[] {
    const texts: { name: string; text: string }[] = [];
    for (const candidate of candidates) {
        if (!candidate.scannedAsText) continue;
        const bytes = entries.get(candidate.path);
        if (!bytes) continue;
        const text = decodeText(bytes);
        if (text === null) continue;
        texts.push({ name: candidate.name, text });
    }
    return texts;
}
