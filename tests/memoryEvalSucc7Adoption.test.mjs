/**
 * The succ-7 adoption: the signature, the freeze, and the pinned manifest.
 *
 * Each assertion here exists because the same mistake has been made once
 * already in this repository, and a check that cannot be shown to fail is not
 * evidence that anything passed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    MEMORY_EVAL_SUCC7_CASES,
    MEMORY_EVAL_SUCC7_DATASET_FROZEN,
    MEMORY_EVAL_SUCC7_MANIFEST,
    MEMORY_EVAL_SUCC7_REVIEW,
    MEMORY_EVAL_SUCC7_REVIEWED,
    buildSucc7DraftManifest,
    succ7SignatureProblems,
    verifySucc7Manifest,
} from "../lib/memoryEvalSucc7.ts";
import { HARNESS_TARGET_DATASET_VERSION } from "../lib/memoryEvalHarnessTarget.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the signed digests are the digests this tree holds", () => {
    assert.deepEqual([...succ7SignatureProblems()], []);
    const built = buildSucc7DraftManifest();
    assert.equal(
        MEMORY_EVAL_SUCC7_REVIEW.signedDatasetDigest,
        built.datasetDigest
    );
    assert.equal(
        MEMORY_EVAL_SUCC7_REVIEW.signedManifestDigest,
        built.manifestDigest
    );
    assert.equal(MEMORY_EVAL_SUCC7_REVIEW.reviewer, "@mposition");
    assert.equal(MEMORY_EVAL_SUCC7_REVIEW.reviewedAt, "2026-09-02");
    assert.equal(MEMORY_EVAL_SUCC7_REVIEWED, true);
});

test("a signature of a different dataset is refused", () => {
    // The case the record exists for: an edit lands after the review and keeps
    // the version number. If this passes, the signature is decoration.
    const problems = succ7SignatureProblems({
        ...MEMORY_EVAL_SUCC7_REVIEW,
        signedDatasetDigest: "0".repeat(64),
    });
    assert.ok(
        problems.some((line) => line.includes("the signature is of dataset")),
        problems.join(" | ")
    );
});

test("a verdict that did not pass everything is refused", () => {
    for (const verdict of [
        { ...MEMORY_EVAL_SUCC7_REVIEW.verdict, sameBoundaryPassed: 50 },
        { ...MEMORY_EVAL_SUCC7_REVIEW.verdict, problemCases: 3 },
        { ...MEMORY_EVAL_SUCC7_REVIEW.verdict, cellDiversitySufficient: false },
        { ...MEMORY_EVAL_SUCC7_REVIEW.verdict, coverageRepairGoldFit: false },
    ]) {
        const problems = succ7SignatureProblems({
            ...MEMORY_EVAL_SUCC7_REVIEW,
            verdict,
        });
        assert.ok(problems.length > 0, JSON.stringify(verdict));
    }
});

test("it is frozen, and the manifest is a literal rather than a view", () => {
    assert.equal(MEMORY_EVAL_SUCC7_DATASET_FROZEN, true);
    assert.equal(MEMORY_EVAL_SUCC7_MANIFEST.frozen, true);
    assert.deepEqual([...verifySucc7Manifest()], []);
    // Pinned, not computed. A computed record cannot disagree with the tree,
    // and disagreeing is the only thing a frozen record is for.
    const source = readFileSync(
        path.join(REPO, "lib/memoryEvalSucc7.ts"),
        "utf8"
    );
    const pin = source.slice(
        source.indexOf("export const MEMORY_EVAL_SUCC7_MANIFEST")
    );
    assert.ok(
        !pin.startsWith(
            "export const MEMORY_EVAL_SUCC7_MANIFEST: Succ7DraftManifest =\n    buildSucc7DraftManifest()"
        ),
        "the frozen manifest is still a computed view"
    );
    // The signed values, written out so an edit to any of them fails here and
    // not only inside a digest comparison.
    assert.equal(
        MEMORY_EVAL_SUCC7_MANIFEST.datasetDigest,
        "9326730a889d99008ca1c5709fcaaa4226f6031c25b9aced7b1fb26e46498251"
    );
    assert.equal(
        MEMORY_EVAL_SUCC7_MANIFEST.manifestDigest,
        "42c9b0a877086dc4767613e6b357d85ccba7ef40a67f7ff02d7d64b0ced91965"
    );
    assert.equal(
        MEMORY_EVAL_SUCC7_MANIFEST.composition.sourceDatasetDigest,
        "2ffc8c09d6a20c2ad150d222fd71b891bf160b6c26b4d27684708ccbcf20fb63"
    );
});

test("the pinned record notices a tree that moved under it", () => {
    // Handed the manifest a moved tree would produce, rather than editing a
    // file: the point is that the recorded side and the computed side are
    // genuinely two values.
    const built = buildSucc7DraftManifest();
    const failures = verifySucc7Manifest(MEMORY_EVAL_SUCC7_MANIFEST, {
        ...built,
        datasetDigest: "1".repeat(64),
    });
    assert.ok(
        failures.some((line) => line.startsWith("datasetDigest:")),
        failures.join(" | ")
    );
});

test("a successor whose sample did not move is refused", () => {
    const failures = verifySucc7Manifest({
        ...MEMORY_EVAL_SUCC7_MANIFEST,
        composition: {
            ...MEMORY_EVAL_SUCC7_MANIFEST.composition,
            sourceDatasetDigest: MEMORY_EVAL_SUCC7_MANIFEST.datasetDigest,
        },
    });
    assert.ok(
        failures.some((line) => line.includes("equals succ-6's")),
        failures.join(" | ")
    );
});

test("freezing did not move the digest that was signed", () => {
    // The reason `frozen` is outside the fingerprint: the digest a reviewer
    // signs has to be the digest that ends up frozen.
    const built = buildSucc7DraftManifest();
    assert.equal(built.frozen, true);
    assert.equal(
        built.manifestDigest,
        MEMORY_EVAL_SUCC7_REVIEW.signedManifestDigest
    );
});

test("adoption did not move the harness, and 1150 cases are still there", () => {
    // The signature covers the sample. Pointing the harness at it is a
    // separate decision that was not signed.
    assert.equal(HARNESS_TARGET_DATASET_VERSION, "mem-eval-succ-6");
    assert.equal(MEMORY_EVAL_SUCC7_CASES.length, 1150);
});
