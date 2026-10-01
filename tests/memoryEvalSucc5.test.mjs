/**
 * `mem-eval-succ-5`, and the four ways a contract-only successor stops being
 * one.
 *
 * The version exists because `mem-score-v3.3` describes itself as scoring
 * schema 2 while scoring schema 3, and its digest is pinned in four places, so
 * the correction had to be forward-only (@mposition, 2026-08-28). That makes
 * this dataset's whole claim a pair of negatives — the sample did not change,
 * and the contract did — and neither is visible in the case list. So both are
 * asserted here, along with the record that says a human agreed to it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
    MEMORY_EVAL_SUCC5_APPROVAL,
    MEMORY_EVAL_SUCC5_CASES,
    MEMORY_EVAL_SUCC5_CHANGE_REASON,
    MEMORY_EVAL_SUCC5_MANIFEST,
    MEMORY_EVAL_SUCC5_SUPERSEDES,
    buildSucc5Manifest,
    succ5ManifestFingerprintInput,
    verifySucc5Manifest,
} from "../lib/memoryEvalSucc5.ts";
import {
    MEMORY_EVAL_SUCC4_MANIFEST,
} from "../lib/memoryEvalSucc4Manifest.ts";
import { MEMORY_EVAL_SUCC4_CASES } from "../lib/memoryEvalSucc4Dataset.ts";
import { datasetFingerprintInputV3 } from "../lib/memoryEvalDatasetSchemaV3.ts";
import { MEMORY_EVAL_SCORING_CONTRACT_VERSION } from "../lib/memoryEvalScoringContractDigest.ts";

test("the recorded manifest recomputes from the tree", () => {
    assert.deepEqual([...verifySucc5Manifest()], []);
});

test("the sample is succ-4's, case for case and by digest", () => {
    // Not by array identity. The module graph can hold two instances of a
    // module reached by two specifiers — `@/lib/...` from source and
    // `../lib/...` from a test — and an assertion that passed or failed on
    // that would be testing the loader. The fingerprint is the claim the
    // manifest actually makes, so it is the claim asserted.
    assert.equal(MEMORY_EVAL_SUCC5_CASES.length, MEMORY_EVAL_SUCC4_CASES.length);
    assert.equal(
        datasetFingerprintInputV3(MEMORY_EVAL_SUCC5_CASES),
        datasetFingerprintInputV3(MEMORY_EVAL_SUCC4_CASES)
    );
    assert.equal(MEMORY_EVAL_SUCC5_CASES.length, 1150);
    assert.equal(
        MEMORY_EVAL_SUCC5_MANIFEST.datasetDigest,
        MEMORY_EVAL_SUCC4_MANIFEST.datasetDigest
    );
    assert.equal(
        MEMORY_EVAL_SUCC5_MANIFEST.composition.sourceDatasetDigest,
        MEMORY_EVAL_SUCC5_MANIFEST.datasetDigest
    );
});

test("the contract did move, and says what it moved from", () => {
    assert.equal(MEMORY_EVAL_SUCC5_SUPERSEDES, "mem-eval-succ-4");
    assert.equal(MEMORY_EVAL_SUCC5_CHANGE_REASON, "contract descriptor correction");
    // The contract succ-5 was frozen under, which since 2026-09-03 is no
    // longer the one the tree ships. That is the correct relationship, not
    // drift: a frozen dataset records what scored it, and the Korean numeral
    // amendment (`mem-score-v3.5`) arrived after succ-5 was closed. This used
    // to be asserted equal to `MEMORY_EVAL_SCORING_CONTRACT_VERSION`, and
    // that coupling would have silently moved succ-5's manifest digest at the
    // bump — the failure the recorded binding exists to prevent.
    assert.equal(MEMORY_EVAL_SUCC5_MANIFEST.scoringContractVersion, "mem-score-v3.4");
    assert.notEqual(
        MEMORY_EVAL_SUCC5_MANIFEST.scoringContractVersion,
        MEMORY_EVAL_SCORING_CONTRACT_VERSION
    );
    assert.notEqual(
        MEMORY_EVAL_SUCC5_MANIFEST.scoringContractDigest,
        MEMORY_EVAL_SUCC4_MANIFEST.scoringContractDigest
    );
    // The superseded pair is carried, not dropped: an artifact scored under
    // v3.3 has to stay resolvable, and the record of what was corrected is
    // half of what makes this a correction rather than a new dataset.
    assert.equal(
        MEMORY_EVAL_SUCC5_MANIFEST.composition.supersededScoringContractVersion,
        "mem-score-v3.3"
    );
    assert.equal(
        MEMORY_EVAL_SUCC5_MANIFEST.composition.supersededScoringContractDigest,
        "19f4e4f9d5976382d83a03153ef8e7fb52b3f6dd6104efa54f53ef05cd82f777"
    );
});

test("a contract that did not move is refused as a successor", () => {
    // The degenerate case: a version that supersedes its predecessor and
    // changes nothing. It would pass every digest check, because every digest
    // would agree.
    const built = buildSucc5Manifest();
    const unchanged = {
        ...built,
        scoringContractDigest: MEMORY_EVAL_SUCC4_MANIFEST.scoringContractDigest,
    };
    const failures = verifySucc5Manifest(unchanged);
    assert.ok(
        failures.some((line) => line.includes("corrected nothing")),
        failures.join(" | ")
    );
});

test("a sample that moved is refused as a contract-only successor", () => {
    const built = buildSucc5Manifest();
    const drifted = { ...built, datasetDigest: "f".repeat(64) };
    const failures = verifySucc5Manifest(drifted);
    assert.ok(
        failures.some((line) => line.includes("is not one")),
        failures.join(" | ")
    );
});

test("the manifest digest covers the manifest, and not itself", () => {
    // succ-4 needs no such field; succ-5 does, because its dataset digest is
    // deliberately unchanged and so cannot be what distinguishes the two
    // records. Without this the claim "the manifest is new" would rest on the
    // version string.
    const built = buildSucc5Manifest();
    assert.equal(built.manifestDigest, MEMORY_EVAL_SUCC5_MANIFEST.manifestDigest);
    assert.match(built.manifestDigest, /^[0-9a-f]{64}$/);

    const { manifestDigest, ...withoutDigest } = built;
    const input = succ5ManifestFingerprintInput(withoutDigest);
    assert.ok(!input.includes(manifestDigest), "the digest covers itself");
    for (const fragment of [
        `datasetDigest=${built.datasetDigest}`,
        `scoringContractDigest=${built.scoringContractDigest}`,
        `changeReason=${built.composition.changeReason}`,
        `supersedes=${built.supersedes}`,
    ]) {
        assert.ok(input.includes(fragment), `the fingerprint drops ${fragment}`);
    }
});

test("the human record says contract-only, and is filled in", () => {
    // A successor that inherits its cases carries no case-level review, and
    // this record must not be mistaken for one. succ-4's adoption is where
    // the 1,150 cases were judged, and it is referenced rather than restated.
    assert.equal(MEMORY_EVAL_SUCC5_APPROVAL.scope, "contract-only");
    assert.equal(MEMORY_EVAL_SUCC5_APPROVAL.approvedBy, "@mposition");
    assert.match(MEMORY_EVAL_SUCC5_APPROVAL.approvedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(MEMORY_EVAL_SUCC5_APPROVAL.record.length > 0);
});
