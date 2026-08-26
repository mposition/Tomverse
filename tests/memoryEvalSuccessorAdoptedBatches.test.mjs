import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SUCCESSOR_ADOPTED_BATCHES } from "../lib/memoryEvalSuccessorAdopted/index.ts";
import { MEMORY_EVAL_SUCCESSOR_CASES } from "../lib/memoryEvalSuccessorFixtures.ts";
import { CANDIDATE_BATCHES } from "../lib/memoryExtractionEvalCandidates/index.ts";
import {
    parseBatchRecord,
    promotionBlockers,
} from "../lib/memoryEvalBatchRecord.ts";

/**
 * The successor set's half of `tests/memoryEvalAdoptedBatches.test.mjs`.
 *
 * An adopted batch is scored and counts toward its cell's floor, and
 * everything it is allowed to do rests on one line in a markdown file
 * written by a person. So the line is re-read on every run rather than
 * trusted as a fact about the commit that moved the file: if a record is
 * edited, truncated, or its adoption withdrawn, these cases stop being
 * allowed the same day.
 */

const recordOf = (batch) =>
    parseBatchRecord(
        readFileSync(
            fileURLToPath(new URL(`../${batch.record}`, import.meta.url)),
            "utf8"
        )
    );

test("every successor batch's record still adopts it", () => {
    assert.equal(SUCCESSOR_ADOPTED_BATCHES.length, 32);
    for (const batch of SUCCESSOR_ADOPTED_BATCHES) {
        assert.deepEqual(
            promotionBlockers(recordOf(batch), batch.cases.length),
            [],
            batch.id
        );
    }
});

test("every case is judged, not just the batch", () => {
    // A category 2/3/4 batch is reviewed in full, and category 1's sheets
    // carry the sample the reviewer saw. Either way the verdicts on record
    // must all be 채택 — promotionBlockers already refuses a rejection, and
    // this asserts the count is not zero, which it cannot be for a batch
    // whose record parsed at all.
    for (const batch of SUCCESSOR_ADOPTED_BATCHES) {
        const record = recordOf(batch);
        assert.ok(record.cases.length > 0, batch.id);
        for (const entry of record.cases) {
            assert.equal(entry.verdict, "채택", `${batch.id}/${entry.caseId}`);
        }
    }
});

test("the candidate directory is empty, and that is the finished state", () => {
    // Not a tautology: it is what says the promotion completed. A batch left
    // behind in the candidate index would be scored by nothing and counted
    // toward no floor, and the set would be short without any check saying so.
    assert.deepEqual(CANDIDATE_BATCHES, []);
});

test("the registry and the fixtures agree on the case list", () => {
    // The fixtures module derives its cases from this registry rather than
    // listing them again. This is what makes that derivation load-bearing
    // rather than incidental.
    assert.equal(
        MEMORY_EVAL_SUCCESSOR_CASES.length,
        SUCCESSOR_ADOPTED_BATCHES.reduce(
            (total, batch) => total + batch.cases.length,
            0
        )
    );
    assert.equal(MEMORY_EVAL_SUCCESSOR_CASES.length, 1150);
});
