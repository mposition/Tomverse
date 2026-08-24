import assert from "node:assert/strict";
import test from "node:test";

import {
    batchNearDuplicates,
    duplicatePrompts,
    renderReviewSheet,
} from "../lib/routerEvalReviewSheet.ts";
import {
    cellFill,
    evalSetProblems,
    unrecordedProvenanceItems,
} from "../lib/routerQualityEvalSet.ts";

// The sheet is the only thing standing between a drafter's systematic flaw and
// 210 adopted copies of it. Everything here guards one of two properties: the
// reviewer can judge without opening another file, and nothing the agent
// produces can read as an adoption.

const provenance = (batchId, extra = {}) => ({
    batchId,
    provider: "openai",
    modelId: "gpt-5-5",
    modelVersion: "gpt-5.5-2026-05-01",
    promptTemplateVersion: "router-eval-draft-v1",
    promptTemplateHash: "abc123",
    generatorCommit: "deadbee",
    draftedAt: "2026-08-24T00:00:00.000Z",
    ...extra,
});

const item = (id, overrides = {}) => ({
    id,
    stratum: "coding",
    cell: "ko",
    language: { prompt: "ko", expectedResponse: "ko" },
    source: "drafted",
    status: "candidate",
    adoptedBy: null,
    adoptedAt: null,
    draftProvenance: provenance("batch-001"),
    prompt: `파이썬으로 ${id} 문제를 푸는 코드를 써 주세요.`,
    ...overrides,
});

const makeSet = (items, overrides = {}) => ({
    version: "test-v0",
    purpose: "development",
    frozenAt: null,
    frozenBy: null,
    baseline: null,
    cellTargets: [],
    proposedPilotCellTarget: 14,
    items,
    ...overrides,
});

test("the sheet inlines every prompt, so no other file is needed", () => {
    const items = [item("a"), item("b")];
    const sheet = renderReviewSheet({
        set: makeSet(items),
        batchId: "batch-001",
        corpus: items,
    });
    for (const entry of items) {
        assert.ok(sheet.includes(entry.prompt), `${entry.id} prompt missing from the sheet`);
        assert.ok(sheet.includes(entry.id), `${entry.id} heading missing`);
    }
});

test("the sheet leaves every verdict empty", () => {
    const items = [item("a")];
    const sheet = renderReviewSheet({ set: makeSet(items), batchId: "batch-001", corpus: items });
    assert.ok(sheet.includes("**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->"));
    // The generator must never pre-fill an adopter or a date.
    assert.ok(!/adoptedBy["\s:]+["a-z]/i.test(sheet));
});

// docs/ops/tomverse-chat-router-evaluation-set.md §8/§11. The agent drafts; a person adopts. An adopted item arriving from a
// drafting run is the one outcome the whole procedure is built to prevent, so
// the sheet says so loudly rather than rendering it as a normal row.
test("an already-adopted item in a drafted batch is called a rule violation", () => {
    const items = [item("a", { status: "adopted", adoptedBy: "x", adoptedAt: "2026-08-24" })];
    const sheet = renderReviewSheet({ set: makeSet(items), batchId: "batch-001", corpus: items });
    assert.match(sheet, /규칙 위반/);
});

// The reason near-duplicates are ranked over the corpus and not the batch: two
// batches that each look varied can repeat each other, and a within-batch
// comparison is blind to it by construction.
test("near-duplicates reach outside the batch into the corpus", () => {
    const shared = "리스트를 정렬하는 파이썬 코드를 써 주세요.";
    const older = item("old-1", {
        draftProvenance: provenance("batch-000"),
        prompt: shared,
    });
    const fresh = item("new-1", { prompt: shared });
    const corpus = [older, fresh];
    const pairs = batchNearDuplicates({
        set: makeSet(corpus),
        batchId: "batch-001",
        corpus,
    });
    assert.equal(pairs.length, 1);
    assert.deepEqual([pairs[0].a, pairs[0].b].sort(), ["new-1", "old-1"]);
    assert.equal(pairs[0].token, 1);
});

test("pairs untouched by the batch are not put in front of its reviewer", () => {
    const corpus = [
        item("old-1", { draftProvenance: provenance("batch-000") }),
        item("old-2", { draftProvenance: provenance("batch-000") }),
        item("new-1"),
    ];
    const pairs = batchNearDuplicates({ set: makeSet(corpus), batchId: "batch-001", corpus });
    assert.ok(pairs.every((pair) => pair.a === "new-1" || pair.b === "new-1"));
});

test("an exact repeat is found across batches, whatever the ids say", () => {
    const corpus = [
        item("old-1", { draftProvenance: provenance("batch-000"), prompt: "같은 문장입니다." }),
        item("new-1", { prompt: "  같은 문장입니다.  " }),
    ];
    const found = duplicatePrompts(corpus);
    assert.equal(found.length, 1);
    assert.deepEqual([...found[0].ids].sort(), ["new-1", "old-1"]);
});

test("a batch id nothing was drafted under is an error, not an empty sheet", () => {
    assert.throws(
        () => renderReviewSheet({ set: makeSet([item("a")]), batchId: "nope", corpus: [item("a")] }),
        /nope/
    );
});

