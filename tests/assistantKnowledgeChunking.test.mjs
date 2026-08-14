// Release C2: what chunking promises retrieval.
//
// Determinism is the property everything else rests on. Reprocessing a file
// has to produce the same chunks, or `retrievalVersion` stops meaning "these
// were built by algorithm N" and a reprocessing pass rewrites rows that were
// already correct. So the first test is the boring one, and it is the one that
// matters.

import assert from "node:assert/strict";
import test from "node:test";

import {
    KNOWLEDGE_CHUNK_MAX_CHARACTERS,
    KNOWLEDGE_CHUNK_MIN_CHARACTERS,
    KNOWLEDGE_RETRIEVAL_VERSION,
    chunkKnowledgeText,
    knowledgeChunksAreCurrent,
    normalizeKnowledgeText,
} from "../lib/assistantKnowledgeChunking.ts";

const paragraph = (length, filler = "a") =>
    "Sentence. ".repeat(Math.ceil(length / 10)).slice(0, length).trim() || filler;

test("the same document always produces the same chunks", () => {
    const document = [
        "First paragraph about scheduling.",
        "Second paragraph about billing and refunds.",
        paragraph(2_400),
    ].join("\n\n");
    const first = chunkKnowledgeText(document);
    const second = chunkKnowledgeText(document);
    assert.deepEqual(first, second);
    assert.ok(first.length > 0);
});

test("line endings, trailing spaces and blank runs do not change the chunks", () => {
    // A document extracted twice by slightly different builds must not rewrite
    // every row. Without normalisation, reprocessing looks like a content
    // change on a file nobody touched.
    const clean = "One.\n\nTwo.\n\nThree.";
    const messy = "One.  \r\n\r\n\r\n\r\nTwo.\t\r\nThree.".replace("\r\nThree", "\r\n\r\nThree");
    assert.deepEqual(
        chunkKnowledgeText(messy).map((chunk) => chunk.content),
        chunkKnowledgeText(clean).map((chunk) => chunk.content)
    );
});

test("ordinals are 0-based and contiguous", () => {
    const chunks = chunkKnowledgeText(
        Array.from({ length: 8 }, (_, index) => paragraph(600, `p${index}`)).join("\n\n")
    );
    assert.ok(chunks.length > 1);
    chunks.forEach((chunk, index) => assert.equal(chunk.ordinal, index));
});

test("an empty document produces no chunks", () => {
    // The caller records this as a processing failure. A "ready" file with
    // zero chunks would be listed as usable and retrieve nothing.
    assert.deepEqual(chunkKnowledgeText(""), []);
    assert.deepEqual(chunkKnowledgeText("   \n\n  \t \n"), []);
});

test("paragraphs are packed rather than cut at a fixed offset", () => {
    // Three short paragraphs belong in one chunk: a retriever returns the
    // chunk whole, and three separate chunks would each answer with a third
    // of the thought.
    const chunks = chunkKnowledgeText(
        ["Short one.", "Short two.", "Short three."].join("\n\n")
    );
    assert.equal(chunks.length, 1);
    assert.match(chunks[0].content, /Short one\.\n\nShort two\.\n\nShort three\./);
});

test("a paragraph longer than the ceiling is split at a sentence boundary", () => {
    const long =
        "Alpha beta gamma. ".repeat(120) + "Final clause with no period after it";
    const chunks = chunkKnowledgeText(long);
    assert.ok(chunks.length > 1, "an over-long paragraph was not split");
    // Every chunk but a merged tail stays within the ceiling, and the split
    // lands after a sentence rather than mid-word.
    for (const chunk of chunks.slice(0, -1)) {
        assert.ok(
            chunk.content.length <= KNOWLEDGE_CHUNK_MAX_CHARACTERS,
            `chunk ${chunk.ordinal} is ${chunk.content.length} characters`
        );
        assert.match(chunk.content, /\.$/);
    }
});

