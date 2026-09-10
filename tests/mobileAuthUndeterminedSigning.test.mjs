// The decided rules for an undetermined signing half, vector by vector.
//
// Contract and vectors: `.github/audits/2026-09-09-mobile-auth-undetermined-
// signing-half-approval.md` section 7, G1-G11 approved 2026-09-10.
//
// **What these tests cover, stated before the first assertion.** They cover
// the *rules* -- classification, G3's six, the deadline arithmetic, and the
// three ways an answer can be missing. They do not cover the verifier's
// responses, the wrapper's retry, the non-disclosure of output, or the store
// entry's structure: those live in the implementations and are tested by
// calling them.
//
//   X2 · X3 · X3a · X8b · X8c · X12 · X13 · X13a  tests/mobileAuthDeploymentVerify.test.mjs
//                                                 and tests/mobileAuthDeploymentBinding.test.mjs
//   X10b · X10c                                   tests/mobileAuthenticatedFetch.test.mjs
//
// Handing this module a hoped-for input and getting the hoped-for answer
// proves the rule was written down correctly. It proves nothing about a
// deployment, and nothing here may be written up as though it did.

import assert from "node:assert/strict";
import test from "node:test";

import {
  MOBILE_F3_REQUIREMENTS,
  MOBILE_HOLD_DEADLINE_SECONDS,
  MOBILE_MISSING_ANSWER_KINDS,
  MOBILE_SIGNING_ROUND_CASES,
  classifyUndeterminedSigning,
  f2CompletionStatus,
  f3RequirementStatus,
  holdStatus,
} from "../scripts/mobile-auth-undetermined-signing-core.mjs";

/** The shape of a round that is squarely in this branch. */
const caseOne = (overrides = {}) => ({
  materialCheck: "passed",
  previousRefreshAxis: "passed",
  previousAccessAxis: "sample_expired",
  graceWindowRemainingSeconds: 400,
  ...overrides,
});

/** All six of G3 satisfied. */
const allSix = (overrides = {}) => ({
  materialCheck: "passed",
  signingBinding: "matched",
  pepperBinding: "matched",
  recoveryPathCheck: "passed",
  expiryObserved: true,
  graceWindowRemainingSeconds: 400,
  otherUndeterminedOrMismatched: false,
  ...overrides,
});

test("X1: item 6 passed, refresh passed, the access sample expired -- this branch, and not another", () => {
  const verdict = classifyUndeterminedSigning(caseOne());
  assert.equal(verdict.case, "case_1");
  assert.equal(verdict.rollback, false);
  assert.equal(verdict.previousGenerationQuestion, "undetermined");
  // Not a pass, and the field says so rather than leaving it to be inferred.
  assert.equal(verdict.recordedAsPass, false);
});

test("X3: a confirmed material mismatch is case 2, and case 1 is not even asked", () => {
  const verdict = classifyUndeterminedSigning(caseOne({ materialCheck: "mismatch_confirmed" }));
  assert.equal(verdict.case, "case_2");
  assert.equal(verdict.rollback, true);
  assert.equal(verdict.previousGenerationQuestion, undefined);
});

test("X3a: unjudgeable evidence is case 2', which is neither this branch nor a defect", () => {
  // The ordering is the rule: unjudgeable evidence is read before a mismatch,
  // because a mismatch found in evidence nobody can judge is a fact about the
  // evidence. Getting this backwards turns "collect it again" into "roll back".
  const verdict = classifyUndeterminedSigning(
    caseOne({ materialCheck: "evidence_unjudgeable" })
  );
  assert.equal(verdict.case, "case_2_prime");
  assert.equal(verdict.rollback, false);
  assert.match(verdict.answer, /collect the evidence again/);
});

test("X2: a still-valid previous token that was rejected is a defect, not case 1", () => {
  const verdict = classifyUndeterminedSigning(
    caseOne({ previousAccessAxis: "rejected_while_valid" })
  );
  assert.equal(verdict.case, "case_2");
  assert.equal(verdict.rollback, true);
});

test("X6: an undetermined refresh axis puts the round outside this branch", () => {
  // Two undetermined axes are not a basis for promotion; they are not this
  // branch at all.
  for (const axis of ["undetermined", "failed_confirmed"]) {
    const verdict = classifyUndeterminedSigning(caseOne({ previousRefreshAxis: axis }));
    assert.equal(verdict.case, "not_this_branch", axis);
  }
});

