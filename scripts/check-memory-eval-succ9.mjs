/**
 * `mem-eval-succ-9`'s structural checks.
 *
 * Same shape as `check-memory-eval-succ8.mjs`, and the same division of
 * labour: the pure functions in `lib/memoryEvalSucc9.ts` say whether the
 * record is internally consistent, and this script asks the questions a pure
 * function cannot — whether the five retired cases are really gone from the
 * decision set, whether they are really preserved, and whether the signed
 * dataset they came from was left alone.
 *
 * It freezes nothing and approves nothing. succ-9 is unsigned by design until
 * a person signs the two digests it prints.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { MEMORY_EVAL_SUCC8_CASES } from "../lib/memoryEvalSucc8.ts";
import {
    MEMORY_EVAL_SUCC9_APPROVAL,
    MEMORY_EVAL_SUCC9_CASES,
    MEMORY_EVAL_SUCC9_DATASET_FROZEN,
    buildSucc9Manifest,
    succ9Problems,
} from "../lib/memoryEvalSucc9.ts";
import {
    SUCC9_REGRESSION_CORPUS,
    succ9RegressionProblems,
} from "../lib/memoryEvalSucc9Regression.ts";
import { SUCC9_TRANSITION } from "../lib/memoryEvalSucc9Transition.ts";
import {
    SUCC9_SUBTYPE_REVIEW,
    succ9Subtype,
} from "../lib/memoryEvalSucc9Subtypes.ts";
import { MEMORY_EXTRACTION_EXAMPLE_SELECTION_GOLDS } from "../lib/memoryExtractionPrompt.ts";
import { HARNESS_TARGET_DATASET_VERSION } from "../lib/memoryEvalHarnessTarget.ts";

const failures = [];
const notes = [];
const ok = (label, detail) => notes.push(`OK    ${label}  — ${detail}`);
const fail = (line) => failures.push(line);

const manifest = buildSucc9Manifest();

/* ------------------------------------------------------- the record --- */

const structural = [...succ9Problems(manifest)];
if (structural.length > 0) for (const problem of structural) fail(problem);
else ok("succ-9 is the successor it says it is", `${MEMORY_EVAL_SUCC9_CASES.length} cases`);

const regression = [...succ9RegressionProblems()];
if (regression.length > 0) for (const problem of regression) fail(problem);
else ok("the retired cases are preserved", `${SUCC9_REGRESSION_CORPUS.length} entries`);

/* ------------------------------------- gone from here, kept over there --- */

const scored = new Set(
    MEMORY_EVAL_SUCC9_CASES.flatMap((testCase) =>
        (testCase.expected ?? []).map((gold) => `${testCase.id}#${gold.id}`)
    )
);
const preserved = new Set(
    SUCC9_REGRESSION_CORPUS.flatMap((entry) =>
        (entry.originalCase.expected ?? []).map(
            (gold) => `${entry.originalCase.id}#${gold.id}`
        )
    )
);

// The whole point of the version. Each gold that was counted when the
// `mem-extract-v8` example kind was chosen has to be out of the decision set
// and still readable — retired, not deleted.
const stillScored = MEMORY_EXTRACTION_EXAMPLE_SELECTION_GOLDS.filter((gold) =>
    scored.has(gold)
);
const notKept = MEMORY_EXTRACTION_EXAMPLE_SELECTION_GOLDS.filter(
    (gold) => !preserved.has(gold)
);
if (stillScored.length > 0) {
    fail(
        `these chose the prompt and still score in succ-9: ${stillScored.join(", ")}`
    );
} else if (notKept.length > 0) {
    fail(`these left without being preserved: ${notKept.join(", ")}`);
} else {
    ok(
        "the selection golds left the decision set",
        `${MEMORY_EXTRACTION_EXAMPLE_SELECTION_GOLDS.length} retired, all preserved`
    );
}

/* ------- the docs/ops/memory-extraction-eval-dataset.md §3.3 subtype floor -- */

// Reported as numbers rather than only as a pass, because both arms sit
// exactly on the floor: "38 of a floor of 38" tells an operator that the next
// retirement out of this cell needs a declared replacement, and "OK" does not.
for (const language of ["ko", "en"]) {
    const cell = MEMORY_EVAL_SUCC9_CASES.filter(
        (testCase) =>
            testCase.category === "assistant_only" && testCase.language === language
    );
    const hard = cell.filter((testCase) =>
        [3, 4].includes(succ9Subtype(testCase.id) ?? 0)
    );
    const floor = Math.ceil(cell.length * 0.3);
    // `succ9Problems()` reports the shortfall; this line reports the number
    // when there is not one, and stays silent rather than printing OK beside a
    // count that is under the floor.
    if (hard.length >= floor) {
        ok(
            `assistant_only:${language} subtype floor`,
            `${hard.length} subtype 3/4 of ${cell.length}, floor ${floor}` +
                (hard.length === floor ? " (no slack)" : "")
        );
    }
}

