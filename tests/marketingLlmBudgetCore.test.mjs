import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MARKETING_LLM_CLOSE_REASONS,
  MARKETING_LLM_CLOSE_REASONS_BY_STATE,
  MARKETING_LLM_MONTHLY_CAP_CEILING_MICRO_USD,
  MARKETING_LLM_OBSERVED_CLOSE_REASONS,
  marketingLlmReportedModelMatches,
  canonicalMarketingLlmJson,
  marketingLlmAdapterConfigDigest,
  marketingLlmBudgetSignature,
  marketingLlmCloseDigest,
  marketingLlmConfigSnapshot,
  marketingLlmConsumerDigest,
  marketingLlmDispatchDigest,
  marketingLlmMonthKey,
  marketingLlmPinProblems,
  marketingLlmPinAllows,
  marketingLlmPricePinDigest,
  marketingLlmRequestDigest,
  marketingLlmReservation,
  marketingLlmReservePayloadDigest,
  marketingLlmSettleOutcome,
  MARKETING_LLM_SETTINGS_UNSET,
  marketingLlmSettingsValue,
  parseMarketingLlmMonthlyCap,
  parseMarketingLlmSettings,
  resolveMarketingLlmPin,
} from "../lib/marketingLlmBudgetCore.ts";

const pin = (overrides = {}) => ({
  model: "fixture-model-2026-10-01",
  tokenizerFamily: "o200k",
  projectId: "proj_fixture",
  region: "us",
  tiers: ["default", "flex", "priority"],
  contextWindowTokens: 128_000,
  worstInputMicroUsdPerMillion: 800_000,
  worstOutputMicroUsdPerMillion: 3_200_000,
  maxOutputTokens: 4_096,
  priceVersion: "fixture-v1",
  verifiedAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2026-12-30T00:00:00.000Z",
  source: "https://example.invalid/pricing",
  ...overrides,
});

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

test("with no pin for a model nothing can be reserved against it", () => {
  assert.deepEqual(resolveMarketingLlmPin([], "anything", new Date()), { ok: false, code: "model_not_pinned" });
});

test("a reported model is the pinned one when it is the same id or a dated snapshot of it", () => {
  assert.equal(marketingLlmReportedModelMatches("gpt-5.4-mini", "gpt-5.4-mini"), true);
  assert.equal(marketingLlmReportedModelMatches("gpt-5.4-mini", "gpt-5.4-mini-2026-03-17"), true);
  for (const reported of ["gpt-5.4-mini-high", "gpt-5.4", "gpt-5.4-mini-2026-03", "gpt-5.4-mini-2026-03-17x", "gpt-6-luna"]) {
    assert.equal(marketingLlmReportedModelMatches("gpt-5.4-mini", reported), false, reported);
  }
});

test("canonical JSON sorts keys, omits absent values and refuses null and fractions", () => {
  assert.equal(canonicalMarketingLlmJson({ b: 1, a: { d: "x", c: true }, e: undefined }), '{"a":{"c":true,"d":"x"},"b":1}');
  assert.throws(() => canonicalMarketingLlmJson({ a: null }), /canonical_null:\$\.a/);
  assert.throws(() => canonicalMarketingLlmJson({ a: 1.5 }), /canonical_number/);
  assert.throws(() => canonicalMarketingLlmJson({ a: 2 ** 60 }), /canonical_number/);
});

test("the consumer digest is the sha256 of exactly the canonical bytes", () => {
  const submissionDigest = "a".repeat(64);
  assert.equal(
    marketingLlmConsumerDigest(submissionDigest),
    sha(`{"domain":"marketing-llm-consumer-v1","submissionDigest":"${submissionDigest}"}`),
  );
});

