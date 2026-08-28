// Read the reviewers' sheets back, and settle the sample.
//
// Works on either kind of draw: the primary sample from
// eval:router-human-sheets, or the diagnostic supplement from
// eval:router-human-diagnostic. It never mixes them -- one run reads one
// directory -- and it says which it is reading, because a diagnostic result is
// an illustration and the primary one is an estimate.
//
// Run it twice. The first time, with the two reviewers' filled-in sheets: it
// validates them, reports anything ungradable, and -- where the two split --
// writes a blind adjudication sheet holding only the disputed pairs. The
// second time, with the adjudicator's sheet as well: it settles.
//
// Nothing here decides whether the Router passes. It reads positional verdicts
// -- FIRST, SECOND, EQUIVALENT -- and only applies the key at the very end,
// which is what makes "no grader knew which side was Auto" checkable rather
// than asserted. It spends no reserve either: a pair nobody could grade is
// reported as a candidate for one, and lib/routerHumanReviewSample.ts requires
// a person's recorded reason before a reserve is spent.
//
// The procedure is docs/ops/tomverse-chat-router-evaluation-set.md.
//
// Usage:
//   node --import tsx scripts/router-human-review-collect.mjs \
//     --sheets=<directory from eval:router-human-sheets> \
//     --bundle=<answer-bundle.jsonl> --by=<name> \
//     --submission=<reviewerId>=<filled-in sheet.md> \
//     --submission=<reviewerId>=<filled-in sheet.md> \
//     [--adjudication=<reviewerId>=<filled-in sheet.md>] \
//     [--adjudicator=<name>]   who the adjudication sheet is addressed to
//     --out=<directory>
//
// It makes no provider calls and costs nothing.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseAnswerBundle } from "../lib/routerAnswerBundle.ts";
import {
  HUMAN_REVIEWERS_PER_PAIR,
  effectiveSample,
  manifestProblems,
} from "../lib/routerHumanReviewSample.ts";
import { diagnosticSample } from "../lib/routerHumanReviewDiagnostic.ts";
import {
  parseSubmissionMarkdown,
  structuralFailures,
  submissionProblems,
  unreviewablePairs,
  verdictDistribution,
} from "../lib/routerHumanReviewSubmission.ts";
import {
  adjudicationProblems,
  buildAdjudicationSheet,
  collateVerdicts,
  pairsNeedingAdjudication,
  settleSample,
  settledArmVerdicts,
} from "../lib/routerHumanReviewAdjudication.ts";
import { renderSheetMarkdown } from "../lib/routerHumanReviewSheet.ts";

const die = (message) => {
  console.error(message);
  process.exit(1);
};

const flag = (name) => {
  const match = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : null;
};

const flags = (name) =>
  process.argv
    .filter((argument) => argument.startsWith(`--${name}=`))
    .map((argument) => argument.slice(name.length + 3));

const named = (value, what) => {
  const at = value.indexOf("=");
  if (at < 1) die(`--${what}=<reviewerId>=<path> needs both halves, not "${value}".`);
  return { reviewerId: value.slice(0, at), path: value.slice(at + 1) };
};

const sheetsDirectory = flag("sheets") ?? die("--sheets=<directory> is required.");
const bundlePath = flag("bundle") ?? die("--bundle=<answer-bundle.jsonl> is required.");
const outDirectory = flag("out") ?? die("--out=<directory> is required.");
const settledBy = flag("by") ?? die("--by=<name> is required: settling a sample is somebody's.");
const settledAt = flag("at") ?? new Date().toISOString();

const listed = (problems, what) =>
  `\n${what}:\n\n` +
  problems.slice(0, 10).map((problem) => `  - ${problem}`).join("\n") +
  (problems.length > 10 ? `\n  ... and ${problems.length - 10} more` : "") +
  "\n";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const bundle = parseAnswerBundle(readFileSync(bundlePath, "utf8"));
const keyFile = readJson(join(sheetsDirectory, "key.json"));

