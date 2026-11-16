import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_ANALYSIS_MAX_AGE_MS,
  AMUX_ANALYSIS_OPEN_MAX_AGE_MS,
  amuxAnalysisEnded,
  amuxAnalysisEndedWhere,
  amuxAnalysisMaxAgeMs,
  amuxSessionContentPurgeDue,
  amuxSessionContentRetentionDays,
  amuxSessionContentRetentionMs,
  analysisCanContinue,
  analysisDeadlineAt,
  decidedDraftPurgeAt,
  draftDecisionAllowed,
  effectiveAnalysisTerminationAt,
  expiredUndecidedDraftPurgeWindow,
  executionBriefPurgeAt,
  holdTimeWindow,
  planDraftUnitRetention,
  purgeDisposition,
  rawPurgeBy,
  rawPurgeEligibleAt,
  shouldAutoCancelAnalysis,
  shouldExpireUndecidedDraft,
  undecidedDraftExpiresAt,
} from "../lib/amux/ideaRetentionCore.ts";

const base = new Date("2026-10-01T00:00:00.000Z");
const at = (days, hours = 0) => new Date(base.getTime() + days * 86_400_000 + hours * 3_600_000);
/** A row written before 2026-11-15, or under the legacy switch. */
const seven = { submittedAt: base, analysisDeadlineAt: at(7) };
/** A row written under the owner direction of 2026-11-15. */
const open = { submittedAt: base, analysisDeadlineAt: at(36_500) };

test("a seven-day row still cancels at its stored day seven, independent of activity", () => {
  assert.equal(analysisDeadlineAt(base, true).toISOString(), at(7).toISOString());
  assert.equal(analysisCanContinue({ ...seven, analysisCompletedAt: null, cancelledAt: null, dbNow: new Date(at(7).getTime() - 1) }), true);
  assert.equal(analysisCanContinue({ ...seven, analysisCompletedAt: null, cancelledAt: null, dbNow: at(7) }), false);
  assert.equal(shouldAutoCancelAnalysis({ ...seven, analysisCompletedAt: null, cancelledAt: null, dbNow: new Date(at(7).getTime() - 1) }), false);
  assert.equal(shouldAutoCancelAnalysis({ ...seven, analysisCompletedAt: null, cancelledAt: null, dbNow: at(7) }), true);
  assert.equal(shouldAutoCancelAnalysis({ ...seven, analysisCompletedAt: at(6), cancelledAt: null, dbNow: at(8) }), false);
  assert.equal(shouldAutoCancelAnalysis({ ...seven, analysisCompletedAt: null, cancelledAt: at(6), dbNow: at(8) }), false);
  assert.equal(rawPurgeEligibleAt({ ...seven, analysisCompletedAt: null, cancelledAt: null, dbNow: at(6) }), null);
  assert.equal(rawPurgeBy({ ...seven, analysisCompletedAt: null, cancelledAt: null, dbNow: at(6) }), null);
  assert.equal(effectiveAnalysisTerminationAt({ ...seven, analysisCompletedAt: null, cancelledAt: null, dbNow: at(9) })?.toISOString(), at(7).toISOString());
  assert.equal(rawPurgeEligibleAt({ ...seven, analysisCompletedAt: null, cancelledAt: null, dbNow: at(7) })?.toISOString(), at(7).toISOString());
  assert.equal(purgeDisposition({ purgeAt: rawPurgeEligibleAt({ ...seven, analysisCompletedAt: null, cancelledAt: null, dbNow: at(7) }), purgedAt: null, activeHoldExpiresAt: null, dbNow: at(7) }), "due");
  assert.equal(rawPurgeBy({ ...seven, analysisCompletedAt: null, cancelledAt: null, dbNow: at(9) })?.toISOString(), at(8).toISOString());
  assert.equal(rawPurgeBy({ ...seven, analysisCompletedAt: null, cancelledAt: at(9), dbNow: at(9) })?.toISOString(), at(8).toISOString());
  assert.equal(rawPurgeBy({ ...seven, analysisCompletedAt: at(5), cancelledAt: null, dbNow: at(9) })?.toISOString(), at(6).toISOString());
});