test("fixed digest vectors for every row of the definitions table", () => {
  const snapshot = marketingLlmConfigSnapshot({ pin: pin(), adapterVersion: "1.0.0" });
  const reservePayloadDigest = marketingLlmReservePayloadDigest({
    requestKey: "00000000-0000-4000-8000-000000000001",
    generatorRunId: "run-1",
    purpose: "draft",
    model: "fixture-model-2026-10-01",
    adapterProfile: "text-only-v1",
  });
  const adapterConfigDigest = marketingLlmAdapterConfigDigest(snapshot);
  const base = {
    callId: "c00000000000000000000001",
    requestKey: "00000000-0000-4000-8000-000000000001",
  };
  const vectors = {
    pricePin: marketingLlmPricePinDigest(pin()),
    reservePayload: reservePayloadDigest,
    request: marketingLlmRequestDigest({ reservePayloadDigest, configSnapshot: snapshot }),
    adapterConfig: adapterConfigDigest,
    dispatch: marketingLlmDispatchDigest({
      ...base,
      dispatchIntentId: "00000000-0000-4000-8000-0000000000d1",
      adapterConfigDigest,
    }),
    closeSettle: marketingLlmCloseDigest({
      ...base,
      action: "settle",
      terminalState: "settled",
      reason: "settled",
      dispatchIntentId: "00000000-0000-4000-8000-0000000000d1",
      observation: {
        observationId: "00000000-0000-4000-8000-0000000000b1",
        reportedModel: "fixture-model-2026-10-01",
        reportedServiceTier: "default",
        reportedInputTokens: 1200,
        reportedOutputTokens: 300,
      },
    }),
    closeExpireReserved: marketingLlmCloseDigest({
      ...base,
      action: "expire",
      terminalState: "released",
      reason: "reservation_expired",
    }),
    closeExpireDispatched: marketingLlmCloseDigest({
      ...base,
      action: "expire",
      terminalState: "unknown_retained",
      reason: "dispatch_expired",
      dispatchIntentId: "00000000-0000-4000-8000-0000000000d1",
    }),
    consumer: marketingLlmConsumerDigest("a".repeat(64)),
    budgetSignature: marketingLlmBudgetSignature("s".repeat(40), {
      action: "release",
      deadlineAt: "2026-10-16T00:00:30.000Z",
      fields: { callId: base.callId },
    }),
  };
  assert.deepEqual(vectors, {
    pricePin: "ec96ffa3bc44904ab806d4e446a1e76c83fdbb82ca0a6fe4630fed4fbc454ff3",
    reservePayload: "2b4e2520915f46c2284e2d82a582d414a38804609a8da959838fcb1a472505b4",
    request: "c4f0f40d2d917bd7a1f1ae1f11834a95febc09c4d449e327d2f5f8f4a4d04989",
    adapterConfig: "0aadd6002d27e92a3a82fad02e845a8d6089ac7e67ff8c0aaba0ee28c66d0649",
    dispatch: "f70c1cf163a18715bd18c7d09e0b27cab1113923837945ec6d45b67110933833",
    closeSettle: "1a80088e4c4a17f3c055d5c1e1e1978f67bd23cb30d6a3a5cfea35d99abe5beb",
    closeExpireReserved: "ab6e651a2c1b4b5fb62adde66e440f9915c6498e73a7918334e92c9e2e9e951e",
    closeExpireDispatched: "fb458c1506acca0e0f858df7577e3f4c0494b786e23b532af81c4ebbdbf02a08",
    consumer: "843b82dbffe1b2b4bc15f48fa01d0fe1a8090076c3d8ada552f03bc30c69d011",
    budgetSignature: "9a71c9e38b05167e29248b52a622a0cab018ba18d469fd6ff7d17e890c2021d9",
  });
});

test("an expiry close and a generator release of the same call never share a digest", () => {
  const base = { callId: "c00000000000000000000001", requestKey: "00000000-0000-4000-8000-000000000001" };
  assert.notEqual(
    marketingLlmCloseDigest({ ...base, action: "expire", terminalState: "released", reason: "reservation_expired" }),
    marketingLlmCloseDigest({ ...base, action: "release", terminalState: "released", reason: "reported_undispatched" }),
  );
});

