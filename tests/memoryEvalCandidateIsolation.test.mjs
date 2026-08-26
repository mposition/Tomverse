import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MEMORY_EVAL_CASES } from "../lib/memoryExtractionEvalFixtures.ts";
import { CANDIDATE_BATCHES } from "../lib/memoryExtractionEvalCandidates/index.ts";
import { findDuplicateCases } from "../lib/memoryExtractionEvalCore.ts";
import { MEMORY_KINDS } from "../lib/memoryValidatorCore.ts";
import { parseBatchRecord } from "../lib/memoryEvalBatchRecord.ts";

/**
 * Policy docs/policy/external-conversation-import-and-memory.md §12.6: whatever an agent makes is a candidate pool until a person
 * adopts it, and docs/ops/memory-extraction-eval-dataset.md §6.2 says a draft
 * carries no authority. Those are promises until something enforces them.
 *
 * The enforcement is that the fixtures file does not import the candidates,
 * so a draft cannot be scored, cannot count toward a cell's floor, and is not
 * covered by the dataset digest. This file fails the moment that stops being
 * true -- which is the only way "candidate pool" stays a fact rather than a
 * note someone remembered to follow.
 */

const read = (path) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

test("no candidate case is in the dataset", () => {
    const adopted = new Set(MEMORY_EVAL_CASES.map((entry) => entry.id));
    const leaked = CANDIDATE_BATCHES.flatMap((batch) => batch.cases)
        .map((entry) => entry.id)
        .filter((id) => adopted.has(id));
    assert.deepEqual(
        leaked,
        [],
        `${leaked.join(", ")} reached MEMORY_EVAL_CASES without being adopted`
    );
});

