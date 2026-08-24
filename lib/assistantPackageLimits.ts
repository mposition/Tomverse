/**
 * The figures an imported assistant package is bounded by (Slice 2).
 *
 * docs/policy/assistant-package-import.md §4 approves B1–B6 on 2026-08-23.
 * Changing a number here is a policy change, so change the policy first.
 *
 * ## Why these are not the import limits
 *
 * `lib/externalImportLimits.ts` bounds a conversation export: a container
 * that is mostly media, where the useful part is one JSON entry and gating on
 * total size would reject the heavy users the feature is for. A skill package
 * is the opposite -- a few dozen text files whose whole content is the point.
 * The two sets of numbers guard different shapes, and §4 records each of these
 * as its own decision rather than as an inheritance. Moving one must not move
 * the other.
 *
 * The single exception is the instruction ceiling, which is not a new limit at
 * all: it is `ASSISTANT_PROFILE_LIMITS.maxInstructionsCharacters`, the same
 * column bound the profile editor already enforces. It is re-exported here so
 * the adapter can refuse early with a message naming the package, and it is
 * read from the existing constant rather than copied, because two spellings of
 * one limit is how they come apart.
 *
 * Pure: no Prisma, no R2, no clock, no network.
 */

import { ASSISTANT_PROFILE_LIMITS } from "@/lib/assistantProfileVersioning";

export const ASSISTANT_PACKAGE_LIMITS = {
    /**
     * B1. The archive as it arrives. Agent Skills upload caps a skill at under
     * 30MB uncompressed, so a compressed container has room here without this
     * becoming the limit anyone meets.
     */
    maxContainerBytes: 64 * 1024 * 1024,
    /**
     * B2. A skill package is documents and scripts, not a mail spool. The
     * conversation import's 50,000 answers a different question.
     */
    maxEntries: 2_000,
    /** B3. Everything the parser inflates, across all entries. */
    maxTotalInflatedBytes: 128 * 1024 * 1024,
    /**
     * B4. One entry. The same physical constraint as a knowledge file --
     * the largest single blob the server will hold in memory -- and the same
     * value for that reason, decided separately.
     */
    maxEntryBytes: 32 * 1024 * 1024,
    /**
     * B5. Not a new ceiling: the profile version column's own bound. Read from
     * the source rather than restated.
     */
    maxInstructionCharacters: ASSISTANT_PROFILE_LIMITS.maxInstructionsCharacters,
    /**
     * B6. How many knowledge files one package may contribute. Half of
     * `maxFilesPerProfile`, so a package cannot fill a profile on its own and
     * the owner keeps room to add their own.
     */
    maxKnowledgeFiles: 10,
    /**
     * Inflated-to-compressed ratio for an entry the parser actually reads.
     * Not one of the approved figures: it is the archive-bomb guard the
     * conversation import already uses, at the same value, because the attack
     * and the defence are identical and a second number would only be a second
     * thing to get wrong.
     */
    maxEntryCompressionRatio: 100,
} as const;

/**
 * Entry names a package may not carry, whatever else is true of them.
 *
 * Judged on the name alone and before anything is inflated, because the point
 * is to refuse without reading. A script is not on this list -- scripts are
 * allowed to exist in a package and are reported rather than refused (§5.2);
 * what they are never allowed to do is run, and the parser achieves that by
 * never inflating them.
 */
export const ASSISTANT_PACKAGE_REFUSED_ENTRY_REASONS = [
    "path_traversal",
    "absolute_path",
    "encrypted",
    "symlink",
    "duplicate_path",
    "case_collision",
    "entry_too_large",
    "suspicious_compression_ratio",
] as const;

export type AssistantPackageRefusedEntryReason =
    (typeof ASSISTANT_PACKAGE_REFUSED_ENTRY_REASONS)[number];

/**
 * Why an entry was read past but not used. Each is counted under its own
 * reason: folded together, the inventory could not say why something the
 * owner expected to see is missing.
 */
