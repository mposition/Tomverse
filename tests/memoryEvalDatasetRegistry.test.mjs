import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
    EVAL_DATASET_COMPOSITIONS,
    MEMORY_EVAL_ARTIFACT_SCHEMA,
    resolveArtifactDataset,
} from "../lib/memoryEvalDatasetRegistry.ts";
import {
    MEMORY_EVAL_DATASET_MANIFESTS,
    evalDatasetManifest,
} from "../lib/memoryEvalDatasetManifests.ts";

/**
 * A wrong answer here is the worst kind available: the report would classify
 * one run's answers against another run's gold labels and read as confident.
 * So every refusal is asserted by name, and the one case that must NOT be a
 * refusal — an artifact written before `scoringContractDigest` existed — is
 * asserted hardest. Refusing that would destroy the capability the manifest
 * work exists to keep.
 */

const succ2 = evalDatasetManifest("mem-eval-succ-2");
const seed11 = evalDatasetManifest("mem-eval-seed-11");

/** An artifact as run1 wrote one: no `artifactSchema`, no contract digest. */
const historical = (overrides = {}) => ({
    datasetVersion: succ2.datasetVersion,
    datasetDigest: succ2.datasetDigest,
    commitSha: "f6c60491",
    mode: "live",
    ...overrides,
});

/** An artifact as the harness writes one now. */
const current = (overrides = {}) => ({
    artifactSchema: MEMORY_EVAL_ARTIFACT_SCHEMA,
    datasetVersion: succ2.datasetVersion,
    datasetDigest: succ2.datasetDigest,
    scoringContractDigest: succ2.scoringContractDigest,
    scoringContractVersion: succ2.scoringContractVersion,
    commitSha: "f6c60491",
    mode: "live",
    ...overrides,
});

const refusal = (artifactManifest) => {
    const result = resolveArtifactDataset(artifactManifest);
    assert.equal(result.ok, false, "expected a refusal");
    assert.ok(result.detail.length > 40, "a refusal has to be actionable");
    return result.reason;
};

/* ------------------------------------------------------ the happy paths -- */

test("run1's artifact still resolves, with no contract digest of its own", () => {
    // The regression this whole module exists to prevent. Before it, the
    // report imported one dataset and refused everything else.
    const result = resolveArtifactDataset(historical());
    assert.equal(result.ok, true);
    assert.equal(result.manifest.datasetVersion, "mem-eval-succ-2");
    assert.equal(result.scoringContract, "absent_historical");
    assert.equal(result.artifactSchema, 1);
    assert.equal(result.composition.cases.length, 1150);
});

test("a current artifact resolves with its contract digest verified", () => {
    const result = resolveArtifactDataset(current());
    assert.equal(result.ok, true);
    assert.equal(result.scoringContract, "verified");
    assert.equal(result.artifactSchema, MEMORY_EVAL_ARTIFACT_SCHEMA);
});

test("a schema-1 artifact resolves against seed-11", () => {
    const result = resolveArtifactDataset({
        datasetVersion: seed11.datasetVersion,
        datasetDigest: seed11.datasetDigest,
        mode: "live",
    });
    assert.equal(result.ok, true);
    assert.equal(result.composition.schemaVersion, 1);
    assert.equal(result.scoringContract, "absent_historical");
});

test("every manifest with a composition resolves from its own recorded digest", () => {
    for (const manifest of MEMORY_EVAL_DATASET_MANIFESTS) {
        if (!EVAL_DATASET_COMPOSITIONS[manifest.datasetVersion]) continue;
        const result = resolveArtifactDataset({
            datasetVersion: manifest.datasetVersion,
            datasetDigest: manifest.datasetDigest,
        });
        assert.equal(
            result.ok,
            true,
            `${manifest.datasetVersion} does not resolve: ${result.detail ?? ""}`
        );
    }
});

/* ---------------------------------------------------------- refusals ----- */