// One directory, one kind of draw. A run that read a manifest and a diagnostic
// draw together would be a run that pooled a random sample with a sample
// selected on the judges' verdicts.
const primaryPath = join(sheetsDirectory, "manifest.json");
const diagnosticPath = join(sheetsDirectory, "diagnostic-draw.json");
const isDiagnostic = !existsSync(primaryPath) && existsSync(diagnosticPath);
if (!existsSync(primaryPath) && !existsSync(diagnosticPath)) {
  die(`${sheetsDirectory} holds neither manifest.json nor diagnostic-draw.json, so there is no draw to read.`);
}

const draw = readJson(isDiagnostic ? diagnosticPath : primaryPath);
if (!isDiagnostic) {
  const drawTrouble = manifestProblems(draw, bundle);
  if (drawTrouble.length > 0) {
    die(listed(drawTrouble, `${primaryPath} does not describe a usable draw`));
  }
}
if (keyFile.populationDigest !== draw.populationDigest) {
  die("key.json and the draw describe different populations. Nothing was read.");
}

const reviewersPerPair = isDiagnostic ? HUMAN_REVIEWERS_PER_PAIR : draw.reviewersPerPair;
const submissionArgs = flags("submission").map((value) => named(value, "submission"));
if (submissionArgs.length !== reviewersPerPair) {
  die(`--submission=<reviewerId>=<path> is required ${reviewersPerPair} times, once per reviewer.`);
}

console.log(
  isDiagnostic
    ? `Reading the diagnostic supplement — ${draw.targetJudge} against ${draw.referenceJudge}, seed ${draw.seed}.`
    : `Reading the primary sample, seed ${draw.seed}.`
);

const sheetFor = (reviewerId) => {
  const path = join(sheetsDirectory, `sheet-${reviewerId}.json`);
  if (!existsSync(path)) die(`${path} does not exist, so ${reviewerId} has no sheet to check against.`);
  return readJson(path);
};

const reviewerIds = submissionArgs.map((entry) => entry.reviewerId);
let key = keyFile.key;
const submissions = [];
const failures = [];

for (const { reviewerId, path } of submissionArgs) {
  const sheet = sheetFor(reviewerId);
  const { submission, unreadable } = parseSubmissionMarkdown({
    text: readFileSync(path, "utf8"),
    reviewerId,
    populationDigest: draw.populationDigest,
    submittedAt: settledAt,
  });
  const problems = submissionProblems(submission, sheet);
  if (problems.length > 0) die(listed(problems, `${path} cannot be used`) + "\nNothing was written.");
  submissions.push(submission);
  failures.push(...structuralFailures(submission, sheet, unreadable));

  const spread = verdictDistribution(submission.verdicts);
  console.log(
    `${reviewerId}: ${submission.verdicts.length} graded ` +
      `(FIRST ${spread.first}, SECOND ${spread.second}, EQUIVALENT ${spread.equivalent}).`
  );
}

if (failures.length > 0) {
  console.log(`\n${failures.length} item(s) came back ungradable:`);
  for (const failure of failures) {
    console.log(`  ${failure.reviewerId} ${failure.itemId}: ${failure.reason} -- ${failure.detail}`);
  }
  const candidates = isDiagnostic ? [] : unreviewablePairs(failures, key, reviewerIds);
  if (isDiagnostic) {
    console.log("\nThe diagnostic supplement has no reserve. An ungradable pair is dropped from it and said so.");
  } else if (candidates.length === 0) {
    console.log("\nNo pair was ungradable for every reviewer, so nothing here calls for a reserve.");
    console.log("Go back to the reviewer rather than replacing the pair.");
  } else {
    console.log(`\n${candidates.length} pair(s) no reviewer could grade. These are candidates for a reserve,`);
    console.log("not substitutions: record the reason against the manifest yourself.");
    for (const candidate of candidates) {
      console.log(`  ${candidate.pairId}: ${candidate.reason} -- ${candidate.detail}`);
    }
  }
}

const pairIds = isDiagnostic ? diagnosticSample(draw) : effectiveSample(draw);
const adjudicationArg = flag("adjudication") ? named(flag("adjudication"), "adjudication") : null;
let adjudication = null;