export const ASSISTANT_PACKAGE_SKIP_REASONS = [
    "directory",
    "nested_archive",
    "executable_script",
    "unsupported_extension",
    "media",
    "empty",
    "over_knowledge_limit",
] as const;

export type AssistantPackageSkipReason =
    (typeof ASSISTANT_PACKAGE_SKIP_REASONS)[number];

/** Refusals that end the whole package rather than one entry. */
export const ASSISTANT_PACKAGE_REFUSAL_CODES = [
    "ASSISTANT_PACKAGE_TOO_LARGE",
    "ASSISTANT_PACKAGE_TOO_MANY_ENTRIES",
    "ASSISTANT_PACKAGE_UNSAFE_ENTRY",
    "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED",
    "ASSISTANT_PACKAGE_MANIFEST_INVALID",
    "ASSISTANT_PACKAGE_SCHEMA_VERSION_UNSUPPORTED",
    "ASSISTANT_PACKAGE_INSTRUCTIONS_TOO_LONG",
    "ASSISTANT_PACKAGE_SECRET_PRESENT",
] as const;

export type AssistantPackageRefusalCode =
    (typeof ASSISTANT_PACKAGE_REFUSAL_CODES)[number];

/**
 * File extensions that may become knowledge, narrowed from the knowledge
 * allowlist to what a text-shaped package actually carries.
 *
 * The knowledge tables accept PDFs and Office documents too, and a package may
 * contain them; those are offered as candidates by extension here so the
 * server's own `knowledgeFileRefusal()` remains the thing that decides -- this
 * list exists to keep the inventory honest, not to grant anything.
 */
export const ASSISTANT_PACKAGE_KNOWLEDGE_EXTENSIONS = new Set([
    "txt",
    "text",
    "log",
    "md",
    "markdown",
    "csv",
    "json",
    "pdf",
    "docx",
    "xlsx",
    "pptx",
    "odt",
    "ods",
    "odp",
]);

/**
 * Extensions the inventory reports as executable code.
 *
 * "Executable" here means what §1.1 means by it: a file whose purpose is to be
 * run. It is reported, never inflated, and never offered as knowledge. The
 * chat attachment policy makes the same call on the same extensions and lets
 * a user attach a `.py` for reading -- the difference is that a package's
 * scripts arrive alongside instructions telling a model to use them, which is
 * the combination this refuses to carry forward.
 */
export const ASSISTANT_PACKAGE_SCRIPT_EXTENSIONS = new Set([
    "sh",
    "bash",
    "zsh",
    "ps1",
    "bat",
    "cmd",
    "com",
    "exe",
    "msi",
    "py",
    "rb",
    "pl",
    "php",
    "js",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "jsx",
    "jar",
    "app",
    "bin",
    "dll",
    "so",
    "dylib",
]);

/** Archive extensions. Never opened -- depth stays 0 (§1.1, and Release A §5.2). */
export const ASSISTANT_PACKAGE_ARCHIVE_EXTENSIONS = new Set([
    "zip",
    "tgz",
    "gz",
    "tar",
    "bz2",
    "xz",
    "7z",
    "rar",
]);

/** Binary media a package may carry and knowledge cannot use. */
export const ASSISTANT_PACKAGE_MEDIA_EXTENSIONS = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "svg",
    "ico",
    "heic",
    "heif",
    "mp3",
    "wav",
    "m4a",
    "ogg",
    "flac",
    "mp4",
    "mov",
    "webm",
    "avi",
    "mkv",
    "ttf",
    "otf",
    "woff",
    "woff2",
]);

/** Lowercased extension without the dot, or "" when the name has none. */
export const packageEntryExtension = (name: string): string => {
    const base = name.split("/").pop() ?? name;
    const dot = base.lastIndexOf(".");
    if (dot <= 0 || dot === base.length - 1) return "";
    return base.slice(dot + 1).toLowerCase();
};
