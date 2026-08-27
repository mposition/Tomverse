import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SUCC3_ADOPTED_BATCHES } from "../lib/memoryEvalSucc3Adopted/index.ts";
import {
    MEMORY_EVAL_SUCC3_CASES,
    MEMORY_EVAL_SUCC3_DATASET_FROZEN,
    MEMORY_EVAL_SUCC3_DATASET_PURPOSE,
    MEMORY_EVAL_SUCC3_DATASET_VERSION,
    MEMORY_EVAL_SUCC3_SUPERSEDES,
} from "../lib/memoryEvalSucc3Fixtures.ts";
import {
    MEMORY_EVAL_SUCCESSOR_CASES,
    MEMORY_EVAL_SUCCESSOR_DATASET_VERSION,
} from "../lib/memoryEvalSuccessorFixtures.ts";
import { SUCCESSOR_ADOPTED_BATCHES } from "../lib/memoryEvalSuccessorAdopted/index.ts";
import { TRANCHE_1_SUCCESSORS } from "../lib/memoryEvalSuccessorAdopted/tranche1Successors.ts";
import { TRANCHE_2_SUCCESSORS } from "../lib/memoryEvalSuccessorAdopted/tranche2Successors.ts";
import { MEMORY_EVAL_REPLACEMENT_PLAN } from "../lib/memoryEvalSuccessorAdopted/replacementPlan.ts";
import {
    MEMORY_EVAL_REGRESSION_CASES,
    MEMORY_EVAL_REGRESSION_PROVENANCE,
} from "../lib/memoryEvalRegressionCorpus/index.ts";
import {
    parseBatchRecord,
    promotionBlockers,
} from "../lib/memoryEvalBatchRecord.ts";
import { evalDatasetManifest } from "../lib/memoryEvalDatasetManifests.ts";
import {
    assessSampleAdequacy,
    findDuplicateCases,
} from "../lib/memoryExtractionEvalCore.ts";
import { validateSuccessorDataset } from "../lib/memoryEvalDatasetSchema.ts";

/**
 * `mem-eval-succ-3`, and the thing it must not have done to `mem-eval-succ-2`.
 *
 * Everything a batch is allowed to do rests on one line in a markdown file
 * written by a person, so the 40 lines are re-read on every run rather than
 * trusted as a fact about the commit that added them.
 *
 * The other half is subtraction. succ-3 exists because 99 cases left, and the
 * ways that could go wrong are all silent: a case in both sets, a successor
 * and its original both registered, a replacement that never arrived, a cell
 * quietly under its floor. Each of those is checked as an equality here, not
 * as a "no obvious problem".
 */

const SUCCESSORS = [...TRANCHE_1_SUCCESSORS, ...TRANCHE_2_SUCCESSORS];

const recordOf = (batch) =>
    parseBatchRecord(
        readFileSync(
            fileURLToPath(new URL(`../${batch.record}`, import.meta.url)),
            "utf8"
        )
    );

/* --------------------------------------------------------- the records -- */

test("every succ-3 batch's record still adopts it", () => {
    assert.equal(SUCC3_ADOPTED_BATCHES.length, 40);
    for (const batch of SUCC3_ADOPTED_BATCHES) {
        assert.deepEqual(
            promotionBlockers(recordOf(batch), batch.cases.length),
            [],
            batch.id
        );
    }
});

test("every case on record is judged 채택, and there are judgements to read", () => {
    for (const batch of SUCC3_ADOPTED_BATCHES) {
        const record = recordOf(batch);
        assert.ok(record.cases.length > 0, batch.id);
        for (const entry of record.cases) {
            assert.equal(entry.verdict, "채택", `${batch.id}/${entry.caseId}`);
        }
    }
});