test("a new idea's analysis goes on past day seven and ends only when it completes or is cancelled", () => {
  // Owner direction 2026-11-15: a hundred-year deadline, stored once.
  assert.equal(analysisDeadlineAt(base, false).toISOString(), at(36_500).toISOString());
  assert.equal(AMUX_ANALYSIS_OPEN_MAX_AGE_MS, 36_500 * 86_400_000);
  assert.equal(amuxAnalysisMaxAgeMs(true), AMUX_ANALYSIS_MAX_AGE_MS);
  assert.ok(Number.isFinite(analysisDeadlineAt(new Date("2026-11-15T00:00:00.000Z"), false).getTime()));
  for (const day of [7, 8, 30, 365]) {
    assert.equal(analysisCanContinue({ ...open, analysisCompletedAt: null, cancelledAt: null, dbNow: at(day) }), true);
    assert.equal(shouldAutoCancelAnalysis({ ...open, analysisCompletedAt: null, cancelledAt: null, dbNow: at(day) }), false);
    assert.equal(rawPurgeEligibleAt({ ...open, analysisCompletedAt: null, cancelledAt: null, dbNow: at(day) }), null);
    assert.equal(amuxAnalysisEnded({ ...open, analysisCompletedAt: null, cancelledAt: null, dbNow: at(day) }), false);
  }
  // A completed or cancelled analysis keeps its termination clocks.
  assert.equal(rawPurgeBy({ ...open, analysisCompletedAt: at(40), cancelledAt: null, dbNow: at(41) })?.toISOString(), at(41).toISOString());
  assert.equal(rawPurgeEligibleAt({ ...open, analysisCompletedAt: null, cancelledAt: at(12), dbNow: at(12) })?.toISOString(), at(12).toISOString());
  assert.equal(analysisCanContinue({ ...open, analysisCompletedAt: at(40), cancelledAt: null, dbNow: at(41) }), false);
});

test("the stored deadline decides, not the switch: a seven-day row is never extended or shortened", () => {
  // The switch only chooses a new submission's deadline.
  assert.equal(shouldAutoCancelAnalysis({ ...seven, analysisCompletedAt: null, cancelledAt: null, dbNow: at(7) }), true);
  assert.equal(shouldAutoCancelAnalysis({ ...open, analysisCompletedAt: null, cancelledAt: null, dbNow: at(7) }), false);
  assert.equal(amuxAnalysisEnded({ ...seven, analysisCompletedAt: null, cancelledAt: null, dbNow: at(7) }), true);
});

test("session content is kept ninety days after intake, and never while its analysis runs", () => {
  assert.equal(amuxSessionContentRetentionDays(false), 90);
  assert.equal(amuxSessionContentRetentionDays(true), 7);
  assert.equal(amuxSessionContentRetentionMs(false), 90 * 86_400_000);
  const ended = { ...open, analysisCompletedAt: at(3), cancelledAt: null };
  assert.equal(amuxSessionContentPurgeDue({ ...ended, dbNow: at(7), legacy: false }), false);
  assert.equal(amuxSessionContentPurgeDue({ ...ended, dbNow: at(89, 23), legacy: false }), false);
  assert.equal(amuxSessionContentPurgeDue({ ...ended, dbNow: at(90), legacy: false }), true);
  // Past retention, a running analysis keeps it until it ends.
  const running = { ...open, analysisCompletedAt: null, cancelledAt: null };
  assert.equal(amuxSessionContentPurgeDue({ ...running, dbNow: at(200), legacy: false }), false);
  assert.equal(amuxSessionContentPurgeDue({ ...running, dbNow: at(200), legacy: true }), false);
  assert.equal(amuxSessionContentPurgeDue({ ...running, cancelledAt: at(150), dbNow: at(200), legacy: false }), true);
  // Under the legacy switch a seven-day row purges on day seven, as before.
  const legacyRow = { ...seven, analysisCompletedAt: null, cancelledAt: null };
  assert.equal(amuxSessionContentPurgeDue({ ...legacyRow, dbNow: new Date(at(7).getTime() - 1), legacy: true }), false);
  assert.equal(amuxSessionContentPurgeDue({ ...legacyRow, dbNow: at(7), legacy: true }), true);
  // Nothing is ever due before day seven, whichever the switch.
  assert.equal(amuxSessionContentPurgeDue({ ...seven, analysisCompletedAt: at(1), cancelledAt: null, dbNow: at(6), legacy: true }), false);
  const where = amuxAnalysisEndedWhere(at(5));
  assert.deepEqual(where, { OR: [{ analysisCompletedAt: { not: null } }, { cancelledAt: { not: null } },
    { analysisDeadlineAt: { lte: at(5) } }] });
});