test("the adapter digest follows the stored snapshot, so a new adapter version is a mismatch", () => {
  const stored = marketingLlmConfigSnapshot({ pin: pin(), adapterVersion: "1.0.0" });
  const deployed = marketingLlmConfigSnapshot({ pin: pin(), adapterVersion: "1.0.1" });
  assert.notEqual(marketingLlmAdapterConfigDigest(stored), marketingLlmAdapterConfigDigest(deployed));
  assert.equal(stored.pricePinDigest, marketingLlmPricePinDigest(pin()));
  assert.deepEqual(
    { maxRetries: stored.maxRetries, store: stored.store, stream: stored.stream, serviceTier: stored.serviceTier },
    { maxRetries: 0, store: false, stream: false, serviceTier: "default" },
  );
});

test("the reservation is the whole context window and output cap at worst prices, rounded up", () => {
  // 128,000 x 0.8 + 4,096 x 3.2 = 102,400 + 13,107.2 -> 115,508 micro-USD.
  assert.deepEqual(marketingLlmReservation(pin()), {
    reservedInputTokens: 128_000,
    reservedOutputTokens: 4_096,
    reservedMicroUsd: 115_508,
  });
  // Exact multiples are not rounded up.
  assert.equal(
    marketingLlmReservation(pin({ contextWindowTokens: 1_000_000, worstInputMicroUsdPerMillion: 1, maxOutputTokens: 1_000_000, worstOutputMicroUsdPerMillion: 1 })).reservedMicroUsd,
    2,
  );
});

test("a pin is usable only when every field is well formed and inside the row limits", () => {
  assert.deepEqual(marketingLlmPinProblems(pin()), []);
  assert.ok(marketingLlmPinProblems(pin({ tiers: ["flex", "default"] })).includes("tiers_format"));
  assert.ok(marketingLlmPinProblems(pin({ tiers: ["flex"] })).includes("default_tier_missing"));
  assert.ok(marketingLlmPinProblems(pin({ expiresAt: pin().verifiedAt })).includes("expiry_not_after_verified"));
  assert.ok(marketingLlmPinProblems(pin({ source: "http://example.invalid" })).includes("source_format"));
  assert.ok(marketingLlmPinProblems(pin({ contextWindowTokens: 2_000_001 })).includes("context_window_over_row_limit"));
  assert.ok(marketingLlmPinProblems(pin({ maxOutputTokens: 100_001 })).includes("output_cap_over_row_limit"));
  assert.ok(marketingLlmPinProblems(pin({ worstInputMicroUsdPerMillion: 50_000_000 })).includes("reservation_over_row_limit"));
  assert.ok(marketingLlmPinProblems(pin({ maxOutputTokens: 0 })).includes("maxOutputTokens_range"));
});

test("pin lookup refuses unknown, duplicated, malformed and expired pins", () => {
  const at = (iso) => new Date(iso);
  assert.deepEqual(resolveMarketingLlmPin([pin()], "fixture-model-2026-10-01", at("2026-10-16T00:00:00Z")), { ok: true, pin: pin() });
  assert.equal(resolveMarketingLlmPin([pin()], "other", at("2026-10-16T00:00:00Z")).code, "model_not_pinned");
  assert.equal(resolveMarketingLlmPin([pin(), pin()], "fixture-model-2026-10-01", at("2026-10-16T00:00:00Z")).code, "model_not_pinned");
  assert.equal(resolveMarketingLlmPin([pin({ tiers: [] })], "fixture-model-2026-10-01", at("2026-10-16T00:00:00Z")).code, "model_not_pinned");
  assert.equal(resolveMarketingLlmPin([pin()], "fixture-model-2026-10-01", at("2026-12-30T00:00:00Z")).code, "pin_expired");
  assert.equal(resolveMarketingLlmPin([pin()], "fixture-model-2026-10-01", at("2026-09-30T23:59:59Z")).code, "pin_expired");
});