/* ------------------------------------ the signed predecessor, untouched --- */

// succ-8 was signed against two digests on 2026-09-04. Removing a case from it
// would move both and void that signature, so the retirement is a new dataset
// and never an edit to the old one.
const succ8Golds = new Set(
    MEMORY_EVAL_SUCC8_CASES.flatMap((testCase) =>
        (testCase.expected ?? []).map((gold) => `${testCase.id}#${gold.id}`)
    )
);
const missingFromSucc8 = MEMORY_EXTRACTION_EXAMPLE_SELECTION_GOLDS.filter(
    (gold) => !succ8Golds.has(gold)
);
if (missingFromSucc8.length > 0) {
    fail(
        `succ-8 was edited; it is signed and historical: ${missingFromSucc8.join(", ")}`
    );
} else {
    ok("succ-8 is unchanged", "the retirement is a new version, not an edit");
}

/* ----------------------------------------------------- the signature --- */

const signedFields = [
    MEMORY_EVAL_SUCC9_APPROVAL.approvedBy,
    MEMORY_EVAL_SUCC9_APPROVAL.approvedAt,
    MEMORY_EVAL_SUCC9_APPROVAL.approvedCommit,
    MEMORY_EVAL_SUCC9_APPROVAL.signedDatasetDigest,
    MEMORY_EVAL_SUCC9_APPROVAL.signedManifestDigest,
];
const filled = signedFields.filter((value) => value !== null);
if (filled.length === 0) {
    if (MEMORY_EVAL_SUCC9_DATASET_FROZEN) {
        fail("frozen with nobody's name on it");
    } else {
        ok("the approval's shape", "unsigned, and every signed field is null");
    }
} else if (filled.length !== signedFields.length) {
    fail(
        `${filled.length} of ${signedFields.length} signature fields are filled; ` +
            "a partial signature claims an approval of bytes nobody read"
    );
} else {
    ok("the approval's shape", `signed by ${MEMORY_EVAL_SUCC9_APPROVAL.approvedBy}`);
    if (!/^@[A-Za-z0-9-]+$/.test(MEMORY_EVAL_SUCC9_APPROVAL.approvedBy ?? "")) {
        fail(`the reviewer is not a handle: ${MEMORY_EVAL_SUCC9_APPROVAL.approvedBy}`);
    }
    if (!existsSync(MEMORY_EVAL_SUCC9_APPROVAL.record)) {
        fail(`the approval's record does not exist: ${MEMORY_EVAL_SUCC9_APPROVAL.record}`);
    }
    if (MEMORY_EVAL_SUCC9_APPROVAL.signedDatasetDigest !== manifest.datasetDigest) {
        fail("the signed dataset digest is not this tree's");
    }
    if (MEMORY_EVAL_SUCC9_APPROVAL.signedManifestDigest !== manifest.manifestDigest) {
        fail("the signed manifest digest is not this tree's");
    }
    // Fail-closed: "cannot verify here" is the normal path in a shallow clone
    // and would pass any forty-hex string.
    const commit = MEMORY_EVAL_SUCC9_APPROVAL.approvedCommit ?? "";
    if (!/^[0-9a-f]{40}$/.test(commit)) {
        fail(`the approved commit is not a full sha: ${commit}`);
    } else {
        try {
            execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
                stdio: ["ignore", "ignore", "ignore"],
            });
            ok("the approval's commit is an ancestor of HEAD", `${commit.slice(0, 12)}…`);
        } catch {
            fail(`${commit} is not an ancestor of HEAD in this checkout`);
        }
    }
}

/* ---------------------------------------------------------- report --- */

console.log("");
for (const line of notes) console.log(line);
console.log("");
console.log(`transitions: ${SUCC9_TRANSITION.length}`);
console.log(`subtypeDigest    ${manifest.subtypeDigest}  (${SUCC9_SUBTYPE_REVIEW.status})`);
console.log(`datasetDigest    ${manifest.datasetDigest}`);
console.log(`manifestDigest   ${manifest.manifestDigest}`);
console.log(`scoringContract  ${manifest.scoringContractVersion} ${manifest.scoringContractDigest}`);

if (failures.length > 0) {
    console.error("\nsucc-9 is not whole:\n");
    for (const line of failures) console.error(`  FAIL  ${line}`);
    process.exit(1);
}

console.log(
    `\nsucc-9 structural checks all hold. frozen=${MEMORY_EVAL_SUCC9_DATASET_FROZEN}; ` +
        `the harness targets ${HARNESS_TARGET_DATASET_VERSION}.`
);
if (!MEMORY_EVAL_SUCC9_DATASET_FROZEN) {
    console.log(
        "A decision-grade run against it is refused as `dataset_not_frozen` until " +
            "somebody signs the two digests above."
    );
}
