/**
 * The succ-7 adoption: the signature, the freeze, and the pinned manifest.
 *
 * Each assertion here exists because the same mistake has been made once
 * already in this repository, and a check that cannot be shown to fail is not
 * evidence that anything passed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    MEMORY_EVAL_SUCC7_CASES,
    MEMORY_EVAL_SUCC7_DATASET_FROZEN,
    MEMORY_EVAL_SUCC7_MANIFEST,
    MEMORY_EVAL_SUCC7_REVIEW,
    MEMORY_EVAL_SUCC7_REVIEWED,
    MEMORY_EVAL_SUCC7_SUPERSEDED_REVIEWS,
    buildSucc7DraftManifest,
    manifestFingerprintInput,
    succ7SignatureProblems,
    succ7SupersededReviewProblems,
    verifySucc7Manifest,
} from "../lib/memoryEvalSucc7.ts";
import {
    SUCC7_TRANSITION,
    SUCC7_TRANSITION_DIGEST,
    succ7TransitionDigestOf,
} from "../lib/memoryEvalSucc7Transition.ts";
import { HARNESS_TARGET_DATASET_VERSION } from "../lib/memoryEvalHarnessTarget.ts";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the second signature describes this tree, pairing included", () => {
    assert.deepEqual([...succ7SignatureProblems()], []);
    const built = buildSucc7DraftManifest();
    for (const [field, value] of [
        ["signedDatasetDigest", built.datasetDigest],
        ["signedManifestDigest", built.manifestDigest],
        ["signedTransitionDigest", built.transitionDigest],
        ["signedSourceDatasetDigest", built.composition.sourceDatasetDigest],
    ]) {
        assert.equal(MEMORY_EVAL_SUCC7_REVIEW[field], value, field);
    }
    assert.equal(MEMORY_EVAL_SUCC7_REVIEW.reviewer, "@mposition");
    assert.equal(MEMORY_EVAL_SUCC7_REVIEW.reviewedAt, "2026-09-03");
    assert.equal(MEMORY_EVAL_SUCC7_REVIEWED, true);
});

test("the first signature is kept, and cannot pass as a live one", () => {
    // History rather than deletion: without it the repository cannot say why
    // the current signature is the second one. The check holds each entry to
    // being genuinely stale, so the list cannot become a place a superseded
    // approval is quietly reused.
    assert.deepEqual([...succ7SupersededReviewProblems()], []);
    assert.equal(MEMORY_EVAL_SUCC7_SUPERSEDED_REVIEWS.length, 1);
    const [first] = MEMORY_EVAL_SUCC7_SUPERSEDED_REVIEWS;
    assert.equal(first.reviewedAt, "2026-09-02");
    assert.equal(first.status, "superseded");
    assert.ok(first.supersededBecause);
    // The sample it signed is this sample; the manifest it signed is not.
    const built = buildSucc7DraftManifest();
    assert.equal(first.signedDatasetDigest, built.datasetDigest);
    assert.notEqual(first.signedManifestDigest, built.manifestDigest);
    assert.equal(first.signedTransitionDigest, undefined);
});

test("a history entry that still matches the tree is refused", () => {
    const built = buildSucc7DraftManifest();
    const problems = succ7SupersededReviewProblems([
        {
            ...MEMORY_EVAL_SUCC7_REVIEW,
            status: "superseded",
            supersededBecause: "claimed",
        },
    ]);
    assert.ok(
        problems.some((line) => line.includes("live signature filed as history")),
        problems.join(" | ")
    );
    // And one with no reason, whichever way its digests fall.
    const noReason = succ7SupersededReviewProblems([
        {
            ...MEMORY_EVAL_SUCC7_SUPERSEDED_REVIEWS[0],
            supersededBecause: undefined,
        },
        built && undefined,
    ].filter(Boolean));
    assert.ok(
        noReason.some((line) => line.includes("records no reason")),
        noReason.join(" | ")
    );
});

test("a signature of a different dataset is refused", () => {
    // The case the record exists for: an edit lands after the review and keeps
    // the version number. If this passes, the signature is decoration.
    const problems = succ7SignatureProblems({
        ...MEMORY_EVAL_SUCC7_REVIEW,
        status: "signed",
        signedTransitionDigest: SUCC7_TRANSITION_DIGEST,
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
            status: "signed",
            signedTransitionDigest: SUCC7_TRANSITION_DIGEST,
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
        "ecfb84a40d1df50d2df59402711473c37dfe1c59310bfc1d7b69ccfdc9e40902"
    );
    assert.equal(
        MEMORY_EVAL_SUCC7_MANIFEST.transitionDigest,
        SUCC7_TRANSITION_DIGEST
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

test("freezing does not move the manifest digest", () => {
    // The reason `frozen` is outside the fingerprint: the digest a reviewer
    // signs has to be the digest that ends up frozen. Asserted on the record
    // rather than on the flag, so it holds whichever way the flag is set.
    const fields = { ...buildSucc7DraftManifest() };
    delete fields.manifestDigest;
    const asFrozen = { ...fields, frozen: !fields.frozen };
    assert.equal(
        manifestFingerprintInput(fields),
        manifestFingerprintInput(asFrozen)
    );
});

test("adoption did not move the harness, and 1150 cases are still there", () => {
    // The signature covers the sample. Pointing the harness at it is a
    // separate decision that was not signed.
    assert.equal(HARNESS_TARGET_DATASET_VERSION, "mem-eval-succ-6");
    assert.equal(MEMORY_EVAL_SUCC7_CASES.length, 1150);
});

/* ------------------------------------------- what the digests have to cover -- */