test("the fixtures file does not import the candidate pool", () => {
    // The structural half. An id check alone would pass the day someone
    // spreads the batch in under new ids.
    const source = read("../lib/memoryExtractionEvalFixtures.ts");
    // An import, not a mention. The fixtures file explains in prose which
    // directory it may not pull from, and a substring check would fail on
    // the explanation while passing on a dynamic import.
    assert.doesNotMatch(
        source,
        /(?:from|import\()\s*["'][^"']*memoryExtractionEvalCandidates/,
        "fixtures must not import candidates -- adoption is a human act, " +
            "recorded in the batch record, not an import"
    );
});

test("every candidate batch names a record file for its reviewer", () => {
    // A batch with no record is a batch whose verdicts have nowhere to go,
    // and docs/ops/memory-extraction-eval-dataset.md §6.3's batch adoption would have nothing to be written into.
    for (const batch of CANDIDATE_BATCHES) {
        assert.match(batch.id, /^batch-\d{3}$/);
        assert.ok(batch.cases.length >= 25 && batch.cases.length <= 50,
            `${batch.id} has ${batch.cases.length} cases; docs/ops/memory-extraction-eval-dataset.md §6.1 says 25-50`);
        assert.ok(
            batch.record.startsWith("docs/ops/memory-extraction-eval-batches/"),
            `${batch.id} must name a record under the batch record directory`
        );
        readFileSync(
            fileURLToPath(new URL(`../${batch.record}`, import.meta.url)),
            "utf8"
        );
    }
});

test("candidates are already valid cases, so review is about judgement", () => {
    // Type checking catches an invalid kind at build time; this catches the
    // rules a type cannot express. A reviewer should be spending attention on
    // whether a case is a good case, not on whether it is well-formed.
    const all = CANDIDATE_BATCHES.flatMap((batch) => batch.cases);
    assert.deepEqual(findDuplicateCases(all), []);
    for (const entry of all) {
        const messages = entry.conversations.flatMap(
            (conversation) => conversation.messages
        );
        assert.ok(messages.length >= 2, `${entry.id}: docs/ops/memory-extraction-eval-dataset.md §3.1 wants at least two turns`);
        assert.ok(
            messages.some((message) => message.role === "user"),
            `${entry.id}: docs/ops/memory-extraction-eval-dataset.md §3.1 wants at least one user turn`
        );
        // A gold is normally category ①'s alone. The 2026-08-26
        // mixed-critical amendment lets a named critical case carry one, and
        // when it does the gold is checked by exactly the same rules — the
        // keyword grounding below is what stops a mixed case from asserting
        // a fact the user never stated.
        const carriesGold =
            entry.category === "durable_facts" ||
            entry.criticalGoldMode === "allow_expected_only";
        if (carriesGold) {
            assert.ok(
                entry.expected.length >= 1 && entry.expected.length <= 3,
                `${entry.id}: docs/ops/memory-extraction-eval-dataset.md §4.1 limits expected to 1-3`
            );
            const userText = messages
                .filter((message) => message.role === "user")
                .map((message) => message.content)
                .join(" ")
                .toLowerCase();
            for (const expectation of entry.expected) {
                assert.ok(
                    MEMORY_KINDS.includes(expectation.kind),
                    `${entry.id}: ${expectation.kind} is not a docs/ops/memory-extraction-eval-dataset.md §8.2 kind`
                );
                assert.ok(
                    expectation.mustInclude.length <= 2,
                    `${entry.id}: docs/ops/memory-extraction-eval-dataset.md §4.1 recommends at most two keywords`
                );
                for (const keyword of expectation.mustInclude) {
                    // docs/ops/memory-extraction-eval-dataset.md §3.2: the fact must be grounded in what the USER said.
                    // A keyword only the assistant used would make the case
                    // a category ② in disguise.
                    assert.ok(
                        userText.includes(keyword.toLowerCase()),
                        `${entry.id}: "${keyword}" appears in no user turn`
                    );
                }
            }
        } else {
            assert.deepEqual(
                entry.expected,
                [],
                `${entry.id}: docs/ops/memory-extraction-eval-dataset.md §4.2 requires an empty expected outside category ①`
            );
        }

        if (entry.criticalGoldMode !== undefined) {
            // Fail closed on a typo: exactly one literal is the permission,
            // and anything else must not read as one.
            assert.equal(
                entry.criticalGoldMode,
                "allow_expected_only",
                `${entry.id}: unknown criticalGoldMode`
            );
            assert.notEqual(
                entry.category,
                "durable_facts",
                `${entry.id}: category ① does not need the permission`
            );
        }
    }
});

test("no kind takes more than 40% of a candidate cell", () => {
    // docs/ops/memory-extraction-eval-dataset.md §3.2. A cell that is 200 preferences measures one kind and reports it
    // as the quality of ten.
    for (const batch of CANDIDATE_BATCHES) {
        const counts = new Map();
        for (const entry of batch.cases) {
            for (const expectation of entry.expected) {
                counts.set(
                    expectation.kind,
                    (counts.get(expectation.kind) ?? 0) + 1
                );
            }
        }
        for (const [kind, count] of counts) {
            assert.ok(
                count <= batch.cases.length * 0.4,
                `${batch.id}: ${kind} is ${count}/${batch.cases.length}, over the 40% ceiling`
            );
        }
    }
});

test("a record's verdicts name cases that are still in the batch", () => {
    // docs/ops/memory-extraction-eval-dataset.md §6.4 redrafts a rejected case rather than editing it in place, and a
    // redraft can renumber ids. If the record then names ids the batch no
    // longer contains, the batch reads as reviewed while the cases that would
    // move into the dataset are ones nobody judged -- the exact outcome
    // docs/ops/memory-extraction-eval-dataset.md §6.3's explicit adoption line was added to prevent.
    for (const batch of CANDIDATE_BATCHES) {
        const record = parseBatchRecord(
            readFileSync(
                fileURLToPath(new URL(`../${batch.record}`, import.meta.url)),
                "utf8"
            )
        );
        const known = new Set(batch.cases.map((entry) => entry.id));
        const orphans = record.cases
            .map((entry) => entry.caseId)
            .filter((id) => !known.has(id));
        assert.deepEqual(
            orphans,
            [],
            `${batch.id}: its record judges ${orphans.join(", ")}, which the batch no longer contains`
        );
    }
});
