import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MEMORY_EVAL_CASES } from "../lib/memoryExtractionEvalFixtures.ts";
import { ADOPTED_BATCHES } from "../lib/memoryExtractionEvalAdopted/index.ts";
import { CANDIDATE_BATCHES } from "../lib/memoryExtractionEvalCandidates/index.ts";
import {
    parseBatchRecord,
    promotionBlockers,
} from "../lib/memoryEvalBatchRecord.ts";

/**
 * An adopted batch is scored, counts toward its cell's docs/ops/memory-extraction-eval-dataset.md §12.2 floor and is
 * covered by the dataset digest. Everything it is allowed to do rests on one
 * line in a markdown file, written by a person.
 *
 * So the line is re-read on every run rather than trusted as a fact about the
 * commit that moved the file. If a record is edited, truncated, or its
 * adoption withdrawn, these cases stop being allowed in the dataset the same
 * day -- which is the difference between an audit trail and a note.
 */

const recordOf = (batch) =>
    parseBatchRecord(
        readFileSync(
            fileURLToPath(new URL(`../${batch.record}`, import.meta.url)),
            "utf8"
        )
    );

test("every adopted batch's record still adopts it", () => {
    for (const batch of ADOPTED_BATCHES) {
        const blockers = promotionBlockers(recordOf(batch), batch.cases.length);
        assert.deepEqual(
            blockers,
            [],
            `${batch.id} is in the dataset but its record no longer licenses it: ${blockers.join("; ")}`
        );
    }
});

test("every adopted case is actually in the dataset", () => {
    // The registry claims these cases are dataset. A batch listed here but
    // not imported by the fixtures file would make that claim false, and the
    // cell floor it appears to satisfy would be short.
    const present = new Set(MEMORY_EVAL_CASES.map((entry) => entry.id));
    for (const batch of ADOPTED_BATCHES) {
        const missing = batch.cases
            .map((entry) => entry.id)
            .filter((id) => !present.has(id));
        assert.deepEqual(
            missing,
            [],
            `${batch.id}: ${missing.join(", ")} is adopted but absent from MEMORY_EVAL_CASES`
        );
    }
});

test("a batch is in one pool or the other, never both", () => {
    // Adoption is a move. A batch left in both directories would be a batch
    // the fixtures file may import while the candidate isolation test still
    // reports it as safely walled off.
    const candidateIds = new Set(CANDIDATE_BATCHES.map((batch) => batch.id));
    for (const batch of ADOPTED_BATCHES) {
        assert.ok(
            !candidateIds.has(batch.id),
            `${batch.id} is listed as both adopted and awaiting review`
        );
    }
});

test("the record's sampled verdicts name cases the adopted batch contains", () => {
    // docs/ops/memory-extraction-eval-dataset.md §7.1 wants the judgement basis on record. A record whose ids no
    // longer match the batch cannot supply one -- the cases in the dataset
    // would be traceable to nothing.
    for (const batch of ADOPTED_BATCHES) {
        const known = new Set(batch.cases.map((entry) => entry.id));
        const orphans = recordOf(batch)
            .cases.map((entry) => entry.caseId)
            .filter((id) => !known.has(id));
        assert.deepEqual(
            orphans,
            [],
            `${batch.id}: its record judges ${orphans.join(", ")}, which the batch does not contain`
        );
    }
});

test("the fixtures file imports adopted batches, not the candidate pool", () => {
    const source = readFileSync(
        fileURLToPath(
            new URL("../lib/memoryExtractionEvalFixtures.ts", import.meta.url)
        ),
        "utf8"
    );
    assert.doesNotMatch(
        source,
        /(?:from|import\()\s*["'][^"']*memoryExtractionEvalCandidates/,
        "the candidate directory is the one the fixtures file may not import"
    );
    for (const batch of ADOPTED_BATCHES) {
        assert.match(
            source,
            /(?:from|import\()\s*["'][^"']*memoryExtractionEvalAdopted/,
            `${batch.id} is adopted, so the fixtures file must import it from the adopted directory`
        );
    }
});