test("the pinned record is hashed against its own fields", () => {
    // Comparing two digest strings proves only that two strings match. Every
    // non-digest field of the record could be edited with the digest left
    // alone, and on 2026-09-02 all three of these verified clean.
    for (const tampered of [
        { ...MEMORY_EVAL_SUCC7_MANIFEST, caseCount: 999 },
        {
            ...MEMORY_EVAL_SUCC7_MANIFEST,
            transitionTypes: { same_boundary: 1, coverage_repair: 53 },
        },
        { ...MEMORY_EVAL_SUCC7_MANIFEST, scoringContractVersion: "mem-score-v9.9" },
        { ...MEMORY_EVAL_SUCC7_MANIFEST, unresolvedPolicies: [] },
    ]) {
        const failures = verifySucc7Manifest(tampered);
        assert.ok(
            failures.some((line) => line.includes("does not hash to its own")),
            JSON.stringify(failures)
        );
    }
});

test("swapping two same-cell pairings moves the transition digest", () => {
    // The case set, the cell counts and the 53/1 tally are all unchanged by
    // this swap; only which replacement answers for which original moves. Both
    // rows are durable_facts:en, so nothing else in the manifest can see it.
    const swapped = SUCC7_TRANSITION.map((row) =>
        row.replacement === "succ-durable-en-601"
            ? { ...row, retired: "succ-durable-en-11" }
            : row.replacement === "succ-durable-en-602"
              ? { ...row, retired: "succ-durable-en-103" }
              : row
    );
    assert.notEqual(succ7TransitionDigestOf(swapped), SUCC7_TRANSITION_DIGEST);
    // And the manifest notices, because it carries the digest.
    const built = buildSucc7DraftManifest();
    const failures = verifySucc7Manifest(MEMORY_EVAL_SUCC7_MANIFEST, {
        ...built,
        transitionDigest: succ7TransitionDigestOf(swapped),
    });
    assert.ok(
        failures.some((line) => line.startsWith("transitionDigest:")),
        failures.join(" | ")
    );
});

test("the transition digest ignores row order and notices every field", () => {
    const reversed = [...SUCC7_TRANSITION].reverse();
    assert.equal(succ7TransitionDigestOf(reversed), SUCC7_TRANSITION_DIGEST);
    for (const change of [
        (row) => ({ ...row, basis: row.basis === "approved10" ? "polarity44" : "approved10" }),
        (row) => ({ ...row, transitionType: "coverage_repair" }),
        (row) => ({ ...row, unresolvedPolicy: "something new" }),
    ]) {
        const moved = SUCC7_TRANSITION.map((row, index) =>
            index === 0 ? change(row) : row
        );
        assert.notEqual(succ7TransitionDigestOf(moved), SUCC7_TRANSITION_DIGEST);
    }
});

/* ------------------------------------------------- what a signature must say -- */

test("a signature naming no commit or no record is refused", () => {
    const signed = { ...MEMORY_EVAL_SUCC7_REVIEW, status: "signed" };
    for (const [field, value, needle] of [
        ["reviewedCommit", "", "reviewedCommit is not"],
        ["reviewedCommit", "abc123", "reviewedCommit is not"],
        ["record", "", "record is not an audit path"],
        ["record", "somewhere/else.md", "record is not an audit path"],
    ]) {
        const problems = succ7SignatureProblems({ ...signed, [field]: value });
        assert.ok(
            problems.some((line) => line.includes(needle)),
            `${field}=${JSON.stringify(value)} -> ${problems.join(" | ")}`
        );
    }
});

