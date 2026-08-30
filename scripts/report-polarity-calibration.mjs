// Where do negation markers sit, relative to the fact they are meant to negate?
//
//   npm run report:polarity-calibration
//   npm run report:polarity-calibration -- --json
//
// **This is a diagnostic. It decides nothing.**
// `.github/audits/memory-eval-gold-contract-2026-08-27.md` §9.3 settled
// polarity as a field of v6's output, compared field to field against the
// gold's own field. No `K` exists in `mem-score-v3` or in
// `scoringContractDigest`, no gate reads this script, and its exit code is
// always 0 (§9.4).
//
// It prints a histogram and the sentences behind it, deliberately, rather than
// a single threshold. A script that printed one number would read as if that
// number were the contract -- which is exactly the thing §9.3 removed. The one
// summary it does print is the overlap that made a threshold impossible, and
// it prints that because it is the evidence the decision rests on.
//
// Reads POLARITY_CALIBRATION_CASES and nothing else: no dataset, no provider,
// no file written.

import { POLARITY_CALIBRATION_CASES } from "../lib/memoryEvalPolarityCalibration/corpus.ts";
import { polarityGap } from "../lib/memoryEvalPolarityCalibration/distance.ts";

const json = process.argv.includes("--json");
const LANGUAGES = /** @type {const} */ (["ko", "en"]);
const SHAPES = /** @type {const} */ ([
  "affirmative",
  "negative",
  "double_negative",
  "correction",
  "conditional",
]);

const measured = POLARITY_CALIBRATION_CASES.map((testCase) => ({
  id: testCase.id,
  language: testCase.language,
  shape: testCase.shape,
  statement: testCase.statement,
  factValueAll: testCase.factValueAll,
  goldPolarity: testCase.goldPolarity,
  assertsGold: testCase.assertsGold,
  note: testCase.note ?? null,
  gap: polarityGap({
    statement: testCase.statement,
    factValueAll: testCase.factValueAll,
    language: testCase.language,
  }),
}));

// One bucket per distinct gap, not fixed-width bins. Sixty sentences produce
// about a dozen distinct values, and binning them would hide the two that
// matter -- the largest legitimate negative and the smallest incidental
// affirmative.
const histogram = LANGUAGES.map((language) => {
  const rows = measured.filter((row) => row.language === language);
  const gaps = [...new Set(rows.map((row) => row.gap).filter((gap) => gap !== null))].sort(
    (a, b) => a - b
  );
  return {
    language,
    total: rows.length,
    unmarked: rows.filter((row) => row.gap === null).length,
    buckets: gaps.map((gap) => ({
      gap,
      ids: rows.filter((row) => row.gap === gap).map((row) => row.id),
      shapes: Object.fromEntries(
        SHAPES.map((shape) => [
          shape,
          rows.filter((row) => row.gap === gap && row.shape === shape).length,
        ]).filter(([, count]) => count > 0)
      ),
    })),
  };
});

// The evidence for §9.3, restated each run so it stays checkable: a threshold
// would have to catch every plain denial and miss every plain assertion, and
// those two requirements cross.
const overlap = LANGUAGES.map((language) => {
  const gapsFor = (shape) =>
    measured
      .filter(
        (row) => row.language === language && row.shape === shape && row.gap !== null
      )
      .map((row) => row);
  const negatives = gapsFor("negative");
  const affirmatives = gapsFor("affirmative");
  const widestNegative = negatives.reduce((a, b) => (b.gap > a.gap ? b : a));
  const nearestAffirmative = affirmatives.reduce((a, b) => (b.gap < a.gap ? b : a));
  return {
    language,
    widestNegative: { id: widestNegative.id, gap: widestNegative.gap },
    nearestAffirmative: { id: nearestAffirmative.id, gap: nearestAffirmative.gap },
    // A threshold would need `gap >= widestNegative` and `gap < nearestAffirmative`.
    separable: widestNegative.gap < nearestAffirmative.gap,
  };
});

const report = { cases: measured.length, histogram, overlap, cases_detail: measured };

if (json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(
  `Polarity marker distances -- ${report.cases} cases (diagnostic; nothing depends on these)\n`
);

for (const entry of histogram) {
  console.log(`## ${entry.language}  (${entry.total} cases, ${entry.unmarked} carry no marker)`);
  for (const bucket of entry.buckets) {
    const shapes = Object.entries(bucket.shapes)
      .map(([shape, count]) => `${shape}×${count}`)
      .join(" ");
    console.log(
      `   ${String(bucket.gap).padStart(3)}  ${"█".repeat(bucket.ids.length).padEnd(7)} ${shapes}`
    );
  }
  console.log();
}

console.log("## Why no threshold exists -- the evidence for §9.3\n");
for (const entry of overlap) {
  console.log(
    `   ${entry.language}: the widest plain denial is ${entry.widestNegative.gap} (${entry.widestNegative.id}),`
  );
  console.log(
    `       the nearest incidental marker in a plain assertion is ${entry.nearestAffirmative.gap} (${entry.nearestAffirmative.id}).`
  );
  console.log(
    entry.separable
      ? `       Separable, by a hair. A margin of ${entry.nearestAffirmative.gap - entry.widestNegative.gap - 1}.\n`
      : `       Not separable: any threshold catching the first misreads the second.\n`
  );
}

console.log("## The sentences\n");
for (const language of LANGUAGES) {
  for (const shape of SHAPES) {
    const rows = measured.filter(
      (row) => row.language === language && row.shape === shape
    );
    if (rows.length === 0) continue;
    console.log(`   ${language} · ${shape}`);
    for (const row of rows) {
      console.log(
        `      ${row.id.padEnd(14)} gap ${String(row.gap ?? "-").padStart(4)}  gold ${row.goldPolarity.padEnd(8)} asserts ${String(row.assertsGold).padEnd(5)}`
      );
      console.log(`         ${row.statement}`);
      if (row.note) console.log(`         — ${row.note}`);
    }
    console.log();
  }
}

console.log(
  "assertsGold is an unreviewed diagnostic draft. It may not carry an accuracy\n" +
    "or quality claim without a line-by-line review first (§9.4)."
);
