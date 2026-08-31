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

const cards = [];
for (const windowDays of windows) {
  const card = await readAiReviewScorecard(windowDays);
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
