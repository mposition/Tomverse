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
  // Both entries are now observed: gpt-4o-transcribe was verified on
  // 2026-09-09 (docs/policy/voice-input.md §6.1.6). Until then this asserted
  // the single gap, which was the register reporting a hole rather than
  // papering over it.
  assert.deepEqual(
    auditVoicePriceRegister({
      modelIds: ["gpt-4o-mini-transcribe", "gpt-4o-transcribe"],
      now: new Date("2026-09-09T00:00:00Z"),
    }),
    []
  );
});

test("an entry whose audio rate is unknown is still reported as unknown", () => {
  // The rule the test above used to carry. It moves to an injected register
  // rather than disappearing: the shipped entries filling their gaps must not
  // take the check for gaps down with them, or the next unverified model is
  // added to a register that no longer refuses one.
  const problems = auditVoicePriceRegister({
    modelIds: ["some-future-transcribe"],
    now: new Date("2026-09-09T00:00:00Z"),
    register: [
      {
        modelId: "some-future-transcribe",
        price: {
          audioInputPerMillionTokensUsd: null,
          publishedAudioInputPerMillionTokensUsd: 1.0,
          outputPerMillionTokensUsd: 2.0,
          estimatedCostPerMinuteUsd: 0.001,
        },
        verifiedAt: "2026-09-02",
        owner: "@mposition",
        ticket: "#1247",
        reverifyBy: "2026-11-01",
        costObservation: null,
      },
    ],
  });
  assert.deepEqual(
    problems.map((problem) => [problem.modelId, problem.code]),
    [["some-future-transcribe", "audio_input_rate_unknown"]]
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

  // Both entries now carry one. gpt-4o-transcribe was the held case until
  // 2026-09-09; what makes its observation evidence rather than a number is
  // the same thing that makes the other's -- the recorded rates reproduce the
  // billed amount exactly, which `auditVoicePriceRegister` re-checks above.
  const second = byId["gpt-4o-transcribe"].costObservation;
  assert.notEqual(second, null, "gpt-4o-transcribe records no invoice");
  assert.ok(second.totalUsd > 0);
  assert.ok(second.requests > 0);
  assert.ok(second.isolation.trim() && second.source.trim());
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

test("the provider billed the same count the response reported", () => {
  // The one fact that makes a rate "per million tokens" mean anything. An
  // amount alone cannot separate "2.4x the price" from "2.4x the units": 228
  // units at the published US$2.50/1M reaches the same US$0.00057 as 95 at
  // US$6.00/1M. The Costs API's `quantity` settles it, and it is recorded so
  // the question is not re-argued from the amount
  // (docs/policy/voice-input.md §6.1.3).
  for (const entry of VOICE_MODEL_PRICE_REGISTER) {
    const seen = entry.costObservation;
    if (!seen) continue;

    assert.equal(
      seen.billedQuantityUnit,
      "tokens",
      `${entry.modelId} was billed in ${seen.billedQuantityUnit}, which a per-million-token rate is not per`
    );
    assert.equal(
      seen.billedAudioInputQuantity,
      seen.audioInputTokens,
      `${entry.modelId}: the response reported ${seen.audioInputTokens} audio tokens and the provider billed for ${seen.billedAudioInputQuantity}`
    );
    assert.equal(seen.billedOutputQuantity, seen.outputTokens);
  }
});

test("the reconciliation uses the billed quantity, not the reported one", () => {
  // A charge is a rate times a quantity. Reconciling against the response's
  // own token count would make the audit agree with itself whenever the
  // provider counts differently -- exactly the case the audit exists to
  // notice. This fixture's arithmetic closes only if the billed quantity is
  // the one used.
  const base = VOICE_MODEL_PRICE_REGISTER.find(
    (candidate) => candidate.modelId === "gpt-4o-mini-transcribe"
  );
  const diverged = [
    {
      ...base,
      costObservation: {
        ...base.costObservation,
        billedAudioInputQuantity: 704,
        totalUsd: 0.002672,
      },
    },
  ];

  const problems = auditVoicePriceRegister({
    modelIds: ["gpt-4o-mini-transcribe"],
    now: new Date("2026-09-02T00:00:00Z"),
    register: diverged,
  });

  assert.deepEqual(
    problems.map((problem) => problem.code),
    ["billing_basis_diverged"]
  );
  assert.match(problems[0].detail, /no longer a rate per response token/);
});

test("a charge billed in some other unit is refused, not converted", () => {
  // Seconds against a per-million-token rate is not an arithmetic problem to
  // solve; it means the rate fields are named for a unit the provider is not
  // billing, and inventing the conversion is how a made-up ratio becomes the
  // register's answer.
  const base = VOICE_MODEL_PRICE_REGISTER.find(
    (candidate) => candidate.modelId === "gpt-4o-mini-transcribe"
  );
  const inSeconds = [
    {
      ...base,
      costObservation: {
        ...base.costObservation,
        billedQuantityUnit: "seconds",
      },
    },
  ];

  const problems = auditVoicePriceRegister({
    modelIds: ["gpt-4o-mini-transcribe"],
    now: new Date("2026-09-02T00:00:00Z"),
    register: inSeconds,
  });

  assert.deepEqual(
    problems.map((problem) => problem.code),
    ["billed_unit_is_not_tokens"]
  );
});

test("the effective audio rate is not the published one", () => {
  // Costing transcription from the published price understates the input side
  // by 2.4x, on every model measured. Why it does is not established
  // (docs/policy/voice-input.md §6.1.3) -- what is established is that the two
  // numbers differ, so a future edit collapsing them into one field has to
  // fail here.
  const entry = VOICE_MODEL_PRICE_REGISTER.find(
    (candidate) => candidate.modelId === "gpt-4o-mini-transcribe"
  );

  assert.equal(entry.price.publishedAudioInputPerMillionTokensUsd, 1.25);
  assert.equal(entry.price.audioInputPerMillionTokensUsd, 3.0);
  assert.notEqual(
    entry.price.audioInputPerMillionTokensUsd,
    entry.price.publishedAudioInputPerMillionTokensUsd,
    "if these ever agree, the discrepancy this register records has closed " +
      "and §6.1.3 needs re-reading rather than this assertion relaxing"
  );
});

test("the effective rate is what reproduces the invoice, on both models", () => {
  // The register's central arithmetic, asserted directly rather than only
  // through the audit: the recorded rates have to reproduce a real charge.
  const byId = Object.fromEntries(
    VOICE_MODEL_PRICE_REGISTER.map((entry) => [entry.modelId, entry])
  );
  for (const modelId of ["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]) {
    const { price, costObservation: seen } = byId[modelId];
    const implied =
      (seen.audioInputTokens * price.audioInputPerMillionTokensUsd) / 1e6 +
      (seen.outputTokens * price.outputPerMillionTokensUsd) / 1e6;
    assert.ok(
      Math.abs(implied - seen.totalUsd) < 5e-7,
      `${modelId}: recorded rates imply ${implied}, invoice says ${seen.totalUsd}`
    );
  }
});

test("the published audio price would not reproduce either invoice", () => {
  // Why the register cannot simply hold the page's number. Stated as
  // arithmetic so that anyone tempted to collapse the two fields has to
  // delete a failing test to do it.
  const byId = Object.fromEntries(
    VOICE_MODEL_PRICE_REGISTER.map((entry) => [entry.modelId, entry])
  );
  for (const modelId of ["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]) {
    const { price, costObservation: seen } = byId[modelId];
    const atPublished =
      (seen.audioInputTokens * price.publishedAudioInputPerMillionTokensUsd) /
        1e6 +
      (seen.outputTokens * price.outputPerMillionTokensUsd) / 1e6;
    assert.ok(
      atPublished < seen.totalUsd,
      `${modelId}: the published price must under-state the real charge`
    );
  }
});

test("the discrepancy is on the input side only", () => {
  // Output matched the published price exactly on both models. Recorded
  // because it bounds what any future explanation has to account for: not
  // "this account is billed differently" in general, but the input side
  // specifically.
  const byId = Object.fromEntries(
    VOICE_MODEL_PRICE_REGISTER.map((entry) => [entry.modelId, entry])
  );
  for (const [modelId, publishedOutput] of [
    ["gpt-4o-mini-transcribe", 5.0],
    ["gpt-4o-transcribe", 10.0],
  ]) {
    const { price, costObservation: seen } = byId[modelId];
    assert.equal(price.outputPerMillionTokensUsd, publishedOutput);
    // The audio half is what the whole invoice minus the output half leaves.
    const audioHalf =
      seen.totalUsd - (seen.outputTokens * publishedOutput) / 1e6;
    const effective = (audioHalf / seen.audioInputTokens) * 1e6;
    assert.ok(
      Math.abs(effective / price.publishedAudioInputPerMillionTokensUsd - 2.4) <
        1e-9,
      `${modelId}: effective/published came to ${effective / price.publishedAudioInputPerMillionTokensUsd}, not 2.4`
    );
  }
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
        publishedAudioInputPerMillionTokensUsd: 1.25,
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
        publishedAudioInputPerMillionTokensUsd: 1.25,
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
  // The rule, driven by an injected entry. It used to point at
  // gpt-4o-transcribe, which was the register's one unverified model; that
  // entry was observed on 2026-09-09 (§6.1.6), and a rule that can only be
  // demonstrated against the shipped register stops being demonstrable the
  // moment the register is complete.
  assert.equal(
    voiceModelPriceRefusal({
      modelId: "some-future-transcribe",
      register: [
        {
          modelId: "some-future-transcribe",
          price: {
            audioInputPerMillionTokensUsd: null,
            publishedAudioInputPerMillionTokensUsd: 1.0,
            outputPerMillionTokensUsd: 2.0,
            estimatedCostPerMinuteUsd: 0.001,
          },
          verifiedAt: "2026-09-02",
          owner: "@mposition",
          ticket: "#1247",
          reverifyBy: "2026-11-01",
          costObservation: null,
        },
      ],
    })?.code,
    "audio_input_rate_unknown"
  );
});

test("both shipped models are now accepted by the readiness refusal", () => {
  // The behavioural consequence of §6.1.6, stated rather than left implicit:
  // a deployment that selects gpt-4o-transcribe is no longer refused, because
  // its cost is known. That is not advice to select it -- the default remains
  // gpt-4o-mini-transcribe and this model bills twice as much per audio token.
  for (const modelId of ["gpt-4o-mini-transcribe", "gpt-4o-transcribe"]) {
    assert.equal(
      voiceModelPriceRefusal({ modelId }),
      null,
      `${modelId} should have a known cost`
    );
  }
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