// Operator, 2026-11-16: an undecided draft keeps the open 36,500-day clock.
test("undecided draft expires only at the open horizon and its body is due within twenty-four hours", () => {
  const D = 36_500;
  assert.equal(undecidedDraftExpiresAt(base).toISOString(), at(D).toISOString());
  assert.equal(shouldExpireUndecidedDraft({ analysisCompletedAt: base, finalDecisionAt: null, alreadyExpired: false, dbNow: new Date(at(D).getTime() - 1) }), false);
  assert.equal(shouldExpireUndecidedDraft({ analysisCompletedAt: base, finalDecisionAt: null, alreadyExpired: false, dbNow: at(D) }), true);
  assert.equal(shouldExpireUndecidedDraft({ analysisCompletedAt: base, finalDecisionAt: at(D - 1), alreadyExpired: false, dbNow: at(D + 1) }), false);
  assert.equal(shouldExpireUndecidedDraft({ analysisCompletedAt: base, finalDecisionAt: at(D), alreadyExpired: false, dbNow: at(D + 1) }), true);
  assert.equal(shouldExpireUndecidedDraft({ analysisCompletedAt: base, finalDecisionAt: null, alreadyExpired: true, dbNow: at(D + 1) }), false);
  assert.equal(draftDecisionAllowed({ analysisCompletedAt: base, finalDecisionAt: null, alreadyExpired: false, dbNow: new Date(at(D).getTime() - 1) }), true);
  assert.equal(draftDecisionAllowed({ analysisCompletedAt: base, finalDecisionAt: null, alreadyExpired: false, dbNow: at(D) }), false);
  assert.equal(draftDecisionAllowed({ analysisCompletedAt: base, finalDecisionAt: at(D - 1), alreadyExpired: false, dbNow: at(D - 1) }), false);
  assert.equal(draftDecisionAllowed({ analysisCompletedAt: base, finalDecisionAt: null, alreadyExpired: true, dbNow: at(10) }), false);
  const purge = expiredUndecidedDraftPurgeWindow({ analysisCompletedAt: base, bodyFinalDecisionAt: null });
  assert.equal(purge?.eligibleAt.toISOString(), at(D).toISOString());
  assert.equal(purge?.purgeBy.toISOString(), at(D + 1).toISOString());
  assert.equal(purgeDisposition({ purgeAt: purge?.eligibleAt ?? null, purgedAt: null, activeHoldExpiresAt: null, dbNow: at(D) }), "due");
  assert.equal(expiredUndecidedDraftPurgeWindow({ analysisCompletedAt: base, bodyFinalDecisionAt: at(D - 1) }), null);
  assert.equal(expiredUndecidedDraftPurgeWindow({ analysisCompletedAt: base, bodyFinalDecisionAt: at(D) })?.purgeBy.toISOString(), at(D + 1).toISOString());
  assert.equal(expiredUndecidedDraftPurgeWindow({ analysisCompletedAt: base, bodyFinalDecisionAt: at(D + 10) })?.purgeBy.toISOString(), at(D + 1).toISOString());
  // A decided body still purges 30 days after its decision.
  assert.equal(decidedDraftPurgeAt(at(2)).toISOString(), at(32).toISOString());
  assert.equal(executionBriefPurgeAt(at(2)).toISOString(), at(92).toISOString());
});

