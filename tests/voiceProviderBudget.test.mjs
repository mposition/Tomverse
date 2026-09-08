import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveVoiceProviderBudget,
  VOICE_PROVIDER_BUDGET_DEV_DEFAULTS,
  VOICE_PROVIDER_BUDGET_ENV_NAMES,
} from "../lib/voiceProviderBudget.ts";
import {
  secondsUntilVoiceBudgetDayReset,
  secondsUntilVoiceBudgetMonthReset,
  voiceBudgetDayStart,
  voiceBudgetMonthStart,
  voiceBudgetNextMonthStart,
} from "../lib/voiceProviderBudget.ts";
import {
  auditVoicePriceRegister,
  voiceModelPriceRefusal,
  VOICE_MODEL_PRICE_REGISTER,
  VOICE_PRICE_REVERIFY_MAX_DAYS,
} from "../lib/voiceInputPricing.ts";
import {
  DEFAULT_VOICE_TRANSCRIPTION_MODEL,
  resolveVoiceTranscriptionModel,
} from "../lib/voiceTranscriptionPortCore.ts";

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

// ---------------------------------------------------------------------------
// Readiness: the configured model has to be one whose cost is known
// docs/policy/voice-input.md §6.1.4
// ---------------------------------------------------------------------------

test("the configured model is resolved in one place", () => {
  // Readiness checks a model's price and the port calls a model. If those two
  // read the environment separately they can drift, and then the check is
  // verifying a model nobody calls.
  assert.equal(
    resolveVoiceTranscriptionModel({}),
    DEFAULT_VOICE_TRANSCRIPTION_MODEL
  );
  assert.equal(
    resolveVoiceTranscriptionModel({ VOICE_TRANSCRIPTION_MODEL: "gpt-4o-transcribe" }),
    "gpt-4o-transcribe"
  );
  // Set-but-blank is not a model choice.
  assert.equal(
    resolveVoiceTranscriptionModel({ VOICE_TRANSCRIPTION_MODEL: "   " }),
    DEFAULT_VOICE_TRANSCRIPTION_MODEL
  );
});

test("the default model may be called", () => {
  assert.equal(
    voiceModelPriceRefusal({ modelId: DEFAULT_VOICE_TRANSCRIPTION_MODEL }),
    null
  );
});

test("a model with no known audio rate is refused", () => {
  // The concrete case this rule exists for: an operator setting
  // VOICE_TRANSCRIPTION_MODEL to the entry that has never been invoiced.
  assert.equal(
    voiceModelPriceRefusal({ modelId: "gpt-4o-transcribe" })?.code,
    "audio_input_rate_unknown"
  );
});

test("an unrecognised model string is refused, not shrugged at", () => {
  // A typo must not be a route to a model whose cost nothing here can state.
  assert.equal(
    voiceModelPriceRefusal({ modelId: "gpt-4o-mini-transcirbe" })?.code,
    "model_not_in_register"
  );
  assert.equal(
    voiceModelPriceRefusal({ modelId: "whisper-1" })?.code,
    "model_not_in_register"
  );
});

test("a priced model that has never been invoiced is refused", () => {
  // §6.1-3: running on an unobserved cost needs a recorded human approval, so
  // the default is refusal rather than silent acceptance.
  const pricedButUnobserved = [
    {
      ...VOICE_MODEL_PRICE_REGISTER.find(
        (candidate) => candidate.modelId === "gpt-4o-mini-transcribe"
      ),
      costObservation: null,
    },
  ];

  assert.equal(
    voiceModelPriceRefusal({
      modelId: "gpt-4o-mini-transcribe",
      register: pricedButUnobserved,
    })?.code,
    "cost_never_observed"
  );
});

test("an expired reading does not refuse readiness", () => {
  // Deliberate: readiness asks whether this configuration is usable now, and
  // failing it on a calendar date would take a running production down with no
  // deploy and no code change. CI keeps failing on expiry instead.
  const stale = [
    {
      ...VOICE_MODEL_PRICE_REGISTER.find(
        (candidate) => candidate.modelId === "gpt-4o-mini-transcribe"
      ),
      reverifyBy: "2020-01-01",
    },
  ];

  assert.equal(
    voiceModelPriceRefusal({ modelId: "gpt-4o-mini-transcribe", register: stale }),
    null
  );
  // ...but the audit still calls it expired.
  assert.ok(
    auditVoicePriceRegister({
      modelIds: ["gpt-4o-mini-transcribe"],
      now: new Date("2026-09-08T00:00:00Z"),
      register: stale,
    }).some((problem) => problem.code === "expired")
  );
});