test("the monthly cap is decimal USD read without floats, capped at US$100", () => {
  assert.equal(parseMarketingLlmMonthlyCap("100"), MARKETING_LLM_MONTHLY_CAP_CEILING_MICRO_USD);
  assert.equal(parseMarketingLlmMonthlyCap("100.000000"), 100_000_000);
  assert.equal(parseMarketingLlmMonthlyCap("0.000001"), 1);
  assert.equal(parseMarketingLlmMonthlyCap("12.34"), 12_340_000);
  assert.equal(parseMarketingLlmMonthlyCap("0.1"), 100_000);
  for (const bad of [undefined, "", "0", "0.000000", "100.000001", "101", "1000", "1e2", "-1", " 5", "5.", ".5", "5.1234567", "NaN"]) {
    assert.equal(parseMarketingLlmMonthlyCap(bad), null, String(bad));
  }
});

test("settle outcomes follow the fixed priority and fall back to the reservation", () => {
  const configSnapshot = marketingLlmConfigSnapshot({ pin: pin(), adapterVersion: "1.0.0" });
  const outcome = (observation) =>
    marketingLlmSettleOutcome({
      configSnapshot,
      reservedInputTokens: 128_000,
      reservedOutputTokens: 4_096,
      observation: {
        observationId: "00000000-0000-4000-8000-0000000000b1",
        reportedModel: "fixture-model-2026-10-01",
        reportedServiceTier: "default",
        reportedInputTokens: 10,
        reportedOutputTokens: 10,
        ...observation,
      },
    });
  assert.deepEqual(outcome({}), { terminalState: "settled", reason: "settled" });
  assert.deepEqual(outcome({ reportedInputTokens: 128_000, reportedOutputTokens: 4_096 }), { terminalState: "settled", reason: "settled" });
  assert.equal(outcome({ reportedOutputTokens: 4_097, reportedModel: "x", reportedServiceTier: "flex" }).reason, "tokens_over_bound");
  assert.equal(outcome({ reportedModel: "x", reportedServiceTier: "flex" }).reason, "model_mismatch");
  assert.equal(outcome({ reportedServiceTier: "flex" }).reason, "tier_mismatch");
});

test("close reasons are paired to states and to whether an observation is kept", () => {
  assert.deepEqual([...MARKETING_LLM_CLOSE_REASONS].sort(), [
    "dispatch_expired",
    "model_mismatch",
    "reported_undispatched",
    "reported_unknown",
    "reservation_expired",
    "settled",
    "tier_mismatch",
    "tokens_over_bound",
  ]);
  assert.deepEqual(MARKETING_LLM_CLOSE_REASONS_BY_STATE.released, ["reported_undispatched", "reservation_expired"]);
  assert.deepEqual([...MARKETING_LLM_OBSERVED_CLOSE_REASONS].sort(), ["model_mismatch", "settled", "tier_mismatch", "tokens_over_bound"]);
});

test("the month key is the UTC year and month", () => {
  assert.equal(marketingLlmMonthKey(new Date("2026-10-01T00:00:00.000Z")), "2026-10");
});

test("a web-search reservation reads the window once per model pass and adds every search, and a text reservation is unchanged", () => {
  const searchPin = pin({ webSearchMicroUsdPerCall: 10_000, maxWebSearchCalls: 3 });
  assert.equal(marketingLlmReservation(searchPin).reservedMicroUsd, 115_508);
  // Three searches requested, four billable (OpenAI's observed overshoot):
  // five passes of 128,000 x 0.8, the output cap once, and four searches --
  // 512,000 + 13,107.2 + 40,000.
  assert.deepEqual(marketingLlmReservation(searchPin, "web-search-v1"), {
    reservedInputTokens: 640_000,
    reservedOutputTokens: 4_096,
    reservedMicroUsd: 565_108,
  });
  // A pin without search fields prices no search, and is not allowed the profile.
  assert.equal(marketingLlmReservation(pin(), "web-search-v1").reservedMicroUsd, 115_508);
  assert.equal(marketingLlmPinAllows(pin(), "web-search-v1"), false);
  assert.equal(marketingLlmPinAllows(searchPin, "web-search-v1"), true);
  assert.equal(marketingLlmPinAllows(searchPin, "text-only-v1"), true);
  assert.equal(marketingLlmPinAllows(searchPin, "other"), false);
});

