import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveVoiceProviderBudget,
  VOICE_PROVIDER_BUDGET_DEV_DEFAULTS,
  VOICE_PROVIDER_BUDGET_ENV_NAMES,
} from "../lib/voiceProviderBudget.ts";
import {
  auditVoicePriceRegister,
  VOICE_MODEL_PRICE_REGISTER,
  VOICE_PRICE_REVERIFY_MAX_DAYS,
} from "../lib/voiceInputPricing.ts";

/**
 * The audio provider budget and the audio price register:
 * docs/policy/voice-input.md §6.1-3 and §6.1-4.
 */

const dev = { production: false };
const prod = { production: true };

// ---------------------------------------------------------------------------
// The provider budget
// ---------------------------------------------------------------------------

test("production refuses to run without both numbers", () => {
  const missing = resolveVoiceProviderBudget({}, prod);

  assert.equal(missing.limits, null, "no limits means /api/ready refuses");
  assert.deepEqual(
    missing.problems.map((problem) => problem.envName).sort(),
    [
      VOICE_PROVIDER_BUDGET_ENV_NAMES.day,
      VOICE_PROVIDER_BUDGET_ENV_NAMES.month,
    ].sort()
  );
});

test("production accepts an explicit pair", () => {
  const resolved = resolveVoiceProviderBudget(
    {
      [VOICE_PROVIDER_BUDGET_ENV_NAMES.day]: "3600",
      [VOICE_PROVIDER_BUDGET_ENV_NAMES.month]: "72000",
    },
    prod
  );

  assert.deepEqual(resolved.limits, {
    secondsPerDay: 3600,
    secondsPerMonth: 72000,
  });
  assert.deepEqual(resolved.problems, []);
});

test("only one of the two set in production is still a refusal", () => {
  const half = resolveVoiceProviderBudget(
    { [VOICE_PROVIDER_BUDGET_ENV_NAMES.day]: "3600" },
    prod
  );

  assert.equal(half.limits, null);
  assert.deepEqual(
    half.problems.map((problem) => problem.envName),
    [VOICE_PROVIDER_BUDGET_ENV_NAMES.month]
  );
});

test("development falls back so nobody has to configure a laptop", () => {
  const resolved = resolveVoiceProviderBudget({}, dev);

  assert.deepEqual(resolved.limits, VOICE_PROVIDER_BUDGET_DEV_DEFAULTS);
});

test("zero is refused rather than read as off", () => {
  // The kill switch turns the feature off and says so. A budget of zero
  // refuses every request with a budget message, which reads as an outage.
  for (const raw of ["0", "-1", "1.5", "abc"]) {
    const resolved = resolveVoiceProviderBudget(
      {
        [VOICE_PROVIDER_BUDGET_ENV_NAMES.day]: raw,
        [VOICE_PROVIDER_BUDGET_ENV_NAMES.month]: "72000",
      },
      prod
    );

    assert.equal(resolved.limits, null, `${raw} must not become a limit`);
    assert.equal(
      resolved.problems[0].code,
      "not_a_positive_integer",
      `${raw} is reported as unusable, not as a missing value`
    );
  }
});

test("a month below a day is reported rather than silently reordered", () => {
  // Not a stricter budget: a typo that makes the daily limit unreachable. The
  // operator has to know which of the two numbers they meant.
  const resolved = resolveVoiceProviderBudget(
    {
      [VOICE_PROVIDER_BUDGET_ENV_NAMES.day]: "3600",
      [VOICE_PROVIDER_BUDGET_ENV_NAMES.month]: "600",
    },
    prod
  );

  assert.equal(resolved.limits, null);
  assert.equal(resolved.problems[0].code, "month_below_day");
});

test("outside production the same typo is reported but still runs", () => {
  const resolved = resolveVoiceProviderBudget(
    {
      [VOICE_PROVIDER_BUDGET_ENV_NAMES.day]: "3600",
      [VOICE_PROVIDER_BUDGET_ENV_NAMES.month]: "600",
    },
    dev
  );

  assert.notEqual(resolved.limits, null);
  assert.equal(resolved.problems[0].code, "month_below_day");
});

// ---------------------------------------------------------------------------
// The price register
// ---------------------------------------------------------------------------

