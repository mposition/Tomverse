import assert from "node:assert/strict";
import test from "node:test";
import {
    nearDuplicatePairs,
    shapeFeatures,
} from "../lib/memoryEvalNearDuplicates.ts";
import { MEMORY_EVAL_CASES } from "../lib/memoryExtractionEvalFixtures.ts";
import { CANDIDATE_BATCHES } from "../lib/memoryExtractionEvalCandidates/index.ts";

/**
 * The report exists to give a reviewer a shortlist for the judgement docs/ops/memory-extraction-eval-dataset.md §3.1
 * hands them: "같은 틀에 단어만 바꾼 200개는 200개가 아니라 1개입니다".
 *
 * A detector has two ways to be useless, and the first version was the second
 * kind: its skeleton collapsed every Hangul run to one placeholder and scored
 * 1.00 on nearly every pair, including pairs sharing nothing. Both directions
 * are pinned here.
 */

const testCase = (id, turns) => ({
    id,
    category: "durable_facts",
    language: "ko",
    expected: [],
    conversations: [
        {
            externalConversationId: `${id}-c1`,
            title: "t",
            messages: turns.map(([role, content], index) => ({
                externalMessageId: `${id}-m${index + 1}`,
                role,
                content,
            })),
        },
    ],
});

const jaccard = (a, b) => {
    let shared = 0;
    for (const item of a) if (b.has(item)) shared += 1;
    return shared / (a.size + b.size - shared);
};

const ORIGINAL = testCase("a", [
    ["user", "저는 간호사로 일한 지 12년 됐습니다."],
    ["assistant", "오래 하셨네요. 어떤 부분을 도와드릴까요?"],
]);
/** The exact failure docs/ops/memory-extraction-eval-dataset.md §3.1 names: one frame, the noun swapped. */
const TEMPLATE_CLONE = testCase("b", [
    ["user", "저는 세무사로 일한 지 12년 됐습니다."],
    ["assistant", "오래 하셨네요. 어떤 부분을 도와드릴까요?"],
]);
/** Same topic, genuinely different sentence -- must NOT look like a clone. */
const DISTINCT = testCase("c", [
    ["user", "세무 일을 십이 년째 하고 있어요."],
    ["assistant", "그 정도면 웬만한 건 다 겪으셨겠어요."],
]);

test("a template reused with the words swapped scores near the top", () => {
    const score = jaccard(shapeFeatures(ORIGINAL), shapeFeatures(TEMPLATE_CLONE));
    assert.ok(score > 0.8, `template clone scored ${score.toFixed(2)}, expected > 0.8`);
});

test("a genuinely different sentence on the same topic does not", () => {
    const score = jaccard(shapeFeatures(ORIGINAL), shapeFeatures(DISTINCT));
    assert.ok(score < 0.4, `distinct case scored ${score.toFixed(2)}, expected < 0.4`);
});

test("the shape signal is not constant across the real cases", () => {
    // The regression that made the first version worthless. A detector that
    // returns the same number for everything cannot rank anything, and a
    // reviewer following it reads noise.
    const cases = [
        ...MEMORY_EVAL_CASES,
        ...CANDIDATE_BATCHES.flatMap((batch) => batch.cases),
    ];
    const pairs = nearDuplicatePairs(cases);
    assert.ok(pairs.length > 50, `only ${pairs.length} within-cell pairs`);
    const scores = new Set(pairs.map((pair) => pair.shape.toFixed(2)));
    assert.ok(scores.size > 5, `shape took only ${scores.size} distinct value(s)`);
    const saturated = pairs.filter((pair) => pair.shape > 0.9).length;
    assert.equal(
        saturated,
        0,
        `${saturated} real pair(s) scored above 0.9 -- either the drafts repeat a ` +
            `template, or the signal has saturated again`
    );
});

test("pairs are ranked, and never cross a cell boundary", () => {
    const cases = [
        ...MEMORY_EVAL_CASES,
        ...CANDIDATE_BATCHES.flatMap((batch) => batch.cases),
    ];
    const pairs = nearDuplicatePairs(cases);
    for (let i = 1; i < pairs.length; i += 1) {
        const previous = Math.max(pairs[i - 1].token, pairs[i - 1].shape);
        const current = Math.max(pairs[i].token, pairs[i].shape);
        assert.ok(previous >= current, "pairs must be sorted most-similar first");
    }
    const byId = new Map(
        cases.map((entry) => [entry.id, `${entry.category}:${entry.language}`])
    );
    for (const pair of pairs) {
        assert.equal(byId.get(pair.a), byId.get(pair.b));
    }
});
