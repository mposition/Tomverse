/**
 * Resolving a schema-3 artifact, and refusing the four ways it can be wrong.
 *
 * The schema-1/2 path is tested next door and is untouched by this arm — that
 * separation is the point, and one of the assertions here is that resolving a
 * schema-3 artifact does not disturb it.
 *
 * .github/audits/memory-eval-gold-contract-2026-08-27.md §10.2.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
    MEMORY_EVAL_ARTIFACT_SCHEMA,
    MEMORY_EVAL_SUPPORTED_DATASET_SCHEMAS,
    resolveArtifactDataset,
} from "../lib/memoryEvalDatasetRegistry.ts";
import {
    MEMORY_EVAL_SUCC4_MANIFEST,
} from "../lib/memoryEvalSucc4Manifest.ts";
import { MEMORY_EVAL_SUCC4_CASES } from "../lib/memoryEvalSucc4Dataset.ts";
import { MEMORY_EVAL_DATASET_MANIFESTS } from "../lib/memoryEvalDatasetManifests.ts";

const succ4Artifact = (overrides = {}) => ({
    artifactSchema: MEMORY_EVAL_ARTIFACT_SCHEMA,
    datasetVersion: MEMORY_EVAL_SUCC4_MANIFEST.datasetVersion,
    datasetSchemaVersion: 3,
    datasetDigest: MEMORY_EVAL_SUCC4_MANIFEST.datasetDigest,
    scoringContractDigest: MEMORY_EVAL_SUCC4_MANIFEST.scoringContractDigest,
    scoringContractVersion: MEMORY_EVAL_SUCC4_MANIFEST.scoringContractVersion,
    commitSha: "0".repeat(40),
    ...overrides,
});

test("a well-formed schema-3 artifact resolves to the frozen cases", () => {
    const result = resolveArtifactDataset(succ4Artifact());
    assert.equal(result.ok, true, result.ok ? "" : result.detail);
    assert.equal(result.manifest.datasetVersion, "mem-eval-succ-4");
    assert.equal(result.manifest.schemaVersion, 3);
    assert.equal(result.composition.schemaVersion, 3);
    assert.equal(result.composition.cases.length, MEMORY_EVAL_SUCC4_CASES.length);
    assert.equal(result.scoringContract, "verified");
});

test("a schema-3 artifact with a stale dataset digest is refused", () => {
    const result = resolveArtifactDataset(
        succ4Artifact({ datasetDigest: "f".repeat(64) })
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "digest_mismatch");
});

test("a schema-3 artifact scored under another contract is refused", () => {
    // Under schema 3 the dataset digest already covers the labelling, so this
    // digest is the contract's own rules. A run scored under different ones is
    // not comparable, however identical the sample was.
    const result = resolveArtifactDataset(
        succ4Artifact({ scoringContractDigest: "a".repeat(64) })
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "scoring_contract_mismatch");
});

test("a schema-3 artifact with no contract digest is a defect, not history", () => {
    // There are no schema-3 artifacts older than the contract digest, so the
    // `absent_historical` reading that schema 1 and 2 need is not available
    // here — the field went missing rather than never existing.
    const result = resolveArtifactDataset(
        succ4Artifact({ scoringContractDigest: undefined })
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "scoring_contract_missing");
});

test("a dataset schema this tree cannot score is refused by name", () => {
    for (const datasetSchemaVersion of [4, 0, -1, 2.5, "3", "three", true]) {
        const result = resolveArtifactDataset(
            succ4Artifact({ datasetSchemaVersion })
        );
        assert.equal(result.ok, false, String(datasetSchemaVersion));
        assert.equal(
            result.reason,
            "unsupported_dataset_schema",
            String(datasetSchemaVersion)
        );
    }
    assert.deepEqual([...MEMORY_EVAL_SUPPORTED_DATASET_SCHEMAS], [1, 2, 3]);
});

test("an artifact claiming the wrong schema for its dataset is refused", () => {
    // Both directions: a schema-3 dataset called 2, and a schema-2 dataset
    // called 3. Each would put the wrong scorer behind every number.
    const asTwo = resolveArtifactDataset(
        succ4Artifact({ datasetSchemaVersion: 2 })
    );
    assert.equal(asTwo.ok, false);
    assert.equal(asTwo.reason, "dataset_schema_mismatch");

    const succ3 = MEMORY_EVAL_DATASET_MANIFESTS.find(
        (manifest) => manifest.datasetVersion === "mem-eval-succ-3"
    );
    assert.ok(succ3, "mem-eval-succ-3 is not registered");
    const asThree = resolveArtifactDataset({
        artifactSchema: 2,
        datasetVersion: succ3.datasetVersion,
        datasetSchemaVersion: 3,
        datasetDigest: succ3.datasetDigest,
        scoringContractDigest: succ3.scoringContractDigest,
    });
    assert.equal(asThree.ok, false);
    assert.equal(asThree.reason, "dataset_schema_mismatch");
});

test("the schema-1/2 path is unchanged by the schema-3 arm", () => {
    // Every recorded artifact so far resolves through it, and the schema-3
    // work must not have moved so much as a refusal reason there.
    const succ3 = MEMORY_EVAL_DATASET_MANIFESTS.find(
        (manifest) => manifest.datasetVersion === "mem-eval-succ-3"
    );
    const result = resolveArtifactDataset({
        artifactSchema: 2,
        datasetVersion: succ3.datasetVersion,
        datasetDigest: succ3.datasetDigest,
        scoringContractDigest: succ3.scoringContractDigest,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.detail);
    assert.equal(result.manifest.schemaVersion, 2);
    assert.equal(result.composition.schemaVersion, 2);
    assert.equal(result.scoringContract, "verified");
});

test("an artifact that predates the field still resolves", () => {
    // `datasetSchemaVersion` exists so a disagreement is visible, not because
    // the schema was unknown before it. An artifact without it binds to the
    // manifest's recorded schema, which is the same answer.
    const result = resolveArtifactDataset(
        succ4Artifact({ datasetSchemaVersion: undefined })
    );
    assert.equal(result.ok, true, result.ok ? "" : result.detail);
    assert.equal(result.manifest.schemaVersion, 3);
});
