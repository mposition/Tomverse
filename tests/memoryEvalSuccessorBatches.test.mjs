import assert from "node:assert/strict";
import { test } from "node:test";
import { CANDIDATE_BATCHES } from "../lib/memoryExtractionEvalCandidates/index.ts";
import { validateSuccessorDataset } from "../lib/memoryEvalDatasetSchema.ts";
import { MEMORY_EVAL_CASES } from "../lib/memoryExtractionEvalFixtures.ts";

/**
 * The successor dataset's category-1 batches, checked as one set.
 *
 * `docs/ops/memory-extraction-eval-dataset.md` §4.1.1 asks for validation per
 * batch rather than once at the end. This runs it per batch AND over the
 * whole set, because the two catch different things: a batch can be internally
 * fine while the arms are short, and the arms can be right while one batch
 * quietly went partial.
 */

const successor = CANDIDATE_BATCHES.filter(
    (batch) => batch.successorTo === "mem-eval-seed-11"
);
const cases = successor.flatMap((batch) => batch.cases);
const frozen = new Map(MEMORY_EVAL_CASES.map((entry) => [entry.id, entry]));

const conversationText = (entry) =>
    entry.conversations
        .flatMap((conversation) =>
            conversation.messages.map(
                (message) => `${message.role}:${message.content}`
            )
        )
        .join("\n");

test("every batch validates on its own", () => {
    for (const batch of successor) {
        const result = validateSuccessorDataset({
            cases: batch.cases,
            purpose: "development",
        });
        assert.deepEqual(result.errors, [], batch.id);
    }
});

test("the whole set validates as a decision set", () => {
    // The arms have to be at the floor in exhaustive cases specifically, and
    // that only becomes checkable once every batch is in.
    const result = validateSuccessorDataset({ cases, purpose: "decision" });
    assert.deepEqual(result.errors, []);
    assert.equal(cases.length, 400);
});

test("both arms are at 200, and nothing is partial", () => {
    const byArm = {};
    for (const entry of cases) {
        assert.equal(entry.goldCompleteness, "exhaustive", entry.id);
        byArm[entry.language] = (byArm[entry.language] ?? 0) + 1;
    }
    assert.deepEqual(byArm, { ko: 200, en: 200 });
});

test("every expected memory states a disposition", () => {
    let memories = 0;
    for (const entry of cases) {
        assert.ok(entry.expected.length > 0, entry.id);
        for (const expected of entry.expected) {
            memories += 1;
            assert.ok(
                ["bulk_safe", "sensitive_review"].includes(
                    expected.expectedDisposition
                ),
                `${entry.id}/${expected.id}`
            );
        }
    }
    assert.equal(memories, 438);
});

test("case ids are unique across the batches", () => {
    const ids = new Set(cases.map((entry) => entry.id));
    assert.equal(ids.size, cases.length);
});

test("a reworked case copies its source, one source at most once", () => {
    // The rework is a relabelling. If a conversation moved, the batch is
    // authoring new cases under cover of a rework, and the 2026-08-23
    // adoption record stops describing what a reviewer would read.
    const claimed = new Set();
    let reworked = 0;
    for (const entry of cases) {
        if (!entry.sourceCaseId) continue;
        reworked += 1;
        const source = frozen.get(entry.sourceCaseId);
        assert.ok(source, `${entry.id} names ${entry.sourceCaseId}`);
        assert.equal(
            claimed.has(entry.sourceCaseId),
            false,
            `${entry.sourceCaseId} is reworked twice`
        );
        claimed.add(entry.sourceCaseId);
        assert.equal(conversationText(entry), conversationText(source), entry.id);
    }
    assert.equal(reworked, 396);
});

test("exactly four cases are rewritten, and each is genuinely new text", () => {
    // Named rather than counted: a fifth rewrite has to be argued for.
    const rewritten = cases
        .filter((entry) => !entry.sourceCaseId)
        .map((entry) => entry.id);
    assert.deepEqual(rewritten, [
        "succ-durable-ko-2",
        "succ-durable-ko-29",
        "succ-durable-ko-43",
        "succ-durable-ko-197",
    ]);

    const frozenText = new Set(MEMORY_EVAL_CASES.map(conversationText));
    for (const id of rewritten) {
        const entry = cases.find((candidate) => candidate.id === id);
        assert.equal(
            frozenText.has(conversationText(entry)),
            false,
            `${id} reuses a frozen conversation`
        );
    }
});

test("the kind relabels are the ones the notes name", () => {
    const changed = [];
    for (const entry of cases) {
        if (!entry.sourceCaseId) continue;
        const before = frozen
            .get(entry.sourceCaseId)
            .expected.map((expected) => expected.kind);
        const after = entry.expected.map((expected) => expected.kind);
        if (after.length > before.length) continue;
        if (before.join() !== after.join()) {
            changed.push(`${entry.id}: ${before.join()} -> ${after.join()}`);
        }
    }
    assert.deepEqual(changed, [
        "succ-durable-ko-17: preference -> formatting",
        "succ-durable-ko-21: communication_style -> structure",
        "succ-durable-en-6: preference -> structure",
        "succ-durable-en-19: relationship -> constraint",
        "succ-durable-en-20: relationship -> constraint",
        "succ-durable-en-54: relationship -> constraint",
        "succ-durable-ko-104: relationship -> constraint",
        "succ-durable-en-104: relationship -> constraint",
        "succ-durable-ko-193: communication_style -> structure",
        "succ-durable-ko-198: preference -> tone",
        "succ-durable-en-193: communication_style -> structure",
        "succ-durable-en-198: preference -> verbosity",
    ]);
});

test("the third-party health golds refuse the profile form", () => {
    // Two tokens each, and the first alone is what a medical profile
    // satisfies. This is what makes the user-centred constraint the only
    // answer that scores.
    const table = [
        ["succ-durable-en-19", "the user's partner is deaf"],
        ["succ-durable-en-20", "the user's father has dementia"],
        ["succ-durable-en-54", "the user's daughter is coeliac"],
        ["succ-durable-ko-104", "사용자의 아버지는 당뇨가 있다"],
        ["succ-durable-en-104", "the user's son is autistic"],
    ];
    for (const [id, profile] of table) {
        const entry = cases.find((candidate) => candidate.id === id);
        assert.ok(entry, id);
        const expected = entry.expected[0];
        assert.equal(expected.kind, "constraint", id);
        assert.equal(expected.expectedDisposition, "sensitive_review", id);
        assert.equal(expected.mustInclude.length, 2, id);
        const matches = expected.mustInclude.every((token) =>
            profile.toLocaleLowerCase().includes(token.toLocaleLowerCase())
        );
        assert.equal(matches, false, `${id} scores the profile form`);
    }
});

test("the sensitive count is stable and both arms carry some", () => {
    const held = cases.filter((entry) =>
        entry.expected.some(
            (expected) => expected.expectedDisposition === "sensitive_review"
        )
    );
    assert.equal(held.length, 35);
    for (const language of ["ko", "en"]) {
        assert.ok(
            held.some((entry) => entry.language === language),
            `${language} has no sensitive-review case`
        );
    }
});

test("no kind dominates the gold", () => {
    // docs/ops/memory-extraction-eval-dataset.md's diversity rule: no single
    // kind over 40% of the labels.
    const counts = {};
    let total = 0;
    for (const entry of cases) {
        for (const expected of entry.expected) {
            counts[expected.kind] = (counts[expected.kind] ?? 0) + 1;
            total += 1;
        }
    }
    const [kind, top] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    assert.ok(top / total < 0.4, `${kind} is ${top}/${total}`);
});
