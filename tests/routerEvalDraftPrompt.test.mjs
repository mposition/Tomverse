import assert from "node:assert/strict";
import test from "node:test";

import {
    DRAFT_TEMPLATE_VERSION,
    draftInstruction,
    parseDraftedPrompts,
    templateHash,
} from "../lib/routerEvalDraftPrompt.ts";

const base = { stratum: "coding", cell: "ko", count: 14, avoid: [] };

// docs/ops/tomverse-chat-router-evaluation-set.md §2: "Korean is a first-class cell in every stratum, not a translation of the
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

// docs/ops/tomverse-chat-router-evaluation-set.md §8 bans personal data, credentials and customer-identifying content from the
// set, including invented ones that look real.
test("the sourcing bans are in the instruction, not left to judgement", () => {
    const instruction = draftInstruction(base);
    assert.match(instruction, /No personal data, no credentials/);
    assert.match(instruction, /Not even invented ones that look real/);
});

// Varying the topic while reusing one sentence frame is the failure the
// near-duplicate report is built to catch, and v1's wording did not prevent
// it: Wave 1 returned 14 Korean prompts of which 7 shared one frame. So the
// rule now states a cap the drafter can count against.
test("the frame rule is a cap, not an accounting convention", () => {
    assert.match(draftInstruction(base), /AT MOST TWO prompts may share a sentence/);
});

// v1 asked for "some short, some with real constraints" and got neither: no
// short prompt in either cell of Wave 1, and constraints only in English. The
// quotas scale with the batch so a small batch is not asked for more short
// prompts than it holds.
test("the length and constraint rules carry counts derived from the batch size", () => {
    const fourteen = draftInstruction(base);
    assert.match(fourteen, /AT LEAST 4 must be SHORT/);
    assert.match(fourteen, /AT LEAST 5 must carry a real constraint/);

    const four = draftInstruction({ ...base, count: 4 });
    assert.match(four, /AT LEAST 2 must be SHORT/);
    assert.match(four, /AT LEAST 2 must carry a real constraint/);
});

// A quota of zero would read as permission to skip the rule entirely, so the
// floor holds even for a batch small enough to round below it.
test("the quotas never round down to nothing", () => {
    for (const count of [1, 2, 3]) {
        const instruction = draftInstruction({ ...base, count });
        assert.match(instruction, /AT LEAST 2 must be SHORT/);
        assert.match(instruction, /AT LEAST 2 must carry a real constraint/);
    }
});

test("the template version moved with the rules it describes", () => {
    assert.equal(DRAFT_TEMPLATE_VERSION, "router-eval-draft-v4");
});

// Wave 2's coding cell returned 7 of 14 prompts pointing at code that was not
// there -- "fix this function", no function. Both systems would answer by
// asking for it, which measures clarification, not routing. The cell's own
// seeds inline their code; nothing told the drafter to.
test("the coding cell is told to inline the code it refers to", () => {
    const instruction = draftInstruction({ ...base, stratum: "coding", cell: "en" });
    assert.match(instruction, /Include the code the prompt is about, inline/);
    assert.doesNotMatch(
        draftInstruction({ ...base, stratum: "writing_and_rewriting", cell: "en" }),
        /Include the code/
    );
});