test("a hold runs up to the open horizon and notice is seven days before or immediate", () => {
  assert.equal(holdTimeWindow({ createdAt: base, expiresAt: at(90) }).notifyAt?.toISOString(), at(83).toISOString());
  assert.equal(holdTimeWindow({ createdAt: base, expiresAt: at(365) }).valid, true);
  assert.equal(holdTimeWindow({ createdAt: base, expiresAt: at(36_500) }).notifyAt?.toISOString(), at(36_493).toISOString());
  assert.equal(holdTimeWindow({ createdAt: base, expiresAt: at(2) }).notifyAt?.toISOString(), base.toISOString());
  assert.equal(holdTimeWindow({ createdAt: base, expiresAt: at(36_500, 1) }).valid, false);
  assert.equal(holdTimeWindow({ createdAt: base, expiresAt: base }).valid, false);
});

test("expired hold does not restart a previously due purge clock", () => {
  assert.equal(purgeDisposition({ purgeAt: null, purgedAt: null, activeHoldExpiresAt: null, dbNow: at(2) }), "not_scheduled");
  assert.equal(purgeDisposition({ purgeAt: at(1), purgedAt: at(1), activeHoldExpiresAt: null, dbNow: at(2) }), "already_purged");
  assert.equal(purgeDisposition({ purgeAt: at(3), purgedAt: null, activeHoldExpiresAt: null, dbNow: at(2) }), "not_due");
  assert.equal(purgeDisposition({ purgeAt: at(1), purgedAt: null, activeHoldExpiresAt: at(3), dbNow: at(2) }), "held");
  assert.equal(purgeDisposition({ purgeAt: at(1), purgedAt: null, activeHoldExpiresAt: at(2), dbNow: at(2) }), "due");
});

test("unit cleanup plans keep each undecided body on its own absolute expiry", () => {
  const proposed = {
    state: "proposed", expiresAt: at(30), finalDecisionAt: null,
    bodyPurgeAfter: null, bodyPurgedAt: null, activeHoldExpiresAt: null,
  };
  const before = planDraftUnitRetention({ ...proposed, dbNow: new Date(at(30).getTime() - 1) });
  assert.equal(before.expireNow, false);
  assert.equal(before.bodyDisposition, "not_due");
  assert.equal(before.undecidedPurgeBy.toISOString(), at(31).toISOString());
  assert.equal(planDraftUnitRetention({ ...proposed, dbNow: at(29), activeHoldExpiresAt: at(35) }).bodyDisposition, "not_due");

  const atExpiry = planDraftUnitRetention({ ...proposed, dbNow: at(30) });
  assert.equal(atExpiry.expireNow, true);
  assert.equal(atExpiry.bodyDisposition, "due");
  assert.equal(atExpiry.unpurgedAtOrAfterOriginalDeadline, false);

  const held = planDraftUnitRetention({ ...proposed, dbNow: at(32), activeHoldExpiresAt: at(35) });
  assert.equal(held.expireNow, true);
  assert.equal(held.bodyDisposition, "held");
  assert.equal(held.unpurgedAtOrAfterOriginalDeadline, true);
  assert.equal(held.undecidedPurgeBy.toISOString(), at(31).toISOString());
  assert.equal(planDraftUnitRetention({ ...proposed, dbNow: at(35), activeHoldExpiresAt: at(35) }).bodyDisposition, "due");
});

