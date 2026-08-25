import assert from "node:assert/strict";
import { test } from "node:test";
import { BATCH_101_DURABLE_KO } from "../lib/memoryExtractionEvalCandidates/batch101DurableKo.ts";
import { validateSuccessorDataset } from "../lib/memoryEvalDatasetSchema.ts";
import { MEMORY_EVAL_CASES } from "../lib/memoryExtractionEvalFixtures.ts";

/**
 * The first successor batch, checked the way every later one will be.
 *
 * `docs/ops/memory-extraction-eval-dataset.md` §4.1.1 says to run validation
 * per batch rather than once at the end, and this is that run. It validates
 * as a *development* set on purpose: the decision-set rules include a per-arm
 * floor of 200, which 25 cases cannot meet and are not meant to.
 */

test("batch 101 validates as a batch in progress", () => {
    const result = validateSuccessorDataset({
        cases: BATCH_101_DURABLE_KO,
        purpose: "development",
    });
    assert.deepEqual(result.errors, []);
});

test("batch 101 would not pass as a decision set on its own", () => {
    // Not a defect: it is 25 of the 200 that arm needs. Pinned so that a
    // batch cannot be mistaken for the finished set.
    const result = validateSuccessorDataset({
        cases: BATCH_101_DURABLE_KO,
        purpose: "decision",
    });
    assert.equal(result.ok, false);
    assert.deepEqual(
        result.errors.map((error) => error.code),
        ["arm_below_exhaustive_floor", "arm_below_exhaustive_floor"]
    );
});

test("every case is exhaustive and every memory states its disposition", () => {
    assert.equal(BATCH_101_DURABLE_KO.length, 25);
    for (const testCase of BATCH_101_DURABLE_KO) {
        assert.equal(testCase.goldCompleteness, "exhaustive", testCase.id);
        assert.ok(testCase.expected.length > 0, testCase.id);
        for (const expected of testCase.expected) {
            assert.ok(
                ["bulk_safe", "sensitive_review"].includes(
                    expected.expectedDisposition
                ),
                `${testCase.id}/${expected.id}`
            );
        }
    }
});

test("a reworked case names a frozen case that exists, one to one", () => {
    // A rewritten case declares no source, because it copies nothing. That is
    // the honest shape: claiming a source it does not reproduce would make
    // the traceability say something false.
    const frozen = new Set(MEMORY_EVAL_CASES.map((testCase) => testCase.id));
    const claimed = new Set();
    for (const testCase of BATCH_101_DURABLE_KO) {
        if (!testCase.sourceCaseId) continue;
        assert.ok(
            frozen.has(testCase.sourceCaseId),
            `${testCase.id} names ${testCase.sourceCaseId}, which is not in the frozen set`
        );
        assert.equal(
            claimed.has(testCase.sourceCaseId),
            false,
            `${testCase.sourceCaseId} is reworked twice`
        );
        claimed.add(testCase.sourceCaseId);
    }
});

test("the conversations are copied from their source unchanged", () => {
    // The rework is a relabelling. If a conversation moved, this batch is
    // authoring new cases under the cover of a rework, and the 2026-08-23
    // adoption record no longer describes what a reviewer would be reading.
    const frozen = new Map(
        MEMORY_EVAL_CASES.map((testCase) => [testCase.id, testCase])
    );
    for (const testCase of BATCH_101_DURABLE_KO) {
        if (!testCase.sourceCaseId) continue;
        const source = frozen.get(testCase.sourceCaseId);
        const text = (entry) =>
            entry.conversations
                .flatMap((conversation) =>
                    conversation.messages.map(
                        (message) => `${message.role}:${message.content}`
                    )
                )
                .join("\n");
        assert.equal(text(testCase), text(source), testCase.id);
    }
});

test("the two health cases are the ones held for review", () => {
    // Health information is extractable and never auto-approved. Named
    // rather than counted, so
    // that adding a third does not quietly pass as "still two".
    const held = BATCH_101_DURABLE_KO.filter((testCase) =>
        testCase.expected.some(
            (expected) => expected.expectedDisposition === "sensitive_review"
        )
    ).map((testCase) => testCase.id);
    assert.deepEqual(held, ["succ-durable-ko-1", "succ-durable-ko-12"]);
});

test("exactly one case is rewritten rather than reworked", () => {
    // `cand-durable-ko-2` carried four independently valid memories, which no
    // exhaustive gold can hold. Named rather than counted, so a second
    // rewrite has to be argued for rather than slipped in.
    const rewritten = BATCH_101_DURABLE_KO.filter(
        (testCase) => !testCase.sourceCaseId
    ).map((testCase) => testCase.id);
    assert.deepEqual(rewritten, ["succ-durable-ko-2"]);

    // And it really is new text: no frozen case has this conversation.
    const rewrittenCase = BATCH_101_DURABLE_KO.find(
        (testCase) => testCase.id === "succ-durable-ko-2"
    );
    const text = (entry) =>
        entry.conversations
            .flatMap((conversation) =>
                conversation.messages.map((message) => message.content)
            )
            .join("\n");
    const frozenText = new Set(MEMORY_EVAL_CASES.map(text));
    assert.equal(frozenText.has(text(rewrittenCase)), false);
});

test("the third-party health gold requires the user-centred form", () => {
    // "사용자의 어머니가 휠체어를 사용한다" is a third party's medical
    // profile. It satisfies 휠체어 and not 계단, so requiring both is what
    // makes the normalised constraint the only answer that scores.
    const testCase = BATCH_101_DURABLE_KO.find(
        (entry) => entry.id === "succ-durable-ko-12"
    );
    assert.deepEqual(testCase.expected[0].mustInclude, ["휠체어", "계단"]);
    assert.equal(testCase.expected[0].expectedDisposition, "sensitive_review");

    const profileOnly = "사용자의 어머니가 휠체어를 사용한다";
    const normalised =
        "사용자는 휠체어 이용 가족과 이동할 때 계단 없는 경로가 필요하다";
    const matches = (statement) =>
        testCase.expected[0].mustInclude.every((token) =>
            statement.includes(token)
        );
    assert.equal(matches(profileOnly), false);
    assert.equal(matches(normalised), true);
});

test("the re-labelled kinds are the ones the batch record names", () => {
    // The kind taxonomy moves a case off a generic kind only where a dedicated one
    // applies. Pinning the pairs keeps a later edit from re-labelling a case
    // the reviewer adopted under a different label.
    const frozen = new Map(
        MEMORY_EVAL_CASES.map((testCase) => [testCase.id, testCase])
    );
    const changed = [];
    for (const testCase of BATCH_101_DURABLE_KO) {
        if (!testCase.sourceCaseId) continue;
        const before = frozen
            .get(testCase.sourceCaseId)
            .expected.map((expected) => expected.kind)
            .join(",");
        const after = testCase.expected.map((expected) => expected.kind).join(",");
        if (before !== after) changed.push(`${testCase.id}: ${before} -> ${after}`);
    }
    assert.deepEqual(changed, [
        "succ-durable-ko-6: expertise -> expertise,explanation_depth",
        "succ-durable-ko-16: expertise -> expertise,explanation_depth",
        "succ-durable-ko-17: preference -> formatting",
        "succ-durable-ko-21: communication_style -> structure",
    ]);
});
