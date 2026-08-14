// Recomputes the Google image thinking-cap conclusion from its own evidence.
//
// The worksheet states a conclusion. This asks whether the numbers still say
// it. That distinction is the reason the file exists: a prose finding drifts
// silently -- someone edits a sentence, or transcribes a figure wrong, and the
// register keeps reporting a result nobody can rederive. Eighteen paid samples
// are too expensive to leave in that state.
//
// It recomputes rather than compares against a stored answer, so a summary
// edited to say something the samples do not support fails here instead of
// being believed.
//
// If the operator's original `--out` files are dropped in beside the summary,
// every field the summary claims is checked against them and their SHA-256 is
// printed. Until then the summary is a transcription of the run's own stdout,
// which it says about itself in `provenance` -- a weaker artefact than the
// originals, and the check says so rather than letting the difference pass.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, ".github", "audits", "evidence", "google-image-thinking-cap");

const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
const problems = [];
const notes = [];

// --- 1. arithmetic, per sample ------------------------------------------
// `billableOutputTokens` is output + thinking, and it is the whole subject.
// A summary whose own addition does not work cannot support any conclusion.
let sampleCount = 0;
const overLimit = [];
for (const run of summary.runs) {
  const limit = run.requestedMaxOutputTokens;
  if (run.sentCalls !== run.samples.length) {
    problems.push(
      `limit ${limit}: sentCalls ${run.sentCalls} but ${run.samples.length} samples recorded`
    );
  }
  for (const sample of run.samples) {
    sampleCount += 1;
    const sum = sample.outputTokens + sample.thinkingTokens;
    if (sum !== sample.billableOutputTokens) {
      problems.push(
        `limit ${limit} #${sample.index}: ${sample.outputTokens} + ${sample.thinkingTokens} != ${sample.billableOutputTokens}`
      );
    }
    if (sample.reportedTotalTokens !== sum + sample.inputTokens) {
      problems.push(
        `limit ${limit} #${sample.index}: reported total ${sample.reportedTotalTokens} != ${sum} + input ${sample.inputTokens}`
      );
    }
    if (sum > limit) overLimit.push({ limit, sample });
  }
}

// --- 2. the conclusion, recomputed --------------------------------------
// One sample billing more than the limit it was given settles it. Not a
// majority, not a trend: the claim under test is that the parameter bounds the
// billable sum, and a single counterexample is what a bound cannot survive.
const conclusion =
  overLimit.length > 0
    ? "limit_does_not_bound_billable_output"
    : "no_counterexample_in_this_evidence";

if (conclusion !== "limit_does_not_bound_billable_output") {
  problems.push(
    "No sample exceeds its limit, so this evidence does not support the recorded refutation. " +
      "Either the evidence changed or the worksheet §I conclusion needs revisiting."
  );
}

// A counterexample that produced nothing would be far weaker: the model could
// be said to have overrun while failing. The recorded finding rests on one that
// completed and delivered, so that property is checked rather than assumed.
const delivered = overLimit.filter(
  (entry) =>
    entry.sample.finishReason === "completed" &&
    entry.sample.modelOutputImageCount === 1
);
if (overLimit.length > 0 && delivered.length === 0) {
  problems.push(
    "Every over-limit sample failed or returned no image. The recorded conclusion " +
      "relies on an overrun that completed with a delivered image."
  );
}

// --- 3. thinking alone, stated at its real strength -----------------------
// Worth recomputing because the first two runs read as an affirmative result
// and the worksheet deliberately does not claim one. Samples with no output at
// all are the only ones where "thinking hit the ceiling" is even observable.
const thinkingOnly = summary.runs
  .flatMap((run) =>
    run.samples
      .filter((sample) => sample.outputTokens === 0)
      .map((sample) => run.requestedMaxOutputTokens - sample.thinkingTokens)
  );
const offsets = new Set(thinkingOnly);
notes.push(
  thinkingOnly.length === 0
    ? "No output-free samples: nothing here speaks to thinking on its own."
    : `${thinkingOnly.length} output-free samples, limit minus thinking = ${[...offsets].join(", ")}. ` +
      "Consistent with a bound on thinking alone within the measured range; not a general guarantee."
);

// --- 4. the originals, if they are here ----------------------------------
const originals = readdirSync(dir).filter(
  (name) => name.endsWith(".json") && name !== "summary.json"
);

if (originals.length === 0) {
  notes.push(
    `No original run files present. summary.json is provenance="${summary.provenance}", ` +
      "which is a transcription, not the artefact the run wrote. Drop the --out " +
      "files in here to upgrade it."
  );
} else {
  const byLimit = new Map(
    summary.runs.map((run) => [run.requestedMaxOutputTokens, run])
  );
  for (const name of originals.sort()) {
    const raw = readFileSync(join(dir, name), "utf8");
    const sha = createHash("sha256").update(raw).digest("hex");
    let report;
    try {
      report = JSON.parse(raw);
    } catch {
      problems.push(`${name}: not valid JSON`);
      continue;
    }
    notes.push(`${name}  sha256:${sha}`);

    // A raw response still carrying an API key or a prompt would make this
    // directory the leak, so it is checked here rather than trusted.
    if (/\bAIza[A-Za-z0-9_-]{10,}|\bAQ\.[A-Za-z0-9_-]{10,}/.test(raw)) {
      problems.push(`${name}: contains something shaped like an API key`);
    }
    for (const body of report.requestBodies ?? []) {
      if (typeof body.input === "string" && !body.input.startsWith("sha256:")) {
        problems.push(`${name}: requestBodies[].input is not a digest`);
      }
    }

    const claimed = byLimit.get(report.requestedMaxOutputTokens);
    if (!claimed) {
      problems.push(
        `${name}: limit ${report.requestedMaxOutputTokens} is not in summary.json`
      );
      continue;
    }
    if (report.samples.length !== claimed.samples.length) {
      problems.push(
        `${name}: ${report.samples.length} samples, summary claims ${claimed.samples.length}`
      );
      continue;
    }
    for (const [index, sample] of report.samples.entries()) {
      const mine = claimed.samples[index];
      for (const field of [
        "responseId",
        "inputTokens",
        "outputTokens",
        "thinkingTokens",
        "billableOutputTokens",
        "finishReason",
        "modelOutputImageCount",
      ]) {
        if (sample[field] !== mine[field]) {
          problems.push(
            `${name} #${index}: ${field} is ${JSON.stringify(sample[field])}, summary says ${JSON.stringify(mine[field])}`
          );
        }
      }
    }
  }
}

console.log(
  `Google image thinking-cap evidence: ${sampleCount} samples across ${summary.runs.length} limits ` +
    `(${summary.runs.map((run) => run.requestedMaxOutputTokens).join(", ")}).`
);
for (const note of notes) console.log(`  ${note}`);
if (overLimit.length > 0) {
  for (const { limit, sample } of overLimit) {
    console.log(
      `  counterexample: limit ${limit}, ${sample.outputTokens} output + ${sample.thinkingTokens} thinking = ` +
        `${sample.billableOutputTokens} (+${sample.billableOutputTokens - limit}), ` +
        `${sample.finishReason}, ${sample.modelOutputImageCount} image(s)`
    );
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nThe evidence no longer supports what the worksheet records. Resolve before\n" +
      "citing §I as a verification result.\n"
  );
  process.exit(1);
}

console.log(`\nRecomputed conclusion: ${conclusion} -- matches worksheet §I.`);
