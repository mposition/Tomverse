// The decided rules for a rotation round whose signing half came back
// undetermined.
//
// Contract: .github/audits/2026-09-09-mobile-auth-undetermined-signing-half-approval.md,
// G1-G11 approved 2026-09-10. Procedure: docs/ops/mobile-auth-key-rotation.md
// section 3 item 8.
//
// Pure: no filesystem, no clock, no process, no network. The instant is an
// argument so the deadline's boundary can be tested rather than waited for.
//
// **What this module is not.** It computes the rules that were decided; it
// does not decide anything else and it establishes nothing about the world:
//
//   - It never returns an action. Exceeding the deadline is reported as
//     exceeded and nothing more -- G9 chose an operator deadline, so an
//     overrun is recorded and the hold continues. There is no transition to
//     F2 here and no "complete" that a timer can reach.
//   - `f3RequirementsMet` is not eligibility and not approval. The risk
//     acceptance, the signature and the promotion itself are a person's, and
//     the module says so in every answer it gives.
//   - It reads observations it is handed. Whether those observations really
//     came from the deployment under test is what the binding axis is for,
//     and that axis runs in the verifier -- not here. Feeding this module a
//     hoped-for input proves nothing about a deployment.
//
// So a test of this module is a test of the rules. The verifier's own
// responses, the wrapper's retry, the non-disclosure of output and the store
// entry's structure are checked by calling those implementations, and no
// result here may be written up as covering them.

/** G9: the hold's deadline, counted from the instant below. Approved 2026-09-10. */
export const MOBILE_HOLD_DEADLINE_SECONDS = 24 * 60 * 60;

/**
 * G9: what the deadline is counted from.
 *
 * The moment the round was classified as case one -- the instant item 7's
 * access axis was judged undetermined. Not the deploy's completion: the time
 * spent collecting and judging would then eat the deadline.
 */
export const MOBILE_HOLD_CLOCK_STARTS_AT = "the instant the round was classified as case one";

/**
 * The three ways an answer can be missing, kept apart on purpose.
 *
 *   undetermined    the question is live and this round cannot answer it
 *   not_applicable  the question has stopped applying (G7: the grace window
 *                   closed, and not being accepted is now the intended state)
 *   unconfirmed     something happened but nobody checked the result -- an F2
 *                   whose preflight re-check has not passed
 *
 * "The question went away" is not "the answer was yes", and "it was done" is
 * not "it was checked". Folding any two of these into one word is the failure
 * this vocabulary exists to prevent.
 */
export const MOBILE_MISSING_ANSWER_KINDS = ["undetermined", "not_applicable", "unconfirmed"];

/** Section 1: which of the three unknowns a round is actually in. */
export const MOBILE_SIGNING_ROUND_CASES = [
  /** Case 1 -- the branch this packet is about. Item 6 passed, refresh passed, access undetermined. */
  "case_1",
  /** Case 2 -- a deployment defect confirmed on judgeable evidence. The answer is rollback. */
  "case_2",
  /** Case 2' -- the evidence itself cannot be judged. The answer is to collect it again. */
  "case_2_prime",
  /** None of the three: this round is not in this branch at all. */
  "not_this_branch",
  /**
   * Not one of section 1's three, and not a fourth case either: the round was
   * handed an observation that does not decide between them, so it is not
   * classified. A rejection with no record of the grace state at that instant
   * is the one that gets here -- see `classifyUndeterminedSigning`.
   */
  "insufficient_observation",
];

/**
 * What item 7's access axis observed, as an observation.
 *
 *   accepted        the previous generation's token was accepted
 *   rejected        it was refused -- and that is all this says
 *   sample_expired  its `exp` passed before it could be presented
 *
 * `rejected` used to be spelled `rejected_while_valid`, and the name was the
 * defect: it carried the verdict "the key should have been accepted" inside
 * the input, so the classifier ordered a rollback for a refusal that was the
 * contract working. Whether the key was still inside its grace window at that
 * instant is a **separate observation** (`graceRemainingAtRejectionSeconds`),
 * and it is what decides between a defect and the intended state.
 */
