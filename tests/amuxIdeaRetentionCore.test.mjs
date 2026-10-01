import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("unfinished analysis cancels at absolute day seven, independent of activity", () => {
  assert.equal(analysisDeadlineAt(base).toISOString(), at(7).toISOString());
  assert.equal(analysisCanContinue({ submittedAt: base, analysisCompletedAt: null, cancelledAt: null, dbNow: new Date(at(7).getTime() - 1) }), true);
  assert.equal(analysisCanContinue({ submittedAt: base, analysisCompletedAt: null, cancelledAt: null, dbNow: at(7) }), false);
  assert.equal(shouldAutoCancelAnalysis({ submittedAt: base, analysisCompletedAt: null, cancelledAt: null, dbNow: new Date(at(7).getTime() - 1) }), false);
  assert.equal(shouldAutoCancelAnalysis({ submittedAt: base, analysisCompletedAt: null, cancelledAt: null, dbNow: at(7) }), true);
  assert.equal(shouldAutoCancelAnalysis({ submittedAt: base, analysisCompletedAt: at(6), cancelledAt: null, dbNow: at(8) }), false);
  assert.equal(shouldAutoCancelAnalysis({ submittedAt: base, analysisCompletedAt: null, cancelledAt: at(6), dbNow: at(8) }), false);
  assert.equal(rawPurgeEligibleAt({ submittedAt: base, analysisCompletedAt: null, cancelledAt: null, dbNow: at(6) }), null);
  assert.equal(rawPurgeBy({ submittedAt: base, analysisCompletedAt: null, cancelledAt: null, dbNow: at(6) }), null);
  assert.equal(effectiveAnalysisTerminationAt({ submittedAt: base, analysisCompletedAt: null, cancelledAt: null, dbNow: at(9) })?.toISOString(), at(7).toISOString());
  assert.equal(rawPurgeEligibleAt({ submittedAt: base, analysisCompletedAt: null, cancelledAt: null, dbNow: at(7) })?.toISOString(), at(7).toISOString());
  assert.equal(purgeDisposition({ purgeAt: rawPurgeEligibleAt({ submittedAt: base, analysisCompletedAt: null, cancelledAt: null, dbNow: at(7) }), purgedAt: null, activeHoldExpiresAt: null, dbNow: at(7) }), "due");
  assert.equal(rawPurgeBy({ submittedAt: base, analysisCompletedAt: null, cancelledAt: null, dbNow: at(9) })?.toISOString(), at(8).toISOString());
  assert.equal(rawPurgeBy({ submittedAt: base, analysisCompletedAt: null, cancelledAt: at(9), dbNow: at(9) })?.toISOString(), at(8).toISOString());
  assert.equal(rawPurgeBy({ submittedAt: base, analysisCompletedAt: at(5), cancelledAt: null, dbNow: at(9) })?.toISOString(), at(6).toISOString());
});

test("undecided draft expires after thirty days and its body is due within twenty-four hours", () => {
  assert.equal(undecidedDraftExpiresAt(base).toISOString(), at(30).toISOString());
  assert.equal(shouldExpireUndecidedDraft({ analysisCompletedAt: base, finalDecisionAt: null, alreadyExpired: false, dbNow: new Date(at(30).getTime() - 1) }), false);
  assert.equal(shouldExpireUndecidedDraft({ analysisCompletedAt: base, finalDecisionAt: null, alreadyExpired: false, dbNow: at(30) }), true);
  assert.equal(shouldExpireUndecidedDraft({ analysisCompletedAt: base, finalDecisionAt: at(29), alreadyExpired: false, dbNow: at(31) }), false);
  assert.equal(shouldExpireUndecidedDraft({ analysisCompletedAt: base, finalDecisionAt: at(30), alreadyExpired: false, dbNow: at(31) }), true);
  assert.equal(shouldExpireUndecidedDraft({ analysisCompletedAt: base, finalDecisionAt: null, alreadyExpired: true, dbNow: at(31) }), false);
  assert.equal(draftDecisionAllowed({ analysisCompletedAt: base, finalDecisionAt: null, alreadyExpired: false, dbNow: new Date(at(30).getTime() - 1) }), true);
  assert.equal(draftDecisionAllowed({ analysisCompletedAt: base, finalDecisionAt: null, alreadyExpired: false, dbNow: at(30) }), false);
  assert.equal(draftDecisionAllowed({ analysisCompletedAt: base, finalDecisionAt: at(29), alreadyExpired: false, dbNow: at(29) }), false);
  assert.equal(draftDecisionAllowed({ analysisCompletedAt: base, finalDecisionAt: null, alreadyExpired: true, dbNow: at(10) }), false);
  const purge = expiredUndecidedDraftPurgeWindow({ analysisCompletedAt: base, bodyFinalDecisionAt: null });
  assert.equal(purge?.eligibleAt.toISOString(), at(30).toISOString());
  assert.equal(purge?.purgeBy.toISOString(), at(31).toISOString());
  assert.equal(purgeDisposition({ purgeAt: purge?.eligibleAt ?? null, purgedAt: null, activeHoldExpiresAt: null, dbNow: at(30) }), "due");
  assert.equal(expiredUndecidedDraftPurgeWindow({ analysisCompletedAt: base, bodyFinalDecisionAt: at(29) }), null);
  assert.equal(expiredUndecidedDraftPurgeWindow({ analysisCompletedAt: base, bodyFinalDecisionAt: at(30) })?.purgeBy.toISOString(), at(31).toISOString());
  assert.equal(expiredUndecidedDraftPurgeWindow({ analysisCompletedAt: base, bodyFinalDecisionAt: at(40) })?.purgeBy.toISOString(), at(31).toISOString());
  assert.equal(decidedDraftPurgeAt(at(2)).toISOString(), at(32).toISOString());
  assert.equal(executionBriefPurgeAt(at(2)).toISOString(), at(92).toISOString());
});

test("hold is at most ninety days and notice is seven days before or immediate", () => {
  assert.equal(holdTimeWindow({ createdAt: base, expiresAt: at(90) }).notifyAt?.toISOString(), at(83).toISOString());
  assert.equal(holdTimeWindow({ createdAt: base, expiresAt: at(2) }).notifyAt?.toISOString(), base.toISOString());
  assert.equal(holdTimeWindow({ createdAt: base, expiresAt: at(90, 1) }).valid, false);
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
