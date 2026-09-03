import assert from "node:assert/strict";
import { test } from "node:test";

import {
    MEMORY_EVAL_DATASET_MANIFESTS,
    MEMORY_EVAL_SCORING_CONTRACT_MANIFESTS,
    evalDatasetManifest,
    verifyEvalDatasetManifest,
    verifyScoringContractManifest,
} from "../lib/memoryEvalDatasetManifests.ts";
import { memoryEvalScoringContractReadiness } from "../lib/memoryEvalScoringContractDigest.ts";
import { EVAL_DATASET_COMPOSITIONS } from "../lib/memoryEvalDatasetRegistry.ts";
import { MEMORY_EVAL_SUCCESSOR_CASES } from "../lib/memoryEvalSuccessorFixtures.ts";
import { SUCCESSOR_ADOPTED_BATCHES } from "../lib/memoryEvalSuccessorAdopted/index.ts";
import { MEMORY_EVAL_CASES } from "../lib/memoryExtractionEvalFixtures.ts";
import { ADOPTED_BATCHES } from "../lib/memoryExtractionEvalAdopted/index.ts";
import {
    MEMORY_EVAL_CATEGORIES,
    MEMORY_EVAL_LANGUAGES,
    MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM,
} from "../lib/memoryExtractionEvalCore.ts";

/**
 * The manifest is a record of what a dataset was when a run was scored
 * against it. It is only a record while it disagrees loudly with a tree that
 * has moved, so the recomputation runs here on every build — and the negative
 * tests below exist because a checker nobody has seen fail is a checker
 * nobody has tested.
 *
 * A failure in this file is never fixed by editing the manifest. Either the
 * dataset was edited and must be restored, or it was genuinely reworked and
 * needs a NEW version with a NEW entry (docs/ops/memory-extraction-eval-dataset.md §7.3).
 */

// Read from the registry rather than restated: a manifest recorded for a
// version the registry cannot supply cases for would otherwise be verified
// against a second, hand-kept copy of the same composition.
const COMPOSITIONS = EVAL_DATASET_COMPOSITIONS;

const verify = (version, composition) =>
    verifyEvalDatasetManifest(
        evalDatasetManifest(version),
        composition ?? COMPOSITIONS[version]
    );

/* ------------------------------------------------------- recomputation -- */

test("every manifest recomputes exactly from the live tree", (t) => {
    for (const manifest of MEMORY_EVAL_DATASET_MANIFESTS) {
        const composition = COMPOSITIONS[manifest.datasetVersion];
        assert.ok(
            composition,
            `${manifest.datasetVersion} is recorded but this test cannot reach its ` +
                `registry, so nothing verifies it`
        );
        const result = verifyEvalDatasetManifest(manifest, composition);
        assert.deepEqual(
            result.mismatches,
            [],
            `${manifest.datasetVersion} no longer matches its manifest`
        );
        t.diagnostic(
            `${manifest.datasetVersion}: ${manifest.caseCount} cases, ` +
                `${manifest.batches.length} batches, contract ${result.scoringContract}`
        );
    }
    assert.equal(MEMORY_EVAL_DATASET_MANIFESTS.length, 3);
});

test("the scoring contract is checked where it applies and skipped where it cannot", () => {
    assert.equal(verify("mem-eval-seed-11").scoringContract, "not_applicable_schema_1");
    // succ-2 and succ-3 were authored and scored under mem-score-v2.3. The
    // live contract is mem-score-v3, so their entries report `superseded` and
    // their contract digests are not recomputed -- recomputing them would make
    // each manifest describe a contract its run never saw. Everything that
    // does not depend on the contract is still checked exactly, above.
    assert.equal(verify("mem-eval-succ-2").scoringContract, "superseded");
    assert.equal(verify("mem-eval-succ-3").scoringContract, "superseded");
    for (const version of ["mem-eval-succ-2", "mem-eval-succ-3"]) {
        assert.equal(
            evalDatasetManifest(version).scoringContractVersion,
            "mem-score-v2.3"
        );
    }
});

test("freezing mem-score-v3 left every dataset digest where it was", () => {
    // The contract bump must not touch a dataset digest: the two are disjoint
    // by construction, and this is the assertion that says so out loud rather
    // than trusting the construction. Values written out, so a test that
    // recomputed them could not agree with any tree at all.
    assert.equal(
        evalDatasetManifest("mem-eval-seed-11").datasetDigest,
        "a3b0c18e3c66d31f3eed7d8f7e7acbb94bee9146fff153ac89f91e6151e07a67"
    );
    assert.equal(
        evalDatasetManifest("mem-eval-succ-2").datasetDigest,
        "60aa43f1cf8ea23b715d200b897abfb3bedb8a7fe7d352d2cf85b6a56be91e5c"
    );
    assert.equal(
        evalDatasetManifest("mem-eval-succ-3").datasetDigest,
        "38468da0dce31a144d61d360189b4ce9e1d55e0e914ae66a2d61bfb1e793dc3b"
    );
    // And their recorded contract digests are untouched too: a superseded
    // entry is a record, not a value to refresh.
    assert.equal(
        evalDatasetManifest("mem-eval-succ-2").scoringContractDigest,
        "b07632843d748fcc5773e210b113e0d9e7770aa3a91bf8e20b453e72480b7fb9"
    );
});

