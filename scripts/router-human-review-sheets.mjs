// Draw the human review sample and write the blind sheets for it.
//
// The human sample calibrates the model judges, so nothing about how those
// judges graded may reach the draw. That is why this is its own command with
// its own inputs: it reads an answer bundle and a seed, and there is no
// argument through which a verdict, a score or a judge's name could arrive.
// The diagnostic supplement, which is deliberately drawn from disagreements,
// is a separate command for the same reason.
//
// The procedure is docs/ops/tomverse-chat-router-evaluation-set.md; the draw
// is lib/routerHumanReviewSample.ts and the sheets are
// lib/routerHumanReviewSheet.ts. This script only reads a file, calls those,
// and writes what they return.
//
// Usage:
//   node --import tsx scripts/router-human-review-sheets.mjs \
//     --bundle=<answer-bundle.jsonl> --seed=<integer> --by=<name> \
//     --reviewers=<id>,<id> --out=<directory>
//
//   ... --at=<iso8601>     the draw time to record (default: now)
//
// It makes no provider calls and costs nothing. It writes four kinds of file:
//
//   manifest.json      the draw. Committed.
//   sheet-<id>.md      one per reviewer. Handed out.
//   sheet-<id>.json    the same sheet as data, for the submission validator.
//   key.json           which item was which pair. NEVER handed out.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import { answerBundleProblems, parseAnswerBundle } from "../lib/routerAnswerBundle.ts";
import {
  HUMAN_REVIEWERS_PER_PAIR,
  drawPrimarySample,
  manifestProblems,
} from "../lib/routerHumanReviewSample.ts";
import {
  buildReviewPackage,
  renderSheetMarkdown,
  sheetBlindnessProblems,
  sheetIndependenceProblems,
} from "../lib/routerHumanReviewSheet.ts";

const die = (message) => {
  console.error(message);
  process.exit(1);
};

const flag = (name) => {
  const match = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : null;
};

const bundlePath = flag("bundle") ?? die("--bundle=<answer-bundle.jsonl> is required.");
const outDirectory = flag("out") ?? die("--out=<directory> is required.");
const drawnBy = flag("by") ?? die("--by=<name> is required: a draw is somebody's.");
const drawnAt = flag("at") ?? new Date().toISOString();
const seedText = flag("seed") ?? die("--seed=<integer> is required so the draw can be replayed.");
const seed = Number(seedText);
if (!Number.isInteger(seed) || seed <= 0) die(`--seed must be a positive integer, not "${seedText}".`);

const reviewerIds = (flag("reviewers") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
if (reviewerIds.length !== HUMAN_REVIEWERS_PER_PAIR) {
  die(`--reviewers=<id>,<id> is required: every pair gets ${HUMAN_REVIEWERS_PER_PAIR} independent reviews.`);
}

const listed = (problems, what) =>
  `\n${what}:\n\n` +
  problems.slice(0, 10).map((problem) => `  - ${problem}`).join("\n") +
  (problems.length > 10 ? `\n  ... and ${problems.length - 10} more` : "") +
  "\n";

const bundle = parseAnswerBundle(readFileSync(bundlePath, "utf8"));
const bundleTrouble = answerBundleProblems(bundle);
if (bundleTrouble.length > 0) {
  die(listed(bundleTrouble, `${bundlePath} cannot be sampled`) + "\nNothing was written.");
}

const manifest = drawPrimarySample({ bundle, seed, drawnAt, drawnBy });
const drawTrouble = manifestProblems(manifest, bundle);
if (drawTrouble.length > 0) {
  die(listed(drawTrouble, "the draw does not hold the agreed shape") + "\nNothing was written.");
}

const pack = buildReviewPackage({
  manifest,
  bundle,
  reviewerIds,
  builtAt: drawnAt,
  builtBy: drawnBy,
  routableModelIds: AVAILABLE_MODELS.map((model) => model.id),
});

// Checked before anything is written, because the failure this guards against
// is a sheet that has already been handed to a person.
const blindTrouble = [
  ...pack.sheets.flatMap((sheet) =>
    sheetBlindnessProblems(sheet, bundle).map((problem) => `${sheet.reviewerId}: ${problem}`)
  ),
  ...sheetIndependenceProblems(pack.sheets),
];
if (blindTrouble.length > 0) {
  die(listed(blindTrouble, "these sheets are not blind, so they were not written"));
}

if (!existsSync(outDirectory)) mkdirSync(outDirectory, { recursive: true });
const write = (name, contents) => {
  writeFileSync(join(outDirectory, name), contents);
  return join(outDirectory, name);
};

const written = [
  write("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`),
  write("key.json", `${JSON.stringify({ builtAt: pack.builtAt, builtBy: pack.builtBy, populationDigest: pack.populationDigest, key: pack.key }, null, 2)}\n`),
  ...pack.sheets.flatMap((sheet) => [
    write(`sheet-${sheet.reviewerId}.md`, renderSheetMarkdown(sheet)),
    write(`sheet-${sheet.reviewerId}.json`, `${JSON.stringify(sheet, null, 2)}\n`),
  ]),
];

console.log(`Drawn from ${bundlePath} at seed ${seed} by ${drawnBy}.`);
console.log(`Population ${manifest.populationDigest} (${manifest.digestAlgorithm}).`);
console.log(
  `${manifest.cells.length} cells, ${manifest.perCell.primary} primary and ${manifest.perCell.reserve} reserve each: ` +
    `${manifest.cells.length * manifest.perCell.primary} pairs to ${reviewerIds.length} reviewers.`
);
for (const path of written) console.log(`  wrote ${path}`);

if (pack.disclosures.length > 0) {
  console.log(
    `\n${pack.disclosures.length} answer(s) name their own author, which the run's own exclusion should have ` +
      "caught. They are shown to the reviewer verbatim -- a scrub would change the answer being graded -- so\n" +
      "decide what to do with them before these sheets go out:"
  );
  for (const disclosure of pack.disclosures) {
    console.log(`  ${disclosure.pairId} answer ${disclosure.side}: ${disclosure.markers.join(", ")}`);
  }
}

console.log(`\nkey.json identifies every item. It is not a sheet, and it does not go to a reviewer.`);
