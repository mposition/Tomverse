/**
 * Whether a previewed page may be published as a share link, as facts in and
 * an answer out.
 *
 * Policy: docs/policy/generated-artifacts.md section 19. A share link turns
 * one previewed HTML page, SVG or React component into a public, read-only
 * page anyone holding the link can open. That is content leaving the account,
 * so it sits behind `feature.artifactSharingEnabled`, a default-off switch
 * that only the literal "true" turns on, and it is off whenever the existing
 * `feature.publicSharingEnabled` maintenance switch is off.
 *
 * Pure: the route gathers the facts, this decides, so the route and its tests
 * cannot disagree about a rule.
 */

import { codePreviewKindForLanguage, type CodePreviewKind } from "@/lib/chatArtifactPreview";
import { HTML_PREVIEW_MAX_BYTES } from "@/lib/htmlArtifactPreview";

export const ARTIFACT_SHARING_FLAG_KEY = "feature.artifactSharingEnabled";

export const artifactSharingEnabledFromValue = (value: string | null | undefined): boolean => value === "true";

/** Both switches: this one on, and public sharing not stopped for maintenance. */
export const artifactSharingAvailable = (input: {
    storedFlagValue: string | null | undefined;
    publicSharingEnabled: boolean;
}): boolean => input.publicSharingEnabled && artifactSharingEnabledFromValue(input.storedFlagValue);

/** CHECK lists of prisma/migrations/20261128150000_artifact_share (scripts/check-enum-constraints.mjs). */
export const ARTIFACT_SHARE_SOURCE_KINDS = ["artifact", "code_block"] as const;
export const ARTIFACT_SHARE_PREVIEW_KINDS = ["html", "svg", "react"] as const satisfies readonly CodePreviewKind[];
export const ARTIFACT_SHARE_LANGUAGES = ["html", "htm", "svg", "jsx", "tsx"] as const;

export type ArtifactShareSourceKind = (typeof ARTIFACT_SHARE_SOURCE_KINDS)[number];
export type ArtifactShareLanguage = (typeof ARTIFACT_SHARE_LANGUAGES)[number];

/** Generated files that may be shared: HTML pages. Office documents and other files are not pages. */
export const ARTIFACT_SHARE_FILE_FORMATS: ReadonlySet<string> = new Set(["html", "htm"]);

export const isArtifactShareLanguage = (value: string): value is ArtifactShareLanguage =>
    (ARTIFACT_SHARE_LANGUAGES as readonly string[]).includes(value);

/** The kind and stored language of a fence tag that may be shared, or null. */
export const shareableCodeLanguage = (
    language: string | null | undefined
): { previewKind: CodePreviewKind; language: ArtifactShareLanguage } | null => {
    const normalized = (language ?? "").trim().toLowerCase();
    const previewKind = codePreviewKindForLanguage(normalized);
    return previewKind && isArtifactShareLanguage(normalized) ? { previewKind, language: normalized } : null;
};

/** One link per source, so pressing Share twice shows the same link. */
export const artifactShareSourceKey = (
    source: { kind: "artifact"; artifactId: string } | { kind: "code_block"; messageId: string; contentHash: string }
) => (source.kind === "artifact" ? `artifact:${source.artifactId}` : `code:${source.messageId}:${source.contentHash}`);

/** How long a link lives: SHARE_LINK_TTL_DAYS, the conversation share's setting, 1..365, default 30. */
export const artifactShareTtlDays = (env: Record<string, string | undefined>) => {
    const configured = Number(env.SHARE_LINK_TTL_DAYS);
    return Number.isInteger(configured) && configured >= 1 && configured <= 365 ? configured : 30;
};

export type ArtifactShareRefusalCode =
    | "ARTIFACT_SHARING_DISABLED"
    | "PLAN_FEATURE_NOT_INCLUDED"
    | "ARTIFACT_SHARE_SOURCE_NOT_FOUND"
    | "CONVERSATION_KIND_NOT_SUPPORTED"
    | "TEMPORARY_CHAT"
    | "CONVERSATION_LOCKED"
    | "CONTINUATION_SHARE_NOT_SUPPORTED"
    | "RESEARCH_SHARE_PRIVATE"
    | "ARTIFACT_SHARE_TOO_LARGE";

export type ArtifactShareFacts = {
    sharingAvailable: boolean;
    planAllowsSharing: boolean;
    /** The source exists, is the caller's, is a shareable kind, and its text came from the answer. */
    sourceFound: boolean;
    conversation: {
        isChatKind: boolean;
        temporary: boolean;
        /** The conversation has a password, whether or not it is unlocked right now. */
        locked: boolean;
        continuesImport: boolean;
    } | null;
    /** The answer is a Research report whose current revision uses private sources. */
    researchPrivate: boolean;
    contentBytes: number;
};

const STATUS: Record<ArtifactShareRefusalCode, number> = {
    ARTIFACT_SHARING_DISABLED: 503,
    PLAN_FEATURE_NOT_INCLUDED: 403,
    ARTIFACT_SHARE_SOURCE_NOT_FOUND: 404,
    CONVERSATION_KIND_NOT_SUPPORTED: 409,
    TEMPORARY_CHAT: 409,
    CONVERSATION_LOCKED: 409,
    CONTINUATION_SHARE_NOT_SUPPORTED: 409,
    RESEARCH_SHARE_PRIVATE: 409,
    ARTIFACT_SHARE_TOO_LARGE: 413,
};

/**
 * The first reason this source may not be published, or null when it may.
 *
 * A locked conversation is refused even while it is unlocked: a password is
 * the owner saying the conversation is private, and a public page made from
 * it would outlive the next lock. The public page re-checks the lock on every
 * read, so locking later also takes existing links down.
 */
export const artifactShareRefusal = (
    facts: ArtifactShareFacts
): { code: ArtifactShareRefusalCode; status: number } | null => {
    const refuse = (code: ArtifactShareRefusalCode) => ({ code, status: STATUS[code] });
    if (!facts.sharingAvailable) return refuse("ARTIFACT_SHARING_DISABLED");
    if (!facts.planAllowsSharing) return refuse("PLAN_FEATURE_NOT_INCLUDED");
    if (!facts.sourceFound || !facts.conversation) return refuse("ARTIFACT_SHARE_SOURCE_NOT_FOUND");
    if (!facts.conversation.isChatKind) return refuse("CONVERSATION_KIND_NOT_SUPPORTED");
    if (facts.conversation.temporary) return refuse("TEMPORARY_CHAT");
    if (facts.conversation.locked) return refuse("CONVERSATION_LOCKED");
    if (facts.conversation.continuesImport) return refuse("CONTINUATION_SHARE_NOT_SUPPORTED");
    if (facts.researchPrivate) return refuse("RESEARCH_SHARE_PRIVATE");
    if (!Number.isFinite(facts.contentBytes) || facts.contentBytes < 1 || facts.contentBytes > HTML_PREVIEW_MAX_BYTES) {
        return refuse("ARTIFACT_SHARE_TOO_LARGE");
    }
    return null;
};

/** Line endings as the answer stored them may differ from the rendered block's. */
const normalizeNewlines = (value: string) => value.replace(/\r\n?/g, "\n");

/**
 * Whether a code block's text really is part of the answer it claims to come
 * from. The one cheap check at this boundary: what is published is text the
 * answer contains, not text the browser made up. Fenced code is literal in
 * markdown, so the rendered block's text is a substring of the stored answer.
 */
export const answerContainsCode = (answer: string, code: string) => {
    const needle = normalizeNewlines(code);
    return needle.trim().length > 0 && normalizeNewlines(answer).includes(needle);
};