test("X7: once the grace window closes the question is not applicable, and still not a pass", () => {
  const verdict = classifyUndeterminedSigning(caseOne({ graceWindowRemainingSeconds: 0 }));
  assert.equal(verdict.case, "case_1");
  assert.equal(verdict.previousGenerationQuestion, "not_applicable");
  assert.equal(verdict.graceWindowClosed, true);
  assert.equal(verdict.recordedAsPass, false);
  // The two words are different answers, and the vocabulary keeps them apart.
  assert.equal(MOBILE_MISSING_ANSWER_KINDS.includes("undetermined"), true);
  assert.equal(MOBILE_MISSING_ANSWER_KINDS.includes("not_applicable"), true);
});

test("a previous generation that was accepted leaves nothing undetermined", () => {
  const verdict = classifyUndeterminedSigning(caseOne({ previousAccessAxis: "accepted" }));
  assert.equal(verdict.case, "not_this_branch");
});

test("every classification names one of the four cases", () => {
  const inputs = [
    caseOne(),
    caseOne({ materialCheck: "mismatch_confirmed" }),
    caseOne({ materialCheck: "evidence_unjudgeable" }),
    caseOne({ materialCheck: "something else" }),
    caseOne({ previousAccessAxis: "rejected_while_valid" }),
    caseOne({ previousAccessAxis: "accepted" }),
    caseOne({ previousAccessAxis: "who knows" }),
    caseOne({ previousRefreshAxis: "undetermined" }),
    {},
  ];
  for (const input of inputs) {
    const verdict = classifyUndeterminedSigning(input);
    assert.equal(MOBILE_SIGNING_ROUND_CASES.includes(verdict.case), true, JSON.stringify(verdict));
    assert.equal(typeof verdict.why, "string");
  }
});

// --- G3, requirement by requirement ----------------------------------------

test("all six satisfied reports the requirements met, and says what that is not", () => {
  const status = f3RequirementStatus(allSix());
  assert.equal(status.requirementsMet, true);
  assert.deepEqual(status.missing, []);
  // The narrow claim never travels without the four sentences beside it.
  assert.equal(status.notEstablished.length, 4);
  assert.match(status.notEstablished.join(" "), /risk of case 1 is accepted/);
  assert.match(status.notEstablished.join(" "), /a function is not one/);
  assert.match(status.notEstablished.join(" "), /the promotion happened/);
  assert.match(status.notEstablished.join(" "), /binding axis runs in the verifier/);
});

test("X4: no binding at all means the requirements are not met", () => {
  const status = f3RequirementStatus(
    allSix({ signingBinding: "undetermined", pepperBinding: "undetermined" })
  );
  assert.equal(status.requirementsMet, false);
  assert.deepEqual(status.missing, ["binding_on_both_axes"]);
});

test("one bound axis is not a bound sample", () => {
  // A matching `dep` beside an empty row column. The verifier fails it, and
  // the requirement list has to agree rather than counting the half.
  const status = f3RequirementStatus(allSix({ pepperBinding: "undetermined" }));
  assert.equal(status.met.binding_on_both_axes, false);
  assert.equal(status.requirementsMet, false);
});

test("X5 and X5a: the recovery path check must have been run, not merely applicable", () => {
  // X5 -- a signing-only rotation can run it, so "the previous pepper
  // generation is not applicable" does not excuse it.
  assert.equal(f3RequirementStatus(allSix()).met.recovery_path_check_passed, true);
  // X5a -- not run is not met, and it is a different answer from failed.
  for (const state of ["not_run", "failed", "undetermined", undefined]) {
    const status = f3RequirementStatus(allSix({ recoveryPathCheck: state }));
    assert.equal(status.met.recovery_path_check_passed, false, String(state));
    assert.equal(status.requirementsMet, false, String(state));
  }
});

test("the expiry has to be observed, not assumed from the sample being old", () => {
  const status = f3RequirementStatus(allSix({ expiryObserved: false }));
  assert.deepEqual(status.missing, ["expiry_observed"]);
});

test("the grace window has to be recorded, and a closed window is a legitimate value", () => {
  // What is refused is not having looked. Zero is a reading; absent is not.
  assert.equal(f3RequirementStatus(allSix({ graceWindowRemainingSeconds: 0 })).requirementsMet, true);
  const unread = f3RequirementStatus(allSix({ graceWindowRemainingSeconds: undefined }));
  assert.deepEqual(unread.missing, ["grace_window_recorded"]);
});

test("X11: several missing requirements are reported separately, not folded into one", () => {
  const status = f3RequirementStatus(
    allSix({
      signingBinding: "undetermined",
      recoveryPathCheck: "not_run",
      otherUndeterminedOrMismatched: true,
    })
  );
  assert.deepEqual(status.missing, [
    "binding_on_both_axes",
    "recovery_path_check_passed",
    "no_other_undetermined",
  ]);
  // And the six keys are always all present, so a reader can see which passed.
  assert.deepEqual(Object.keys(status.met).sort(), [...MOBILE_F3_REQUIREMENTS].sort());
});