test("every model the deployment can reach has a recorded price", () => {
  const problems = auditVoicePriceRegister({
    modelIds: ["gpt-4o-mini-transcribe", "gpt-4o-transcribe"],
    now: new Date("2026-09-02T00:00:00Z"),
  });

  // One gap, and it is the register reporting it rather than papering over
  // it: gpt-4o-transcribe has never been invoiced and the provider publishes
  // no audio rate for it (docs/policy/voice-input.md §6.1.3-5).
  assert.deepEqual(
    problems.map((problem) => [problem.modelId, problem.code]),
    [["gpt-4o-transcribe", "audio_input_rate_unknown"]]
  );
});

test("the default model's price is not the one that is unknown", () => {
  // The split the check script relies on: an unknown audio rate blocks the
  // model this build actually uses, and is only reported for the others.
  const problems = auditVoicePriceRegister({
    modelIds: ["gpt-4o-mini-transcribe"],
    now: new Date("2026-09-02T00:00:00Z"),
  });

  assert.deepEqual(problems, []);
});

test("a model with no entry is a problem, not a default", () => {
  const problems = auditVoicePriceRegister({
    modelIds: ["whisper-1"],
    now: new Date("2026-09-02T00:00:00Z"),
  });

  assert.equal(problems[0].code, "missing_entry");
});

test("the deadline turns the check from warning into failure", () => {
  const beforeDeadline = auditVoicePriceRegister({
    modelIds: ["gpt-4o-mini-transcribe"],
    now: new Date("2026-11-30T00:00:00Z"),
  });
  const afterDeadline = auditVoicePriceRegister({
    modelIds: ["gpt-4o-mini-transcribe"],
    now: new Date("2026-12-02T00:00:00Z"),
  });

  assert.deepEqual(beforeDeadline, []);
  assert.equal(afterDeadline[0].code, "expired");
});

test("no entry may schedule its re-reading more than the maximum away", () => {
  const day = 24 * 60 * 60 * 1000;
  for (const entry of VOICE_MODEL_PRICE_REGISTER) {
    const span =
      Date.parse(`${entry.reverifyBy}T00:00:00Z`) -
      Date.parse(`${entry.verifiedAt}T00:00:00Z`);
    assert.ok(
      span > 0 && span <= VOICE_PRICE_REVERIFY_MAX_DAYS * day,
      `${entry.modelId}: ${entry.verifiedAt} -> ${entry.reverifyBy}`
    );
  }
});

test("every entry names a person and a ticket", () => {
  for (const entry of VOICE_MODEL_PRICE_REGISTER) {
    assert.ok(entry.owner.trim(), `${entry.modelId} has no owner`);
    assert.ok(entry.ticket.trim(), `${entry.modelId} has no ticket`);
  }
});

test("an observed cost carries the invoice it was read from", () => {
  // §6.1.3: the paid verification ran on 2026-09-08 for the default model and
  // not for the other one. The register has to be able to say "read" without
  // saying "charged", and it now has to say both about different entries.
  const byId = Object.fromEntries(
    VOICE_MODEL_PRICE_REGISTER.map((entry) => [entry.modelId, entry])
  );

  const observed = byId["gpt-4o-mini-transcribe"].costObservation;
  assert.notEqual(observed, null, "the verified model records no invoice");
  assert.ok(observed.totalUsd > 0, "an observation with no charge is not one");
  assert.ok(observed.requests > 0);
  assert.ok(
    observed.isolation.trim() && observed.source.trim(),
    "an aggregate charge is only evidence if it says how it was isolated"
  );

  assert.equal(
    byId["gpt-4o-transcribe"].costObservation,
    null,
    "gpt-4o-transcribe has never been called; it cannot have been invoiced"
  );
});

test("an observation names no raw account identifier", () => {
  // This register lives in a public repository, and an API key id, project id
  // or organization id is not needed to check any of the arithmetic above.
  // What the isolation claim actually needs is that the calls can be pinned to
  // one key -- a digest does that for anyone holding the operations record,
  // and tells everyone else nothing (docs/policy/voice-input.md §6.1.3-4).
  const rawIdentifier = /\b(key|proj|org|user)[-_][A-Za-z0-9]{12,}\b/;

  for (const entry of VOICE_MODEL_PRICE_REGISTER) {
    if (!entry.costObservation) continue;
    for (const [field, value] of Object.entries(entry.costObservation)) {
      if (typeof value !== "string") continue;
      assert.ok(
        !rawIdentifier.test(value),
        `${entry.modelId}.${field} carries what looks like a raw account identifier`
      );
    }
  }
});

