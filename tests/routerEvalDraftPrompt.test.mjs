import assert from "node:assert/strict";
import test from "node:test";

import {
    DRAFT_TEMPLATE_VERSION,
    draftInstruction,
    parseDraftedPrompts,
    templateHash,
} from "../lib/routerEvalDraftPrompt.ts";

const base = { stratum: "coding", cell: "ko", count: 14, avoid: [] };

// §2: "Korean is a first-class cell in every stratum, not a translation of the
// English one. Translated prompts measure translation quality, not Korean
// usage." A drafting model handed the English cell and asked for Korean will
// translate it, because that is the easier task. So the instruction has to say
// so, and the caller must never be able to hand it the other cell's items.
test("a Korean cell is told in so many words not to translate", () => {
    const instruction = draftInstruction(base);
    assert.match(instruction, /Do not translate an English/);
    assert.match(instruction, /AS A KOREAN SPEAKER WOULD ASK/);
});

test("an English cell is not given the Korean-specific instruction", () => {
    const instruction = draftInstruction({ ...base, cell: "en" });
    assert.doesNotMatch(instruction, /Do not translate/);
});

test("the cross-language cell asks for a Korean prompt wanting English back", () => {
    const instruction = draftInstruction({
        ...base,
        stratum: "translation_cross_language",
        cell: "ko-en",
    });
    assert.match(instruction, /written in Korean and asks for output in English/);
});

// The avoid list exists so the drafter does not repeat this cell. Handing it
// another cell's prompts would turn it into a translation source, which is the
// failure above by a different route -- so the caller passes only this cell's
// items and the template never asks for more.
test("prompts already in the cell are listed as things not to repeat", () => {
    const instruction = draftInstruction({
        ...base,
        avoid: ["리스트를 정렬하는 코드를 써 주세요."],
    });
    assert.match(instruction, /do not write variants of them/);
    assert.ok(instruction.includes("리스트를 정렬하는 코드를 써 주세요."));
});

test("a cell that does not belong to the stratum is refused", () => {
    assert.throws(() => draftInstruction({ ...base, cell: "ko-en" }), /not a cell of coding/);
    assert.throws(
        () => draftInstruction({ ...base, stratum: "translation_cross_language", cell: "ko" }),
        /not a cell of translation_cross_language/
    );
});

test("the count must be a whole positive number", () => {
    for (const count of [0, -1, 2.5]) {
        assert.throws(() => draftInstruction({ ...base, count }), /whole number/);
    }
});

// §8 bans personal data, credentials and customer-identifying content from the
// set, including invented ones that look real.
test("the sourcing bans are in the instruction, not left to judgement", () => {
    const instruction = draftInstruction(base);
    assert.match(instruction, /No personal data, no credentials/);
    assert.match(instruction, /Not even invented ones that look real/);
});

// Varying the topic while reusing one sentence frame is the failure the
// near-duplicate report is built to catch. Saying so up front is cheaper than
// catching it afterwards.
test("the drafter is told that a reused frame is one prompt", () => {
    assert.match(draftInstruction(base), /share a sentence frame with/);
});

test("strata with their own requirements get their own line", () => {
    assert.match(
        draftInstruction({ ...base, stratum: "current_information", cell: "ko" }),
        /genuinely require current information/
    );
    assert.match(
        draftInstruction({ ...base, stratum: "document_and_attachment", cell: "ko" }),
        /never a file/
    );
    assert.match(
        draftInstruction({ ...base, stratum: "long_context_conversation", cell: "ko" }),
        /Include the earlier conversation/
    );
});

// The hash is what makes two batches comparable. If wording could change
// without moving it, the record would say the batches were drafted alike when
// they were not.
test("the hash moves when the instruction moves, and holds when it does not", () => {
    const a = templateHash(draftInstruction(base));
    assert.equal(a, templateHash(draftInstruction(base)));
    assert.notEqual(a, templateHash(draftInstruction({ ...base, cell: "en" })));
    assert.notEqual(a, templateHash(draftInstruction({ ...base, avoid: ["something"] })));
    assert.equal(typeof DRAFT_TEMPLATE_VERSION, "string");
});

// --- parsing ---------------------------------------------------------------

test("a JSON array is read whether or not the model wrapped it in prose", () => {
    for (const body of [
        '[{"prompt":"하나"},{"prompt":"둘"}]',
        'Here you go:\n```json\n[{"prompt":"하나"},{"prompt":"둘"}]\n```\nHope that helps.',
    ]) {
        assert.deepEqual(parseDraftedPrompts(body).prompts, ["하나", "둘"]);
    }
});

test("bare strings are accepted, since models return them", () => {
    assert.deepEqual(parseDraftedPrompts('["하나","둘"]').prompts, ["하나", "둘"]);
});

// A short batch a person can see beats a padded one they cannot: a dropped
// entry is counted and reported rather than replaced with a placeholder.
test("malformed entries are dropped and counted, never padded", () => {
    const result = parseDraftedPrompts('[{"prompt":"하나"},{"prompt":""},{"note":"x"},null,42]');
    assert.deepEqual(result.prompts, ["하나"]);
    assert.equal(result.dropped, 4);
});

test("a reply with no array yields nothing rather than guessing", () => {
    for (const body of ["I cannot help with that.", "", null, "[not json]"]) {
        assert.deepEqual(parseDraftedPrompts(body).prompts, []);
    }
});

test("surrounding whitespace is trimmed but the prompt is otherwise untouched", () => {
    const result = parseDraftedPrompts('[{"prompt":"  두 줄\\n짜리 프롬프트  "}]');
    assert.deepEqual(result.prompts, ["두 줄\n짜리 프롬프트"]);
});