export const MOBILE_ACCESS_AXIS_OBSERVATIONS = ["accepted", "rejected", "sample_expired"];

const isInteger = (value) => Number.isInteger(value);

/**
 * Section 1, in the order section 1 states it.
 *
 * The order is the rule, not a convenience. Case 2' comes first because
 * unjudgeable evidence means case 1 cannot even be asked; case 2 comes next
 * because a confirmed mismatch settles the round without asking case 1.
 * Reordering these is how "collect it again" turns into "roll back".
 */
export const classifyUndeterminedSigning = (input) => {
  const materialCheck = input?.materialCheck;
  const refreshAxis = input?.previousRefreshAxis;
  const accessAxis = input?.previousAccessAxis;
  const graceRemaining = input?.graceWindowRemainingSeconds;
  const graceAtRejection = input?.graceRemainingAtRejectionSeconds;

  const reason = (roundCase, why, extra = {}) => ({ case: roundCase, why, ...extra });

  if (materialCheck === "evidence_unjudgeable") {
    return reason(
      "case_2_prime",
      "the evidence for item 6 could not be judged, so case 1 cannot be asked yet",
      { answer: "collect the evidence again and re-run item 6", rollback: false }
    );
  }
  if (materialCheck === "mismatch_confirmed") {
    return reason(
      "case_2",
      "item 6 confirmed a material mismatch on judgeable evidence",
      { answer: "roll back; case 1 is not asked", rollback: true }
    );
  }
  if (materialCheck !== "passed") {
    return reason("not_this_branch", "item 6 did not report one of passed, mismatch_confirmed or evidence_unjudgeable");
  }

  /**
   * A refusal is not yet a finding. `MOBILE_PREVIOUS_SIGNING_KEY_SECONDS` is
   * 900 and the keyring's window is exclusive, so the previous key verifies at
   * +899s and answers `unknown_kid` at +900s -- reproduced against the real
   * mint and verify path on 2026-09-10. The second of those is the contract
   * doing what it says. Ordering a rollback for it would undo a correct
   * deployment, and an earlier version of this function did exactly that
   * because the input was named `rejected_while_valid`: the caller's label
   * decided the verdict.
   *
   * So the grace state at the instant of the refusal is read first, and it is
   * a distinct observation from `graceWindowRemainingSeconds`, which is the
   * window at the time of judgement. Collapsing them would answer a question
   * about one instant with a measurement from another.
   */
  if (accessAxis === "rejected") {
    if (!isInteger(graceAtRejection)) {
      return reason(
        "insufficient_observation",
        "the access sample was rejected, but the grace window at that instant was not recorded, and that is what tells a defect from the intended refusal",
        {
          answer:
            "record how much of the previous signing key's grace window was left at the instant of the rejection, then classify again",
          rollback: false,
        }
      );
    }
    if (graceAtRejection > 0) {
      return reason(
        "case_2",
        "the previous access token was rejected while its signing key was still inside its grace window -- that is a deployment defect, not case 1",
        { answer: "roll back", rollback: true, graceWindowClosedAtRejection: false }
      );
    }
    // Closed at the instant of the refusal: refusing was the intended
    // behaviour. It is still not an answer to case 1's question -- nobody
    // presented the sample while it counted -- so the round falls through to
    // case 1 below, where G7 names the unknown.
  }
  if (accessAxis === "rejected_while_valid") {
    return reason(
      "insufficient_observation",
      'the access axis was reported as "rejected_while_valid", which states a verdict rather than an observation',
      {
        answer:
          'report "rejected" and, separately, the grace window remaining at the instant of the rejection',
        rollback: false,
      }
    );
  }
  if (refreshAxis !== "passed") {
    return reason(
      "not_this_branch",
      "item 7's refresh axis did not pass, and case 1 is defined with it passing"
    );
  }
  if (accessAxis === "accepted") {
    return reason("not_this_branch", "the previous generation was accepted; nothing is undetermined");
  }
  if (accessAxis !== "sample_expired" && accessAxis !== "rejected") {
    return reason(
      "not_this_branch",
      "item 7's access axis did not report one of accepted, rejected or sample_expired"
    );
  }

  // Case 1. G7 decides what to call it once the grace window has closed.
  //
  // A rejection reaches here only through the closed branch above, so its
  // window is closed by construction; the sample-expired path reads the
  // recorded window instead.
  const graceClosed =
    accessAxis === "rejected" || (isInteger(graceRemaining) && graceRemaining <= 0);
  return reason(
    "case_1",
    accessAxis === "rejected"
      ? "item 6 passed, the refresh axis passed, and the access sample was refused after its signing key's grace window had already closed -- the intended behaviour, and not an answer"
      : "item 6 passed, the refresh axis passed, and the access sample expired before it could be used",
    {
      rollback: false,
      /**
       * G7. The question stops applying when the window closes -- and that is
       * still not a pass. Whether the previous generation was actually cut
       * inside the window stays unknown for good.
       */
      previousGenerationQuestion: graceClosed ? "not_applicable" : "undetermined",
      graceWindowClosed: graceClosed,
      recordedAsPass: false,
    }
  );
};

