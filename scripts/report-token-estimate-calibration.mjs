// Reads dual-estimate shadow samples and prints the calibration report (G1
// step 2/3).
//
// A thin wrapper. Everything that decides what a number means lives in
// lib/tokenEstimateCalibration.ts, so the thresholds cannot drift between the
// query and the analysis, and so the analysis stays testable without a
// database.
//
// Needs DATABASE_URL, so it runs where the data is rather than in CI. It is a
// report and never fails a build; the only non-zero exit is a database it
// cannot reach.
//
// Usage:
//   npm run report:token-estimate-calibration
//   npm run report:token-estimate-calibration -- --since 2026-08-01 --json

import { prisma } from "../lib/prisma.ts";
import { buildCalibrationReport } from "../lib/tokenEstimateCalibration.ts";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const sinceIndex = args.indexOf("--since");
const since = sinceIndex >= 0 ? args[sinceIndex + 1] : null;
const limitIndex = args.indexOf("--limit");
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 200_000;

if (since && Number.isNaN(Date.parse(since))) {
  console.error(`FAIL: --since "${since}" is not a date.`);
  process.exit(1);
}

const percent = (value) => `${value.toFixed(1)}%`;
const rate = (value) => `${(value * 100).toFixed(1)}%`;

let samples;
try {
  samples = await prisma.tokenEstimateShadowSample.findMany({
    where: since ? { createdAt: { gte: new Date(since) } } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
} catch (cause) {
  console.error(
    "FAIL: could not read TokenEstimateShadowSample. This report runs where the " +
      "data is and needs DATABASE_URL."
  );
  console.error(cause instanceof Error ? cause.message : cause);
  process.exit(1);
}

const report = buildCalibrationReport(samples);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  await prisma.$disconnect();
  process.exit(0);
}

console.log(
  `\nshadow samples: ${report.totalSamples} read${since ? ` since ${since}` : ""}, ` +
    `${report.eligibleSamples} eligible for calibration.`
);

// Exclusions are printed before the results on purpose. If one provider or
// every long request was dropped, the numbers below describe a biased sample,
// and that has to be visible before anyone reads them.
const exclusionEntries = Object.entries(report.exclusionsByReason);
if (exclusionEntries.length === 0) {
  console.log("excluded: none.");
} else {
  console.log("excluded:");
  for (const [reason, count] of exclusionEntries.sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(7)}  ${reason}`);
  }
  const byProvider = Object.entries(report.exclusionsByProvider).sort((a, b) => b[1] - a[1]);
  if (byProvider.length > 0) {
    console.log(
      "  by provider: " + byProvider.map(([provider, count]) => `${provider} ${count}`).join(", ")
    );
  }
}

if (report.cohorts.length === 0) {
  console.log("\nNo eligible samples yet. Enable TOKEN_ESTIMATE_SHADOW_ENABLED and let traffic run.");
  await prisma.$disconnect();
  process.exit(0);
}

console.log("\nper tokenizer family and content cohort (raw estimates only):\n");
console.log(
  "  " +
    "family".padEnd(22) +
    "cohort".padEnd(19) +
    "n".padStart(7) +
    "ctl p50".padStart(9) +
    "cnd p50".padStart(9) +
    "ctl p95".padStart(9) +
    "cnd p95".padStart(9) +
    "under".padStart(8) +
    "Q99".padStart(7) +
    "margin".padStart(8) +
    "  status"
);

for (const cohort of report.cohorts) {
  console.log(
    "  " +
      cohort.tokenizerFamily.padEnd(22) +
      cohort.contentCohort.padEnd(19) +
      String(cohort.sampleCount).padStart(7) +
      percent(cohort.control.medianAbsoluteErrorPercent).padStart(9) +
      percent(cohort.candidate.medianAbsoluteErrorPercent).padStart(9) +
      percent(cohort.control.p95AbsoluteErrorPercent).padStart(9) +
      percent(cohort.candidate.p95AbsoluteErrorPercent).padStart(9) +
      rate(cohort.candidate.underestimateRate).padStart(8) +
      cohort.candidateQ99ActualOverRaw.toFixed(2).padStart(7) +
      cohort.recommendedReservationMultiplier.toFixed(2).padStart(8) +
      `  ${cohort.status}`
  );
  for (const reason of cohort.underpoweredReasons) {
    console.log(`      - ${reason}`);
  }
}

console.log(
  "\n  ctl/cnd = control and candidate raw estimates. under = share of candidate\n" +
    "  estimates below what the provider billed. margin = recommended reservation\n" +
    "  multiplier for this cohort; a provisional floor until the family is powered."
);

console.log(
  "\nESTIMATE-01 wants median <= 5% and ESTIMATE-02 p95 <= 15%, per cohort. An\n" +
    "aggregate is deliberately not printed: a large Latin sample would carry a\n" +
    "Hangul failure past the gate."
);

await prisma.$disconnect();
