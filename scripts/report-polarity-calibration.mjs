// What does the proximity rule get right, at each K?
//
//   npm run report:polarity-calibration
//   npm run report:polarity-calibration -- --json
//   npm run report:polarity-calibration -- --k ko=12,en=24
//
// Reads POLARITY_CALIBRATION_CASES and nothing else. It never reads a dataset,
// never calls a provider, and writes no file -- see
// `.github/audits/memory-eval-gold-contract-2026-08-27.md` §9 for why K may not
// be chosen on mem-eval-succ-3's own output.
//
// The curve is the whole point, not the maximum. A K that scores highest by a
// single item is not a better rule than its neighbour; a K on a plateau is. So
// the report separates the three populations that a single accuracy number
// hides:
//
//   * K-invariant right  -- correct at every K. The rule is not what decides
//                           these, so they inflate any accuracy figure equally
//                           and say nothing about the choice.
//   * K-invariant wrong  -- wrong at every K. No distance reaches these, and
//                           the answer is a contract clause forbidding golds of
//                           that shape, not a larger K.
//   * K-sensitive        -- the only items the choice is actually made on. They
//                           are listed individually, with the gap that decides
//                           each, because a decision made on four sentences
//                           should be readable as four sentences.

import { POLARITY_CALIBRATION_CASES } from "../lib/memoryEvalPolarityCalibration/corpus.ts";
import {
  polarityGap,
  polarityMatches,
} from "../lib/memoryEvalPolarityCalibration/distance.ts";

const json = process.argv.includes("--json");

// 0 to 40 characters. The upper bound is not a belief about language -- it is
// past the length of every statement in the corpus measured without spaces, so
// the curve is guaranteed to reach its own ceiling and stop moving. A rule that
// still improved at 40 would be one accepting any marker anywhere, which is the
// global scan this distance exists to replace.
const K_MAX = 40;
const K_RANGE = Array.from({ length: K_MAX + 1 }, (_, k) => k);
const LANGUAGES = /** @type {const} */ (["ko", "en"]);

const requestedArg = process.argv.find((arg) => arg.startsWith("--k"));
const parseRequested = () => {
  if (!requestedArg) return null;
  const raw = requestedArg.includes("=")
    ? requestedArg.slice(requestedArg.indexOf("=") + 1)
    : process.argv[process.argv.indexOf(requestedArg) + 1];
  if (!raw) return null;
  /** @type {Record<string, number>} */
  const out = {};
  for (const pair of raw.split(",")) {
    const [language, value] = pair.split(":").length === 2
      ? pair.split(":")
      : pair.split("=");
    const parsed = Number.parseInt(value ?? "", 10);
    if (!LANGUAGES.includes(language) || !Number.isInteger(parsed)) {
      console.error(`Unreadable --k segment: ${pair}`);
      process.exit(2);
    }
    out[language] = parsed;
  }
  return out;
};
const requested = parseRequested();

const predict = (testCase, k) =>
  polarityMatches({
    statement: testCase.statement,
    factValueAll: testCase.factValueAll,
    language: testCase.language,
    polarity: testCase.goldPolarity,
    k,
  });

const evaluated = POLARITY_CALIBRATION_CASES.map((testCase) => {
  const gap = polarityGap({
    statement: testCase.statement,
    factValueAll: testCase.factValueAll,
    language: testCase.language,
  });
  const correctAt = new Set(
    K_RANGE.filter((k) => predict(testCase, k) === testCase.assertsGold)
  );
  return {
    case: testCase,
    gap,
    correctAt,
    sensitivity:
      correctAt.size === K_RANGE.length
        ? "invariant_right"
        : correctAt.size === 0
          ? "invariant_wrong"
          : "sensitive",
  };
});

const curve = LANGUAGES.map((language) => {
  const rows = evaluated.filter((row) => row.case.language === language);
  return {
    language,
    total: rows.length,
    invariantRight: rows.filter((r) => r.sensitivity === "invariant_right").length,
    invariantWrong: rows.filter((r) => r.sensitivity === "invariant_wrong").length,
    sensitive: rows.filter((r) => r.sensitivity === "sensitive").length,
    points: K_RANGE.map((k) => ({
      k,
      correct: rows.filter((r) => r.correctAt.has(k)).length,
      // Out of the sensitive population only: the figure the choice is
      // actually made on, undiluted by items no K affects.
      sensitiveCorrect: rows.filter(
        (r) => r.sensitivity === "sensitive" && r.correctAt.has(k)
      ).length,
    })),
  };
});

