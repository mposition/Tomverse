import assert from "node:assert/strict";
import { test } from "node:test";
import { CANDIDATE_BATCHES } from "../lib/memoryExtractionEvalCandidates/index.ts";
import { validateSuccessorDataset } from "../lib/memoryEvalDatasetSchema.ts";
import { MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM } from "../lib/memoryExtractionEvalCore.ts";
import { MEMORY_EVAL_CASES } from "../lib/memoryExtractionEvalFixtures.ts";

/**
 * The successor dataset's batches, checked as one set.
 *
 * `docs/ops/memory-extraction-eval-dataset.md` §4.1.1 asks for validation per
 * batch rather than once at the end. This runs it per batch AND over the
 * whole set, because the two catch different things: a batch can be internally
 * fine while the arms are short, and the arms can be right while one batch
 * quietly went partial.
 *
 * ## The set is being built one category at a time
 *
 * Category ① (`durable_facts`) was written first, and its numbers below are
 * pinned exactly. The other three categories are critical negatives and are
 * being written after it, so the whole-set decision validation cannot pass
 * yet — the cells that have no cases are short of their floor.
 *
 * That check is kept rather than deferred, and made to assert *which* errors
 * are outstanding. A test that simply stopped running until the set was
 * finished would go quiet during exactly the period when cases are being
 * added, and the first thing it would have to catch is a new batch that
 * validates differently from the ones before it.
 */

const successor = CANDIDATE_BATCHES.filter(
    (batch) => batch.successorTo === "mem-eval-seed-11"
);
const cases = successor.flatMap((batch) => batch.cases);
const durable = cases.filter((entry) => entry.category === "durable_facts");
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

test("the decision validation passes, and does not mean the set is ready", () => {
    // It passes on category 1 alone, because the only floor this validator
    // enforces is `durable_facts` — `MEMORY_EVAL_MIN_EXHAUSTIVE_CASES_PER_ARM`
    // is derived from that one entry. Asserted here so nobody reads a green
    // result as "the successor set can be frozen": the other three cells are
    // covered by the next test, and by the freeze check once the set is the
    // dataset.
    const result = validateSuccessorDataset({ cases, purpose: "decision" });
    assert.deepEqual(result.errors, []);
});

test("the critical-negative cells are short, and by how much", () => {
    // The work that is left, written down. This test is expected to be
    // edited by each batch that lands — that is the point of it. A count
    // that moves without this file moving is a batch nobody recorded.
    const counts = {};
    for (const entry of cases) {
        if (entry.category === "durable_facts") continue;
        const cell = `${entry.category}:${entry.language}`;
        counts[cell] = (counts[cell] ?? 0) + 1;
    }
    assert.deepEqual(counts, {
        "injection_directives:ko": 125,
        "injection_directives:en": 125,
    });

    // Named against the policy floor rather than a literal, so raising the
    // floor shows up here rather than silently passing.
    for (const language of ["ko", "en"]) {
        assert.equal(
            counts[`injection_directives:${language}`],
            MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM.injection_directives,
            `injection_directives:${language} is no longer at its floor`
        );
        for (const category of ["assistant_only", "sensitive_secrets"]) {
            const have = counts[`${category}:${language}`] ?? 0;
            assert.ok(
                have < MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM[category],
                `${category}:${language} is at ${have} — if it reached the ` +
                    "floor, record that here rather than removing the check"
            );
        }
    }
});

test("category 1 is complete and stays complete", () => {
    // Pinned, not recomputed. These four numbers were what the 14 batches
    // were reviewed and adopted against, and a later category must not move
    // them.
    assert.equal(durable.length, 400);
    const byArm = {};
    for (const entry of durable) {
        assert.equal(entry.goldCompleteness, "exhaustive", entry.id);
        byArm[entry.language] = (byArm[entry.language] ?? 0) + 1;
    }
    assert.deepEqual(byArm, { ko: 200, en: 200 });
});

test("nothing anywhere in the set is partial", () => {
    // Wider than the category-1 check above: a partial case is refused in a
    // decision set whatever category it sits in, and the error code for it
    // would be swallowed by the floor errors the first test allows.
    for (const entry of cases) {
        assert.equal(entry.goldCompleteness, "exhaustive", entry.id);
    }
});

test("every expected memory states a disposition", () => {
    let memories = 0;
    for (const entry of durable) {
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

test("a critical negative asserts nothing comes out, exhaustively", () => {
    // The whole content of a category 2/3/4 case. An empty gold without
    // `exhaustive` would say "we did not finish looking", which is the
    // opposite of what the case claims, and a non-empty one would make it a
    // different category.
    const critical = cases.filter(
        (entry) => entry.category !== "durable_facts"
    );
    assert.ok(critical.length > 0);
    for (const entry of critical) {
        assert.equal(entry.goldCompleteness, "exhaustive", entry.id);
        if (entry.criticalGoldMode === undefined) {
            assert.deepEqual(entry.expected, [], entry.id);
            continue;
        }
        // The 2026-08-26 permission, and the only value it may take. A gold
        // is allowed here, but the permission is not a licence for an empty
        // one — a case that declares it and then expects nothing is a case
        // whose author changed their mind and left the flag behind.
        assert.equal(entry.criticalGoldMode, "allow_expected_only", entry.id);
        assert.ok(entry.expected.length > 0, entry.id);
    }

    // Named, not counted. Ten mixed cases is what the amendment settled, and
    // an eleventh has to be argued for rather than appearing.
    assert.deepEqual(
        critical
            .filter((entry) => entry.criticalGoldMode !== undefined)
            .map((entry) => entry.id),
        [
            "succ-injection-ko-119",
            "succ-injection-ko-120",
            "succ-injection-ko-121",
            "succ-injection-ko-123",
            "succ-injection-ko-124",
            "succ-injection-en-119",
            "succ-injection-en-120",
            "succ-injection-en-121",
            "succ-injection-en-123",
            "succ-injection-en-124",
        ]
    );
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
    for (const entry of durable) {
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
    const rewritten = durable
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
        const entry = durable.find((candidate) => candidate.id === id);
        assert.equal(
            frozenText.has(conversationText(entry)),
            false,
            `${id} reuses a frozen conversation`
        );
    }
});

test("the kind relabels are the ones the notes name", () => {
    const changed = [];
    for (const entry of durable) {
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
        const entry = durable.find((candidate) => candidate.id === id);
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
    const held = durable.filter((entry) =>
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
    for (const entry of durable) {
        for (const expected of entry.expected) {
            counts[expected.kind] = (counts[expected.kind] ?? 0) + 1;
            total += 1;
        }
    }
    const [kind, top] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    assert.ok(top / total < 0.4, `${kind} is ${top}/${total}`);
});
