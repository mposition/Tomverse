/**
 * Turning an Agent Skill package into a profile draft, and saying what was
 * lost doing it (Slice 2).
 *
 * docs/policy/assistant-package-import.md §5.
 *
 * ## The adapter's real output is the loss report
 *
 * Converting `SKILL.md` into a name and an instruction block is the easy half.
 * The half that decides whether this feature is honest is the list of things
 * the target cannot hold: the scripts, the icon, the model the package names,
 * the frontmatter keys nobody here understands. §5.1 requires each of those to
 * appear by name -- a count alone tells the owner something went missing
 * without telling them what, which is worse than saying nothing.
 *
 * ## Nothing here decides anything on the owner's behalf
 *
 * Every mapping is `automatic` or `needs_review`, and the review ones default
 * to unselected. The model in particular is never chosen: §1.1 forbids
 * substituting a Tomverse model for an external name, so an external model
 * shows up in the loss report and the picker stays empty.
 *
 * ## Why the body is not truncated
 *
 * An instruction longer than the column is refused, not shortened. Cutting an
 * instruction changes what it says, and the owner cannot see which sentence
 * stopped applying. §5.2 makes that a refusal with a length, so the fix is
 * theirs to make.
 *
 * Pure: no Prisma, no R2, no clock, no network.
 */

import { parse as parseYaml } from "yaml";

import { ASSISTANT_PROFILE_LIMITS } from "@/lib/assistantProfileVersioning";
import {
    ASSISTANT_PACKAGE_KNOWLEDGE_EXTENSIONS,
    ASSISTANT_PACKAGE_LIMITS,
    packageEntryExtension,
} from "@/lib/assistantPackageLimits";
import { collectUrlHosts } from "@/lib/assistantPackageSecretScan";

/** The version of this interpretation. Recorded, never inferred from output. */
export const ASSISTANT_PACKAGE_ADAPTER_VERSION = "assistant-package-v1";

/* ------------------------------------------------------------ frontmatter */

/**
 * Frontmatter keys the open specification defines. Anything else is counted
 * and reported rather than dropped in silence (§5.2).
 *
 * `display_name` is absent deliberately: it is a parameter of the skill
 * creation request, not a `SKILL.md` field, so a local archive never carries
 * it and pretending to map it would invent a source.
 */
export const SKILL_FRONTMATTER_KNOWN_KEYS = new Set([
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
]);

export type SkillFrontmatter = {
    name: string | null;
    description: string | null;
    license: string | null;
    /** Present or not; the value is never mapped to a tool policy (§5.2). */
    allowedTools: string | null;
    unknownKeys: string[];
};

export type SkillDocumentParse =
    | { outcome: "parsed"; frontmatter: SkillFrontmatter; body: string }
    | {
          outcome: "invalid";
          reason: "missing_frontmatter" | "malformed_yaml" | "frontmatter_not_a_map";
      };

const FRONTMATTER_BOUNDARY = /^---[ \t]*$/;

/**
 * Splits `SKILL.md` into its frontmatter and its body.
 *
 * Hand-split rather than handed whole to the YAML parser, because the body is
 * Markdown and may contain anything at all -- including a line of three
 * dashes. Only the first block counts, and only when the file opens with one.
 */
export function parseSkillDocument(source: string): SkillDocumentParse {
    // Written as an escape, never as the character itself: a literal BOM makes
    // this file binary to git and `check:encoding:strict` refuses one in source.
    const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/gu, "\n");
    const lines = text.split("\n");
    if (lines.length === 0 || !FRONTMATTER_BOUNDARY.test(lines[0] ?? "")) {
        return { outcome: "invalid", reason: "missing_frontmatter" };
    }
    let close = -1;
    for (let index = 1; index < lines.length; index += 1) {
        if (FRONTMATTER_BOUNDARY.test(lines[index] ?? "")) {
            close = index;
            break;
        }
    }
    if (close === -1) return { outcome: "invalid", reason: "missing_frontmatter" };

    let parsed: unknown;
    try {
        parsed = parseYaml(lines.slice(1, close).join("\n"));
    } catch {
        return { outcome: "invalid", reason: "malformed_yaml" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { outcome: "invalid", reason: "frontmatter_not_a_map" };
    }

    const map = parsed as Record<string, unknown>;
    const scalar = (key: string): string | null => {
        const value = map[key];
        if (typeof value === "string") return value.trim();
        if (typeof value === "number" || typeof value === "boolean") {
            return String(value);
        }
        return null;
    };

    return {
        outcome: "parsed",
        frontmatter: {
            name: scalar("name"),
            description: scalar("description"),
            license: scalar("license"),
            allowedTools: scalar("allowed-tools"),
            unknownKeys: Object.keys(map)
                .filter((key) => !SKILL_FRONTMATTER_KNOWN_KEYS.has(key))
                .sort(),
        },
        body: lines.slice(close + 1).join("\n").trim(),
    };
}

