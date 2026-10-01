import assert from "node:assert/strict";
import test from "node:test";

import {
  analysisCanContinue,
  analysisDeadlineAt,
  decidedDraftPurgeAt,
  draftDecisionAllowed,
  effectiveAnalysisTerminationAt,
  EXPIRED_UNDECIDED_DRAFT_BODY_PURGE,
  executionBriefPurgeAt,
  holdTimeWindow,
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

test("undecided draft expires after thirty days without silently scheduling its body purge", () => {
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
  assert.equal(EXPIRED_UNDECIDED_DRAFT_BODY_PURGE, "policy_decision_required");
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

test("invalid or overflowing clocks fail closed", () => {
  assert.throws(() => analysisDeadlineAt(new Date("invalid")));
  assert.throws(() => analysisDeadlineAt(new Date(8_640_000_000_000_000)));
  assert.throws(() => holdTimeWindow({ createdAt: base, expiresAt: new Date("invalid") }));
});
