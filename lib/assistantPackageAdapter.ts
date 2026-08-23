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
    /** Why this needs a look, when it does. Rendered next to the field. */
    note: string | null;
};

/** One thing the target cannot hold. Named, not counted (§5.1). */
export type ConversionLoss = {
    kind:
        | "scripts"
        | "icon"
        | "model"
        | "license"
        | "unknown_frontmatter"
        | "allowed_tools"
        | "relative_links"
        | "skipped_entries"
        | "knowledge_over_limit";
    /** One line the owner reads. No paths, no secrets. */
    detail: string;
};

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
    refusals: { code: "ASSISTANT_PACKAGE_INSTRUCTIONS_TOO_LONG"; detail: string }[];
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
            detail: `The instructions are ${codePoints(body)} characters; the limit is ${ASSISTANT_PACKAGE_LIMITS.maxInstructionCharacters}. Shorten them in the package and import it again.`,
        });
    }

    if (inventory.scriptPaths.length > 0) {
        losses.push({
            kind: "scripts",
            detail: `${inventory.scriptPaths.length} executable file(s): ${inventory.scriptPaths.join(", ")}. Tomverse does not run scripts and did not read them.`,
        });
    }
    if (frontmatter.allowedTools !== null) {
        losses.push({
            kind: "allowed_tools",
            detail: `The package requests tools (${frontmatter.allowedTools}). Tool access is decided by your plan and this profile's own settings, not by the package.`,
        });
    }
    if (frontmatter.license !== null) {
        losses.push({
            kind: "license",
            detail: `Licence stated as "${frontmatter.license}". Licences are not stored on a profile.`,
        });
    } else {
        losses.push({
            kind: "license",
            detail: "The package states no licence. Check that you may use its contents.",
        });
    }
    if (frontmatter.unknownKeys.length > 0) {
        losses.push({
            kind: "unknown_frontmatter",
            detail: `${frontmatter.unknownKeys.length} setting(s) this import does not understand: ${frontmatter.unknownKeys.join(", ")}.`,
        });
    }
    if (/\]\((?!https?:)[^)\s]+\)/.test(body)) {
        losses.push({
            kind: "relative_links",
            detail: "The instructions link to files inside the package. Those links will not resolve; add the files as knowledge if you need them.",
        });
    }
    losses.push({
        kind: "icon",
        detail: "Any icon image in the package is not carried over. A profile icon is an emoji.",
    });
    losses.push({
        kind: "model",
        detail: "The package does not choose a Tomverse model, and none is chosen for you. Pick one before publishing.",
    });
    if (inventory.skippedCount > 0) {
        losses.push({
            kind: "skipped_entries",
            detail: `${inventory.skippedCount} file(s) in the package are of a kind this import does not use.`,
        });
    }

    const candidates = inventory.knowledgeCandidates.slice(
        0,
        ASSISTANT_PACKAGE_LIMITS.maxKnowledgeFiles
    );
    if (inventory.knowledgeCandidates.length > candidates.length) {
        losses.push({
            kind: "knowledge_over_limit",
            detail: `The package offers ${inventory.knowledgeCandidates.length} documents; at most ${ASSISTANT_PACKAGE_LIMITS.maxKnowledgeFiles} can be imported at once.`,
        });
    }

    return {
        identity: {
            name: {
                value: name,
                disposition: "needs_review",
                note: nameTruncated
                    ? "Shortened to fit. A package name is a slug -- give it a name you would recognise in a list."
                    : "A package name is a slug -- give it a name you would recognise in a list.",
            },
            description: {
                value: description,
                disposition: "needs_review",
                note: descriptionTruncated
                    ? "Shortened to fit. A package description says when to use the skill; a profile description is just a label."
                    : null,
            },
        },
        instructions: {
            value: body,
            disposition: "needs_review",
            note: "Read this in full before approving. It came from a file, not from you.",
        },
        starters: { value: [], disposition: "automatic", note: null },
        modelIds: {
            value: [],
            disposition: "needs_review",
            note: "Choose a model. Nothing here is chosen for you.",
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