/** G3: the six, in the order section 5.1 lists them. */
export const MOBILE_F3_REQUIREMENTS = [
  "item_6_passed",
  "binding_on_both_axes",
  "recovery_path_check_passed",
  "expiry_observed",
  "grace_window_recorded",
  "no_other_undetermined",
];

/**
 * What this module cannot establish, returned with every F3 answer.
 *
 * Not a disclaimer. `requirementsMet` is the narrowest possible statement --
 * the six observations that were handed in satisfy G3 -- and without these
 * four sentences beside it, a record would read as though a function had
 * approved a promotion.
 */
const F3_NOT_ESTABLISHED = [
  "that the risk of case 1 is accepted -- G4 makes that a person's line in the record",
  "that anyone signed this -- G6 names the approver, and a function is not one",
  "that the promotion happened -- this returns a judgement, not an action",
  "that the observations came from the deployment under test -- the binding axis runs in the verifier",
];

/**
 * G3, requirement by requirement.
 *
 * Every requirement is reported separately and none of them substitutes for
 * another. Requirement 2 needs **both** binding axes: a matching `dep` beside
 * an empty row column is not a bound sample, and the verifier fails it.
 */
export const f3RequirementStatus = (input) => {
  const met = {};
  const missing = [];

  met.item_6_passed = input?.materialCheck === "passed";

  const signing = input?.signingBinding;
  const pepper = input?.pepperBinding;
  met.binding_on_both_axes = signing === "matched" && pepper === "matched";

  // G8: the condition is that the check was actually run, not that it was
  // applicable. A signing-only rotation can run it -- "not applicable" is the
  // previous pepper generation's compatibility, which is a different check.
  met.recovery_path_check_passed = input?.recoveryPathCheck === "passed";

  // Observed and written down, not inferred from the sample being old.
  met.expiry_observed = input?.expiryObserved === true;

  // Recorded, whatever it says. A closed window is a legitimate value here;
  // what is refused is not having looked (G7 then decides the wording).
  met.grace_window_recorded = isInteger(input?.graceWindowRemainingSeconds);

  met.no_other_undetermined = input?.otherUndeterminedOrMismatched === false;

  for (const requirement of MOBILE_F3_REQUIREMENTS) {
    if (!met[requirement]) missing.push(requirement);
  }

  return {
    met,
    missing,
    /** Narrow on purpose: the six were satisfied. Nothing follows from it alone. */
    requirementsMet: missing.length === 0,
    notEstablished: F3_NOT_ESTABLISHED,
  };
};

/**
 * G9: the hold's clock.
 *
 * `exceeded` is reported and nothing is done with it. G9 chose **(a) an
 * operator deadline**, so passing it records an overrun and the hold
 * continues -- there is no automatic F2 here, and `stillHolding` says so in
 * every answer rather than leaving it to be inferred from an absence.
 *
 * The instant itself counts as reached (`remainingSeconds <= 0`). The
 * approval fixed 24 hours and the starting point but said nothing about which
 * side of the boundary the exact second falls on; this is the implementation's
 * reading of "24시간", reported as such rather than presented as decided.
 */