test("a successor's carried verdicts really are in the source record", () => {
    // The successor records say the verdicts were carried from the batch each
    // one succeeds rather than re-reviewed. That claim is checkable, so it is
    // checked: a carried 채택 that the source never gave would be a review
    // nobody did.
    const sourceById = new Map(SUCCESSOR_ADOPTED_BATCHES.map((b) => [b.id, b]));
    const succ3ById = new Map(SUCC3_ADOPTED_BATCHES.map((b) => [b.id, b]));
    let carried = 0;
    for (const successor of SUCCESSORS) {
        const source = sourceById.get(successor.replacesBatchId);
        const sourceVerdicts = new Map(
            recordOf(source).cases.map((entry) => [entry.caseId, entry.verdict])
        );
        for (const entry of recordOf(succ3ById.get(successor.id)).cases) {
            assert.equal(
                sourceVerdicts.get(entry.caseId),
                "채택",
                `${successor.id}/${entry.caseId} is carried but ${source.id} does not adopt it`
            );
            carried += 1;
        }
    }
    assert.ok(carried > 300, `only ${carried} verdicts carried`);
});

/* ------------------------------------------------------ the composition -- */

test("a batch appears as the original or its successor, never both", () => {
    const ids = SUCC3_ADOPTED_BATCHES.map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length, "a batch id is registered twice");

    const registered = new Set(ids);
    for (const successor of SUCCESSORS) {
        assert.ok(registered.has(successor.id), `${successor.id} is missing`);
        assert.ok(
            !registered.has(successor.replacesBatchId),
            `${successor.replacesBatchId} is registered alongside its successor ${successor.id}`
        );
    }
    // The 7 batches no rule-authoring case came from keep their own ids.
    const unchanged = SUCCESSOR_ADOPTED_BATCHES.filter((b) =>
        registered.has(b.id)
    );
    assert.equal(unchanged.length, 7);
    assert.equal(SUCCESSORS.length, 25);
    assert.equal(ids.length, 7 + 25 + 8);
});

test("the registry and the fixtures agree on the case list", () => {
    assert.equal(
        MEMORY_EVAL_SUCC3_CASES.length,
        SUCC3_ADOPTED_BATCHES.reduce((n, b) => n + b.cases.length, 0)
    );
    assert.equal(MEMORY_EVAL_SUCC3_CASES.length, 1150);
    assert.equal(
        new Set(MEMORY_EVAL_SUCC3_CASES.map((c) => c.id)).size,
        1150
    );
});

test("succ-3 declares what it is and what it replaced", () => {
    assert.equal(MEMORY_EVAL_SUCC3_DATASET_VERSION, "mem-eval-succ-3");
    assert.equal(MEMORY_EVAL_SUCC3_SUPERSEDES, MEMORY_EVAL_SUCCESSOR_DATASET_VERSION);
    assert.equal(MEMORY_EVAL_SUCC3_DATASET_PURPOSE, "decision");
    // Held false until the operator fills the 초안 생성자 row on the eight
    // replacement batches: `npm run check:memory-eval-freeze` refuses a
    // `true` here while any §7.1 condition is unmet.
    assert.equal(MEMORY_EVAL_SUCC3_DATASET_FROZEN, false);
});

/* --------------------------------------------------------- the removal -- */

test("exactly the 99 provenance cases left, and none of them came back", () => {
    const succ3 = new Set(MEMORY_EVAL_SUCC3_CASES.map((c) => c.id));
    const succ2 = new Set(MEMORY_EVAL_SUCCESSOR_CASES.map((c) => c.id));
    const moved = MEMORY_EVAL_REGRESSION_PROVENANCE.map((e) => e.originalId);

    assert.equal(moved.length, 99);
    for (const id of moved) {
        assert.ok(succ2.has(id), `${id} was never in succ-2`);
        assert.ok(!succ3.has(id), `${id} is still in the decision set`);
    }
    // Not "at least the 99": exactly them. A case that vanished for any other
    // reason would be a hole nobody recorded.
    const gone = [...succ2].filter((id) => !succ3.has(id));
    assert.deepEqual([...gone].sort(), [...moved].sort());

    // And the corpus holds precisely those.
    assert.deepEqual(
        MEMORY_EVAL_REGRESSION_CASES.map((c) => c.id).sort(),
        [...moved].sort()
    );
});

