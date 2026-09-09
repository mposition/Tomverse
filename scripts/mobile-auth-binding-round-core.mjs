// Judging one three-sample binding round.
//
// Contract: .github/audits/2026-09-09-mobile-auth-evidence-deployment-binding-approval.md
// section 10.2 and E5, approved 2026-09-09.
//
// Pure: no filesystem, no clock, no process. The CLI beside it reads the run
// summaries and passes an instant in.
//
// **What a met sample condition is not.** Three samples naming the same
// deployment do not establish that the deployment is stable, that no older
// instance is still serving, or that this evidence came from the new version.
// Old and new instances can both answer, and `new -> new -> new -> old` is an
// ordinary sequence (W17). What the round bounds is the probability that a
// mixed state goes unseen by *this* sample -- and only under a model nobody
// measured: each request independent, the new version taking half the traffic.
// Under that same model at 90% new, a single round misses a mixed state 72.9%
// of the time. So the number the record carries is an illustration with its
// assumptions attached, and what is accepted is the residual risk of not
// knowing the real distribution -- not the number.
//
// **Retries are excluded on purpose.** Sampling until it passes re-draws the
// pass condition and moves the miss probability from 12.5% to 25-50% under the
// same model. Three samples, fixed; one that differs makes the round
// undetermined and the round ends there. Opening a second round on the same
// deployment is a person's decision, recorded, because a second round is a
// retry wearing a different name (23.4% over two rounds, 48.7% over five).
//
// **It does not detect a repeat.** The interval rule below refuses two samples
// issued at the same second, which an exact duplicate always is -- but that is
// a consequence of demanding three distinct moments, not identity checking.
// Nothing here compares evidence identity, and the same evidence used in two
// different rounds passes both. E11's record-based detection is approved in
// direction only and is not implemented (W18, W19).

/** E5: three samples. Not a floor and not a target -- the count is the rule. */
export const MOBILE_BINDING_ROUND_SAMPLES = 3;

/**
 * E5: at least two minutes apart, measured on the token's own `iat`.
 *
 * Issue time rather than the time a person collected the response: two samples
 * are only two looks at different moments if the deployment produced them at
 * different moments.
 */
export const MOBILE_BINDING_ROUND_MIN_INTERVAL_SECONDS = 120;

/**
 * The sentence a record has to carry beside any probability.
 *
 * A bare number in a record reads as a measurement of this deployment. It is
 * not one, and the record is the only place a later reader meets it.
 */
export const MOBILE_BINDING_ROUND_MODEL_CAVEAT =
  "Illustrative value of a model in which each request is independent and the " +
  "new version takes 50% of traffic; the real distribution is unmeasured. What " +
  "is accepted is the residual risk of not knowing the distribution or the " +
  "correlation between samples, not this number.";

/** Illustrative only -- see the caveat above. Keyed by round ordinal. */
export const MOBILE_BINDING_ROUND_ILLUSTRATIVE_MISS = {
  1: "12.5%",
  2: "23.4%",
  5: "48.7%",
};

export const MOBILE_BINDING_ROUND_VERDICTS = [
  /** The three samples met the condition E5 states. Promotion is still gated on everything else. */
  "sample_condition_met",
  /** Nothing was decided by this round. Not a pass, not a defect. */
  "undetermined",
  /** All three name the same *other* deployment: stop, do not open another round. */
  "halt",
  /** The round may not be judged at all -- a second round with nobody's decision behind it. */
  "refused",
];

const asInteger = (value) => (Number.isInteger(value) ? value : null);

const SUMMARY_SCHEMA = "tomverse.mobile-auth-verify.v1";

/** The two axes a round is about. Both, always -- one bound half is not a bound sample. */
const BINDING_FIELDS = [
  ["signingBinding", "signingDeploymentId"],
  ["pepperBinding", "pepperDeploymentId"],
];

/**
 * What the verifier calls the two binding checks.
 *
 * Needed because "did this sample pass" is too coarse a question for the one
 * place it matters. A sample that names another deployment fails its own run --
 * that is the binding axis doing its job -- and if that counted as "cannot be
 * judged", the answer "every sample is consistently somewhere else" could never
 * be reached. So the round asks the narrower question instead: did anything
 * *other* than the binding fail?
 */
const BINDING_CHECK_NAMES = new Set(["signing binding", "pepper binding"]);

const nonEmptyString = (value) =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * One sample, as the verifier's own summary describes it.
 *
 * Shape-checked rather than trusted: a summary that lost a field would
 * otherwise be judged as if the field said what the judge hoped. What is
 * checked here is only whether the file *says* the things a round is judged
 * on -- what those things say is the caller's business, so that the order in
 * which findings are weighed stays in one place.
 */
