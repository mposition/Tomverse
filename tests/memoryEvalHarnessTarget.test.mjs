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
import { MEMORY_EVAL_SUCC5_MANIFEST } from "../lib/memoryEvalSucc5.ts";

test("the harness target is the frozen schema-3 set", () => {
    assert.equal(HARNESS_TARGET_DATASET_VERSION, "mem-eval-succ-6");
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
    //
    // The dataset digest moved on 2026-08-31 and this is the first time it
    // has: succ-5 was a contract-only successor sharing succ-4's cases, so
    // all three of them recorded `0a516821…`. succ-6 replaced thirteen cases,
    // so a digest that still read `0a516821…` here would mean the harness was
    // pointed at the old sample under the new name.
    const target = harnessTarget();
    assert.equal(
        target.datasetDigest,
        "2ffc8c09d6a20c2ad150d222fd71b891bf160b6c26b4d27684708ccbcf20fb63"
    );
    assert.equal(
        target.scoringContractDigest,
        "a62f4bdd8d2073345e19e478541c20d81275a0d11fb78aa6e4df86ec0489b4cd"
    );
    assert.equal(target.scoringContractVersion, "mem-score-v3.4");
    assert.deepEqual([...harnessTargetBindingFailures(target)], []);
});

test("succ-5 stays resolvable by name, with its own sample", () => {
    // The historical path. The 2026-08-29 decision-grade run was scored
    // against succ-5, and its artifact has to stay readable — which means
    // succ-5 must keep resolving to its own 1,150 cases and its own digest,
    // not to whatever the default target has since become.
    const succ5 = harnessTarget("mem-eval-succ-5");
    assert.equal(succ5.datasetVersion, "mem-eval-succ-5");
    assert.equal(succ5.cases.length, 1150);
    assert.equal(
        succ5.datasetDigest,
        "0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0"
    );
    assert.equal(succ5.scoringContractVersion, "mem-score-v3.4");
    assert.equal(succ5.datasetDigest, MEMORY_EVAL_SUCC5_MANIFEST.datasetDigest);
    // And it is not the default any more, which is the other half of the
    // switch: a test that only checked succ-5 still resolves would pass with
    // the harness never having moved.
    assert.notEqual(HARNESS_TARGET_DATASET_VERSION, "mem-eval-succ-5");
    assert.notEqual(succ5.datasetDigest, harnessTarget().datasetDigest);
});

test("succ-6's manifest is what the binding resolves against", () => {
    // `targetManifestDigests` reads the pinned record. The target recomputes
    // from the tree. Their agreement is the binding, and it is the reason the
    // manifest had to be a literal rather than a computed view.
    const recorded = targetManifestDigests("mem-eval-succ-6");
    assert.ok(recorded, "succ-6 has no resolvable manifest");
    assert.equal(
        recorded.datasetDigest,
        "2ffc8c09d6a20c2ad150d222fd71b891bf160b6c26b4d27684708ccbcf20fb63"
    );
    assert.equal(recorded.scoringContractVersion, "mem-score-v3.4");
    assert.deepEqual([...harnessTargetBindingFailures(harnessTarget())], []);
});

test("succ-4 keeps its cases and stops being a run target", () => {
    // Both halves matter. The sample is identical, which is what makes succ-5
    // a contract-only successor; and the binding check refuses succ-4 anyway,
    // because it is bound to `mem-score-v3.3` — a contract that describes
    // itself as scoring schema 2 while scoring schema 3, kept as evidence
    // rather than repaired in place (@mposition, 2026-08-28).
    const succ4 = harnessTarget("mem-eval-succ-4");
    const succ5 = harnessTarget("mem-eval-succ-5");
    assert.equal(succ4.datasetDigest, succ5.datasetDigest);
    assert.equal(succ4.cases.length, succ5.cases.length);
    assert.notEqual(succ4.scoringContractDigest, succ5.scoringContractDigest);

    const failures = harnessTargetBindingFailures(succ4);
    assert.equal(failures.length, 1, failures.join(" | "));
    assert.match(failures[0], /mem-score-v3\.3.*superseded contract is evidence/s);
});

test("the manifest is where those values come from, not a second copy", () => {
    const recorded = targetManifestDigests("mem-eval-succ-5");
    assert.equal(recorded.datasetDigest, MEMORY_EVAL_SUCC5_MANIFEST.datasetDigest);
    assert.equal(
        recorded.scoringContractDigest,
        MEMORY_EVAL_SUCC5_MANIFEST.scoringContractDigest
    );
    const superseded = targetManifestDigests("mem-eval-succ-4");
    assert.equal(
        superseded.scoringContractDigest,
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
