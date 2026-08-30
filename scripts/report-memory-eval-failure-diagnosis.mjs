/**
 * What a failing memory-extraction eval run's failures look like, grouped by
 * what can be observed rather than by what someone guesses caused them.
 *
 * Usage:
 *   npm run report:memory-eval-failure-diagnosis -- --artifact=path/to/run.json
 *   ... --sample=8        how many quoted cases to print per group (default 6)
 *
 * The four causes this exists to separate — a prompt defect, a scoring
 * taxonomy the prompt and the gold read differently, a defect in the gold, and
 * the model being wrong — are not printed as conclusions, because this file
 * cannot tell them apart and neither can any other file. What it prints is the
 * evidence that does: whose message a candidate quoted, where in the
 * conversation, whether the gold expected anything at all, and whether a
 * missed gold entry was relabelled or never produced.
 *
 * Report only. It writes nothing, gates nothing and approves nothing.
 */

import { readFileSync } from "node:fs";

import {
    diagnoseRun,
    tally,
} from "../lib/memoryEvalFailureDiagnosis.ts";
import { harnessTarget } from "../lib/memoryEvalHarnessTarget.ts";
import { MEMORY_EVAL_CRITICAL_CATEGORIES } from "../lib/memoryExtractionEvalCore.ts";

const argValue = (name, fallback) => {
    const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
    return match ? match.slice(name.length + 3) : fallback;
};

const artifactPath = argValue("artifact", "");
if (!artifactPath) {
    console.error(
        "--artifact=path/to/run.json is required.\n\n" +
            "The artifact is the run's own record. This report reads it rather than\n" +
            "recomputing a run, because a diagnosis of numbers nobody produced is a\n" +
            "diagnosis of nothing."
    );
    process.exit(1);
}
const sampleSize = Number(argValue("sample", "6"));
if (!(Number.isInteger(sampleSize) && sampleSize > 0)) {
    console.error("--sample must be a positive integer.");
    process.exit(1);
}

const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
const target = harnessTarget();

// The artifact has to be about the sample this tree holds. Diagnosing one
// run's failures against another dataset's gold would produce confident,
// wrong groupings — every case id would still resolve, and every label would
// be the other sample's.
const manifest = artifact.manifest ?? {};
if (manifest.datasetVersion !== target.datasetVersion) {
    console.error(
        `This artifact is on ${manifest.datasetVersion} and the tree holds ` +
            `${target.datasetVersion}.\n\n` +
            "Case ids resolve across datasets, so the report would run and be wrong.\n" +
            "Check out the commit the run names, or diagnose an artifact from this one."
    );
    process.exit(1);
}
if (manifest.datasetDigest !== target.datasetDigest) {
    console.error(
        "This artifact names the right dataset version and a different digest.\n\n" +
            `  artifact  ${manifest.datasetDigest}\n` +
            `  tree      ${target.datasetDigest}\n\n` +
            "The sample moved under a version that was supposed to be frozen, or the\n" +
            "artifact was written against a different tree. Either way the gold this\n" +
            "report would read is not the gold the run was scored on."
    );
    process.exit(1);
}

const diagnosis = diagnoseRun({
    records: artifact.records ?? [],
    cases: target.cases,
    criticalCategories: MEMORY_EVAL_CRITICAL_CATEGORIES,
});

// The report has to add up to the run it is about. Two drafts of the
// classifier disagreed with the artifact — once by 10 critical adoptions,
// once by 13 unmatched candidates — and both read plausibly. A diagnosis that
// quietly reports different numbers from the run's own is worse than none, so
// the disagreement is fatal rather than a footnote.
const runCritical = (artifact.records ?? []).reduce(
    (total, record) => total + (record.outcome?.criticalBulkSafeAdoptions ?? 0),
    0
);
const runUnmatchedCandidates = (artifact.records ?? []).reduce(
    (total, record) =>
        total +
        ((record.outcome?.candidateTotal ?? 0) - (record.outcome?.candidateMatched ?? 0)),
    0
);
const runUnmatchedGold = (artifact.records ?? []).reduce(
    (total, record) =>
        total + ((record.outcome?.goldTotal ?? 0) - (record.outcome?.goldMatched ?? 0)),
    0
);
const mine = {
    critical: diagnosis.unrecognisedCandidates.filter((row) => row.critical).length,
    gold: diagnosis.unmatchedGold.length,
};
const disagreements = [
    mine.critical === runCritical
        ? null
        : `critical adoptions: the artifact says ${runCritical}, this report found ${mine.critical}`,
    mine.gold === runUnmatchedGold
        ? null
        : `unmatched gold: the artifact says ${runUnmatchedGold}, this report found ${mine.gold}`,
].filter(Boolean);
if (disagreements.length > 0) {
    console.error(
        "\nThis report does not add up to the run it is describing:\n" +
            disagreements.map((problem) => `  ${problem}`).join("\n") +
            "\n\nThe classifier and the scorer have drifted apart. Fix the classifier\n" +
            "rather than the artifact — the artifact is the record of what happened.\n"
    );
    process.exit(1);
}

