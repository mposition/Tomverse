// The schema-3 assembler, and the four things it refuses to guess.
//
// `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12. Schema 3 is not
// a migration, so a missing decision has to stop the assembly rather than be
// filled in. These tests drive each refusal with a case shaped to trigger it,
// because a refusal nobody has seen fire is a claim and not a guard.

import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_EVAL_SUCC3_CASES } from "../lib/memoryEvalSucc3Fixtures.ts";
import {
    Succ4AssemblyError,
    assembleCase,
    assembleCases,
    containsAll as containsAllTokens,
    proposeAnchor,
} from "../lib/memoryEvalSucc4Assembly.ts";
import { SUCC4_READINGS } from "../lib/memoryEvalSucc4Review/readings.ts";
import { goldEvidenceFailure } from "../lib/memoryEvalDatasetSchemaV3.ts";
import { SUCC4_B_PLUS_MOVES } from "../lib/memoryEvalSucc4Review/bPlusMoves.ts";
import { SUCC4_FACT_VALUE_ANY } from "../lib/memoryEvalSucc4Review/factValueAny.ts";
import { SUCC4_ANCHORS } from "../lib/memoryEvalSucc4Review/anchors.ts";

const byId = new Map(MEMORY_EVAL_SUCC3_CASES.map((c) => [c.id, c]));
const moving = new Set(SUCC4_B_PLUS_MOVES.map((move) => move.originalId));
const staying = MEMORY_EVAL_SUCC3_CASES.filter((c) => !moving.has(c.id));

/** A schema-2 case with one gold, shaped by the caller. */
const caseWith = (gold, overrides = {}) => ({
    id: "probe-case",
    category: "durable_facts",
    language: "ko",
    goldCompleteness: "exhaustive",
    expected: [{ id: "e1", kind: "constraint", expectedDisposition: "bulk_safe", ...gold }],
    conversations: [
        {
            externalConversationId: "probe-1",
            title: "t",
            messages: [
                { externalMessageId: "probe-1-m1", role: "user", content: "저는 인천에 삽니다." },
                { externalMessageId: "probe-1-m2", role: "assistant", content: "네." },
            ],
        },
    ],
    ...overrides,
});

test("a gold nobody read is refused, by name", () => {
    assert.throws(
        () => assembleCase(caseWith({ mustInclude: ["인천"] })),
        (error) =>
            error instanceof Succ4AssemblyError &&
            /probe-case:e1/.test(error.message) &&
            /nobody has read this gold/.test(error.message)
    );
});

test("mustIncludeAny with no recorded decision is refused", () => {
    // The list either carried expression variants forward or hid the negation,
    // and which one is not derivable from the label -- three negated golds
    // stay in the decision set and seven affirmed ones do too.
    // Built from a real case so it clears the polarity check first and lands
    // on this one. A synthetic case would fail earlier and prove nothing.
    const real = byId.get("succ-durable-ko-1");
    const probe = {
        ...real,
        expected: [{ ...real.expected[0], mustIncludeAny: ["알레르기", "알러지"] }],
    };
    assert.throws(
        () => assembleCase(probe),
        (error) =>
            error instanceof Succ4AssemblyError &&
            /mustIncludeAny and has no recorded decision/.test(error.message)
    );
});

test("a fact no user message carries has no proposal", () => {
    const probe = caseWith({ mustInclude: ["부산"] });
    assert.equal(proposeAnchor(probe, ["부산"]), null);
});

test("a gold with no reviewed anchor is refused, proposal or not", () => {
    // .github/audits/memory-eval-gold-contract-2026-08-27.md §12.11.
    // succ-durable-ko-129 has a polarity — it was read in batch 8 and
    // ruled negated on 2026-08-28 — and no anchor record, because it moves.
    // The heuristic finds a perfectly good candidate for it, and that is
    // exactly what may not be adopted.
    const probe = byId.get("succ-durable-ko-129");
    assert.ok(proposeAnchor(probe, ["주말"]), "the proposal does find one");
    assert.throws(
        () => assembleCase(probe),
        (error) =>
            error instanceof Succ4AssemblyError && /no reviewed anchor/.test(error.message)
    );
});

test("every assembled anchor is the reviewed one, byte for byte", () => {
    // The record is the decision; assembly may not improve on it. Checked
    // without re-deriving, because re-deriving is what the record replaced.
    const anchorByKey = new Map(SUCC4_ANCHORS.map((a) => [a.key, a]));
    const readingByKey = new Map(
        SUCC4_READINGS.filter((r) => r.evidenceMessageId).map((r) => [
            `${r.caseId}:${r.goldId}`,
            r,
        ])
    );
    const { cases } = assembleCases(staying);
    for (const testCase of cases) {
        for (const gold of testCase.expected) {
            const key = `${testCase.id}:${gold.id}`;
            const record = readingByKey.get(key) ?? anchorByKey.get(key);
            assert.ok(record, `${key} assembled with no record`);
            assert.equal(gold.evidence.evidenceMessageId, record.evidenceMessageId, key);
            assert.equal(gold.evidence.evidenceQuote, record.evidenceQuote, key);
        }
    }
});