test("mem-score-v3 is pinned, and the tree still computes it", () => {
    // The gap this closes: on the day a contract is frozen, every dataset
    // entry names the previous one, so nothing recomputes the new contract's
    // digest at all. That window -- when its terms are most likely to be
    // adjusted and least likely to be noticed -- is exactly when it needs a
    // record of its own.
    const result = verifyScoringContractManifest();
    assert.deepEqual(result.mismatches, []);
    assert.equal(result.version, "mem-score-v3.5");
    assert.equal(
        result.entry.descriptorDigest,
        "08e6d8b6a65a8f874b3c437a118b89e2e57eacb5652dffcd301247cff24213bc"
    );
    // v3.4 stays pinned at what it was frozen with. succ-5, succ-6 and succ-7
    // are bound to it for good, so a value that moved here would leave three
    // frozen manifests describing a contract that no longer exists.
    assert.equal(
        MEMORY_EVAL_SCORING_CONTRACT_MANIFESTS.find(
            (m) => m.version === "mem-score-v3.4"
        ).descriptorDigest,
        "a62f4bdd8d2073345e19e478541c20d81275a0d11fb78aa6e4df86ec0489b4cd"
    );
    // v3.3 stays pinned at the value it was frozen with, and that value is
    // what makes it historical rather than current: its descriptor says it
    // scores schema 2 while it scores schema 3. v3.4 corrects the field, and
    // correcting it forward is why both records exist.
    assert.equal(
        MEMORY_EVAL_SCORING_CONTRACT_MANIFESTS.find(
            (m) => m.version === "mem-score-v3.3"
        ).descriptorDigest,
        "19f4e4f9d5976382d83a03153ef8e7fb52b3f6dd6104efa54f53ef05cd82f777"
    );
    // v3.2 stays pinned for the same reason v3 does: it was frozen, and its
    // digest is what a later claim about it is checked against.
    assert.equal(
        MEMORY_EVAL_SCORING_CONTRACT_MANIFESTS.find(
            (m) => m.version === "mem-score-v3.2"
        ).descriptorDigest,
        "8d6dfef8537cf910a40d175e0bb315bdfaa4e47fa5e89ea3c4bfbc032d9b6e1b"
    );
    // v3 stays pinned. It existed, it was frozen, and nothing was scored under
    // it -- but a version whose record is deleted once it is superseded is a
    // version nobody can check a later claim against.
    assert.equal(
        MEMORY_EVAL_SCORING_CONTRACT_MANIFESTS.find((m) => m.version === "mem-score-v3")
            .descriptorDigest,
        "0ff454d61bb41b640465bc77aad39f590f09413d9e46e32f1a8ba66fc2cd26dc"
    );
    assert.equal(result.entry.approvedOn, "2026-09-03");
    // Nothing outstanding that a dataset could satisfy. v3.3 split the one
    // pending rule: the gold-authoring half is enforced at review, and the
    // half about what a model emits is `prompt_pending`, which is reported by
    // `memoryEvalScoringContractPromptPending()` rather than counted against
    // a sample.
    assert.deepEqual(result.entry.pendingRules, []);
    assert.deepEqual(
        [...result.entry.pendingRules],
        [...memoryEvalScoringContractReadiness()],
        "the entry records rules outstanding at freeze; they are still the live ones"
    );
});

test("succ-2 still carries the digest run1's artifact was scored against", () => {
    // Written out rather than recomputed. This is the value in run
    // 32972243326's artifact and in the 2026-08-27 audit record, and a test
    // that recomputed it would agree with any tree at all.
    assert.equal(
        evalDatasetManifest("mem-eval-succ-2").datasetDigest,
        "60aa43f1cf8ea23b715d200b897abfb3bedb8a7fe7d352d2cf85b6a56be91e5c"
    );
});

/* --------------------------------------------------------- the records -- */

test("versions are unique and the supersession chain resolves", () => {
    const versions = MEMORY_EVAL_DATASET_MANIFESTS.map((m) => m.datasetVersion);
    assert.equal(new Set(versions).size, versions.length);
    for (const manifest of MEMORY_EVAL_DATASET_MANIFESTS) {
        if (manifest.supersedes === null) continue;
        assert.ok(
            versions.includes(manifest.supersedes),
            `${manifest.datasetVersion} supersedes ${manifest.supersedes}, which has no manifest`
        );
    }
    assert.equal(evalDatasetManifest("mem-eval-succ-99"), undefined);
});

