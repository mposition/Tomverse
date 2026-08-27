// Draw the diagnostic supplement: pairs the two model judges read differently.
//
// This is a separate command from eval:router-human-sheets because it is a
// separate measurement. The primary sample is drawn without reference to any
// verdict, which is what lets it estimate how often people agree with the
// judges. This one goes looking for disagreements on purpose, because a
// handful of the cases the judges split on says more about why they differ
// than sixty random ones do.
//
// The two can never be pooled. A diagnostic pair was chosen because of its
// verdict, so counting it in the primary agreement rate would be counting a
// sample selected on the thing being measured. Every pair the primary draw
// has spoken for -- primary, reserve, or already substituted in -- is
// excluded here, and lib/routerHumanReviewDiagnostic.ts refuses a draw that
// overlaps.
//
// The procedure is docs/ops/tomverse-chat-router-evaluation-set.md.
//
// Usage:
//   node --import tsx scripts/router-human-review-diagnostic.mjs \
//     --primary=<directory from eval:router-human-sheets> \
//     --bundle=<answer-bundle.jsonl> \
//     --target=<verdicts.jsonl> --reference=<verdicts.jsonl> \
//     --seed=<integer> --by=<name> --reviewers=<id>,<id> --out=<directory>
//
//   ... --at=<iso8601>   the draw time to record (default: now)
//
// The two --verdicts files are the ones --mode=judge-calibration compares: the
// judge under test first, then the independent one. This command makes no
// provider calls and costs nothing.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseAnswerBundle } from "../lib/routerAnswerBundle.ts";
import { HUMAN_REVIEWERS_PER_PAIR, manifestProblems } from "../lib/routerHumanReviewSample.ts";
import {
  buildSheetFor,
  renderSheetMarkdown,
  sheetBlindnessProblems,
  sheetIndependenceProblems,
} from "../lib/routerHumanReviewSheet.ts";
import {
  diagnosticProblems,
  diagnosticReadout,
  diagnosticSample,
  drawDiagnosticSample,
} from "../lib/routerHumanReviewDiagnostic.ts";

const die = (message) => {
  console.error(message);
  process.exit(1);
};

const flag = (name) => {
  const match = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : null;
};

const primaryDirectory = flag("primary") ?? die("--primary=<directory> is required: this draw avoids that sample.");
const bundlePath = flag("bundle") ?? die("--bundle=<answer-bundle.jsonl> is required.");
const targetPath = flag("target") ?? die("--target=<verdicts.jsonl> is required: the judge under test.");
const referencePath = flag("reference") ?? die("--reference=<verdicts.jsonl> is required: the independent judge.");
const outDirectory = flag("out") ?? die("--out=<directory> is required.");
const drawnBy = flag("by") ?? die("--by=<name> is required: a draw is somebody's.");
const drawnAt = flag("at") ?? new Date().toISOString();
const seedText = flag("seed") ?? die("--seed=<integer> is required so the draw can be replayed.");
const seed = Number(seedText);
if (!Number.isInteger(seed) || seed <= 0) die(`--seed must be a positive integer, not "${seedText}".`);

const reviewerIds = (flag("reviewers") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
if (reviewerIds.length !== HUMAN_REVIEWERS_PER_PAIR || new Set(reviewerIds).size !== reviewerIds.length) {
  die(`--reviewers=<id>,<id> is required: ${HUMAN_REVIEWERS_PER_PAIR} different people, as in the primary sample.`);
}

const listed = (problems, what) =>
  `\n${what}:\n\n` +
  problems.slice(0, 10).map((problem) => `  - ${problem}`).join("\n") +
  (problems.length > 10 ? `\n  ... and ${problems.length - 10} more` : "") +
  "\n";

const readPass = (path) => {
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
  const header = lines.find((line) => line.kind === "header");
  if (!header) die(`${path} has no header line, so it is not a verdict file.`);
  return {
    identity: header.judge,
    bundleDigest: header.bundleDigest,
    verdicts: lines.filter((line) => line.kind === "verdict").map((line) => ({ pairId: line.pairId, verdict: line.verdict })),
  };
};

const bundle = parseAnswerBundle(readFileSync(bundlePath, "utf8"));
const primary = JSON.parse(readFileSync(join(primaryDirectory, "manifest.json"), "utf8"));
const primaryTrouble = manifestProblems(primary, bundle);
if (primaryTrouble.length > 0) {
  die(listed(primaryTrouble, `${primaryDirectory}/manifest.json does not describe a usable primary draw`));
}

const draw = drawDiagnosticSample({
  bundle,
  primary,
  target: readPass(targetPath),
  reference: readPass(referencePath),
  seed,
  drawnAt,
  drawnBy,
});
const drawTrouble = diagnosticProblems(draw, primary);
if (drawTrouble.length > 0) die(listed(drawTrouble, "the diagnostic draw cannot be used") + "\nNothing was written.");

const pairIds = diagnosticSample(draw);
if (pairIds.length === 0) {
  console.log(`${draw.targetJudge} and ${draw.referenceJudge} did not split on any pair outside the primary sample.`);
  console.log("There is nothing to supplement, and nothing was written.");
  process.exit(0);
}

const built = reviewerIds.map((reviewerId) =>
  buildSheetFor({ reviewerId, pairIds, bundle, seed, populationDigest: draw.populationDigest })
);
const blindTrouble = [
  ...built.flatMap(({ sheet }) =>
    sheetBlindnessProblems(sheet, bundle).map((problem) => `${sheet.reviewerId}: ${problem}`)
  ),
  ...sheetIndependenceProblems(built.map(({ sheet }) => sheet)),
];
if (blindTrouble.length > 0) die(listed(blindTrouble, "these sheets are not blind, so they were not written"));

if (!existsSync(outDirectory)) mkdirSync(outDirectory, { recursive: true });
const write = (name, contents) => {
  writeFileSync(join(outDirectory, name), contents);
  return join(outDirectory, name);
};

const written = [
  write("diagnostic-draw.json", `${JSON.stringify(draw, null, 2)}\n`),
  write(
    "key.json",
    `${JSON.stringify(
      { builtAt: drawnAt, builtBy: drawnBy, populationDigest: draw.populationDigest, key: built.flatMap(({ key }) => key) },
      null,
      2
    )}\n`
  ),
  ...built.flatMap(({ sheet }) => [
    write(`sheet-${sheet.reviewerId}.md`, renderSheetMarkdown(sheet)),
    write(`sheet-${sheet.reviewerId}.json`, `${JSON.stringify(sheet, null, 2)}\n`),
  ]),
];

console.log(`Diagnostic supplement — ${draw.targetJudge} against ${draw.referenceJudge}, seed ${seed}.`);
console.log(`Drawn from outside the primary sample at seed ${draw.primarySeed}, over the same population.`);
console.log(`${pairIds.length} pair(s) across ${draw.cells.length} cell(s), at most ${draw.perCellCap} per cell:\n`);
for (const cell of diagnosticReadout(draw)) {
  const short = cell.shortOfTarget > 0 ? `  (${cell.shortOfTarget} short of ${draw.perCellCap})` : "";
  console.log(`  ${cell.cell.padEnd(38)} ${cell.drawn} of ${cell.disagreementsAvailable} disagreement(s)${short}`);
}
console.log("");
for (const path of written) console.log(`  wrote ${path}`);
console.log(
  "\nThese pairs were chosen because the judges split on them, so what people say about them is an\n" +
    "illustration and not a rate. It is not comparable with the primary sample and must not be pooled\n" +
    "with it: report the two separately or not at all."
);