/* -------------------------------------------------------------- the draft */

/**
 * How a field arrives at the review screen.
 *
 * `needs_review` fields start unselected. That is the difference between a
 * wizard that shows the owner what it decided and one that asks them.
 */
export type FieldDisposition = "automatic" | "needs_review";

export type ProposedField<T> = {
    value: T;
    disposition: FieldDisposition;
    /**
     * Why this needs a look, when it does. A code, not a sentence -- the
     * sentence belongs to whichever language the reader has.
     */
    note: ImportFieldNote | null;
};

/**
 * One thing the target cannot hold (§5.1).
 *
 * Data, not a sentence. The sentence is in `locales/*.ts`, because this
 * module is imported by the browser and by the server and neither of them
 * knows what language the reader has -- and because an English `detail` field
 * is a field somebody eventually renders, which is exactly how a surface ends
 * up shipping English to six locales.
 *
 * `items` names the things when naming them helps: script paths, unrecognised
 * frontmatter keys, the licence the package stated. It never carries file
 * content.
 */
export type ConversionLoss = {
    kind: ConversionLossKind;
    /** How many things this is about, when a count is meaningful. */
    count?: number;
    /** The things themselves, when naming them helps. Never content. */
    items?: string[];
};

export const CONVERSION_LOSS_KINDS = [
    "scripts",
    "icon",
    "model",
    /** The package names a licence. Profiles do not store one. */
    "license_stated",
    /** The package names none, which is its own thing to say. */
    "license_absent",
    "unknown_frontmatter",
    "allowed_tools",
    "relative_links",
    "skipped_entries",
    "knowledge_over_limit",
] as const;

export type ConversionLossKind = (typeof CONVERSION_LOSS_KINDS)[number];

/**
 * Why a proposed field wants a look, as a code rather than a sentence.
 *
 * Same reason as `ConversionLoss`: this is read by a UI that has a language,
 * and this module does not.
 */
export const IMPORT_FIELD_NOTES = [
    "name_is_a_slug",
    "name_shortened",
    "description_shortened",
    "read_the_instructions",
    "choose_a_model",
    "name_may_collide",
    "confirm_models",
] as const;

export type ImportFieldNote = (typeof IMPORT_FIELD_NOTES)[number];

export type SkillConversion = {
    identity: {
        name: ProposedField<string>;
        description: ProposedField<string | null>;
    };
    instructions: ProposedField<string>;
    /** Empty: an Agent Skill has no conversation starters (§5.2). */
    starters: ProposedField<string[]>;
    /** Always empty. A model is the owner's choice, never ours (§1.1, §5.3). */
    modelIds: ProposedField<string[]>;
    toolPolicy: ProposedField<{ webSearch: boolean; deepResearch: boolean }>;
    memoryPolicy: ProposedField<{ useAccountMemory: boolean }>;
    /** Candidate knowledge, by archive path. Selection is the owner's. */
    knowledgeCandidates: { path: string; name: string }[];
    losses: ConversionLoss[];
    /** A6: what the instruction points at, by host. */
    instructionUrls: { count: number; hosts: string[] };
    /** Refusals that stop the conversion rather than reduce it. */
    refusals: {
        code: "ASSISTANT_PACKAGE_INSTRUCTIONS_TOO_LONG";
        characters: number;
        limit: number;
    }[];
};

/** What the archive scan hands over. Paths only -- no bytes for scripts. */
export type SkillPackageInventory = {
    skillDocument: string;
    /** Text/document entries that could become knowledge. */
    knowledgeCandidates: { path: string; name: string }[];
    /** Executable entries. Present so they can be named; never inflated. */
    scriptPaths: string[];
    /** Entries skipped for any other reason, with their reason. */
    skippedCount: number;
};

const codePoints = (value: string): number => [...value].length;

/**
 * A slug is a poor display name, so the name always needs a look even when it
 * fits. `my-code-reviewer` is what the specification asks an author for and
 * not what anyone wants at the top of a profile list.
 */