// --- schema rules -----------------------------------------------------------

test("a cell and a language that disagree is reported as a mislabelling", () => {
    const problems = evalSetProblems(
        makeSet([item("a", { language: { prompt: "en", expectedResponse: "en" } })])
    );
    assert.ok(problems.some((problem) => /prompt language is "en"/.test(problem)), problems.join("\n"));
});

// The cross-language cell is the reason language is a pair rather than a
// string: "ko-en" is a direction, and collapsing it loses the ability to ask
// about Korean prompts separately from Korean answers.
test("the cross-language cell expects a Korean prompt and an English answer", () => {
    const good = evalSetProblems(
        makeSet([
            item("x", {
                stratum: "translation_cross_language",
                cell: "ko-en",
                language: { prompt: "ko", expectedResponse: "en" },
            }),
        ])
    );
    assert.deepEqual(good, []);

    const bad = evalSetProblems(
        makeSet([
            item("x", {
                stratum: "translation_cross_language",
                cell: "ko-en",
                language: { prompt: "ko", expectedResponse: "ko" },
            }),
        ])
    );
    assert.ok(bad.some((problem) => /expects a "ko" answer, not "en"/.test(problem)), bad.join("\n"));
});

test("a drafted item with no provenance cannot be weighed for its drafter", () => {
    const problems = evalSetProblems(makeSet([item("a", { draftProvenance: undefined })]));
    assert.ok(problems.some((problem) => /records no draft provenance/.test(problem)));
});

// "unrecorded" is a truthful record of a real gap, and it satisfies the
// non-empty-string rule. Left at that it would pass a check about
// reconstructability while reconstructing nothing, so it is counted instead.
test("an unreconstructable drafter passes validation and is counted separately", () => {
    const set = makeSet([
        item("a", { draftProvenance: provenance("batch-001", { provider: "unrecorded" }) }),
        item("b"),
    ]);
    assert.deepEqual(evalSetProblems(set), []);
    assert.deepEqual(
        unrecordedProvenanceItems(set).map((entry) => entry.id),
        ["a"]
    );
});

// --- cell fill --------------------------------------------------------------

// docs/ops/tomverse-chat-router-evaluation-set.md §2: a short cell makes the set unjudgeable and is never averaged away, so
// every cell gets a row -- including the full ones. If only short cells were
// returned, an empty result would mean both "all full" and "nothing counted".
test("every cell is reported, and candidates never count towards the target", () => {
    const set = makeSet([
        item("a"),
        item("b", { status: "adopted", adoptedBy: "reviewer", adoptedAt: "2026-08-24" }),
    ]);
    const fill = cellFill(set);
    assert.equal(fill.length, 15);
    const coding = fill.find((cell) => cell.stratum === "coding" && cell.cell === "ko");
    assert.deepEqual(
        { adopted: coding.adopted, candidates: coding.candidates, short: coding.short },
        { adopted: 1, candidates: 1, short: 13 }
    );
});

// A frozen target is a person's decision and outranks the agent's proposal
// wherever both exist.
test("a frozen cell target wins over the proposed one", () => {
    const set = makeSet([item("a")], {
        cellTargets: [{ stratum: "coding", cell: "ko", target: 3 }],
        proposedPilotCellTarget: 14,
    });
    const fill = cellFill(set);
    assert.equal(fill.find((cell) => cell.stratum === "coding" && cell.cell === "ko").target, 3);
    assert.equal(
        fill.find((cell) => cell.stratum === "coding" && cell.cell === "en").target,
        14
    );
});

// The memory near-duplicate lib warns about a signal that is constant being no
// signal, and a Router prompt is one short sentence where a conversation was
// several. Pinning that `shape` still separates template reuse from unrelated
// prompts at that length, because the seed pool scores 0.00 across the board
// and that reads like a dead signal until you check.
test("shape separates a reused template from an unrelated prompt", () => {
    const same = (id, prompt) =>
        item(id, { prompt, draftProvenance: provenance("batch-001") });
    const corpus = [
        same("t1", "다음 문단을 더 간결하게 다듬어 주세요. 원래 의미는 유지해 주세요."),
        same("t2", "다음 이메일을 더 간결하게 다듬어 주세요. 원래 의미는 유지해 주세요."),
        same("t3", "아래 코드가 왜 느린지 설명하고 개선안을 제시해 주세요."),
    ];
    const pairs = batchNearDuplicates({ set: makeSet(corpus), batchId: "batch-001", corpus });
    const templated = pairs.find(
        (pair) => [pair.a, pair.b].includes("t1") && [pair.a, pair.b].includes("t2")
    );
    const unrelated = pairs.find(
        (pair) => [pair.a, pair.b].includes("t1") && [pair.a, pair.b].includes("t3")
    );
    assert.ok(templated.shape > 0.5, `template reuse scored ${templated.shape}`);
    assert.ok(unrelated.shape < 0.1, `unrelated prompts scored ${unrelated.shape}`);
    assert.ok(pairs.indexOf(templated) < pairs.indexOf(unrelated));
});