test("no staying gold is left with a choice of message", () => {
    // The en-306 class, drained. Every staying gold has exactly one user
    // message carrying its fact values, so the anchor was not a choice; the
    // four where a message holds two covering sentences carry sentenceChoice.
    let choices = 0;
    for (const testCase of staying) {
        const users = testCase.conversations
            .flatMap((c) => c.messages)
            .filter((m) => m.role === "user");
        for (const gold of testCase.expected) {
            const carriers = users.filter((m) =>
                containsAllTokens(m.content, gold.mustInclude, testCase.language)
            );
            if (carriers.length > 1) choices += 1;
        }
    }
    assert.equal(choices, 0);
    assert.equal(SUCC4_ANCHORS.filter((a) => a.sentenceChoice).length, 4);
});

test("the anchor record covers the staying golds exactly", () => {
    const stayingKeys = new Set(
        staying.flatMap((c) => c.expected.map((g) => `${c.id}:${g.id}`))
    );
    const overridden = new Set(
        SUCC4_READINGS.filter((r) => r.evidenceMessageId).map((r) => `${r.caseId}:${r.goldId}`)
    );
    const recorded = SUCC4_ANCHORS.map((a) => a.key);
    assert.equal(new Set(recorded).size, recorded.length, "a key twice");
    for (const key of recorded) {
        assert.ok(stayingKeys.has(key), `${key} is not a staying gold`);
        assert.ok(!overridden.has(key), `${key} is overridden by a reading`);
    }
    assert.equal(recorded.length + [...stayingKeys].filter((k) => overridden.has(k)).length, 355);
});

test("assembleCases collects refusals and assembles nothing", () => {
    // Stopping at the first sends the author round the loop once per missing
    // decision; assembling the rest would produce the partial dataset this
    // module exists to not produce.
    const result = assembleCases([
        caseWith({ mustInclude: ["인천"] }),
        caseWith({ mustInclude: ["인천"] }, { id: "probe-case-2" }),
    ]);
    assert.equal(result.cases.length, 0);
    assert.equal(result.refusals.length, 2);
});

test("every case that stays assembles, and every anchor resolves", () => {
    const { cases, refusals } = assembleCases(staying);
    assert.deepEqual(refusals, []);
    assert.equal(cases.length, 1047);
    for (const testCase of cases) {
        for (const gold of testCase.expected) {
            assert.ok(
                gold.polarity === "affirmed" || gold.polarity === "negated",
                `${testCase.id}:${gold.id}`
            );
            assert.equal(
                goldEvidenceFailure(gold, testCase.conversations, testCase.language),
                null,
                `${testCase.id}:${gold.id}`
            );
        }
    }
});

test("the cross-sample covers what can vary", () => {
    // Sampling the average would hide the cases where the assembler does
    // anything: a carried-over disjunction, an overridden anchor, a critical
    // category holding a gold, two golds of opposite polarity off one sentence.
    const sample = [
        "succ-durable-ko-144",
        "succ-durable-en-143",
        "succ-durable-ko-307",
        "succ-assistant-ko-307",
        "succ-assistant-en-306",
        "succ-durable-ko-1",
        "succ-injection-ko-119",
        "succ-durable-ko-104",
    ].map((id) => assembleCase(byId.get(id)));

    const golds = sample.flatMap((c) => c.expected);
    assert.ok(sample.some((c) => c.language === "ko"));
    assert.ok(sample.some((c) => c.language === "en"));
    assert.ok(sample.some((c) => c.expected.length > 1), "multi-gold");
    assert.ok(golds.some((g) => g.polarity === "negated"));
    assert.ok(golds.some((g) => g.expectedDisposition === "sensitive_review"));
    assert.ok(golds.some((g) => g.factValueAny), "factValueAny carried over");
    assert.ok(sample.some((c) => c.criticalGoldMode === "allow_expected_only"));
    assert.ok(golds.some((g) => g.factValueAll.length > 1), "two fact values");

    // ko-144 is the pair that makes the field worth having: one sentence,
    // two golds, opposite labels.
    const pair = sample.find((c) => c.id === "succ-durable-ko-144");
    assert.deepEqual(
        pair.expected.map((g) => g.polarity),
        ["affirmed", "negated"]
    );
    assert.equal(
        pair.expected[0].evidence.evidenceMessageId,
        pair.expected[1].evidence.evidenceMessageId
    );
});

test("an anchor overridden to a later turn stays overridden", () => {
    // The proposal takes the first user message carrying the tokens, and in a
    // correction that is the user quoting the assistant's premise back.
    // goldEvidenceFailure passes on those, so nothing but a reading catches it.
    const assembled = assembleCase(byId.get("succ-assistant-en-306"));
    assert.equal(assembled.expected[0].evidence.evidenceMessageId, "succ-b165-6-m3");
    assert.match(assembled.expected[0].evidence.evidenceQuote, /I have no siblings/);
    const proposal = proposeAnchor(byId.get("succ-assistant-en-306"), ["sibling"]);
    assert.equal(proposal.evidenceMessageId, "succ-b165-6-m1");
});

test("every mustIncludeAny gold has a decision, and no decision is stale", () => {
    const carrying = new Set();
    for (const testCase of MEMORY_EVAL_SUCC3_CASES) {
        for (const gold of testCase.expected) {
            if (gold.mustIncludeAny) carrying.add(`${testCase.id}:${gold.id}`);
        }
    }
    const decided = new Set(SUCC4_FACT_VALUE_ANY.map((d) => d.key));
    assert.equal(carrying.size, 23);
    assert.deepEqual([...carrying].filter((k) => !decided.has(k)), []);
    assert.deepEqual([...decided].filter((k) => !carrying.has(k)), []);
});