// The plateau, not the peak: the widest run of K with the top score, and the
// value in the middle of it. A choice at a plateau's edge is one item away from
// a different rule.
const plateaus = curve.map((entry) => {
  const best = Math.max(...entry.points.map((point) => point.correct));
  /** @type {{from: number, to: number}[]} */
  const runs = [];
  for (const point of entry.points) {
    if (point.correct !== best) continue;
    const last = runs.at(-1);
    if (last && last.to === point.k - 1) last.to = point.k;
    else runs.push({ from: point.k, to: point.k });
  }
  const widest = runs.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
  return {
    language: entry.language,
    best,
    total: entry.total,
    runs,
    widest,
    midpoint: Math.floor((widest.from + widest.to) / 2),
  };
});

// The window, not the accuracy.
//
// Accuracy over the whole corpus answers a question nobody asked: the corpus
// is not a sample of anything, so 17/30 is a fact about how many sentences of
// each shape were written, not about the rule. What decides K is narrower and
// exact.
//
// A gold may only rest on a statement that plainly asserts or plainly denies
// (§9.2 puts that in the contract). For those two shapes the requirement is
// two-sided and admits no judgement:
//
//   * every negative must be caught      -> K >= its gap
//   * no affirmative may be caught       -> K <  its gap
//
// So the feasible window is [max negative gap, min affirmative gap - 1]. If it
// is empty, no K exists and the rule does not work for that language -- which
// is a finding, not a tuning problem. The other three shapes are reported
// separately because no K is claimed to handle them.
const CONTRACT_SHAPES = new Set(["affirmative", "negative"]);

const windows = LANGUAGES.map((language) => {
  const rows = evaluated.filter(
    (row) => row.case.language === language && CONTRACT_SHAPES.has(row.case.shape)
  );
  const negatives = rows.filter((row) => row.case.shape === "negative" && row.gap !== null);
  const affirmatives = rows.filter(
    (row) => row.case.shape === "affirmative" && row.gap !== null
  );
  const floor = negatives.length === 0 ? 0 : Math.max(...negatives.map((r) => r.gap));
  const ceiling =
    affirmatives.length === 0
      ? K_MAX
      : Math.min(...affirmatives.map((r) => r.gap)) - 1;
  const binds = (list, value) =>
    list.filter((row) => row.gap === value).map((row) => row.case.id);
  return {
    language,
    floor,
    ceiling,
    feasible: floor <= ceiling,
    width: ceiling - floor + 1,
    floorSetBy: binds(negatives, floor),
    ceilingSetBy: binds(affirmatives, ceiling + 1),
    negatives: negatives.length,
    affirmatives: affirmatives.length,
    // Affirmatives carrying no marker at all constrain nothing, and a window
    // held open only by their absence would be one the corpus never tested.
    unmarkedAffirmatives: rows.filter(
      (row) => row.case.shape === "affirmative" && row.gap === null
    ).length,
  };
});

const byShape = LANGUAGES.flatMap((language) =>
  [...new Set(POLARITY_CALIBRATION_CASES.map((c) => c.shape))].map((shape) => {
    const rows = evaluated.filter(
      (row) => row.case.language === language && row.case.shape === shape
    );
    return {
      language,
      shape,
      total: rows.length,
      // How many of this shape any single K can get right at once.
      bestSimultaneous: Math.max(
        ...K_RANGE.map((k) => rows.filter((row) => row.correctAt.has(k)).length)
      ),
      inContract: CONTRACT_SHAPES.has(shape),
    };
  })
);