// ---------------------------------------------------------------------------
// Budget bucket boundaries and the retry-after they imply
// docs/policy/voice-input.md §6.1-4; docs/ops/voice-provider-budget-rollout.md §2
// ---------------------------------------------------------------------------

const at = (iso) => new Date(iso);

test("buckets open on UTC calendar boundaries", () => {
  // Not local time: a KST-anchored day would roll at 15:00 UTC and the ledger
  // would book into a bucket the refusal never refers to.
  const now = at("2026-09-08T23:30:00.000Z");

  assert.equal(voiceBudgetDayStart(now).toISOString(), "2026-09-08T00:00:00.000Z");
  assert.equal(voiceBudgetMonthStart(now).toISOString(), "2026-09-01T00:00:00.000Z");
});

test("a daily refusal points at the next UTC midnight", () => {
  const now = at("2026-09-08T23:59:00.000Z");

  assert.equal(secondsUntilVoiceBudgetDayReset(now), 60);
});

test("a monthly refusal points at the 1st, not at tomorrow", () => {
  // The defect this fixes: the month bucket does not recover until the 1st, so
  // quoting the daily figure sends the user back into the same refusal every
  // day until then.
  const now = at("2026-09-08T00:00:00.000Z");

  assert.equal(secondsUntilVoiceBudgetDayReset(now), 86_400);
  assert.equal(secondsUntilVoiceBudgetMonthReset(now), 23 * 86_400);
  assert.ok(
    secondsUntilVoiceBudgetMonthReset(now) > secondsUntilVoiceBudgetDayReset(now)
  );
});

test("the month rolls over the year end without a special case", () => {
  // `Date.UTC` normalises a 13th month into the next January. A hand-written
  // `month + 1` guard is the thing that gets this wrong.
  const now = at("2026-12-31T23:59:00.000Z");

  assert.equal(
    voiceBudgetNextMonthStart(now).toISOString(),
    "2027-01-01T00:00:00.000Z"
  );
  assert.equal(secondsUntilVoiceBudgetMonthReset(now), 60);
});

test("month ends of every length land on the 1st", () => {
  // 30-day, 31-day, a common-year February and a leap February. Month length
  // is never computed here, and these fix that it stays that way.
  for (const [now, expected] of [
    ["2026-04-30T12:00:00.000Z", "2026-05-01T00:00:00.000Z"],
    ["2026-01-31T12:00:00.000Z", "2026-02-01T00:00:00.000Z"],
    ["2026-02-28T12:00:00.000Z", "2026-03-01T00:00:00.000Z"],
    ["2028-02-29T12:00:00.000Z", "2028-03-01T00:00:00.000Z"],
  ]) {
    assert.equal(
      voiceBudgetNextMonthStart(at(now)).toISOString(),
      expected,
      `${now} -> ${expected}`
    );
  }
});

test("a leap day is a day like any other for the daily bucket", () => {
  const now = at("2028-02-29T23:00:00.000Z");

  assert.equal(voiceBudgetDayStart(now).toISOString(), "2028-02-29T00:00:00.000Z");
  assert.equal(secondsUntilVoiceBudgetDayReset(now), 3_600);
});

test("a reset is never zero or in the past", () => {
  // `resetAt` must be in the future -- an already-elapsed one reads as
  // "retryable now" and the caller retries straight into the same refusal.
  for (const now of [
    at("2026-09-08T23:59:59.999Z"),
    at("2026-09-30T23:59:59.999Z"),
    at("2026-12-31T23:59:59.999Z"),
  ]) {
    assert.ok(secondsUntilVoiceBudgetDayReset(now) >= 1, `day ${now.toISOString()}`);
    assert.ok(secondsUntilVoiceBudgetMonthReset(now) >= 1, `month ${now.toISOString()}`);
  }
});

test("the first instant of a month is a whole month away from the next", () => {
  const now = at("2026-09-01T00:00:00.000Z");

  assert.equal(secondsUntilVoiceBudgetMonthReset(now), 30 * 86_400);
});