test("batch case counts and cell counts add up to the recorded total", () => {
    for (const manifest of MEMORY_EVAL_DATASET_MANIFESTS) {
        const batched = manifest.batches.reduce((n, b) => n + b.caseCount, 0);
        const unbatched = manifest.unbatched?.caseCount ?? 0;
        assert.equal(
            batched + unbatched,
            manifest.caseCount,
            `${manifest.datasetVersion}: batches + unbatched != caseCount`
        );
        const cells = Object.values(manifest.cellCounts).reduce((a, b) => a + b, 0);
        assert.equal(cells, manifest.caseCount);
    }
});

test("every recorded cell is at or above its §12.2 floor", () => {
    for (const manifest of MEMORY_EVAL_DATASET_MANIFESTS) {
        for (const category of MEMORY_EVAL_CATEGORIES) {
            for (const language of MEMORY_EVAL_LANGUAGES) {
                const cell = `${category}:${language}`;
                assert.ok(
                    (manifest.cellCounts[cell] ?? 0) >=
                        MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM[category],
                    `${manifest.datasetVersion} ${cell} is below its floor`
                );
            }
        }
    }
});

/* ------------------------------------------------ the checker's teeth --- */

test("a missing batch is reported", () => {
    const result = verify("mem-eval-succ-2", {
        ...COMPOSITIONS["mem-eval-succ-2"],
        batches: SUCCESSOR_ADOPTED_BATCHES.slice(0, -1),
        cases: MEMORY_EVAL_SUCCESSOR_CASES,
    });
    assert.ok(result.mismatches.some((line) => line.includes("batch-132")));
});

test("a batch whose cases changed is reported by digest, not only by count", () => {
    const [first, ...rest] = SUCCESSOR_ADOPTED_BATCHES;
    const edited = {
        ...first,
        // Same count, one gold token changed: the count check cannot see this.
        cases: first.cases.map((testCase, index) =>
            index !== 0
                ? testCase
                : {
                      ...testCase,
                      expected: testCase.expected.map((expected, i) =>
                          i === 0
                              ? { ...expected, mustInclude: ["something else"] }
                              : expected
                      ),
                  }
        ),
    };
    const result = verify("mem-eval-succ-2", {
        ...COMPOSITIONS["mem-eval-succ-2"],
        batches: [edited, ...rest],
    });
    assert.ok(result.mismatches.some((line) => line.includes(`${first.id}: digest`)));
});

test("a case that drifted out of its cell is reported", () => {
    const cases = MEMORY_EVAL_SUCCESSOR_CASES.map((testCase, index) =>
        index === 0 ? { ...testCase, language: "en" } : testCase
    );
    const result = verify("mem-eval-succ-2", {
        ...COMPOSITIONS["mem-eval-succ-2"],
        cases,
    });
    assert.ok(result.mismatches.some((line) => line.startsWith("durable_facts:")));
    assert.ok(result.mismatches.some((line) => line.startsWith("dataset digest:")));
});

test("a case belonging to no batch is reported", () => {
    const stray = {
        ...MEMORY_EVAL_SUCCESSOR_CASES[0],
        id: "succ-stray-1",
    };
    const result = verify("mem-eval-succ-2", {
        ...COMPOSITIONS["mem-eval-succ-2"],
        cases: [...MEMORY_EVAL_SUCCESSOR_CASES, stray],
    });
    assert.ok(
        result.mismatches.some((line) => line.includes("belong to no batch")),
        result.mismatches.join("\n")
    );
});

test("seed-11's unbatched seed cases are checked, not waved through", () => {
    const manifest = evalDatasetManifest("mem-eval-seed-11");
    assert.equal(manifest.unbatched.caseCount, 32);

    const batched = new Set(
        ADOPTED_BATCHES.flatMap((batch) => batch.cases.map((c) => c.id))
    );
    const seedIndex = MEMORY_EVAL_CASES.findIndex((c) => !batched.has(c.id));
    const cases = MEMORY_EVAL_CASES.map((testCase, index) =>
        index !== seedIndex
            ? testCase
            : { ...testCase, expected: [] }
    );
    const result = verify("mem-eval-seed-11", {
        ...COMPOSITIONS["mem-eval-seed-11"],
        cases,
    });
    assert.ok(result.mismatches.some((line) => line.startsWith("unbatched digest:")));
});

test("a schema mismatch between manifest and composition is reported", () => {
    const result = verify("mem-eval-succ-2", {
        ...COMPOSITIONS["mem-eval-succ-2"],
        schemaVersion: 1,
    });
    assert.ok(result.mismatches.some((line) => line.startsWith("schema version:")));
});