test("every replacement named in the plan is in the decision set", () => {
    const succ3 = new Set(MEMORY_EVAL_SUCC3_CASES.map((c) => c.id));
    const succ2 = new Set(MEMORY_EVAL_SUCCESSOR_CASES.map((c) => c.id));

    assert.equal(MEMORY_EVAL_REPLACEMENT_PLAN.length, 99);
    for (const { originalId, replacementId } of MEMORY_EVAL_REPLACEMENT_PLAN) {
        assert.ok(succ3.has(replacementId), `${replacementId} is not in succ-3`);
        assert.ok(!succ2.has(replacementId), `${replacementId} was in succ-2`);
        assert.ok(!succ3.has(originalId), `${originalId} did not leave`);
    }

    // Arrivals and departures balance, so the count is not held up by
    // something else moving in the opposite direction.
    const arrived = [...succ3].filter((id) => !succ2.has(id));
    assert.deepEqual(
        arrived.sort(),
        MEMORY_EVAL_REPLACEMENT_PLAN.map((e) => e.replacementId).sort()
    );
});

test("the provenance and the plan agree, now that both are filled", () => {
    const planned = new Map(
        MEMORY_EVAL_REPLACEMENT_PLAN.map((e) => [e.originalId, e.replacementId])
    );
    for (const entry of MEMORY_EVAL_REGRESSION_PROVENANCE) {
        assert.equal(
            entry.replacementId,
            planned.get(entry.originalId),
            `${entry.originalId}: provenance and plan name different replacements`
        );
    }
});

/* ------------------------------------------------------------ the set --- */

test("succ-3 passes the schema and holds every §12.2 floor", () => {
    const validation = validateSuccessorDataset({
        cases: MEMORY_EVAL_SUCC3_CASES,
        purpose: "decision",
    });
    assert.deepEqual(validation.errors, []);

    const adequacy = assessSampleAdequacy(
        MEMORY_EVAL_SUCC3_CASES.map((c) => ({
            caseId: c.id,
            category: c.category,
            language: c.language,
        }))
    );
    assert.deepEqual(adequacy.underpowered, []);
    assert.deepEqual(findDuplicateCases(MEMORY_EVAL_SUCC3_CASES), []);
});

test("succ-3's manifest matches its registry, batch for batch", () => {
    const manifest = evalDatasetManifest("mem-eval-succ-3");
    assert.ok(manifest, "succ-3 has no manifest");
    assert.equal(manifest.supersedes, "mem-eval-succ-2");
    assert.equal(manifest.caseCount, 1150);
    assert.equal(manifest.unbatched, null);
    assert.deepEqual(
        manifest.batches.map((b) => b.id),
        SUCC3_ADOPTED_BATCHES.map((b) => b.id)
    );
    // The digest values themselves are recomputed by
    // `tests/memoryEvalDatasetManifests.test.mjs`; what this pins is that the
    // manifest describes this registry rather than some other arrangement of
    // the same case count.
    for (const [index, batch] of SUCC3_ADOPTED_BATCHES.entries()) {
        assert.equal(manifest.batches[index].caseCount, batch.cases.length);
        assert.equal(manifest.batches[index].cell, batch.cell);
    }
});

test("succ-2 is untouched by all of this", () => {
    // The reason succ-3 is a third module. run1's verdict is attached to
    // succ-2, and its manifest recomputing is what keeps that readable.
    assert.equal(MEMORY_EVAL_SUCCESSOR_CASES.length, 1150);
    assert.equal(SUCCESSOR_ADOPTED_BATCHES.length, 32);
    assert.equal(
        evalDatasetManifest("mem-eval-succ-2").datasetDigest,
        "60aa43f1cf8ea23b715d200b897abfb3bedb8a7fe7d352d2cf85b6a56be91e5c"
    );
});
