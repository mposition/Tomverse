// Read the reviewers' sheets back, and settle the sample.
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
import { effectiveSample, manifestProblems } from "../lib/routerHumanReviewSample.ts";
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

const manifest = readJson(join(sheetsDirectory, "manifest.json"));
const keyFile = readJson(join(sheetsDirectory, "key.json"));
const bundle = parseAnswerBundle(readFileSync(bundlePath, "utf8"));

const drawTrouble = manifestProblems(manifest, bundle);
if (drawTrouble.length > 0) {
  die(listed(drawTrouble, `${sheetsDirectory}/manifest.json does not describe a usable draw`));
}
if (keyFile.populationDigest !== manifest.populationDigest) {
  die("key.json and manifest.json describe different populations. Nothing was read.");
}

const submissionArgs = flags("submission").map((value) => named(value, "submission"));
if (submissionArgs.length !== manifest.reviewersPerPair) {
  die(`--submission=<reviewerId>=<path> is required ${manifest.reviewersPerPair} times, once per reviewer.`);
}

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
    populationDigest: manifest.populationDigest,
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
  const candidates = unreviewablePairs(failures, key, reviewerIds);
  if (candidates.length === 0) {
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

const pairIds = effectiveSample(manifest);
const adjudicationArg = flag("adjudication") ? named(flag("adjudication"), "adjudication") : null;
let adjudication = null;

if (adjudicationArg) {
  const collated = collateVerdicts({ submissions, key, reviewerIds, pairIds });
  const built = buildAdjudicationSheet({
    adjudicatorId: adjudicationArg.reviewerId,
    collated,
    bundle,
    seed: manifest.seed,
    populationDigest: manifest.populationDigest,
    reviewerIds,
  });
  key = [...key, ...built.key];
  const parsed = parseSubmissionMarkdown({
    text: readFileSync(adjudicationArg.path, "utf8"),
    reviewerId: adjudicationArg.reviewerId,
    populationDigest: manifest.populationDigest,
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
  populationDigest: manifest.populationDigest,
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
    seed: manifest.seed,
    populationDigest: manifest.populationDigest,
    reviewerIds,
  });
  written.push(
    write(`sheet-${adjudicatorId}.md`, renderSheetMarkdown(built.sheet)),
    write(`sheet-${adjudicatorId}.json`, `${JSON.stringify(built.sheet, null, 2)}\n`),
    write(
      `key-${adjudicatorId}.json`,
      `${JSON.stringify({ populationDigest: manifest.populationDigest, key: built.key }, null, 2)}\n`
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
}

for (const path of written) console.log(`  wrote ${path}`);
