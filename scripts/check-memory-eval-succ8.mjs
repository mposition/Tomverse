/**
 * `npm run check:memory-eval-succ8`
 *
 * succ-8's structural invariants and its signature's shape.
 *
 * ## Why this exists as its own gate
 *
 * `verifySucc8Manifest()` and `succ8SignatureProblems()` were written and then
 * called by nothing that runs. Both are reachable from
 * `resolveArtifactDataset()`, which runs when somebody reads an old artifact —
 * not on a commit, and not before a signature. A verifier nothing invokes is a
 * comment with a return type: succ-8 could have lost its pinned manifest,
 * gained a half-filled approval, or been frozen with nobody's name on it, and
 * every required check would still have been green.
 *
 * This is the succ-6 and succ-7 pattern, for the dataset that is now the
 * harness target and the one a signature is actually pending on.
 *
 * ## What it does not do
 *
 * It does not sign, freeze, or edit anything. It reports, and it fails the
 * build when the record and the tree disagree.
 */

import {
    MEMORY_EVAL_SUCC8_APPROVAL,
    MEMORY_EVAL_SUCC8_CASES,
    MEMORY_EVAL_SUCC8_DATASET_FROZEN,
    MEMORY_EVAL_SUCC8_DATASET_VERSION,
    MEMORY_EVAL_SUCC8_MANIFEST,
    buildSucc8Manifest,
    succ8SignatureProblems,
    verifySucc8Manifest,
} from "../lib/memoryEvalSucc8.ts";
import { MEMORY_EVAL_SUCC7_CASES, MEMORY_EVAL_SUCC7_MANIFEST } from "../lib/memoryEvalSucc7.ts";
import {
    HARNESS_TARGET_DATASET_VERSION,
    harnessTarget,
    harnessTargetBindingFailures,
} from "../lib/memoryEvalHarnessTarget.ts";
import { MEMORY_EVAL_SCORING_CONTRACT_VERSION } from "../lib/memoryEvalScoringContractDigest.ts";

const failures = [];
const notes = [];
const ok = (label, detail) => notes.push(`OK    ${label}  — ${detail}`);
const fail = (line) => failures.push(line);

/* ----------------------------------------------- the record and the tree -- */

const manifestProblems = [...verifySucc8Manifest()];
if (manifestProblems.length > 0) {
    for (const problem of manifestProblems) fail(problem);
} else {
    ok(
        "succ-8 matches its pinned manifest",
        "record against tree, and the record against its own fields"
    );
}

// The pinned record is a literal, and this is the assertion that says so. If
// it were `buildSucc8Manifest()` the check above would compare the tree with
// itself and pass through any edit at all -- the shape succ-6 shipped once.
const built = buildSucc8Manifest();
if (MEMORY_EVAL_SUCC8_MANIFEST === built) {
    fail(
        "the pinned manifest is the builder's own object; nothing is pinned and a " +
            "signature would cover whatever the tree says at read time"
    );
} else {
    ok("the manifest is a record, not a recomputation", "literal, compared with the builder");
}

/* --------------------------------------------- the contract-only claim ---- */

// Reference identity is checked by `succ8Problems()`, from inside the module,
// and deliberately not repeated here: this script reaches succ-7 through a
// different specifier than succ-8 does (`../lib/…` against `@/lib/…`), which
// under the loader is a second module instance and a second array. Comparing
// them here reports a copy that does not exist. What is checkable from outside
// is the count and the digest, and those are below.
if (MEMORY_EVAL_SUCC8_CASES.length !== MEMORY_EVAL_SUCC7_CASES.length) {
    fail(
        `case count differs from succ-7: ${MEMORY_EVAL_SUCC8_CASES.length} against ` +
            `${MEMORY_EVAL_SUCC7_CASES.length}`
    );
} else {
    ok("the sample is succ-7's", `${MEMORY_EVAL_SUCC8_CASES.length} cases`);
}
if (MEMORY_EVAL_SUCC8_MANIFEST.datasetDigest !== MEMORY_EVAL_SUCC7_MANIFEST.datasetDigest) {
    fail("the dataset digest is not succ-7's; this is not a contract-only successor");
} else {
    ok("dataset digest unchanged", MEMORY_EVAL_SUCC8_MANIFEST.datasetDigest.slice(0, 12) + "…");
}
if (
    MEMORY_EVAL_SUCC8_MANIFEST.scoringContractDigest ===
    MEMORY_EVAL_SUCC7_MANIFEST.scoringContractDigest
) {
    fail("the scoring contract digest is succ-7's; a correction that corrected nothing");
} else {
    ok(
        "scoring contract moved",
        `${MEMORY_EVAL_SUCC7_MANIFEST.scoringContractVersion} -> ` +
            `${MEMORY_EVAL_SUCC8_MANIFEST.scoringContractVersion}`
    );
}

/* ------------------------------------------------------ the signature ----- */

const signatureProblems = [...succ8SignatureProblems()];
if (signatureProblems.length > 0) {
    for (const problem of signatureProblems) fail(problem);
} else {
    ok(
        "the approval's shape",
        MEMORY_EVAL_SUCC8_APPROVAL.approvedBy
            ? `signed by ${MEMORY_EVAL_SUCC8_APPROVAL.approvedBy} on ` +
                  `${MEMORY_EVAL_SUCC8_APPROVAL.approvedAt}`
            : "unsigned, and every signed field is null"
    );
}

/* -------------------------------------------------------- the binding ----- */

if (HARNESS_TARGET_DATASET_VERSION === MEMORY_EVAL_SUCC8_DATASET_VERSION) {
    const bindingProblems = [...harnessTargetBindingFailures(harnessTarget())];
    if (bindingProblems.length > 0) {
        for (const problem of bindingProblems) fail(problem);
    } else {
        ok("the harness target binds", `${HARNESS_TARGET_DATASET_VERSION} against its manifest`);
    }
}

/* ------------------------------------------------------------- report ----- */

console.log("");
console.log(`  datasetVersion    ${MEMORY_EVAL_SUCC8_MANIFEST.datasetVersion}`);
console.log(`  supersedes        ${MEMORY_EVAL_SUCC8_MANIFEST.supersedes}`);
console.log(`  caseCount         ${MEMORY_EVAL_SUCC8_MANIFEST.caseCount}`);
console.log(`  datasetDigest     ${MEMORY_EVAL_SUCC8_MANIFEST.datasetDigest}`);
console.log(`  manifestDigest    ${MEMORY_EVAL_SUCC8_MANIFEST.manifestDigest}`);
console.log(`  scoringContract   ${MEMORY_EVAL_SUCC8_MANIFEST.scoringContractVersion}`);
console.log(`  frozen            ${MEMORY_EVAL_SUCC8_DATASET_FROZEN}`);
console.log(`  harness target    ${HARNESS_TARGET_DATASET_VERSION}`);
console.log(`  live contract     ${MEMORY_EVAL_SCORING_CONTRACT_VERSION}`);
console.log("");

for (const line of notes) console.log(line);
if (failures.length > 0) {
    console.error("\nsucc-8 is not whole:\n");
    for (const line of failures) console.error(`  FAIL  ${line}`);
    process.exit(1);
}

console.log(
    `\nsucc-8 structural checks all hold. frozen=${MEMORY_EVAL_SUCC8_DATASET_FROZEN}` +
        (MEMORY_EVAL_SUCC8_DATASET_FROZEN
            ? "."
            : "; a decision-grade run against it is refused as `dataset_not_frozen` " +
              "until somebody signs the two digests above.")
);