test("text with no sentence punctuation still splits into bounded pieces", () => {
    // A CSV or a table has no ". " anywhere. Without a floor on where a
    // sentence break is acceptable, "the last break before the ceiling" can be
    // at character 3 and the chunks come out wildly uneven.
    const table = Array.from({ length: 400 }, (_, i) => `row-${i},value-${i}`).join(
        "\n"
    );
    const chunks = chunkKnowledgeText(table);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks.slice(0, -1)) {
        assert.ok(chunk.content.length <= KNOWLEDGE_CHUNK_MAX_CHARACTERS);
        assert.ok(
            chunk.content.length >= KNOWLEDGE_CHUNK_MIN_CHARACTERS,
            `chunk ${chunk.ordinal} came out at ${chunk.content.length} characters`
        );
    }
});

test("a short tail is merged backwards instead of standing alone", () => {
    // Sized so packing genuinely produces two chunks -- 1,150 + 2 + 100 is
    // past the ceiling -- and the second is under the floor. An earlier
    // version of this test used a total that fitted in one chunk, so it
    // passed without the merge branch ever running.
    const head = paragraph(1_150);
    const tail = paragraph(100, "tail");
    assert.ok(
        head.length + 2 + tail.length > KNOWLEDGE_CHUNK_MAX_CHARACTERS,
        "the fixture no longer forces a second chunk"
    );
    assert.ok(tail.length < KNOWLEDGE_CHUNK_MIN_CHARACTERS);

    const chunks = chunkKnowledgeText([head, tail].join("\n\n"));
    assert.equal(chunks.length, 1, "a short orphan chunk was kept");
    assert.ok(chunks[0].content.endsWith(tail));
});

test("chunks do not overlap, and their offsets run forward", () => {
    const document = Array.from({ length: 10 }, (_, index) =>
        paragraph(500, `p${index}`)
    ).join("\n\n");
    const chunks = chunkKnowledgeText(document);
    assert.ok(chunks.length > 1);
    for (let index = 1; index < chunks.length; index += 1) {
        assert.ok(
            chunks[index].sourceMetadata.startOffset >=
                chunks[index - 1].sourceMetadata.endOffset,
            `chunk ${index} starts before chunk ${index - 1} ends`
        );
    }
});

test("offsets index the normalised text, not the raw input", () => {
    // The offsets are a citation's coordinates. If they indexed the raw bytes,
    // a document with CRLF endings would point a reader at the wrong place.
    const raw = "First.\r\n\r\nSecond paragraph here.";
    const normalized = normalizeKnowledgeText(raw);
    for (const chunk of chunkKnowledgeText(raw)) {
        assert.equal(
            normalized.slice(
                chunk.sourceMetadata.startOffset,
                chunk.sourceMetadata.endOffset
            ),
            chunk.content
        );
    }
});

test("every chunk carries its own terms and the version that built them", () => {
    const chunks = chunkKnowledgeText(
        ["환불 정책은 30일입니다.", "Refunds are processed in 30 days."].join("\n\n")
    );
    assert.equal(chunks.length, 1);
    const [chunk] = chunks;
    assert.equal(chunk.retrievalVersion, KNOWLEDGE_RETRIEVAL_VERSION);
    // Hangul is bigrammed and Latin is word-tokenised, which is the whole
    // reason a lexical index works for both without an embedding.
    assert.ok(chunk.searchTerms.includes("환불"));
    assert.ok(chunk.searchTerms.includes("refunds"));
    assert.ok(chunk.searchTerms.includes("30"));
});

test("a file built by an older algorithm is reprocessable, not silently mixed in", () => {
    assert.equal(
        knowledgeChunksAreCurrent({ retrievalVersion: KNOWLEDGE_RETRIEVAL_VERSION }),
        true
    );
    assert.equal(
        knowledgeChunksAreCurrent({
            retrievalVersion: KNOWLEDGE_RETRIEVAL_VERSION - 1,
        }),
        false
    );
});
