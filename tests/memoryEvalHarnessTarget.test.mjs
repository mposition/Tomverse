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
    harnessRunTuple,
    harnessTarget,
    harnessTargetBindingFailures,
    targetManifestDigests,
} from "../lib/memoryEvalHarnessTarget.ts";
import { MEMORY_EVAL_SUCC4_MANIFEST } from "../lib/memoryEvalSucc4Manifest.ts";
import { MEMORY_EVAL_SUCC5_MANIFEST } from "../lib/memoryEvalSucc5.ts";
import { MEMORY_EVAL_SUCC7_MANIFEST, MEMORY_EVAL_SUCC7_REVIEW } from "../lib/memoryEvalSucc7.ts";
import {
    MEMORY_EVAL_SUCC8_DATASET_FROZEN,
    buildSucc8Manifest,
} from "../lib/memoryEvalSucc8.ts";
import { evalBudgetTupleFailures } from "../lib/memoryEvalBudgetBinding.ts";
import { datasetFingerprintInputV3 } from "../lib/memoryEvalDatasetSchemaV3.ts";
import { datasetFingerprintInputV4 } from "../lib/memoryEvalDatasetFingerprintV4.ts";
import { createHash } from "node:crypto";

const sha256 = (input) => createHash("sha256").update(input, "utf8").digest("hex");

test("the harness target is the schema-3 set the live contract scores", () => {
    assert.equal(HARNESS_TARGET_DATASET_VERSION, "mem-eval-succ-8");
    const target = harnessTarget();
    assert.equal(target.datasetSchemaVersion, 3);
    assert.equal(target.datasetPurpose, "decision");
    assert.equal(target.cases.length, 1150);
    // Not frozen, and that is a statement about where succ-8 is rather than
    // an omission: it is a contract-only successor created on 2026-09-03 and
    // nobody has signed its digest yet. `decideEvalRunMode()` refuses a paid
    // run against it for exactly this reason, which is the intended state
    // until a signature exists.
    assert.equal(target.datasetFrozen, false);
    assert.equal(target.datasetFrozen, MEMORY_EVAL_SUCC8_DATASET_FROZEN);
});

test("its digests are the ones the manifest records", () => {
    // The whole point of the binding. A run that computed anything else would
    // produce an artifact no reader could resolve.
    //
    // succ-8 shares succ-7's cases by reference, so the dataset digest is
    // succ-7's — and that identity is the claim a contract-only successor
    // makes. What differs is the contract, and therefore the manifest.
    const target = harnessTarget();
    assert.equal(
        target.datasetDigest,
        "9326730a889d99008ca1c5709fcaaa4226f6031c25b9aced7b1fb26e46498251"
    );
    assert.equal(
        target.datasetManifestDigest,
        "16613ddbed2d20f5836726012a6a2f8f3cd9307cd50606732cdee12222dd273c"
    );
    assert.equal(
        target.scoringContractDigest,
        "fa32bcfc87aa9203ff05a3e608f01562e3c396ea403b0054226122778fa3cc93"
    );
    assert.equal(target.scoringContractVersion, "mem-score-v3.5");
    assert.deepEqual([...harnessTargetBindingFailures(target)], []);
    // Both halves of the successor claim, asserted against succ-7's own
    // records rather than restated: the sample did not move, the manifest
    // did. Either one alone would be satisfied by a mistake — an unchanged
    // manifest would mean the contract bump never reached the target, and a
    // changed dataset digest would mean the cases were not inherited.
    assert.equal(target.datasetDigest, MEMORY_EVAL_SUCC7_REVIEW.signedDatasetDigest);
    assert.notEqual(
        target.datasetManifestDigest,
        MEMORY_EVAL_SUCC7_REVIEW.signedManifestDigest
    );
    assert.equal(target.datasetManifestDigest, buildSucc8Manifest().manifestDigest);
    assert.notEqual(
        target.scoringContractDigest,
        MEMORY_EVAL_SUCC7_MANIFEST.scoringContractDigest
    );
});

test("succ-8 is fingerprinted with v4, not succ-6's v3", () => {
    // The move's own failure mode. succ-7's manifest recorded a v4 digest —
    // v3 omits `conversation.title`, which the prompt sends — and succ-8
    // inherits it, so a target hashing it with v3 would compute a digest the
    // manifest never recorded and refuse the dataset for a difference this
    // module invented.
    const target = harnessTarget();
    assert.equal(
        target.datasetDigest,
        sha256(datasetFingerprintInputV4(target.cases))
    );
    assert.notEqual(
        target.datasetDigest,
        sha256(datasetFingerprintInputV3(target.cases))
    );
});