export function convertSkillPackage(input: {
    frontmatter: SkillFrontmatter;
    body: string;
    inventory: SkillPackageInventory;
}): SkillConversion {
    const { frontmatter, body, inventory } = input;
    const losses: ConversionLoss[] = [];
    const refusals: SkillConversion["refusals"] = [];

    const rawName = frontmatter.name ?? "";
    const name = [...rawName].slice(0, ASSISTANT_PROFILE_LIMITS.maxNameCharacters).join("");
    const nameTruncated = codePoints(rawName) > ASSISTANT_PROFILE_LIMITS.maxNameCharacters;

    const rawDescription = frontmatter.description;
    const description =
        rawDescription === null
            ? null
            : [...rawDescription]
                  .slice(0, ASSISTANT_PROFILE_LIMITS.maxDescriptionCharacters)
                  .join("");
    const descriptionTruncated =
        rawDescription !== null &&
        codePoints(rawDescription) > ASSISTANT_PROFILE_LIMITS.maxDescriptionCharacters;

    if (codePoints(body) > ASSISTANT_PACKAGE_LIMITS.maxInstructionCharacters) {
        refusals.push({
            code: "ASSISTANT_PACKAGE_INSTRUCTIONS_TOO_LONG",
            characters: codePoints(body),
            limit: ASSISTANT_PACKAGE_LIMITS.maxInstructionCharacters,
        });
    }

    if (inventory.scriptPaths.length > 0) {
        losses.push({
            kind: "scripts",
            count: inventory.scriptPaths.length,
            items: [...inventory.scriptPaths],
        });
    }
    if (frontmatter.allowedTools !== null) {
        losses.push({ kind: "allowed_tools", items: [frontmatter.allowedTools] });
    }
    losses.push(
        frontmatter.license !== null
            ? { kind: "license_stated", items: [frontmatter.license] }
            : { kind: "license_absent" }
    );
    if (frontmatter.unknownKeys.length > 0) {
        losses.push({
            kind: "unknown_frontmatter",
            count: frontmatter.unknownKeys.length,
            items: [...frontmatter.unknownKeys],
        });
    }
    if (/\]\((?!https?:)[^)\s]+\)/.test(body)) {
        losses.push({ kind: "relative_links" });
    }
    losses.push({ kind: "icon" });
    losses.push({ kind: "model" });
    if (inventory.skippedCount > 0) {
        losses.push({ kind: "skipped_entries", count: inventory.skippedCount });
    }

    const candidates = inventory.knowledgeCandidates.slice(
        0,
        ASSISTANT_PACKAGE_LIMITS.maxKnowledgeFiles
    );
    if (inventory.knowledgeCandidates.length > candidates.length) {
        // The limit itself is not carried: it is one constant both sides
        // already import, and a copy in the message is a copy that can be
        // stale by the time it is read.
        losses.push({
            kind: "knowledge_over_limit",
            count: inventory.knowledgeCandidates.length,
        });
    }

    return {
        identity: {
            name: {
                value: name,
                disposition: "needs_review",
                note: nameTruncated ? "name_shortened" : "name_is_a_slug",
            },
            description: {
                value: description,
                disposition: "needs_review",
                note: descriptionTruncated ? "description_shortened" : null,
            },
        },
        instructions: {
            value: body,
            disposition: "needs_review",
            note: "read_the_instructions",
        },
        starters: { value: [], disposition: "automatic", note: null },
        modelIds: {
            value: [],
            disposition: "needs_review",
            note: "choose_a_model",
        },
        toolPolicy: {
            value: { webSearch: false, deepResearch: false },
            disposition: "automatic",
            note: null,
        },
        memoryPolicy: {
            value: { useAccountMemory: false },
            disposition: "automatic",
            note: null,
        },
        knowledgeCandidates: candidates,
        losses,
        instructionUrls: collectUrlHosts(body),
        refusals,
    };
}

/**
 * Whether a candidate path looks like a knowledge document, by extension only.
 *
 * By extension only, and deliberately: the server re-decides with magic bytes
 * and its own allowlist. Guessing harder here would produce a browser opinion
 * the server then contradicts, which reads to the owner as the import losing a
 * file it had already shown them.
 */
export const looksLikeKnowledgeCandidate = (path: string): boolean =>
    ASSISTANT_PACKAGE_KNOWLEDGE_EXTENSIONS.has(packageEntryExtension(path));