export const holdStatus = (input) => {
  const classifiedAt = input?.classifiedAtSeconds;
  const now = input?.nowSeconds;
  if (!isInteger(classifiedAt) || !isInteger(now)) {
    return { known: false, why: "the classification instant and the current instant must both be integers" };
  }
  const deadlineSeconds = classifiedAt + MOBILE_HOLD_DEADLINE_SECONDS;
  const remainingSeconds = deadlineSeconds - now;
  return {
    known: true,
    clockStartsAt: MOBILE_HOLD_CLOCK_STARTS_AT,
    deadlineSeconds,
    remainingSeconds,
    exceeded: remainingSeconds <= 0,
    /** Always true. Only a person ends the hold, before the deadline or after it. */
    stillHolding: true,
    /** Stated, not implied: (a) was chosen, so this is what an overrun buys. */
    onExceeded: "record the overrun; the hold continues and no transition happens",
  };
};

/**
 * G9's fourth value: no exception is opened in section 4's completion
 * condition.
 *
 * Section 4 makes F2 complete on **two** things -- the rollback finished, and
 * the preflight re-check passed afterwards -- and this returns `complete` only
 * when both were observed in that order. An earlier version asked two
 * questions and neither of them was the rollback: a case where nobody had
 * rolled anything back, and a re-check that ran before the rollback did,
 * both came back `complete`.
 *
 * The instants are required rather than inferred. "It was done and then it was
 * checked" is an ordering claim, and without two timestamps there is nothing
 * to order -- an operator who re-ran the preflight, then rolled back, then
 * reported both would otherwise be told the rollback is complete.
 *
 * E7 gates all of it. The re-check compares against the deployment id written
 * on Active, and while E7 is unmeasured that id is not confirmed, so a pass
 * cannot be trusted even when everything else is in order -- a rollback that
 * reuses the id would pass it without anyone having confirmed which case they
 * were in. So this returns `unconfirmed`, never `complete`, until all of them
 * hold. That is the decided behaviour, not a limitation of the module.
 */
export const f2CompletionStatus = (input) => {
  const idConfirmed = input?.expectedDeploymentIdConfirmed === true;
  const recheck = input?.preflightRecheck;
  const rollbackCompletedAt = input?.rollbackCompletedAtSeconds;
  const recheckAt = input?.preflightRecheckAtSeconds;

  /** Never omitted: an F2 that is not complete has to say what is still missing. */
  const unconfirmed = (why, extra = {}) => ({
    status: "unconfirmed",
    why,
    rollbackObserved: isInteger(rollbackCompletedAt),
    rollbackMayHaveRun: true,
    exceptionOpened: false,
    ...extra,
  });

  if (!idConfirmed) {
    return unconfirmed(
      "the deployment id the re-check expects is not confirmed (E7), so its result cannot be trusted"
    );
  }
  if (!isInteger(rollbackCompletedAt)) {
    return unconfirmed(
      "no completed rollback was observed, and section 4 completes F2 on the rollback finishing and the re-check passing after it"
    );
  }
  if (recheck !== "passed") {
    return unconfirmed(
      recheck === "failed"
        ? "the preflight re-check did not pass"
        : "the preflight re-check has not been run"
    );
  }
  if (!isInteger(recheckAt)) {
    return unconfirmed(
      "the re-check passed, but there is no instant for it, so it cannot be shown to have run after the rollback"
    );
  }
  if (recheckAt <= rollbackCompletedAt) {
    return unconfirmed(
      "the re-check that passed did not run after the rollback completed, so it says nothing about the rolled-back deployment"
    );
  }
  return {
    status: "complete",
    why: "the rollback completed, and a later preflight re-check passed against a confirmed expectation",
    rollbackObserved: true,
    exceptionOpened: false,
  };
};