test("independent unit plans use decided and undecided clocks without sharing state", () => {
  const approved = planDraftUnitRetention({
    state: "approved", expiresAt: at(30), finalDecisionAt: at(29),
    bodyPurgeAfter: at(59), bodyPurgedAt: null, activeHoldExpiresAt: null, dbNow: at(31),
  });
  assert.equal(approved.expireNow, false);
  assert.equal(approved.bodyDisposition, "not_due");
  assert.equal(approved.undecidedPurgeBy, null);
  const sibling = planDraftUnitRetention({
    state: "proposed", expiresAt: at(30), finalDecisionAt: null,
    bodyPurgeAfter: null, bodyPurgedAt: null, activeHoldExpiresAt: null, dbNow: at(31),
  });
  assert.equal(sibling.expireNow, true);
  assert.equal(sibling.bodyDisposition, "due");
  assert.equal(sibling.unpurgedAtOrAfterOriginalDeadline, true);

  const rejected = planDraftUnitRetention({
    state: "rejected", expiresAt: at(30), finalDecisionAt: at(20),
    bodyPurgeAfter: at(50), bodyPurgedAt: null, activeHoldExpiresAt: null, dbNow: at(50),
  });
  assert.equal(rejected.bodyDisposition, "due");
  assert.equal(rejected.undecidedPurgeBy, null);
  assert.equal(planDraftUnitRetention({
    state: "rejected", expiresAt: at(30), finalDecisionAt: at(20),
    bodyPurgeAfter: at(50), bodyPurgedAt: null, activeHoldExpiresAt: at(55), dbNow: at(50),
  }).bodyDisposition, "held");
  const expired = planDraftUnitRetention({
    state: "expired", expiresAt: at(30), finalDecisionAt: null,
    bodyPurgeAfter: at(30), bodyPurgedAt: at(30), activeHoldExpiresAt: null, dbNow: at(50),
  });
  assert.equal(expired.bodyDisposition, "already_purged");
  assert.equal(expired.unpurgedAtOrAfterOriginalDeadline, false);
});

test("unit retention planning rejects inconsistent state and clock pairs", () => {
  const proposed = {
    state: "proposed", expiresAt: at(30), finalDecisionAt: null,
    bodyPurgeAfter: null, bodyPurgedAt: null, activeHoldExpiresAt: null, dbNow: at(31),
  };
  assert.throws(() => planDraftUnitRetention({ ...proposed, bodyPurgeAfter: at(30) }));
  assert.throws(() => planDraftUnitRetention({ ...proposed, state: "expired" }));
  assert.throws(() => planDraftUnitRetention({ ...proposed, state: "expired", bodyPurgeAfter: at(30), dbNow: at(29) }));
  assert.throws(() => planDraftUnitRetention({ ...proposed, state: "approved", finalDecisionAt: at(29), bodyPurgeAfter: at(31) }));
  assert.throws(() => planDraftUnitRetention({ ...proposed, state: "expired", bodyPurgeAfter: at(30), bodyPurgedAt: at(29) }));
  assert.throws(() => planDraftUnitRetention({ ...proposed, state: "approved", finalDecisionAt: at(30), bodyPurgeAfter: at(60) }));
  assert.throws(() => planDraftUnitRetention({ ...proposed, state: "rejected", bodyPurgeAfter: at(60) }));
  assert.throws(() => planDraftUnitRetention({ ...proposed, bodyPurgedAt: at(31) }));
  assert.throws(() => planDraftUnitRetention({ ...proposed, activeHoldExpiresAt: new Date("invalid") }));
  assert.throws(() => planDraftUnitRetention({ ...proposed, state: "unknown" }));
  assert.throws(() => planDraftUnitRetention({ ...proposed, state: "approved", finalDecisionAt: at(29), bodyPurgeAfter: at(59), dbNow: at(28) }));
  assert.throws(() => planDraftUnitRetention({ ...proposed, state: "expired", bodyPurgeAfter: at(30), bodyPurgedAt: at(32), dbNow: at(31) }));
  assert.throws(() => planDraftUnitRetention({ ...proposed, expiresAt: new Date("invalid") }));
});

test("invalid or overflowing clocks fail closed", () => {
  assert.throws(() => analysisDeadlineAt(new Date("invalid")));
  assert.throws(() => analysisDeadlineAt(new Date(8_640_000_000_000_000)));
  assert.throws(() => holdTimeWindow({ createdAt: base, expiresAt: new Date("invalid") }));
});
