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

test("no entry claims an observed cost, because none has been observed", () => {
  // §6.1.2: the paid verification needs its own approval and has not run. The
  // register has to be able to say "read" without saying "charged", and this
  // is the line that fails on the day somebody flips the flag without doing
  // the work.
  for (const entry of VOICE_MODEL_PRICE_REGISTER) {
    assert.equal(
      entry.costObserved,
      false,
      `${entry.modelId} claims an observed cost; §6.1.2 says none has been`
    );
  }
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
