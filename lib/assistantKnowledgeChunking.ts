/**
 * Turning an extracted document into retrievable chunks (Release C, C2).
 *
 * docs/policy/external-conversation-import-and-memory.md §14: chunking is
 * deterministic, each chunk carries its own lexical `searchTerms`, and there
 * are no embeddings.
 *
 * Pure: text in, chunks out. No Prisma, no provider, no clock — so the same
 * document always produces the same chunks, which is what makes reprocessing a
 * file idempotent and what lets a test pin the boundaries.
 *
 * ## Why paragraphs, and why no overlap
 *
 * Chunks are packed from paragraph boundaries rather than cut at a fixed
 * offset, because a lexical retriever returns the chunk whole into the prompt
 * and a chunk that starts mid-sentence reads as a document the model cannot
 * follow. Only a single paragraph longer than the ceiling is split, and then
 * at a sentence boundary where one exists.
 *
 * There is no overlap between chunks. Overlap exists to stop a query matching
 * across a boundary from missing, but it stores every overlapping sentence
 * twice and lets two chunks answer with the same text — and with a bigram
 * index the boundary case is narrow while the duplicate-retrieval case is
 * every query. If retrieval quality later shows the boundary case matters, it
 * is a `retrievalVersion` bump with a reprocessing pass, which is exactly what
 * that column is for.
 */

import { memoryRetrievalTerms } from "@/lib/memoryRetrievalTerms";

/**
 * Bumped when the chunk boundaries or the term set a document produces would
 * change. Stored per row, so chunks built by an older algorithm are
 * identifiable and reprocessable rather than silently mixed in.
 *
 * Separate from `MEMORY_RETRIEVAL_VERSION` because they are separate
 * decisions, even though they move together today: §14 says knowledge uses the
 * same tokenising principles as memory, and `memoryRetrievalTerms()` is that
 * shared algorithm rather than a copy of it. A copy would drift, and the two
 * drifting apart silently is worse than them moving together on purpose.
 */
export const KNOWLEDGE_RETRIEVAL_VERSION = 1;

/**
 * The size a chunk is packed up to. Large enough that a paragraph group is a
 * self-contained answer, small enough that four of them plus memory and the
 * conversation still leave the model room — §9.1 puts knowledge fourth in the
 * prompt, below the profile's own instructions.
 */
export const KNOWLEDGE_CHUNK_MAX_CHARACTERS = 1_200;

/**
 * A trailing chunk shorter than this is merged back into its predecessor
 * instead of standing alone. A 30-character chunk is a heading with no body:
 * it scores on its own terms and returns nothing useful.
 */
export const KNOWLEDGE_CHUNK_MIN_CHARACTERS = 200;

/** Bounds one chunk's index entry, as the memory tokenizer bounds a row's. */
export const KNOWLEDGE_CHUNK_MAX_TERMS = 128;

export type KnowledgeChunk = {
    ordinal: number;
    content: string;
    searchTerms: string[];
    retrievalVersion: number;
    sourceMetadata: {
        /** Character offsets into the normalised document. */
        startOffset: number;
        endOffset: number;
    };
};

/**
 * Normalises an extracted document before it is cut.
 *
 * Line endings collapse, runs of blank lines become exactly one blank line,
 * and trailing whitespace on a line goes. All three exist so the same document
 * extracted twice — by a slightly different PDF build, say — produces the same
 * chunks; without them, reprocessing a file would rewrite every chunk and the
 * `retrievalVersion` column would stop meaning anything.
 *
 * NFC because the tokenizer normalises too, and the offsets recorded per chunk
 * have to index the same string the content came from.
 */
export function normalizeKnowledgeText(text: string): string {
    return text
        .normalize("NFC")
        .replace(/\r\n?/gu, "\n")
        .replace(/[^\S\n]+$/gmu, "")
        .replace(/\n{3,}/gu, "\n\n")
        .trim();
}

/** Paragraphs, with the offset each starts at in the normalised text. */
const paragraphsOf = (text: string): { text: string; start: number }[] => {
    const paragraphs: { text: string; start: number }[] = [];
    let offset = 0;
    for (const piece of text.split("\n\n")) {
        const trimmed = piece.trim();
        if (trimmed !== "") {
            // The trim can only remove leading newlines here, so the start
            // offset is the piece's start plus what the trim took.
            paragraphs.push({
                text: trimmed,
                start: offset + piece.indexOf(trimmed),
            });
        }
        offset += piece.length + 2;
    }
    return paragraphs;
};