test("search fields come as a pair, positive and within the cap", () => {
  assert.deepEqual(marketingLlmPinProblems(pin({ webSearchMicroUsdPerCall: 10_000, maxWebSearchCalls: 3 })), []);
  for (const fields of [
    { webSearchMicroUsdPerCall: 10_000 },
    { maxWebSearchCalls: 3 },
    { webSearchMicroUsdPerCall: 0, maxWebSearchCalls: 3 },
    { webSearchMicroUsdPerCall: 10_000, maxWebSearchCalls: 11 },
    { webSearchMicroUsdPerCall: 1.5, maxWebSearchCalls: 3 },
  ]) {
    assert.ok(marketingLlmPinProblems(pin(fields)).includes("web_search_fields"), JSON.stringify(fields));
  }
  // The row limit is judged at the most expensive profile the pin allows.
  assert.ok(
    marketingLlmPinProblems(pin({ webSearchMicroUsdPerCall: 1_000_000, maxWebSearchCalls: 10 })).includes("reservation_over_row_limit"),
  );
});

test("the web-search profile's adapter digest names its search cap; the text profile's does not move", () => {
  const searchPin = pin({ webSearchMicroUsdPerCall: 10_000, maxWebSearchCalls: 3 });
  const text = marketingLlmAdapterConfigDigest(marketingLlmConfigSnapshot({ pin: searchPin, adapterVersion: "1.0.0" }));
  const search = marketingLlmAdapterConfigDigest(
    marketingLlmConfigSnapshot({ pin: searchPin, adapterVersion: "1.0.0", adapterProfile: "web-search-v1" }),
  );
  assert.notEqual(text, search);
  assert.notEqual(
    search,
    marketingLlmAdapterConfigDigest(
      marketingLlmConfigSnapshot({ pin: { ...searchPin, maxWebSearchCalls: 4 }, adapterVersion: "1.0.0", adapterProfile: "web-search-v1" }),
    ),
  );
});

test("the operator's settings document is read strictly, and anything else is unreadable", () => {
  assert.deepEqual(parseMarketingLlmSettings(undefined), MARKETING_LLM_SETTINGS_UNSET);
  assert.deepEqual(parseMarketingLlmSettings(null), MARKETING_LLM_SETTINGS_UNSET);
  const set = { model: "fixture-model-2026-10-01", monthlyUsdCap: "12.5" };
  assert.deepEqual(parseMarketingLlmSettings(marketingLlmSettingsValue(set)), set);
  assert.deepEqual(parseMarketingLlmSettings('{"monthlyUsdCap":null,"model":null}'), MARKETING_LLM_SETTINGS_UNSET);
  for (const value of [
    "{",
    "[]",
    '"x"',
    '{"model":null}',
    '{"model":null,"monthlyUsdCap":null,"extra":1}',
    '{"model":"has space","monthlyUsdCap":null}',
    '{"model":7,"monthlyUsdCap":null}',
    '{"model":null,"monthlyUsdCap":"101"}',
    '{"model":null,"monthlyUsdCap":"0"}',
    '{"model":null,"monthlyUsdCap":5}',
  ]) {
    assert.equal(parseMarketingLlmSettings(value), null, value);
  }
  // One spelling per settings, so equal settings compare equal as stored text.
  assert.equal(
    marketingLlmSettingsValue({ monthlyUsdCap: "1", model: "m" }),
    marketingLlmSettingsValue({ model: "m", monthlyUsdCap: "1" }),
  );
});
