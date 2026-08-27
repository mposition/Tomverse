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

import {
    MEMORY_EVAL_SUCCESSOR_CASES,
    MEMORY_EVAL_SUCCESSOR_DATASET_VERSION,
} from "@/lib/memoryEvalSuccessorFixtures";
import { datasetFingerprintInput } from "@/lib/memoryExtractionEvalCore";

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

const analysis = analyseArtifact({
    artifact,
    casesById: new Map(
        MEMORY_EVAL_SUCCESSOR_CASES.map((testCase) => [testCase.id, testCase])
    ),
    datasetVersion: MEMORY_EVAL_SUCCESSOR_DATASET_VERSION,
    datasetDigest: createHash("sha256")
        .update(datasetFingerprintInput(MEMORY_EVAL_SUCCESSOR_CASES), "utf8")
        .digest("hex"),
});

console.log(renderReport(analysis, { maxRows }));

// A refusal is the one non-zero exit: it means nothing was read, so a caller
// that pipes this into a record would otherwise file an empty page as a
// finding. A run full of failures still exits 0 — describing them is the job.
process.exit(analysis.refusal ? 1 : 0);