const readSample = (value, index) => {
  const problems = [];
  const at = `sample ${index + 1}`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { problems: [`${at} is not an object`] };
  }
  // The schema tag first: everything below reads named fields, and a file with
  // none of them would otherwise be reported field by field as if it were a
  // damaged run summary rather than a different kind of file entirely.
  if (value.schema !== SUMMARY_SCHEMA) {
    return { problems: [`${at} is not a ${SUMMARY_SCHEMA} run summary`] };
  }
  // A run that was cut short leaves this marker rather than the previous run's
  // file, so a stale summary cannot be judged as though it described this one.
  if (value.incomplete === true) {
    return { problems: [`${at} is an incomplete run file; its verification did not finish`] };
  }

  const issuedAt = asInteger(value.tokenIssuedAt);
  const expiresAt = asInteger(value.tokenExpiresAt);
  if (issuedAt === null) problems.push(`${at} has no integer tokenIssuedAt`);
  if (expiresAt === null) problems.push(`${at} has no integer tokenExpiresAt`);
  if (typeof value.passed !== "boolean") problems.push(`${at} has no boolean passed`);

  // The failure list, which is how the round tells a binding finding apart from
  // a stale token or wrong key material.
  let otherFailures = null;
  if (!Array.isArray(value.failures)) {
    problems.push(`${at} has no failures list`);
  } else if (value.failures.some((entry) => typeof entry?.name !== "string")) {
    problems.push(`${at} has a failure with no name`);
  } else {
    otherFailures = value.failures.filter((entry) => !BINDING_CHECK_NAMES.has(entry.name)).length;
    if (value.passed === true && value.failures.length > 0) {
      problems.push(`${at} says it passed and lists failures`);
    }
    if (value.passed === false && value.failures.length === 0) {
      problems.push(`${at} says it did not pass and lists no failure`);
    }
  }

  const expectedDeploymentId = nonEmptyString(value.expectedDeploymentId);
  if (!expectedDeploymentId) {
    problems.push(`${at} names no expected deployment id`);
  }

  // The binding fields are the whole point of the round, and `passed` does not
  // stand in for them: it is one boolean about one run, and a summary with both
  // axes deleted used to satisfy it. Both are required to be *there*; whether
  // they agree is judged below, where the order of findings is decided.
  const bindings = {};
  for (const [outcomeField, idField] of BINDING_FIELDS) {
    const outcome = nonEmptyString(value[outcomeField]);
    const named = nonEmptyString(value[idField]);
    if (!outcome) problems.push(`${at} has no ${outcomeField}`);
    // An axis with no identifier is an axis with nothing to compare, whatever
    // its outcome word says.
    if (!named) problems.push(`${at} has no ${idField}`);
    bindings[outcomeField] = outcome;
    bindings[idField] = named;
  }

  return {
    problems,
    sample: {
      index,
      issuedAt,
      expiresAt,
      passed: value.passed === true,
      otherFailures,
      expectedDeploymentId,
      signingBinding: bindings.signingBinding,
      pepperBinding: bindings.pepperBinding,
      signingDeploymentId: bindings.signingDeploymentId,
      pepperDeploymentId: bindings.pepperDeploymentId,
    },
  };
};

/**
 * The round's verdict.
 *
 * `judgedAtSeconds` is when the *round* is decided, which is after the last
 * sample was collected. Every sample is re-checked against it: a sample that
 * passed its own run and has since expired does not carry its earlier pass
 * forward. That re-check, not the verifier's 900s age limit, is what puts a
 * ceiling on how long a round may take -- and the value that binds first is
 * the access token's own 600s lifetime.
 */
