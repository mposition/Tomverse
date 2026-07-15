import assert from "node:assert/strict";
import test from "node:test";
import {
  providerCreditAlertLevel,
  providerCreditRemainingPercent,
} from "../lib/providerCreditAlertsCore.ts";

test("provider credit percentage is calculated from the saved checkpoint", () => {
  assert.equal(
    providerCreditRemainingPercent({
      configuredCreditMicroUsd: 100_000_000,
      estimatedBalanceMicroUsd: 49_900_000,
    }),
    49.9
  );
  assert.equal(
    providerCreditRemainingPercent({
      configuredCreditMicroUsd: null,
      estimatedBalanceMicroUsd: null,
    }),
    null
  );
});

test("provider credit alerts select the most severe remaining threshold", () => {
  assert.equal(providerCreditAlertLevel(51), "none");
  assert.equal(providerCreditAlertLevel(50), "50");
  assert.equal(providerCreditAlertLevel(20), "20");
  assert.equal(providerCreditAlertLevel(5), "5");
  assert.equal(providerCreditAlertLevel(-3), "5");
});
