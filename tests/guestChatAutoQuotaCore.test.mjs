import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GuestAutoQuotaError,
  planGuestAutoCreditConversion,
  planGuestAutoCreditPrehold,
} from "@/lib/guestChatAutoQuotaCore";
import { estimateRequestCredits } from "@/lib/webSearchCredits";
import { guestChatMaxInputTokens } from "@/lib/chatSecurity";

const candidates = [
  { modelId: "guest-cheap", provider: "provider-a", usageCredits: 1, guestEligible: true },
  { modelId: "guest-mid", provider: "provider-b", usageCredits: 3, guestEligible: true },
  { modelId: "guest-expensive", provider: "provider-c", usageCredits: 8, guestEligible: true },
];

test("Guest Auto filters unreachable candidates before taking the maximum hold", () => {
  const hold = planGuestAutoCreditPrehold({
    candidates,
    remainingDayCredits: 4,
    remainingMonthCredits: 20,
  });

  assert.deepEqual(hold.reachableCandidates.map((candidate) => candidate.modelId), [
    "guest-cheap",
    "guest-mid",
  ]);
  assert.equal(hold.basisModelId, "guest-mid");
  assert.equal(hold.minuteAmount, 1);
  assert.equal(hold.dayAmount, 3);
  assert.equal(hold.monthAmount, 3);
});

test("Guest Auto refuses when neither existing allowance window can reach a candidate", () => {
  assert.throws(
    () => planGuestAutoCreditPrehold({
      candidates,
      remainingDayCredits: 0,
      remainingMonthCredits: 20,
    }),
    (error) => error instanceof GuestAutoQuotaError &&
      error.code === "no_reachable_candidate"
  );
});

test("Guest Auto converts the maximum hold to one exact reachable model and refunds only the difference", () => {
  const hold = planGuestAutoCreditPrehold({
    candidates,
    remainingDayCredits: 8,
    remainingMonthCredits: 8,
  });
  const conversion = planGuestAutoCreditConversion({
    prehold: hold,
    selectedModelId: "guest-mid",
    selectedProvider: "provider-b",
    selectedUsageCredits: 3,
  });

  assert.deepEqual(conversion, {
    selected: candidates[1],
    heldDayCredits: 8,
    heldMonthCredits: 8,
    exactDayCredits: 3,
    exactMonthCredits: 3,
    refundDayCredits: 5,
    refundMonthCredits: 5,
  });
});

test("Guest Auto refuses a model, provider or credit weight outside the frozen reachable view", () => {
  const hold = planGuestAutoCreditPrehold({
    candidates,
    remainingDayCredits: 4,
    remainingMonthCredits: 4,
  });

  for (const input of [
    { selectedModelId: "guest-expensive", selectedProvider: "provider-c", selectedUsageCredits: 8 },
    { selectedModelId: "guest-mid", selectedProvider: "provider-x", selectedUsageCredits: 3 },
    { selectedModelId: "guest-mid", selectedProvider: "provider-b", selectedUsageCredits: 2 },
  ]) {
    assert.throws(
      () => planGuestAutoCreditConversion({ prehold: hold, ...input }),
      (error) => error instanceof GuestAutoQuotaError &&
        error.code === "selected_candidate_unreachable"
    );
  }
});

test("Guest Auto refuses duplicate or malformed runtime candidates instead of guessing", () => {
  assert.throws(
    () => planGuestAutoCreditPrehold({
      candidates: [candidates[0], { ...candidates[0] }],
      remainingDayCredits: 10,
      remainingMonthCredits: 10,
    }),
    (error) => error instanceof GuestAutoQuotaError &&
      error.code === "duplicate_candidate"
  );
  assert.throws(
    () => planGuestAutoCreditPrehold({
      candidates: [{ ...candidates[0], usageCredits: 0 }],
      remainingDayCredits: 10,
      remainingMonthCredits: 10,
    }),
    (error) => error instanceof GuestAutoQuotaError &&
      error.code === "invalid_candidate"
  );
});