export const judgeMobileBindingRound = (input) => {
  const reasons = [];
  const round = asInteger(input?.round);
  const judgedAtSeconds = asInteger(input?.judgedAtSeconds);
  const resumeApprovedBy =
    typeof input?.resumeApprovedBy === "string" ? input.resumeApprovedBy.trim() : "";

  if (round === null || round < 1) {
    return {
      verdict: "refused",
      reasons: ["the round ordinal is missing; a round nobody numbered cannot be recorded"],
    };
  }
  if (judgedAtSeconds === null) {
    return { verdict: "refused", reasons: ["no judgement instant was supplied"] };
  }
  // E5: a second round on the same deployment is a person's decision, because
  // reopening one is a retry under another name and the record alone is an
  // observation rather than a control.
  if (round > 1 && resumeApprovedBy === "") {
    return {
      verdict: "refused",
      reasons: [
        `round ${round} on the same deployment needs a person to decide the resumption; ` +
          "no name was given",
      ],
    };
  }

  const raw = Array.isArray(input?.samples) ? input.samples : [];
  const read = raw.map((value, index) => readSample(value, index));
  const shapeProblems = read.flatMap((entry) => entry.problems);
  if (shapeProblems.length > 0) {
    return { verdict: "undetermined", reasons: shapeProblems };
  }
  const samples = read.map((entry) => entry.sample);

  if (samples.length !== MOBILE_BINDING_ROUND_SAMPLES) {
    // Collection stopped part-way. E5 is explicit that a partial sample is not
    // judged rather than judged on what arrived.
    return {
      verdict: "undetermined",
      reasons: [
        `${samples.length} sample(s) of ${MOBILE_BINDING_ROUND_SAMPLES}; a partial round is not judged`,
      ],
    };
  }

  const expected = new Set(samples.map((sample) => sample.expectedDeploymentId));
  if (expected.size !== 1 || samples[0].expectedDeploymentId === null) {
    reasons.push("the samples were not all checked against one expected deployment id");
  }

  // Whether the round can be judged at all, gathered *before* the binding is
  // read. A sample that expired, or whose own run did not pass, or that was
  // taken too close to its neighbour, says nothing about which deployment is
  // serving -- and treating it as if it did is how three expired copies of the
  // previous deployment's evidence came back as "stop, something else is
  // serving" rather than "collect this again".
  // Deliberately not `passed`. A sample that names another deployment fails its
  // own run, and counting that here would make "consistently somewhere else"
  // unreachable -- the finding would eat the answer it exists to produce. What
  // disqualifies a sample is a failure that is not about the binding: stale
  // evidence, the wrong key material, a wrong `iss`. The count is reported and
  // the names are not: they come out of the file, and this tool does not print
  // what a file it was pointed at contains.
  const unjudgeable = samples.filter((sample) => (sample.otherFailures ?? 0) > 0);
  if (unjudgeable.length > 0) {
    reasons.push(
      `${unjudgeable.length} sample(s) failed a check other than the binding ` +
        "(freshness, key material, iss/aud) -- collect those samples again"
    );
  }

  const expiredAtJudgement = samples.filter((sample) => sample.expiresAt <= judgedAtSeconds);
  if (expiredAtJudgement.length > 0) {
    reasons.push(
      "at the judgement instant these samples were no longer valid: " +
        expiredAtJudgement.map((sample) => `sample ${sample.index + 1}`).join(", ") +
        " -- an earlier pass is not carried forward"
    );
  }

  const ordered = [...samples].sort((a, b) => a.issuedAt - b.issuedAt);
  for (let index = 1; index < ordered.length; index += 1) {
    const gap = ordered[index].issuedAt - ordered[index - 1].issuedAt;
    if (gap < MOBILE_BINDING_ROUND_MIN_INTERVAL_SECONDS) {
      reasons.push(
        `two samples were issued ${gap}s apart, under the ${MOBILE_BINDING_ROUND_MIN_INTERVAL_SECONDS}s minimum`
      );
    }
  }

  const judgeable = reasons.length === 0;

  // "Every sample names the same other deployment" is its own answer: the
  // traffic is going somewhere else entirely, and opening another round would
  // only sample the same wrong thing again.
  //
  // Two conditions, both new. It is only reached when the samples were
  // judgeable in the first place -- otherwise "undetermined" is the honest
  // answer and re-collection the remedy. And **both axes** have to agree: the
  // signing half alone used to decide this, so a token from the old instance
  // beside a row from the new one was reported as a settled fact about where
  // traffic goes, which is exactly the mixed state nothing here can resolve.
  const uniform = (field) => {
    const values = new Set(samples.map((sample) => sample[field]));
    if (values.size !== 1) return null;
    return samples[0][field];
  };
  const signing = uniform("signingDeploymentId");
  const pepper = uniform("pepperDeploymentId");
  const expectedId = samples[0].expectedDeploymentId;
  const consistentlyElsewhere =
    judgeable &&
    signing !== null &&
    pepper !== null &&
    signing === pepper &&
    expectedId !== null &&
    expected.size === 1 &&
    signing !== expectedId;

  if (consistentlyElsewhere) {
    return {
      verdict: "halt",
      reasons: [
        "all three samples name the same deployment, and it is not the expected one; " +
          "stop rather than opening another round",
      ],
      record: recordFor(round, resumeApprovedBy),
    };
  }

  // The binding itself, read last so that the two answers above -- "this cannot
  // be judged" and "this is consistently somewhere else" -- are reached on
  // their own terms. Each axis of each sample must say `matched` and must name
  // the deployment the run was checked against; one axis never speaks for the
  // other, and `passed` never speaks for either.
  for (const sample of samples) {
    const at = `sample ${sample.index + 1}`;
    for (const [outcomeField, idField] of BINDING_FIELDS) {
      if (sample[outcomeField] !== "matched") {
        reasons.push(`${at} reports ${outcomeField} ${sample[outcomeField]}, not matched`);
      }
      if (sample.expectedDeploymentId && sample[idField] !== sample.expectedDeploymentId) {
        reasons.push(`${at} names a ${idField} that is not the expected deployment`);
      }
    }
  }

  if (reasons.length > 0) {
    return { verdict: "undetermined", reasons, record: recordFor(round, resumeApprovedBy) };
  }

  return {
    verdict: "sample_condition_met",
    reasons: [],
    record: recordFor(round, resumeApprovedBy),
  };
};

const recordFor = (round, resumeApprovedBy) => ({
  round,
  resumeDecidedBy: round > 1 ? resumeApprovedBy : null,
  illustrativeMiss: MOBILE_BINDING_ROUND_ILLUSTRATIVE_MISS[round] ?? "not tabulated",
  modelCaveat: MOBILE_BINDING_ROUND_MODEL_CAVEAT,
});