test("the observed charge reproduces the recorded rates exactly", () => {
  // The reconciliation that makes the evidence load-bearing rather than
  // decorative. If this drifts, one of the two numbers was edited alone.
  const entry = VOICE_MODEL_PRICE_REGISTER.find(
    (candidate) => candidate.modelId === "gpt-4o-mini-transcribe"
  );
  const { audioInputPerMillionTokensUsd, outputPerMillionTokensUsd } =
    entry.price;
  const observation = entry.costObservation;

  const implied =
    (observation.audioInputTokens * audioInputPerMillionTokensUsd) / 1e6 +
    (observation.outputTokens * outputPerMillionTokensUsd) / 1e6;

  assert.ok(
    Math.abs(implied - observation.totalUsd) < 5e-7,
    `rates imply ${implied} but the invoice recorded ${observation.totalUsd}`
  );
});

test("the audio rate is not the published text rate", () => {
  // The specific defect §6.1.3 found: the pricing table's `Input` column is
  // the text rate, and costing transcription with it understates the input
  // side by 2.4x. A future edit that collapses the two fields back into one
  // has to fail here.
  const entry = VOICE_MODEL_PRICE_REGISTER.find(
    (candidate) => candidate.modelId === "gpt-4o-mini-transcribe"
  );

  assert.equal(entry.price.textInputPerMillionTokensUsd, 1.25);
  assert.equal(entry.price.audioInputPerMillionTokensUsd, 3.0);
});

test("a rate the invoice does not support is refused", () => {
  // Why the observation is an object and not a boolean: correcting a rate
  // without re-observing it stops the arithmetic closing, and the audit says
  // so. A boolean could not have noticed.
  const drifted = [
    {
      ...VOICE_MODEL_PRICE_REGISTER.find(
        (candidate) => candidate.modelId === "gpt-4o-mini-transcribe"
      ),
      price: {
        audioInputPerMillionTokensUsd: 1.25,
        textInputPerMillionTokensUsd: 1.25,
        outputPerMillionTokensUsd: 5.0,
        estimatedCostPerMinuteUsd: 0.003,
      },
    },
  ];

  const problems = auditVoicePriceRegister({
    modelIds: ["gpt-4o-mini-transcribe"],
    now: new Date("2026-09-02T00:00:00Z"),
    register: drifted,
  });

  assert.equal(problems[0].code, "observation_does_not_reconcile");
});

test("an invoice recorded against no audio rate at all is refused", () => {
  const contradictory = [
    {
      ...VOICE_MODEL_PRICE_REGISTER.find(
        (candidate) => candidate.modelId === "gpt-4o-mini-transcribe"
      ),
      price: {
        audioInputPerMillionTokensUsd: null,
        textInputPerMillionTokensUsd: 1.25,
        outputPerMillionTokensUsd: 5.0,
        estimatedCostPerMinuteUsd: 0.003,
      },
    },
  ];

  const problems = auditVoicePriceRegister({
    modelIds: ["gpt-4o-mini-transcribe"],
    now: new Date("2026-09-02T00:00:00Z"),
    register: contradictory,
  });

  assert.deepEqual(problems.map((problem) => problem.code).sort(), [
    "audio_input_rate_unknown",
    "observation_does_not_reconcile",
  ]);
});

test("a ticket that names nothing is refused", () => {
  // The register nearly shipped with `VOICE-PRICE-001`, which was a plausible
  // string pointing at no tracked work. A reference nobody can open creates
  // the appearance of traceability and none of it.
  for (const entry of VOICE_MODEL_PRICE_REGISTER) {
    assert.match(
      entry.ticket,
      /^(#\d+|https?:\/\/\S+)$/,
      `${entry.modelId}: ${entry.ticket} is not something a person can open`
    );
  }
});