/**
 * Splits one over-long paragraph.
 *
 * At a sentence end where there is one within the last quarter of the window,
 * and at the window otherwise. The quarter is what stops a document with no
 * sentence punctuation — a table, a CSV — from producing wildly uneven chunks:
 * without a floor, "the last sentence end before the ceiling" can be at
 * character 3.
 */
const splitLongParagraph = (
    paragraph: string,
    start: number
): { text: string; start: number }[] => {
    const pieces: { text: string; start: number }[] = [];
    let cursor = 0;
    while (cursor < paragraph.length) {
        const remaining = paragraph.length - cursor;
        if (remaining <= KNOWLEDGE_CHUNK_MAX_CHARACTERS) {
            pieces.push({ text: paragraph.slice(cursor), start: start + cursor });
            break;
        }
        const window = paragraph.slice(
            cursor,
            cursor + KNOWLEDGE_CHUNK_MAX_CHARACTERS
        );
        const earliestAcceptable = Math.floor(
            KNOWLEDGE_CHUNK_MAX_CHARACTERS * 0.75
        );
        // Sentence-ending punctuation for the scripts this product serves:
        // Latin, plus the full-width stops CJK text uses.
        const sentenceEnd = Math.max(
            window.lastIndexOf(". "),
            window.lastIndexOf("! "),
            window.lastIndexOf("? "),
            window.lastIndexOf("。"),
            window.lastIndexOf("！"),
            window.lastIndexOf("？")
        );
        const cut =
            sentenceEnd >= earliestAcceptable
                ? sentenceEnd + 1
                : KNOWLEDGE_CHUNK_MAX_CHARACTERS;
        pieces.push({
            text: window.slice(0, cut).trim(),
            start: start + cursor,
        });
        cursor += cut;
    }
    return pieces.filter((piece) => piece.text !== "");
};

/**
 * The chunks for one extracted document.
 *
 * Empty in, empty out — a file that yielded no text produces no chunks, and
 * the caller records that as a processing failure rather than as a ready file
 * with nothing in it.
 */
export function chunkKnowledgeText(text: string): KnowledgeChunk[] {
    const normalized = normalizeKnowledgeText(text);
    if (normalized === "") return [];

    const units: { text: string; start: number }[] = [];
    for (const paragraph of paragraphsOf(normalized)) {
        if (paragraph.text.length <= KNOWLEDGE_CHUNK_MAX_CHARACTERS) {
            units.push(paragraph);
            continue;
        }
        units.push(...splitLongParagraph(paragraph.text, paragraph.start));
    }

    const packed: { text: string; start: number; end: number }[] = [];
    for (const unit of units) {
        const current = packed[packed.length - 1];
        const joinedLength = current
            ? current.text.length + 2 + unit.text.length
            : 0;
        if (current && joinedLength <= KNOWLEDGE_CHUNK_MAX_CHARACTERS) {
            current.text += `\n\n${unit.text}`;
            current.end = unit.start + unit.text.length;
            continue;
        }
        packed.push({
            text: unit.text,
            start: unit.start,
            end: unit.start + unit.text.length,
        });
    }

    // A short tail is merged backwards even though that takes the chunk over
    // the ceiling. The ceiling is a target for retrieval quality, not a hard
    // limit on a row, and a 40-character orphan chunk is worse than a chunk
    // 40 characters too long.
    if (
        packed.length > 1 &&
        packed[packed.length - 1].text.length < KNOWLEDGE_CHUNK_MIN_CHARACTERS
    ) {
        const tail = packed.pop();
        if (tail) {
            const previous = packed[packed.length - 1];
            previous.text += `\n\n${tail.text}`;
            previous.end = tail.end;
        }
    }

    return packed.map((chunk, ordinal) => ({
        ordinal,
        content: chunk.text,
        searchTerms: memoryRetrievalTerms(chunk.text, {
            maxTerms: KNOWLEDGE_CHUNK_MAX_TERMS,
        }),
        retrievalVersion: KNOWLEDGE_RETRIEVAL_VERSION,
        sourceMetadata: { startOffset: chunk.start, endOffset: chunk.end },
    }));
}

/**
 * Whether a stored file's chunks were built by the current algorithm.
 *
 * Read by the reprocessing pass. Compares the version rather than recomputing:
 * the text is in R2, not in the row, so "are these chunks current" has to be
 * answerable without fetching the object.
 */
export function knowledgeChunksAreCurrent(
    file: { retrievalVersion: number },
    version = KNOWLEDGE_RETRIEVAL_VERSION
): boolean {
    return file.retrievalVersion === version;
}
