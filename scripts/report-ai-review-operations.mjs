// AI Review operational trend, read from a production-like database.
//
// docs/policy/ai-review-m5-quality-contract.md §8.
//
// The reliability half of the M5 scorecard, over the 7/30/90-day windows, plus
// the adoption half beside it -- never mixed into one score. Reliability comes
// from `ComparisonReviewRun`, which the server writes on the path that calls
// the model. Adoption comes from `ProductAnalyticsEvent`, which needs the
// user's analytics consent and a browser that stayed open. Folding the two
// together would make a consent decision look like an outage.
//
// Read-only: every query is a findMany or a count, and nothing here writes to
// the register, a feature flag or a release gate. Approval is a person's act
// recorded elsewhere, and a report that edited its own subject would destroy
// the audit trail the register exists for.
//
// Usage:
//   npm run report:ai-review-operations
//   npm run report:ai-review-operations -- --window=30
//   npm run report:ai-review-operations -- --json

import {
  AI_REVIEW_SCORECARD_WINDOWS,
  readAiReviewScorecard,
} from "../lib/aiReviewScorecard.ts";

const argValue = (name, fallback = "") => {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};
const asJson = process.argv.includes("--json");

const requested = argValue("window");
const windows = requested
  ? [Number(requested)]
  : [...AI_REVIEW_SCORECARD_WINDOWS];
for (const value of windows) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    console.error(`--window must be a positive integer of days (got "${requested}").`);
    process.exit(1);
  }
}

const pct = (metric) =>
  metric.status === "ok"
    ? `${(metric.value * 100).toFixed(1)}%  (${metric.numerator}/${metric.denominator} ${metric.denominatorLabel})`
    : `insufficient_evidence  (${metric.denominator} of ${metric.minimumDenominator} ${metric.denominatorLabel})`;

const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);

// The attempted-write total, counted somewhere other than the run table.
//
// The run table cannot supply its own denominator: a writer whose every write
// failed leaves no rows and therefore no gap to find. The
// `comparison_review_run` structured log line is emitted for every run BEFORE
// its write, so the log platform's count of that event over the same window is
// the independent total. Without it the report says completeness is unknown,
// which is the honest answer and not a zero.
const attemptedWrites = argValue("attempted-writes")
  ? Number(argValue("attempted-writes"))
  : null;
const attemptedWritesSource = argValue("attempted-writes-source") || null;
if (attemptedWrites !== null && !Number.isInteger(attemptedWrites)) {
  console.error("--attempted-writes must be a whole number.");
  process.exit(1);
}
if (attemptedWrites !== null && !attemptedWritesSource) {
  console.error(
    "--attempted-writes-source is required with --attempted-writes: a total " +
      "nobody can trace back to a query is not evidence."
  );
  process.exit(1);
}
// One total cannot describe three windows.
//
// The report defaults to 7, 30 and 90 days. A single --attempted-writes reused
// across all three would be right for at most one of them and would silently
// become a 90-day count applied to the 7-day window, or the reverse. So a
// total requires the window it was counted over.
if (attemptedWrites !== null && windows.length !== 1) {
  console.error(
    "--attempted-writes describes one window, so --window=<days> is required with it.\n" +
      "Counting once and reusing the figure across 7, 30 and 90 days would be right " +
      "for at most one of them."
  );
  process.exit(1);
}

