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
    MEMORY_EVAL_SUCC9_MANIFEST,
    buildSucc9Manifest,
    succ9Problems,
    succ9SignatureProblems,
    verifySucc9Manifest,
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
// Deduplicated: `verifySucc9Manifest()` folds in `succ9SignatureProblems()`
// and `succ9Problems()`, and this script also calls them for their own
// sections, so one defect can arrive twice. A repeated line is noise, and
// noise in a failure report is how the second line stops being read.
const fail = (line) => {
    if (!failures.includes(line)) failures.push(line);
};

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

/* ------------------------------------------------ the pinned record --- */

// The literal against itself and against the tree. `verifySucc9Manifest()`
// folds in `succ9SignatureProblems()` and `succ9Problems()`, so a failure here
// names the field that moved rather than saying the dataset changed.
const pinned = [...verifySucc9Manifest()];
if (pinned.length > 0) for (const problem of pinned) fail(problem);
else
    ok(
        "the pinned manifest matches this tree",
        `${MEMORY_EVAL_SUCC9_MANIFEST.manifestDigest.slice(0, 12)}…`
    );

/* ----------------------------------------------------- the signature --- */

// The judgement lives in `succ9SignatureProblems()`. What is left here is the
// part a pure function cannot do: read the filesystem and ask git.
const signature = [...succ9SignatureProblems()];
if (signature.length > 0) {
    for (const problem of signature) fail(problem);
} else if (MEMORY_EVAL_SUCC9_APPROVAL.approvedBy === null) {
    ok("the approval's shape", "unsigned, and every signed field is null");
} else {
    ok("the approval's shape", `signed by ${MEMORY_EVAL_SUCC9_APPROVAL.approvedBy}`);
    if (!existsSync(MEMORY_EVAL_SUCC9_APPROVAL.record)) {
        fail(`the approval's record does not exist: ${MEMORY_EVAL_SUCC9_APPROVAL.record}`);
    }
    // Fail-closed: "cannot verify here" is the normal path in a shallow clone
    // and would pass any forty-hex string.
    const commit = MEMORY_EVAL_SUCC9_APPROVAL.approvedCommit ?? "";
    try {
        execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
            stdio: ["ignore", "ignore", "ignore"],
        });
        ok("the approval's commit is an ancestor of HEAD", `${commit.slice(0, 12)}…`);
    } catch {
        fail(`${commit} is not an ancestor of HEAD in this checkout`);
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
            "it is signed and frozen."
    );
    if (SUCC9_SUBTYPE_REVIEW.status !== "human_confirmed") {
        // Said here rather than left for the freeze to fail on, because the
        // order matters and it is not the obvious one: confirming the subtype
        // rows moves `subtypeDigest`, which is inside the manifest, so a
        // digest signed before the confirmation is a digest for a tree that
        // no longer exists the moment it arrives.
        console.log(
            "\nThe digests above are NOT the ones to sign. The subtype reading " +
                `is ${SUCC9_SUBTYPE_REVIEW.status}, both assistant_only arms sit on ` +
                "38 of a floor of 38, and confirming those three rows moves " +
                "subtypeDigest and the manifest digest with it. Confirm first, " +
                "then sign what this prints afterwards."
        );
    }
}