test("Guest Auto prehold covers the existing input multiplier and exact search surcharge", () => {
  const models = [
    { id: "guest-search", usageClass: "standard", creditWeight: 2,
      nativeSearch: true },
  ];
  const beforeThreshold = estimateRequestCredits({
    models,
    estimatedInputTokens: 16_000,
    webSearchMode: "always",
    backendReadiness: { brave: true },
  }).models[0];
  const afterThreshold = estimateRequestCredits({
    models,
    estimatedInputTokens: 16_001,
    webSearchMode: "always",
    backendReadiness: { brave: true },
  }).models[0];
  assert.equal(beforeThreshold.weightedBaseCredits, 2);
  assert.equal(afterThreshold.weightedBaseCredits, 3);
  assert.equal(afterThreshold.webSearchSurchargeCredits,
    beforeThreshold.webSearchSurchargeCredits);

  const candidate = {
    modelId: models[0].id,
    provider: "provider-a",
    usageCredits: afterThreshold.totalCredits,
    guestEligible: true,
  };
  const hold = planGuestAutoCreditPrehold({
    candidates: [candidate],
    remainingDayCredits: candidate.usageCredits,
    remainingMonthCredits: candidate.usageCredits,
  });
  assert.equal(planGuestAutoCreditConversion({
    prehold: hold,
    selectedModelId: candidate.modelId,
    selectedProvider: candidate.provider,
    selectedUsageCredits: candidate.usageCredits,
  }).exactDayCredits, candidate.usageCredits);
  assert.throws(() => planGuestAutoCreditConversion({
    prehold: hold,
    selectedModelId: candidate.modelId,
    selectedProvider: candidate.provider,
    selectedUsageCredits: candidate.usageCredits + 1,
  }), (error) => error instanceof GuestAutoQuotaError &&
    error.code === "selected_candidate_unreachable");
});

test("Guest Auto uses the existing Guest input ceiling before filtering reachable candidates", () => {
  const previous = process.env.CHAT_GUEST_MAX_INPUT_TOKENS;
  process.env.CHAT_GUEST_MAX_INPUT_TOKENS = "16001";
  try {
    const estimatedInputTokens = guestChatMaxInputTokens();
    assert.equal(estimatedInputTokens, 16_001);

    const estimates = estimateRequestCredits({
      models: [
        { id: "guest-cheap", usageClass: "standard", creditWeight: 1 },
        { id: "guest-expensive-search", usageClass: "standard", creditWeight: 3,
          nativeSearch: true },
      ],
      estimatedInputTokens,
      webSearchMode: "always",
      backendReadiness: { brave: true },
    }).models;
    const candidates = estimates.map((entry) => ({
      modelId: entry.modelId,
      provider: "provider-a",
      usageCredits: entry.totalCredits,
      guestEligible: true,
    }));
    const cheap = candidates.find((entry) => entry.modelId === "guest-cheap");
    const expensive = candidates.find(
      (entry) => entry.modelId === "guest-expensive-search"
    );
    assert.ok(cheap);
    assert.ok(expensive);
    assert.ok(expensive.usageCredits > cheap.usageCredits);

    // The expensive candidate cannot make the turn look unaffordable. The
    // existing remaining allowance filters it first, then the hold covers the
    // exact weighted input/search amount of the reachable candidate.
    const hold = planGuestAutoCreditPrehold({
      candidates,
      remainingDayCredits: cheap.usageCredits,
      remainingMonthCredits: cheap.usageCredits,
    });
    assert.deepEqual(
      hold.reachableCandidates.map((entry) => entry.modelId),
      ["guest-cheap"]
    );
    const conversion = planGuestAutoCreditConversion({
      prehold: hold,
      selectedModelId: cheap.modelId,
      selectedProvider: cheap.provider,
      selectedUsageCredits: cheap.usageCredits,
    });
    assert.ok(conversion.exactDayCredits <= hold.dayAmount);
    assert.ok(conversion.exactMonthCredits <= hold.monthAmount);
  } finally {
    if (previous === undefined) delete process.env.CHAT_GUEST_MAX_INPUT_TOKENS;
    else process.env.CHAT_GUEST_MAX_INPUT_TOKENS = previous;
  }
});