// A frozen set is re-run against a baseline. An item whose right answer moves
// by the hour scores differently every run for reasons that have nothing to do
// with the systems being compared.
test("current information must be current but stable enough to re-run", () => {
    const instruction = draftInstruction({ ...base, stratum: "current_information", cell: "en" });
    assert.match(instruction, /stays true for months/);
    assert.match(instruction, /NOT a value that moves by the/);
    assert.match(instruction, /genuinely require current information/);
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

// --- truncation ------------------------------------------------------------

// The coding/ko run of Wave 3 was billed and returned nothing. v3 asks the
// drafter to inline the code a prompt refers to, which lengthened the reply
// past the 8,000-token output cap; the array stopped mid-string in its sixth
// entry, JSON.parse rejected the whole thing, and five complete prompts that
// had already been paid for were discarded with it.
test("complete entries survive a reply the output cap cut off", () => {
    const cut =
        '```json\n[\n  {"prompt": "장고 ORM에서 related_name 없이 역참조하면 어떻게 되나요?"},\n' +
        '  {"prompt": "사내 서버라 Java 8밖에 못 씁니다.\\n\\n```java\\npublic record UserDto(String id) {}\\n```"},\n' +
        '  {"prompt": "운영에선 이 배치가 멈춰요.\\n\\n```python\\ndef collect(rows):\\n    acc = []\\';
    const result = parseDraftedPrompts(cut);
    assert.equal(result.prompts.length, 2);
    assert.match(result.prompts[1], /public record UserDto/);
    assert.equal(result.truncated, true);
});

// A closed array is not truncated, however it was wrapped.
test("a complete reply is not reported as truncated", () => {
    for (const body of [
        '[{"prompt":"하나"},{"prompt":"둘"}]',
        'Here you go:\n```json\n[{"prompt":"하나"}]\n```\nHope that helps.',
        '["하나","둘"]',
    ]) {
        assert.equal(parseDraftedPrompts(body).truncated, false);
    }
});

// Braces and brackets inside a prompt's own text must not be read as entry
// boundaries -- code is exactly what v3 asks the drafter to include.
test("brackets inside a prompt string do not split the entry", () => {
    const withCode =
        '[{"prompt":"이 함수 고쳐 주세요.\\n\\ndef f(xs):\\n    return {k: [v] for k, v in xs}\\n"},{"prompt":"둘"}]';
    const result = parseDraftedPrompts(withCode);
    assert.equal(result.prompts.length, 2);
    assert.match(result.prompts[0], /return \{k: \[v\]/);
});

// A reply cut off before any entry closed yields nothing, and says why.
test("a reply cut off before the first entry closes reports truncation, not silence", () => {
    const result = parseDraftedPrompts('[\n  {"prompt": "여기서 잘림');
    assert.deepEqual(result.prompts, []);
    assert.equal(result.truncated, true);
});

// --- v4 -------------------------------------------------------------------

// "One sentence, no second request attached" and "include the earlier
// conversation" cannot both hold, and Wave 3's Korean cell satisfied the first
// by dropping the history -- producing a prompt that named no process and could
// only be answered by asking which one. The quota is lifted here rather than
// left to compete with the thing the stratum measures.
test("the long-context stratum is not asked for short prompts", () => {
    const longContext = draftInstruction({
        ...base,
        stratum: "long_context_conversation",
        cell: "ko",
    });
    assert.doesNotMatch(longContext, /must be SHORT/);
    assert.match(longContext, /Referring to it is/);
    assert.match(longContext, /however long that makes it/);

    // Every other stratum still carries it.
    for (const stratum of ["coding", "writing_and_rewriting", "current_information"]) {
        assert.match(draftInstruction({ ...base, stratum, cell: "ko" }), /must be SHORT/);
    }
});

// The constraint quota is unaffected: it does not fight the history rule.
test("lifting the short quota leaves the constraint quota in place", () => {
    assert.match(
        draftInstruction({ ...base, stratum: "long_context_conversation", cell: "ko" }),
        /AT LEAST 5 must carry a real constraint/
    );
});

// Twelve of fourteen analysis prompts landed in software engineering, which
// measures that field rather than reasoning in several steps.
test("the analysis stratum is told to range across walks of life", () => {
    assert.match(
        draftInstruction({ ...base, stratum: "analysis_and_reasoning", cell: "en" }),
        /Range across walks of life, not one field/
    );
});

// A drafter treats its training horizon as the present, so it wrote 2024 and
// 2025 into prompts read in 2026 -- turning "what is current" into history.
test("current information may not name a literal year", () => {
    assert.match(
        draftInstruction({ ...base, stratum: "current_information", cell: "ko" }),
        /Do not write a literal year/
    );
});
