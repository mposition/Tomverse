// VOICE-MIX-01: score transcripts of the mixed-language script corpus.
//
//   npm run score:voice-mix-eval -- --check-corpus
//   npm run score:voice-mix-eval -- --manifest runs/manifest.json --transcripts runs/no-hint.json --transcripts runs/hint.json
//   npm run score:voice-mix-eval -- --pipeline-check --transcripts runs/dev-synthetic.json
//   ... --json
//
// Offline and read-only: it reads docs/ops/voice-mix-eval/corpus.v1.json, a
// run manifest and one transcripts file per arm, and prints the measures
// lib/voiceMixEvalCore.ts defines, each on its own and per stratum. It calls no
// provider, reads no audio and writes nothing.
//
// A run is scored only when it is exactly what the manifest registered --
// every item x take x repeat once per arm, the registered model and prompt,
// nothing extra -- so a partial or curated run cannot pass for a real one.
// `--pipeline-check` scores dev items without a manifest, for the synthetic
// dry run that proves the request and scoring path; it refuses holdout items
// and its output says it is not evidence.
//
// Exits 0 whatever the numbers are -- this is evidence for a decision, not a
// gate -- 1 when the corpus or the run fails its integrity checks, and 2 when
// it is run wrongly.
//
// Transcripts of the evaluation recordings only. Never production users'
// dictation (docs/policy/voice-input.md §11).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  aggregateVoiceMixScores,
  scoreVoiceMixTranscript,
  voiceMixCorpusProblems,
  voiceMixRunProblems,
} from "../lib/voiceMixEvalCore.ts";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const pipelineCheck = argv.includes("--pipeline-check");
const valueOf = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const valuesOf = (flag) =>
  argv.flatMap((value, index) => (value === flag && argv[index + 1] ? [argv[index + 1]] : []));
const readJson = (path) => JSON.parse(readFileSync(resolve(path), "utf8"));

const corpusPath = valueOf("--corpus") ?? "docs/ops/voice-mix-eval/corpus.v1.json";
const corpusBytes = readFileSync(resolve(corpusPath));
const corpus = JSON.parse(corpusBytes.toString("utf8"));
const corpusDigest = createHash("sha256").update(corpusBytes).digest("hex");
const corpusProblems = voiceMixCorpusProblems(corpus);
if (corpusProblems.length > 0) {
  console.error(`The corpus fails its own checks (${corpusPath}):`);
  for (const problem of corpusProblems) console.error(`  - ${problem}`);
  process.exit(1);
}
if (argv.includes("--check-corpus")) {
  const dev = corpus.items.filter((item) => item.split === "dev").length;
  console.log(`${corpus.version}: ${corpus.items.length} items (${dev} dev, ${corpus.items.length - dev} holdout), no problems.`);
  console.log(`corpusDigest (register this in the manifest): ${corpusDigest}`);
  process.exit(0);
}

const transcriptPaths = valuesOf("--transcripts");
if (transcriptPaths.length === 0) {
  console.error("At least one --transcripts <file> is required (or --check-corpus).");
  process.exit(2);
}
const runs = transcriptPaths.map(readJson);
for (const run of runs) {
  if (!Array.isArray(run.entries)) {
    console.error("Every transcripts file needs an `entries` array.");
    process.exit(2);
  }
}

if (pipelineCheck) {
  if (valueOf("--manifest")) {
    console.error("--pipeline-check and --manifest are exclusive.");
    process.exit(2);
  }
  const holdout = runs.flatMap((run) =>
    run.entries.filter((entry) => corpus.items.find((item) => item.id === entry.itemId)?.split !== "dev")
  );
  if (holdout.length > 0) {
    console.error("--pipeline-check scores dev items only; holdout needs a registered manifest.");
    process.exit(1);
  }
} else {
  const manifestPath = valueOf("--manifest");
  if (!manifestPath) {
    console.error("--manifest <file> is required to score a run (or --pipeline-check for dev items).");
    process.exit(2);
  }
  const runProblems = voiceMixRunProblems(corpus, corpusDigest, readJson(manifestPath), runs);
  if (runProblems.length > 0) {
    console.error("The run is not what the manifest registered:");
    for (const problem of runProblems.slice(0, 50)) console.error(`  - ${problem}`);
    if (runProblems.length > 50) console.error(`  ... and ${runProblems.length - 50} more`);
    process.exit(1);
  }
}

const report = runs.map((run) => {
  const scores = run.entries.map((entry) => scoreVoiceMixTranscript(corpus, entry));
  const aggregates = [];
  for (const split of ["holdout", "dev"]) {
    for (const stratum of ["all", "hint-target", "hint-absent"]) {
      const aggregate = aggregateVoiceMixScores(scores, split, stratum);
      if (aggregate.transcripts > 0) aggregates.push(aggregate);
    }
  }
  return { arm: run.arm ?? null, model: run.model ?? null, aggregates, items: scores };
});

// Written and left to exit on its own: process.exit() right after a large
// write to a pipe can end the process before stdout has been flushed.
if (json) {
  console.log(JSON.stringify({ corpus: corpus.version, pipelineCheck, runs: report }, null, 2));
} else {

  const share = (found, total) => (total === 0 ? "n/a" : `${found}/${total}`);
  const errorRate = (value) =>
    value.rate === null ? "n/a" : `${(value.rate * 100).toFixed(1)}% (${value.errors}/${value.units})`;
  console.log(`Voice mix evaluation -- ${corpus.version}`);
  if (pipelineCheck) console.log("PIPELINE CHECK: dev items, no manifest. Not evidence of recognition quality.");
  console.log("Each line is its own measure; none of them is a combined recognition rate.");
  for (const run of report) {
    console.log(`\narm ${run.arm ?? "?"}, model ${run.model ?? "?"}`);
    for (const aggregate of run.aggregates) {
      console.log(`  ${aggregate.split} / ${aggregate.stratum} (${aggregate.transcripts} transcripts, ${aggregate.scoringVersion})`);
      console.log(`    Korean character error rate  ${errorRate(aggregate.koreanCharErrorRate)}`);
      console.log(`    English word error rate      ${errorRate(aggregate.englishWordErrorRate)}`);
      console.log(`    key terms kept               ${share(aggregate.keyTerms.found, aggregate.keyTerms.total)}`);
      console.log(`    meaning kept                 ${share(aggregate.meaning.found, aggregate.meaning.total)}`);
      console.log(`    number order kept            ${share(aggregate.numberOrder.kept, aggregate.numberOrder.total)}`);
      console.log(
        `    omitted segments             ko ${share(aggregate.omittedSegments.ko.omitted, aggregate.omittedSegments.ko.total)}, en ${share(aggregate.omittedSegments.en.omitted, aggregate.omittedSegments.en.total)}`
      );
      console.log(
        `    likely translated            ${aggregate.likelyTranslated.segments} of ${aggregate.likelyTranslated.omittedEnglishSegments} omitted English segments (${aggregate.likelyTranslated.transliterated} were accepted transliterations)`
      );
      console.log(`    hint terms inserted          ${aggregate.hintInsertion.terms} in ${aggregate.hintInsertion.transcripts} transcripts`);
    }
  }
}