const line = (label, value) => console.log(`  ${label.padEnd(46)} ${value}`);
const rule = (title) => console.log(`\n${title}\n${"-".repeat(title.length)}`);

console.log(
    `\nFailure diagnosis — ${manifest.modelId}::${manifest.promptVersion} on ${manifest.datasetVersion}`
);
console.log(`  artifact ${artifactPath}`);
console.log(`  commit   ${manifest.commitSha}`);
console.log(
    `  verdict  ${artifact.verdict?.pass ? "passed" : "did not pass"}` +
        `   decisionGrade ${String(manifest.decisionGrade)}`
);

/* ------------------------------------------- candidates no gold matched -- */

const extra = diagnosis.unrecognisedCandidates;
const criticalExtra = extra.filter((row) => row.critical);

rule("Candidates the gold does not recognise");
line("total", extra.length);
line("of those, counted against the zero gate", criticalExtra.length);
line("the artifact's own unmatched-candidate count", runUnmatchedCandidates);
if (extra.length !== runUnmatchedCandidates) {
    console.log(
        "\n  The two differ because the artifact counts unmatched candidates only in\n" +
            "  cases whose gold is exhaustive, and this report lists every candidate no\n" +
            "  gold entry claimed. Neither is wrong; they answer different questions."
    );
}

console.log("\n  whose words the candidate quoted:");
for (const { key, count } of tally(extra, (row) => row.citedRole)) {
    line(`    ${key}`, count);
}
console.log(
    "\n  An adoption quoting an assistant turn is the model attributing the\n" +
        "  assistant's words to the user. One quoting the user's own turn is not,\n" +
        "  whatever cell it sits in — that distinction is the whole reason this\n" +
        "  column exists."
);

console.log("\n  where in the conversation the quote sits:");
for (const { key, count } of tally(extra, (row) =>
    row.earliestCitedTurn === null
        ? "no quote"
        : row.earliestCitedTurn === 0
          ? "opening turn"
          : `turn ${row.earliestCitedTurn} (after an earlier message)`
)) {
    line(`    ${key}`, count);
}

console.log("\n  what the gold says about the case:");
line(
    "    gold expects nothing at all",
    extra.filter((row) => row.goldExpectsNothing).length
);
line(
    "    gold expects something, and quoted the same message",
    extra.filter((row) => !row.goldExpectsNothing && row.quotesGoldMessage).length
);
line(
    "    gold expects something, quoted a message it never cites",
    extra.filter((row) => !row.goldExpectsNothing && !row.quotesGoldMessage).length
);
console.log(
    "\n  The middle row is the same fact under a different label; the first is a\n" +
        "  case whose gold says store nothing, so the disagreement is about the\n" +
        "  boundary rather than about accuracy."
);

console.log("\n  by cell:");
for (const { key, count } of tally(
    criticalExtra,
    (row) => `${row.category}:${row.language}`
)) {
    line(`    ${key} (critical)`, count);
}

if (criticalExtra.length > 0) {
    console.log(
        `\n  Up to ${sampleSize} of the critical adoptions, quoted. Read these before\n` +
            "  assigning a cause: the statement, the quote it rests on and the turn it\n" +
            "  came from are what tell a prompt defect from a boundary question."
    );
    for (const row of criticalExtra.slice(0, sampleSize)) {
        console.log(
            `\n    ${row.caseId}  (${row.category}:${row.language})  ` +
                `${row.kind}/${row.polarity}  quoted ${row.citedRole} turn ${row.earliestCitedTurn}`
        );
        console.log(`      says : ${row.statement}`);
        for (const quote of row.quotes) console.log(`      from : "${quote}"`);
    }
}

/* ------------------------------------------------- gold the run missed -- */

const missed = diagnosis.unmatchedGold;
rule("Gold entries the run did not match");
line("total", missed.length);
for (const { key, count } of tally(missed, (row) => row.shape)) {
    line(`  ${key}`, count);
}
console.log(
    "\n  `relabelled` means some candidate quoted the same message: the fact was\n" +
        "  found and named differently, which is a taxonomy question rather than a\n" +
        "  miss. `silent` means the run produced nothing for that case at all."
);

const relabelled = missed.filter((row) => row.shape === "relabelled");
console.log("\n  what the run called them instead, most frequent first:");
for (const { key, count } of tally(relabelled, (row) =>
    row.relabelledAs
        .map((as) => `${row.kind}/${row.polarity} -> ${as.kind}/${as.polarity}`)
        .join("; ")
).slice(0, sampleSize * 2)) {
    line(`    ${key}`, count);
}

console.log("\n  by cell:");
for (const { key, count } of tally(
    missed,
    (row) => `${row.category}:${row.language}`
)) {
    line(`    ${key}`, count);
}

console.log(
    "\nThis is a report. It does not decide whether a group is a prompt defect, a\n" +
        "taxonomy mismatch, a gold defect or a model error — that call is a person's,\n" +
        "and it is recorded in an audit rather than computed here. It writes nothing\n" +
        "to the dataset, the register or the artifact.\n"
);
