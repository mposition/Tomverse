import assert from "node:assert/strict";
import test from "node:test";

import { readMaxSubscriptionPriceView } from "../../components/admin/AmuxMaxSubscriptionPricePanel";

const profile = { mode: "subscription_cli", inputMicroUsdPerMillion: 8_000_000,
  outputMicroUsdPerMillion: 20_000_000, inputTokensCap: 1_000_000, outputTokensCap: 128_000 };
const latest = { id: "p", version: 1, status: "approved",
  expiresAt: "2026-11-03T00:00:00.000Z", admissible: true };

test("the panel reads only a subscription_cli profile reply", () => {
  assert.equal(readMaxSubscriptionPriceView({ state: "profile", profile, latest: null })?.latest, null);
  assert.equal(readMaxSubscriptionPriceView({ state: "profile", profile, latest })?.latest?.admissible, true);
  for (const value of [null, { state: "profile", profile: { ...profile, mode: "api" }, latest },
    { state: "found", profile, latest }, { state: "profile", profile, latest: { ...latest, version: "1" } },
    { state: "profile", profile: { ...profile, inputTokensCap: "1" }, latest: null }]) {
    assert.equal(readMaxSubscriptionPriceView(value), null);
  }
});
