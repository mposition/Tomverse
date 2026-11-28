/**
 * Writing an assistant as a `SKILL.md` (Agent Skills specification).
 *
 * docs/policy/assistant-package-import.md §6.
 *
 * The reading half already exists (`parseSkillDocument` in
 * `lib/assistantPackageAdapter.ts`); this is its mirror, so a skill written
 * here comes back through the same parser. Only the specification's required
 * frontmatter fields are written. `license`, `compatibility`, `metadata` and
 * `allowed-tools` are optional, and an assistant has nothing true to say in
 * any of them -- writing a field we cannot stand behind would be worse than
 * leaving it out.
 *
 * Pure: no Prisma, no clock, no network.
 */

import { stringify } from "yaml";

/** The specification's bounds for the two required fields. */
export const SKILL_DOCUMENT_LIMITS = {
    maxNameCharacters: 64,
    maxDescriptionCharacters: 1_024,
} as const;

/** What a skill is called when an assistant's name has no usable character. */
const FALLBACK_SKILL_NAME = "assistant";

/**
 * A specification-valid skill name from an assistant's display name.
 *
 * Lowercase ASCII letters, digits and single hyphens, never starting or
 * ending with one, at most 64 characters. Accents are folded rather than
 * dropped (`Café` becomes `cafe`); a name with no Latin letter or digit at
 * all, such as one written entirely in Hangul, falls back to a generic name
 * because the display name still travels in the description.
 */
export function skillNameFromProfileName(name: string): string {
    const slug = name
        .normalize("NFKD")
        // The accents NFKD split off. Left in, each would read as a separator.
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .slice(0, SKILL_DOCUMENT_LIMITS.maxNameCharacters)
        .replace(/-+$/u, "");
    return slug === "" ? FALLBACK_SKILL_NAME : slug;
}

export type SkillDocumentSource = {
    /** The assistant's display name. */
    name: string;
    description: string | null;
    instructions: string;
};

/**
 * The `SKILL.md` text.
 *
 * The description is required and non-empty in the specification, and an
 * assistant's is optional, so the display name stands in when there is none.
 * The YAML is produced by the YAML library rather than concatenated, because a
 * description may hold a colon, a quote or a `#` and a hand-built line would
 * turn that into a different document.
 */
export function buildSkillDocument(source: SkillDocumentSource): string {
    const description = [
        ...(source.description?.trim() || source.name.trim() || FALLBACK_SKILL_NAME),
    ]
        .slice(0, SKILL_DOCUMENT_LIMITS.maxDescriptionCharacters)
        .join("");
    const frontmatter = stringify(
        { name: skillNameFromProfileName(source.name), description },
        // No folding: the parser reads a folded scalar back correctly, but an
        // exported description that wraps at 80 columns is harder to review.
        { lineWidth: 0 }
    );
    const body = source.instructions.replace(/\r\n?/gu, "\n").trim();
    return `---\n${frontmatter}---\n\n${body}${body === "" ? "" : "\n"}`;
}

/** The download's filename. The specification names the file, not the skill. */
export const SKILL_DOCUMENT_FILENAME = "SKILL.md";