const report = {
  windows,
  byShape,
  corpus: POLARITY_CALIBRATION_CASES.length,
  kMax: K_MAX,
  curve,
  plateaus,
  sensitive: evaluated
    .filter((row) => row.sensitivity === "sensitive")
    .map((row) => ({
      id: row.case.id,
      language: row.case.language,
      shape: row.case.shape,
      gap: row.gap,
      assertsGold: row.case.assertsGold,
      goldPolarity: row.case.goldPolarity,
      statement: row.case.statement,
      correctFrom: Math.min(...row.correctAt),
      correctTo: Math.max(...row.correctAt),
    })),
  unreachable: evaluated
    .filter((row) => row.sensitivity === "invariant_wrong")
    .map((row) => ({
      id: row.case.id,
      language: row.case.language,
      shape: row.case.shape,
      gap: row.gap,
      assertsGold: row.case.assertsGold,
      goldPolarity: row.case.goldPolarity,
      statement: row.case.statement,
    })),
  requested: requested
    ? LANGUAGES.filter((language) => language in requested).map((language) => {
        const k = requested[language];
        const rows = evaluated.filter((row) => row.case.language === language);
        return {
          language,
          k,
          correct: rows.filter((row) => row.correctAt.has(k)).length,
          total: rows.length,
          wrong: rows
            .filter((row) => !row.correctAt.has(k))
            .map((row) => ({
              id: row.case.id,
              shape: row.case.shape,
              gap: row.gap,
              assertsGold: row.case.assertsGold,
              goldPolarity: row.case.goldPolarity,
              statement: row.case.statement,
              reachable: row.sensitivity === "sensitive",
            })),
        };
      })
    : null,
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(`Polarity calibration -- ${report.corpus} cases, K in 0..${K_MAX}\n`);

console.log("## Feasible window -- plain assertions and plain denials only\n");
for (const window of windows) {
  console.log(
    `   ${window.language}: floor ${window.floor} (${window.floorSetBy.join(", ") || "no negative carries a marker"})`
  );
  console.log(
    `       ceiling ${window.ceiling} (${window.ceilingSetBy.join(", ") || "no affirmative carries a marker"})`
  );
  console.log(
    window.feasible
      ? `       K in ${window.floor}..${window.ceiling}  (${window.width} value${window.width === 1 ? "" : "s"}${window.width === 1 ? ", no margin" : ""})\n`
      : `       EMPTY -- no K satisfies both. The rule does not work for ${window.language}.\n`
  );
}

console.log("## What one K can get right, by shape\n");
for (const row of byShape) {
  console.log(
    `   ${row.language} ${row.shape.padEnd(16)} ${row.bestSimultaneous}/${row.total}${row.inContract ? "" : "   (out of contract -- no K is claimed for these)"}`
  );
}
console.log();

for (const entry of curve) {
  const plateau = plateaus.find((p) => p.language === entry.language);
  console.log(`## ${entry.language}  (${entry.total} cases)`);
  console.log(
    `   decided by K: ${entry.sensitive}   right at every K: ${entry.invariantRight}   wrong at every K: ${entry.invariantWrong}`
  );
  // One line per K that differs from its predecessor: a 41-row table of which
  // 35 rows repeat is a table nobody reads.
  let previous = null;
  for (const point of entry.points) {
    if (previous !== null && point.correct === previous) continue;
    previous = point.correct;
    const bar = "#".repeat(point.correct);
    console.log(
      `   K>=${String(point.k).padStart(2)}  ${String(point.correct).padStart(2)}/${entry.total}  ${bar}`
    );
  }
  console.log(
    `   best ${plateau.best}/${plateau.total} on ${plateau.runs
      .map((run) => (run.from === run.to ? `${run.from}` : `${run.from}-${run.to}`))
      .join(", ")}   widest run ${plateau.widest.from}-${plateau.widest.to}, midpoint ${plateau.midpoint}\n`
  );
}

if (report.sensitive.length > 0) {
  console.log("## Decided by K");
  for (const row of report.sensitive) {
    console.log(
      `   ${row.id.padEnd(18)} ${row.shape.padEnd(16)} gap ${String(row.gap).padStart(3)}  correct for K ${row.correctFrom}-${row.correctTo === K_MAX ? `${K_MAX}+` : row.correctTo}`
    );
    console.log(`      ${row.statement}`);
  }
  console.log();
}

if (report.unreachable.length > 0) {
  console.log("## Wrong at every K -- no distance reaches these");
  for (const row of report.unreachable) {
    console.log(
      `   ${row.id.padEnd(18)} ${row.shape.padEnd(16)} gap ${String(row.gap).padStart(3)}  gold ${row.goldPolarity}, asserts ${row.assertsGold}`
    );
    console.log(`      ${row.statement}`);
  }
  console.log();
}

if (report.requested) {
  console.log("## Requested K");
  for (const entry of report.requested) {
    console.log(`   ${entry.language}=${entry.k}: ${entry.correct}/${entry.total}`);
    for (const row of entry.wrong) {
      console.log(
        `      ${row.id.padEnd(18)} ${row.shape.padEnd(16)} gap ${String(row.gap).padStart(3)}  ${row.reachable ? "another K would fix this" : "no K fixes this"}`
      );
      console.log(`         ${row.statement}`);
    }
  }
}