if (adjudicationArg) {
  const collated = collateVerdicts({ submissions, key, reviewerIds, pairIds });
  const built = buildAdjudicationSheet({
    adjudicatorId: adjudicationArg.reviewerId,
    collated,
    bundle,
    seed: draw.seed,
    populationDigest: draw.populationDigest,
    reviewerIds,
  });
  key = [...key, ...built.key];
  const parsed = parseSubmissionMarkdown({
    text: readFileSync(adjudicationArg.path, "utf8"),
    reviewerId: adjudicationArg.reviewerId,
    populationDigest: draw.populationDigest,
    submittedAt: settledAt,
  });
  const problems = [
    ...submissionProblems(parsed.submission, built.sheet),
    ...adjudicationProblems({ collated, adjudication: parsed.submission, key, reviewerIds }),
  ];
  if (problems.length > 0) {
    die(listed(problems, `${adjudicationArg.path} cannot settle this sample`) + "\nNothing was written.");
  }
  adjudication = parsed.submission;
}

const settled = settleSample({
  submissions,
  adjudication,
  key,
  reviewerIds,
  pairIds,
  populationDigest: draw.populationDigest,
  settledAt,
  settledBy,
});

if (!existsSync(outDirectory)) mkdirSync(outDirectory, { recursive: true });
const write = (name, contents) => {
  writeFileSync(join(outDirectory, name), contents);
  return join(outDirectory, name);
};

const written = [write("settled.json", `${JSON.stringify(settled, null, 2)}\n`)];

console.log(
  `\nagreed ${settled.counts.agreed}, adjudicated ${settled.counts.adjudicated}, ` +
    `awaiting adjudication ${settled.counts.needsAdjudication}, no consensus ${settled.counts.noConsensus}, ` +
    `incomplete ${settled.counts.incomplete}.`
);
if (settled.reviewerAgreementRate !== null) {
  console.log(
    `The two reviewers agreed on ${(settled.reviewerAgreementRate * 100).toFixed(1)}% of the pairs they both graded, ` +
      "before any adjudication."
  );
}

if (settled.counts.needsAdjudication > 0) {
  const adjudicatorId = flag("adjudicator") ?? "adjudicator";
  if (reviewerIds.includes(adjudicatorId)) {
    die(`\n--adjudicator=${adjudicatorId} is one of the reviewers. A third opinion has to be a third person.`);
  }
  const built = buildAdjudicationSheet({
    adjudicatorId,
    collated: settled.pairs,
    bundle,
    seed: draw.seed,
    populationDigest: draw.populationDigest,
    reviewerIds,
  });
  written.push(
    write(`sheet-${adjudicatorId}.md`, renderSheetMarkdown(built.sheet)),
    write(`sheet-${adjudicatorId}.json`, `${JSON.stringify(built.sheet, null, 2)}\n`),
    write(
      `key-${adjudicatorId}.json`,
      `${JSON.stringify({ populationDigest: draw.populationDigest, key: built.key }, null, 2)}\n`
    )
  );
  console.log(
    `\n${pairsNeedingAdjudication(settled.pairs).length} pair(s) need a third opinion. The sheet below holds those ` +
      "pairs and nothing about how the two reviewers split."
  );
} else {
  const arms = settledArmVerdicts(settled, key);
  const count = (verdict) => arms.filter((entry) => entry.verdict === verdict).length;
  written.push(write("human-verdicts.json", `${JSON.stringify(arms, null, 2)}\n`));
  console.log(
    `\n${arms.length} settled pair(s): Auto ${count("auto")}, baseline ${count("baseline")}, ` +
      `equivalent ${count("equivalent")}.`
  );
  console.log("Undecided pairs are left out rather than counted as ties.");
  if (isDiagnostic) {
    console.log(
      "\nThese pairs were chosen because the two judges split on them. What people said about them is an\n" +
        "illustration of where the judges differ, not a rate, and it must not be pooled with the primary\n" +
        "sample or reported beside it as though the two measured the same thing."
    );
  }
}

for (const path of written) console.log(`  wrote ${path}`);