test("an artifact with no version or no digest is refused", () => {
    assert.equal(refusal(null), "no_dataset_version");
    assert.equal(refusal({}), "no_dataset_version");
    assert.equal(
        refusal({ datasetVersion: "mem-eval-succ-2" }),
        "no_dataset_digest"
    );
    // A version string alone is not identity.
    assert.equal(
        refusal({ datasetVersion: "mem-eval-succ-2", datasetDigest: "" }),
        "no_dataset_digest"
    );
});

test("an unregistered version is refused rather than guessed at", () => {
    // The placeholder is a version that will never exist, not the next one.
    // This read `mem-eval-succ-9` until that dataset was assembled, at which
    // point the case stopped testing the refusal it is named for and started
    // reporting `digest_mismatch` — a real version is a hostage to the day
    // somebody builds it.
    assert.equal(
        refusal(historical({ datasetVersion: "mem-eval-succ-99" })),
        "unregistered_version"
    );
});

test("a digest that belongs to another version is refused", () => {
    // Says succ-2, carries seed-11's digest. Either is possible; guessing
    // which would put the wrong gold labels behind every line.
    assert.equal(
        refusal(historical({ datasetDigest: seed11.datasetDigest })),
        "digest_belongs_elsewhere"
    );
});

test("a digest belonging to nothing is refused as a mismatch", () => {
    assert.equal(refusal(historical({ datasetDigest: "f".repeat(64) })), "digest_mismatch");
});

test("a contract digest that disagrees with the manifest is refused", () => {
    // The point of the second digest: these two artifacts agree on the
    // dataset digest and were scored on different labels.
    assert.equal(
        refusal(current({ scoringContractDigest: "a".repeat(64) })),
        "scoring_contract_mismatch"
    );
});

test("a current artifact that lost its contract digest is refused, not read as historical", () => {
    const withoutDigest = current();
    delete withoutDigest.scoringContractDigest;
    assert.equal(refusal(withoutDigest), "scoring_contract_missing");
});

test("a version with a manifest but no cases in the tree is refused", () => {
    // Simulated by resolving a version the compositions map does not carry.
    // The real case is a dataset removed from the tree while its record stays.
    const orphan = MEMORY_EVAL_DATASET_MANIFESTS.find(
        (manifest) => !EVAL_DATASET_COMPOSITIONS[manifest.datasetVersion]
    );
    if (!orphan) {
        // Every recorded dataset is currently in the tree, which is the state
        // we want. Assert the branch's precondition instead of skipping.
        assert.equal(
            Object.keys(EVAL_DATASET_COMPOSITIONS).length,
            MEMORY_EVAL_DATASET_MANIFESTS.length
        );
        return;
    }
    assert.equal(
        refusal({
            datasetVersion: orphan.datasetVersion,
            datasetDigest: orphan.datasetDigest,
        }),
        "dataset_not_in_tree"
    );
});

/* ------------------------------------------- the harness writes both ----- */

test("the harness stamps the schema and both digests", () => {
    // Read as source rather than executed: running the harness reaches a
    // provider gate. What matters is that the manifest it builds names all
    // three fields, because a reader refuses a current artifact without them.
    const source = readFileSync("scripts/evalImportedMemoryExtraction.mjs", "utf8");
    assert.match(source, /artifactSchema: MEMORY_EVAL_ARTIFACT_SCHEMA/);
    assert.match(source, /^\s+datasetDigest,$/m);
    assert.match(source, /^\s+scoringContractDigest,$/m);
    assert.match(
        source,
        /scoringContractVersion: MEMORY_EVAL_SCORING_CONTRACT_VERSION/
    );
});

test("the artifact readers select by lookup, not by import", () => {
    // A consumer that imports one dataset refuses every other version, which
    // is how a preserved dataset becomes unreadable.
    for (const path of [
        "scripts/report-memory-eval-failures.mjs",
        "scripts/make-memory-eval-blind-review.mjs",
    ]) {
        const source = readFileSync(path, "utf8");
        assert.match(source, /resolveArtifactDataset/, `${path} does not resolve`);
        assert.doesNotMatch(
            source,
            /MEMORY_EVAL_SUCCESSOR_CASES/,
            `${path} still imports one dataset directly`
        );
    }
});
