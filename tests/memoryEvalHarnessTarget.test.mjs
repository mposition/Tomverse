/**
 * The harness's target, and the binding that makes a run citable.
 *
 * Five things have to agree for a run to mean anything: the cases, the
 * scorer, the fingerprint function, the dataset digest and the contract
 * digest. They used to be five imports pinned to one dataset, and adding a
 * second schema that way is five edits that must move together with nothing
 * checking that they did. The failure is silent — a schema-3 sample
 * fingerprinted by the schema-2 function produces a digest matching no
 * manifest, which reads as "the dataset was edited".
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
    HARNESS_TARGET_DATASET_VERSION,
    harnessTarget,
    harnessTargetBindingFailures,
    targetManifestDigests,
} from "../lib/memoryEvalHarnessTarget.ts";
import { MEMORY_EVAL_SUCC4_MANIFEST } from "../lib/memoryEvalSucc4Manifest.ts";

test("the harness target is the frozen schema-3 set", () => {
    assert.equal(HARNESS_TARGET_DATASET_VERSION, "mem-eval-succ-4");
    const target = harnessTarget();
    assert.equal(target.datasetSchemaVersion, 3);
    assert.equal(target.datasetFrozen, true);
    assert.equal(target.datasetPurpose, "decision");
    assert.equal(target.cases.length, 1150);
});

test("its digests are the ones the manifest froze", () => {
    // The whole point of the binding. These are the values recorded in
    // docs/release-gates/evidence/memory-extraction-instrument-2026-08-28.md
    // and in the release-gate registry, and a run that computed anything else
    // would produce an artifact no reader could resolve.
    const target = harnessTarget();
    assert.equal(
        target.datasetDigest,
        "0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0"
    );
    assert.equal(
        target.scoringContractDigest,
        "19f4e4f9d5976382d83a03153ef8e7fb52b3f6dd6104efa54f53ef05cd82f777"
    );
    assert.equal(target.scoringContractVersion, "mem-score-v3.3");
    assert.deepEqual([...harnessTargetBindingFailures(target)], []);
});

test("the manifest is where those values come from, not a second copy", () => {
    const recorded = targetManifestDigests("mem-eval-succ-4");
    assert.equal(recorded.datasetDigest, MEMORY_EVAL_SUCC4_MANIFEST.datasetDigest);
    assert.equal(
        recorded.scoringContractDigest,
        MEMORY_EVAL_SUCC4_MANIFEST.scoringContractDigest
    );
});

test("a dataset frozen under an older contract reports the disagreement", () => {
    // `mem-eval-succ-3` was frozen under `mem-score-v2.3` and this tree ships
    // v3.3, so the tree can no longer compute the contract digest its manifest
    // records. That is exactly what the binding check is for, and it is the
    // reason the harness had to move rather than stay: a run against succ-3
    // now would write an artifact whose contract digest matches no record.
    const target = harnessTarget("mem-eval-succ-3");
    assert.equal(target.datasetSchemaVersion, 2);
    const failures = harnessTargetBindingFailures(target);
    assert.ok(failures.length > 0, "succ-3 must not bind under mem-score-v3.3");
    assert.ok(
        failures.some((line) => line.includes("scoring contract version")),
        failures.join(" | ")
    );
    assert.ok(
        !failures.some((line) => line.includes("dataset digest")),
        `the sample itself is unchanged: ${failures.join(" | ")}`
    );
});

test("an unknown dataset throws rather than defaulting", () => {
    // The fail-closed direction. The caller is about to choose a fingerprint
    // function and a scorer, and there is no answer to "which ones" that is
    // safer than stopping.
    assert.throws(
        () => harnessTarget("mem-eval-succ-99"),
        /no target for mem-eval-succ-99/
    );
    assert.equal(targetManifestDigests("mem-eval-succ-99"), null);
});
