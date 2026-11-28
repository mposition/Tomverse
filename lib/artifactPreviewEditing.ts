/**
 * Editing a previewed page in the panel, before anything is sent anywhere.
 *
 * Policy: docs/policy/generated-artifacts.md section 9, "패널 안에서 직접
 * 고치기". The edited text is the person's own, held in this browser tab only:
 * it is never written to the conversation, and it reaches the preview frame
 * through the same `buildCodePreviewDocument` -> `buildHtmlPreviewSrcdoc`
 * path as the original (lib/chatArtifactPreview.ts, lib/htmlArtifactPreview.ts),
 * so an edit cannot loosen the frame's isolation.
 *
 * Pure and client-safe: strings only.
 */

import { codeLanguageFromClassName, codePreviewKindForLanguage, type CodePreviewKind } from "@/lib/chatArtifactPreview";

/** The pause after the last keystroke before the live preview is rebuilt. */
export const ARTIFACT_EDIT_RENDER_DELAY_MS = 400;

/**
 * The longest edited version "Continue with this version" puts in the
 * composer. A page can be a megabyte; a message that large crowds out the
 * answer it asks for, so a longer version is downloaded and attached instead.
 */
export const ARTIFACT_CONTINUE_MAX_CHARS = 50_000;

/** The fence tag a kind of code is written back with. */
const fenceLanguage = (kind: CodePreviewKind, language: string) =>
    kind === "react" ? (language.toLowerCase() === "tsx" ? "tsx" : "jsx") : kind;

/**
 * A fence the code cannot close: one backtick longer than the longest run of
 * backticks inside it, and never shorter than three.
 */
export const markdownFenceFor = (code: string) => {
    let longest = 0;
    for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
    return "`".repeat(Math.max(3, longest + 1));
};

/**
 * The composer text for "Continue with this version": the request sentence
 * with the edited code in a fenced block, or null when the code is longer than
 * `ARTIFACT_CONTINUE_MAX_CHARS`. `template` carries `{code}`.
 */
export const continueWithVersionText = (
    template: string,
    input: { kind: CodePreviewKind; language: string; code: string }
): string | null => {
    if (input.code.length > ARTIFACT_CONTINUE_MAX_CHARS) return null;
    const fence = markdownFenceFor(input.code);
    const block = `${fence}${fenceLanguage(input.kind, input.language)}\n${input.code}\n${fence}`;
    return template.split("{code}").join(block);
};

const MEDIA_TYPES: Record<CodePreviewKind, string> = {
    html: "text/html;charset=utf-8",
    svg: "image/svg+xml;charset=utf-8",
    react: "text/plain;charset=utf-8",
};

/** What a downloaded edited version is called and typed as. A file keeps its own name. */
export const editedDownload = (
    input: { kind: CodePreviewKind; language: string; filename?: string | null }
): { filename: string; mediaType: string } => {
    const fallback =
        input.kind === "html" ? "page.html"
        : input.kind === "svg" ? "image.svg"
        : `component.${fenceLanguage(input.kind, input.language)}`;
    const filename = input.filename?.trim() || fallback;
    return { filename, mediaType: MEDIA_TYPES[input.kind] };
};

/**
 * Edits kept for the life of this page, so closing the panel and opening the
 * same file or block again shows the edited version. In memory only: nothing
 * is written to storage, and a reload starts from the original.
 */
const editedVersions = new Map<string, string>();

/**
 * Which edit belongs to which source. A file is its id. A code block is where
 * it is -- its answer's `data-message-id` and its position among that
 * answer's previewable blocks (`previewableBlockIndex`), the same answer id
 * the share link reads -- plus its text, so
 * two answers that hold the same code keep their edits apart, and an answer
 * whose block changed does not inherit an edit of the old one. A block with no
 * answer id (an answer not saved yet) has no key and keeps no edit.
 */
export const editedVersionKey = (source: {
    artifactId?: string | null;
    messageId?: string | null;
    blockIndex?: number | null;
    kind: CodePreviewKind;
    original: string;
}): string | null => {
    if (source.artifactId) return `artifact:${source.artifactId}`;
    if (!source.messageId || source.blockIndex == null || !Number.isInteger(source.blockIndex) || source.blockIndex < 0) return null;
    return `code:${source.messageId}:${source.blockIndex}:${source.kind}:${source.original}`;
};

const isPreviewableBlock = (codeClassName: string | null | undefined) =>
    codePreviewKindForLanguage(codeLanguageFromClassName(codeClassName)) !== null;

/**
 * A block's position among the blocks of its answer that can be previewed,
 * from each block's `<code>` class name in document order -- so a shell or
 * Python block above an HTML block does not move that block's edit. -1 when
 * the block itself cannot be previewed or is not in the list.
 */
export const previewableBlockIndex = (codeClassNames: ReadonlyArray<string | null | undefined>, own: number): number => {
    if (!Number.isInteger(own) || own < 0 || own >= codeClassNames.length || !isPreviewableBlock(codeClassNames[own])) return -1;
    return codeClassNames.slice(0, own).filter(isPreviewableBlock).length;
};

export const readEditedVersion = (key: string | null) => (key ? editedVersions.get(key) ?? null : null);

/** Keeps `draft` for `key`, or forgets it when it is the original again. Nothing is kept without a key. */
export const keepEditedVersion = (key: string | null, draft: string, original: string) => {
    if (!key) return;
    if (draft === original) editedVersions.delete(key);
    else editedVersions.set(key, draft);
};