test("the run tuple describes succ-8, and a budget for succ-7 is refused", () => {
    // The tuple is what a budget is bound to, so pointing the harness at a new
    // dataset has to move it. It used to name succ-5's manifest directly,
    // which meant a moved target left the tuple describing the old dataset and
    // the mismatch only surfaced as a refusal at spend time.
    const tuple = harnessRunTuple({
        promptVersion: "mem-extract-v7",
        promptDigest: "a".repeat(64),
    });
    assert.equal(tuple.datasetVersion, "mem-eval-succ-8");
    assert.equal(
        tuple.datasetDigest,
        "9326730a889d99008ca1c5709fcaaa4226f6031c25b9aced7b1fb26e46498251"
    );
    assert.equal(
        tuple.datasetManifestDigest,
        "16613ddbed2d20f5836726012a6a2f8f3cd9307cd50606732cdee12222dd273c"
    );
    assert.equal(tuple.scoringContractVersion, "mem-score-v3.5");

    // A budget bound to exactly this run passes, and one bound to the previous
    // dataset does not — without the second half the first proves nothing.
    assert.deepEqual([...evalBudgetTupleFailures({ ...tuple }, tuple)], []);
    const stale = evalBudgetTupleFailures(
        {
            ...tuple,
            datasetVersion: "mem-eval-succ-7",
            datasetManifestDigest: MEMORY_EVAL_SUCC7_MANIFEST.manifestDigest,
        },
        tuple
    );
    assert.equal(stale.length, 2, stale.join(" | "));
    assert.match(
        stale.find((line) => line.startsWith("datasetVersion")),
        /approved mem-eval-succ-7.*would use mem-eval-succ-8/
    );
    // succ-7 and succ-8 share a dataset digest, so the version and the
    // manifest are the only two terms that can tell them apart. A tuple check
    // that compared digests alone would have let a succ-7 budget fund a
    // succ-8 run — which is a run under a contract nobody approved.
    assert.ok(
        stale.some((line) => line.startsWith("datasetManifestDigest")),
        stale.join(" | ")
    );
    assert.ok(
        !stale.some((line) => line.startsWith("datasetDigest:")),
        `the sample is shared by reference: ${stale.join(" | ")}`
    );
});

test("succ-6 stays resolvable by name, with its own sample", () => {
    // The same historical guarantee succ-5 has. The 2026-09-01 decision-grade
    // run against `mem-extract-v7` was scored on succ-6, and its artifact has
    // to stay readable.
    const succ6 = harnessTarget("mem-eval-succ-6");
    assert.equal(succ6.datasetVersion, "mem-eval-succ-6");
    assert.equal(succ6.cases.length, 1150);
    assert.equal(
        succ6.datasetDigest,
        "2ffc8c09d6a20c2ad150d222fd71b891bf160b6c26b4d27684708ccbcf20fb63"
    );
    // Resolvable, and no longer runnable: succ-6 is bound to `mem-score-v3.4`
    // and the tree ships `mem-score-v3.5`. Reading an artifact scored under it
    // and starting a new run against it are different acts, and only the first
    // one survives a contract bump.
    const failures = [...harnessTargetBindingFailures(succ6)];
    assert.equal(failures.length, 1, failures.join(" | "));
    assert.match(failures[0], /mem-score-v3\.4.*superseded contract is evidence/s);
    assert.equal(succ6.scoringContractVersion, "mem-score-v3.4");
    assert.notEqual(HARNESS_TARGET_DATASET_VERSION, "mem-eval-succ-6");
    assert.notEqual(succ6.datasetDigest, harnessTarget().datasetDigest);
});

test("succ-7 stays resolvable by name, and is no longer a run target", () => {
    // succ-7 was frozen and signed on 2026-09-03 and never ran. It is kept
    // resolvable because the signature and the manifest are records, and it
    // stops being runnable the same day for the same reason succ-6 did: the
    // Korean numeral amendment moved the contract underneath it.
    //
    // succ-8 is what carries these cases forward, and the two halves below are
    // what make it a contract-only successor rather than a new dataset.
    const succ7 = harnessTarget("mem-eval-succ-7");
    assert.equal(succ7.datasetVersion, "mem-eval-succ-7");
    assert.equal(succ7.cases.length, 1150);
    assert.equal(succ7.datasetDigest, harnessTarget().datasetDigest);
    assert.notEqual(
        succ7.datasetManifestDigest,
        harnessTarget().datasetManifestDigest
    );
    assert.equal(
        succ7.datasetManifestDigest,
        MEMORY_EVAL_SUCC7_MANIFEST.manifestDigest
    );
    const failures = [...harnessTargetBindingFailures(succ7)];
    assert.equal(failures.length, 1, failures.join(" | "));
    assert.match(failures[0], /mem-score-v3\.4.*superseded contract is evidence/s);
    assert.notEqual(HARNESS_TARGET_DATASET_VERSION, "mem-eval-succ-7");
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
    // Bound to the contract it was frozen under, so the same superseded-
    // contract refusal applies to it as to succ-6 and succ-7.
    assert.equal([...harnessTargetBindingFailures(succ5)].length, 1);
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
    // And the live target binds, which is the half that says the record and
    // the tree still describe the same thing today.
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