const cards = [];
for (const windowDays of windows) {
  const card = await readAiReviewScorecard(windowDays, new Date(), {
    attemptedWrites,
    attemptedWritesSource,
  });
  cards.push(card);
  if (asJson) continue;

  console.log(`\n=== AI Review — last ${windowDays} day(s) ===`);

  console.log("\nReliability  (server-recorded runs)");
  line("runs recorded", card.reliability.runs);
  line("  guest / account", `${card.reliability.guestRuns} / ${card.reliability.accountRuns}`);
  for (const [outcome, count] of Object.entries(card.reliability.byOutcome).sort()) {
    line(`  ${outcome}`, count);
  }
  line("completion rate", pct(card.reliability.completionRate));
  if (card.reliability.completionRate.excluded) {
    line("  excluded", card.reliability.completionRate.excluded);
  }
  line("primary-only completion", pct(card.reliability.primaryOnlyRate));
  line("dual review available", pct(card.reliability.dualAvailabilityRate));
  line("dual review completed", pct(card.reliability.dualCompletionRate));
  line("cached", pct(card.reliability.cachedRate));
  line("attempts that retried", pct(card.reliability.retryRate));
  // Printed first among the reliability figures, because it qualifies every
  // one of them: a rate above zero here means the numbers below are computed
  // over an incomplete sample.
  // Detection first, because it qualifies every figure under it: a gap above
  // zero means the numbers below are computed over an incomplete sample.
  const gaps = card.reliability.detectedTraceGaps;
  line(
    "telemetry writes provably lost",
    `${gaps.missing} of ${gaps.withinSpans} across ${gaps.writers} writer(s)`
  );
  line(
    "telemetry completeness",
    card.reliability.traceCompleteness
      ? `${pct(card.reliability.traceCompleteness)}  attested by ${card.reliability.traceCompletenessSource}`
      : card.reliability.traceCompletenessProblem
        ? `REFUSED — ${card.reliability.traceCompletenessProblem}`
        : "unknown — pass --attempted-writes=<n> --attempted-writes-source=<text> " +
          "--window=<days>; zero detected gaps is not evidence of none"
  );
  line("unreconciled settlements", pct(card.reliability.unreconciledSettlements));
  line("credits resolved wrongly", pct(card.reliability.creditReconciliation));
  line("  settled above reservation", pct(card.reliability.overSettledRate));
  line("  failed but not refunded", pct(card.reliability.unrefundedFailureRate));
  line(
    "duration p50 / p95 (ms)",
    `${card.reliability.p50DurationMs ?? "n/a"} / ${card.reliability.p95DurationMs ?? "n/a"}`
  );
  if (card.reliability.reviewerHealth.length === 0) {
    line("reviewer health", "no attempt reached a provider in this window");
  }
  for (const reviewer of card.reliability.reviewerHealth) {
    line(
      `  ${reviewer.reviewerModelId} (${reviewer.provider ?? "?"})`,
      `${reviewer.failures}/${reviewer.attempts} failed — ${pct(reviewer.failureRate)}`
    );
  }

  console.log("\nTelemetry coverage  (a comparison, never a reliability rate)");
  line("server runs", card.coverage.serverRuns);
  line("client 'review started' events", card.coverage.clientStartedEvents);
  line("client / server", pct(card.coverage.ratio));

  console.log("\nQuality  (from the reviewer-pair register)");
  line("approved pairs", card.quality.approvedPairCount);
  line("candidate pairs", card.quality.candidatePairCount);
  line("dataset version", card.quality.datasetVersion ?? "none — no pair is approved");
  line("independent run ordinals", card.quality.independentRunOrdinals.join(", ") || "none");
  line(
    "critical violations",
    card.quality.zeroToleranceViolations === null
      ? "not measured — no approved pair"
      : card.quality.zeroToleranceViolations
  );
  line("served pairs match approved", card.quality.drift.inSync ? "yes" : "NO");
  if (!card.quality.drift.inSync) {
    line("  served but not approved", card.quality.drift.servedButNotApproved.join(", ") || "none");
    line("  approved but not served", card.quality.drift.approvedButNotServed.join(", ") || "none");
  }

  console.log("\nAdoption and value  (consented client analytics)");
  line("weekly active review users", card.adoption.weeklyActiveReviewUsers);
  line("comparison → review", pct(card.adoption.comparisonToReview));
  line("review → follow-up", pct(card.adoption.reviewToFollowUp));
  line("review → save or share", pct(card.adoption.reviewToSaveOrShare));
  line("review → item web check", pct(card.adoption.reviewToItemWebCheck));
  line("first → second review", pct(card.adoption.firstToSecondReview));
  line("D1 after first review", pct(card.adoption.reviewAnchoredReturnDay1));
  line("D7 after first review", pct(card.adoption.reviewAnchoredReturnDay7));
  line("D30 after first review", pct(card.adoption.reviewAnchoredReturnDay30));
  line("D7 by account age", pct(card.adoption.accountAgeReturnDay7));
  line("D7, comparison-only cohort", pct(card.adoption.cohortReturnDay7.comparisonOnly));
  line("D7, AI Review cohort", pct(card.adoption.cohortReturnDay7.aiReview));
  console.log(
    "  note the two cohorts self-selected. A difference between them is a\n" +
      "       difference in who used the feature as much as in what it did for them.\n" +
      "       Conversions are ordered (the second event follows the first), which is\n" +
      "       the strongest claim these events support: they carry no conversation id.\n" +
      "       'by account age' is anchored on the account, not the review, and is not\n" +
      "       review retention."
  );
}

if (asJson) {
  console.log(JSON.stringify(cards, null, 2));
} else {
  console.log(
    "\nNothing above was written anywhere. Register status, feature flags and\n" +
      "release gates are changed by people, and a report that edited its own\n" +
      "subject would erase the audit trail the register exists for."
  );
}
