/**
 * `npm run report:memory-eval-failures -- --artifact=<path>`
 *
 * Reads a preserved decision-grade artifact and says which cases are behind
 * its numbers. See scripts/report-memory-eval-failures-core.mjs for what it
 * will and will not do; in short, it explains a verdict and never revises one.
 *
 * Calls no provider, so it cannot spend. That is the point of it being
 * separate from the run: reading an artifact should not cost what producing
 * one did.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { resolveArtifactDataset } from "@/lib/memoryEvalDatasetRegistry";
import {
    MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    scoringContractDescriptorInput,
} from "@/lib/memoryEvalScoringContractDigest";

const sha256 = (input) =>
    createHash("sha256").update(input, "utf8").digest("hex");

import {
    analyseArtifact,
    renderReport,
} from "./report-memory-eval-failures-core.mjs";

const argValue = (name) => {
    const prefix = `--${name}=`;
    const hit = process.argv.find((argument) => argument.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : "";
};

const artifactPath = argValue("artifact");
if (!artifactPath) {
    console.error(
        "Pass the artifact: --artifact=artifacts/mem-eval-run1.json\n" +
            "It is the file the run's upload step preserved, not the run's log."
    );
    process.exit(2);
}

const rawMaxRows = argValue("max-rows");
const maxRows =
    rawMaxRows === "all"
        ? null
        : rawMaxRows === ""
          ? 40
          : Number.parseInt(rawMaxRows, 10);
if (maxRows !== null && !(Number.isInteger(maxRows) && maxRows > 0)) {
    console.error("--max-rows takes a positive integer, or `all`.");
    process.exit(2);
}

let artifact;
try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
} catch (error) {
    console.error(`Could not read ${artifactPath}: ${error.message}`);
    process.exit(2);
}

/**
 * Which dataset this artifact was scored against — a lookup, not an import.
 *
 * The script used to import one dataset and compare. That refuses every
 * artifact from any other version, which after `mem-eval-succ-3` is wired
 * means refusing run1 forever while succ-2's cases sit in the tree unread.
 * Reading a superseded run is the whole reason those cases are preserved.
 */
const resolved = resolveArtifactDataset(artifact?.manifest);
if (!resolved.ok) {
    console.error(`Cannot read this artifact (${resolved.reason}).\n\n${resolved.detail}`);
    process.exit(1);
}

if (resolved.scoringContract === "absent_historical") {
    console.log(
        `# note: this artifact predates \`scoringContractDigest\`. It is read against\n` +
            `# ${resolved.manifest.datasetVersion}'s recorded labelling ` +
            `(${resolved.manifest.scoringContractVersion ?? "schema 1"}).\n`
    );
}

const analysis = analyseArtifact({
    artifact,
    casesById: new Map(
        resolved.composition.cases.map((testCase) => [testCase.id, testCase])
    ),
    // Already checked by the resolver, and with better messages. Passed
    // through so the core keeps its own guard rather than trusting a caller.
    datasetVersion: resolved.manifest.datasetVersion,
    datasetDigest: resolved.manifest.datasetDigest,
    // Which scorer's rules classify the lines below. Taken from the resolved
    // manifest rather than from the artifact's own field: the resolver has
    // already refused an artifact whose claim disagrees with the record, so
    // this is the checked value and the artifact's is the claim.
    datasetSchemaVersion: resolved.manifest.schemaVersion,
    // The contract the matchers below would actually apply — the live one,
    // because `candidateMatchesGoldV3` calls the tree's `canon`. Passing the
    // artifact's own value here would compare it with itself and check
    // nothing.
    scoringContractVersion: MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    scoringContractDigest: sha256(scoringContractDescriptorInput()),
});

console.log(renderReport(analysis, { maxRows }));

// A refusal is the one non-zero exit: it means nothing was read, so a caller
// that pipes this into a record would otherwise file an empty page as a
// finding. A run full of failures still exits 0 — describing them is the job.
process.exit(analysis.refusal ? 1 : 0);
