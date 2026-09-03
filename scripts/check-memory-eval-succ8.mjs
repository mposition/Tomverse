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

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

/**
 * Shape is not existence, and only this script can tell the difference.
 *
 * `succ8SignatureProblems()` is a pure function in a module that must stay
 * loadable in every environment, so it can check that the five fields are
 * present and that the digests match the record — and nothing else. It cannot
 * tell whether the reviewer is a name or three spaces, whether the commit is a
 * commit or forty plausible hex characters, or whether the audit record it
 * cites is a file that exists. A signature that passes only the shape check is
 * a signature nobody can trace to a person, a history, or a document.
 *
 * These are the same three questions `check-memory-eval-succ7.mjs` asks of
 * succ-7's signature, asked here for the same reason.
 */
if (MEMORY_EVAL_SUCC8_APPROVAL.approvedBy !== null) {
    const reviewer = String(MEMORY_EVAL_SUCC8_APPROVAL.approvedBy);
    if (reviewer.trim() === "") {
        fail("the approval names a reviewer of whitespace");
    } else if (!/^@[\w.-]+$/.test(reviewer)) {
        fail(
            `the approval's reviewer is not a handle: ${JSON.stringify(reviewer)}. ` +
                "A signature has to name someone a reader can go and ask."
        );
    } else {
        ok("the reviewer is a handle", reviewer);
    }

    const record = MEMORY_EVAL_SUCC8_APPROVAL.record;
    if (!existsSync(fileURLToPath(new URL(`../${record}`, import.meta.url)))) {
        fail(`the approval's record does not exist: ${record}`);
    } else {
        ok("the approval's record exists", record);
    }

    const sha = String(MEMORY_EVAL_SUCC8_APPROVAL.approvedCommit);
    const git = (args) =>
        execFileSync("git", args, {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            stdio: ["ignore", "pipe", "ignore"],
        });
    let known = true;
    try {
        git(["cat-file", "-e", `${sha}^{commit}`]);
    } catch {
        known = false;
    }
    if (!known) {
        // Fail, not "not verifiable here". The softer answer is what made the
        // succ-7 version fail open: `static-and-unit` used to check out at
        // depth 1, so "cannot verify, therefore OK" was the *normal* path and
        // any 40-character string passed as a signing commit.
        fail(
            `the approval's commit ${sha.slice(0, 12)}… is not in this checkout, so ` +
                "it cannot be tied to a history. Fetch full history " +
                "(actions/checkout with fetch-depth: 0) and re-run."
        );
    } else {
        try {
            git(["merge-base", "--is-ancestor", sha, "HEAD"]);
            ok("the approval's commit is an ancestor of HEAD", `${sha.slice(0, 12)}…`);
        } catch {
            fail(
                `the approval names ${sha.slice(0, 12)}…, which is not an ancestor of ` +
                    "HEAD: it describes a history this tree does not have"
            );
        }
    }
} else {
    ok(
        "no signature to trace",
        "unsigned, so there is no reviewer, commit or record to resolve"
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