test("a signature that does not cover the pairing is refused", () => {
    const problems = succ7SignatureProblems({
        ...MEMORY_EVAL_SUCC7_REVIEW,
        status: "signed",
        signedTransitionDigest: undefined,
    });
    assert.ok(
        problems.some((line) => line.includes("does not cover the transition")),
        problems.join(" | ")
    );
});

test("a superseded signature never reads as covering this tree", () => {
    const problems = succ7SignatureProblems({
        ...MEMORY_EVAL_SUCC7_REVIEW,
        status: "superseded",
        supersededBecause: "for the test",
    });
    assert.ok(
        problems.some((line) => line.includes("no signature covers this tree")),
        problems.join(" | ")
    );
});

/* ------------------------------------- the sheet, run as the command it is -- */

const sandbox = (prefix = "succ7-sheet-") => {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    for (const entry of [
        "lib",
        "scripts",
        "tsconfig.json",
        "package.json",
        ".github",
    ]) {
        cpSync(path.join(REPO, entry), path.join(root, entry), {
            recursive: true,
        });
    }
    // Linked rather than copied: the point is to run the real command against
    // a tree we may edit, not to reinstall anything.
    //
    // `junction` on Windows, where a plain directory symlink needs privileges
    // this repository's own development machine does not run with — the first
    // version threw EPERM there and took the whole unit gate down with it,
    // green on Linux CI the entire time.
    symlinkSync(
        path.join(REPO, "node_modules"),
        path.join(root, "node_modules"),
        process.platform === "win32" ? "junction" : "dir"
    );
    return root;
};

const runSheet = (root, out) =>
    spawnSync(
        process.execPath,
        [
            "--import",
            "tsx",
            "scripts/make-memory-eval-succ7-review-sheet.mjs",
            `--out=${out}`,
        ],
        { cwd: root, encoding: "utf8" }
    );

test("the sheet command refuses to claim an adoption the tree lost", (t) => {
    // A command-level test, because the defect was in the command: both
    // verifiers reported drift correctly on 2026-09-02 while this script
    // printed "adopted", `frozen=true` and the *new* digest, having consulted
    // only a boolean.
    const root = sandbox();
    t.after(() => rmSync(root, { recursive: true, force: true }));

    // First, unpatched: the command works. Without this half, a refusal below
    // would not be evidence of anything — the sandbox itself could be broken.
    const clean = path.join(root, "clean.md");
    const before = runSheet(root, clean);
    assert.equal(before.status, 0, before.stderr);
    assert.ok(existsSync(clean));

    // Now edit a case, which is the defect in its original form: an edit lands
    // after the signature, under the same version number. The title is model
    // input and fingerprint v4 covers it, so the dataset digest moves and the
    // manifest digest with it, while the recorded signature still says
    // "signed".
    const casesPath = path.join(root, "lib/memoryEvalSucc7Replacements/durableFacts.ts");
    const source = readFileSync(casesPath, "utf8");
    const edited = source.replace('title: "Kayak",', 'title: "Kayaks",');
    assert.notEqual(edited, source, "the case title to edit was not found");
    writeFileSync(casesPath, edited, "utf8");

    const out = path.join(root, "claimed.md");
    const result = runSheet(root, out);
    assert.notEqual(result.status, 0, "the command wrote a sheet it should refuse");
    assert.match(result.stderr, /Refusing to write a sheet/);
    assert.match(result.stderr, /signature is of manifest/);
    assert.equal(existsSync(out), false, "a refused run still left a sheet behind");
});

test("the check refuses when it cannot place the reviewed commit", (t) => {
    // Fail-closed, demonstrated. The previous version answered "cannot verify,
    // therefore OK", and `static-and-unit` checks out at depth 1 — so in the
    // one environment this check runs, the unverifiable path *was* the normal
    // path, and any 40-character string would have passed as a signing commit.
    //
    // The sandbox is not a git repository, which is the same condition a
    // shallow checkout produces for a commit it does not have.
    const root = sandbox("succ7-check-");
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/check-memory-eval-succ7.mjs"],
        { cwd: root, encoding: "utf8" }
    );
    assert.notEqual(result.status, 0, "the check passed with no history to check against");
    assert.match(
        `${result.stdout}${result.stderr}`,
        /is not in this checkout/,
        `${result.stdout}\n${result.stderr}`
    );
});