// --- G9's clock -------------------------------------------------------------

test("the deadline is 24 hours counted from the classification instant", () => {
  const classifiedAtSeconds = 1_788_000_000;
  const status = holdStatus({ classifiedAtSeconds, nowSeconds: classifiedAtSeconds });
  assert.equal(MOBILE_HOLD_DEADLINE_SECONDS, 86_400);
  assert.equal(status.deadlineSeconds, classifiedAtSeconds + 86_400);
  assert.equal(status.remainingSeconds, 86_400);
  assert.equal(status.exceeded, false);
  assert.match(status.clockStartsAt, /classified as case one/);
});

test("the boundary is exercised at one second either side of it, and on it", () => {
  const classifiedAtSeconds = 1_788_000_000;
  const deadline = classifiedAtSeconds + MOBILE_HOLD_DEADLINE_SECONDS;
  const at = (nowSeconds) => holdStatus({ classifiedAtSeconds, nowSeconds });

  assert.equal(at(deadline - 1).exceeded, false);
  assert.equal(at(deadline - 1).remainingSeconds, 1);
  // The instant itself counts as reached -- the implementation's reading of
  // "24 hours", which the approval did not settle to the second.
  assert.equal(at(deadline).exceeded, true);
  assert.equal(at(deadline).remainingSeconds, 0);
  assert.equal(at(deadline + 1).exceeded, true);
  assert.equal(at(deadline + 1).remainingSeconds, -1);
});

test("exceeding the deadline is not a transition and not a completion", () => {
  // G9 chose an operator deadline. The overrun is recorded; the hold stands.
  const classifiedAtSeconds = 1_788_000_000;
  const late = holdStatus({
    classifiedAtSeconds,
    nowSeconds: classifiedAtSeconds + MOBILE_HOLD_DEADLINE_SECONDS + 7 * 86_400,
  });
  assert.equal(late.exceeded, true);
  assert.equal(late.stillHolding, true);
  assert.match(late.onExceeded, /the hold continues and no transition happens/);
  // Nothing in the answer names F2, a promotion or a completion.
  const serialised = JSON.stringify(late);
  assert.equal(/"F2"|promot|complete/i.test(serialised), false, serialised);
});

test("an unusable instant is reported as unknown rather than computed around", () => {
  for (const input of [{}, { classifiedAtSeconds: 1.5, nowSeconds: 2 }, { classifiedAtSeconds: 1 }]) {
    assert.equal(holdStatus(input).known, false, JSON.stringify(input));
  }
});

// --- G9's fourth value: no exception in section 4 ---------------------------

test("F2 is unconfirmed while the expected deployment id is unconfirmed, even if the re-check passed", () => {
  // A rollback that reuses the id would pass the re-check without anyone
  // having confirmed which case they were in. Passing unconfirmed is not
  // confirmation.
  const status = f2CompletionStatus({
    expectedDeploymentIdConfirmed: false,
    preflightRecheck: "passed",
  });
  assert.equal(status.status, "unconfirmed");
  assert.equal(status.exceptionOpened, false);
  assert.match(status.why, /not confirmed \(E7\)/);
});

test("F2 completes only when a confirmed expectation and a passing re-check meet", () => {
  assert.equal(
    f2CompletionStatus({ expectedDeploymentIdConfirmed: true, preflightRecheck: "passed" }).status,
    "complete"
  );
  for (const recheck of ["failed", "not_run", undefined]) {
    const status = f2CompletionStatus({ expectedDeploymentIdConfirmed: true, preflightRecheck: recheck });
    assert.equal(status.status, "unconfirmed", String(recheck));
    assert.equal(status.exceptionOpened, false, String(recheck));
  }
});

test("a rollback that ran is reported as having run, and separately from completion", () => {
  const status = f2CompletionStatus({ expectedDeploymentIdConfirmed: false, preflightRecheck: "not_run" });
  assert.equal(status.rollbackMayHaveRun, true);
  assert.equal(status.status, "unconfirmed");
  assert.equal(MOBILE_MISSING_ANSWER_KINDS.includes("unconfirmed"), true);
});

test("X9: a met requirement set never says the promotion may proceed", () => {
  // The whole point of G4 and G6. Read the module's own answer as a record
  // would read it: nothing in it authorises anything.
  const serialised = JSON.stringify(f3RequirementStatus(allSix()));
  assert.equal(/eligible|approved|may promote|proceed/i.test(serialised), false, serialised);
  assert.match(serialised, /requirementsMet/);
});
