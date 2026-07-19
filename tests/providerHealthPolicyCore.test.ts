import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateProviderFailureHealth,
  isEmptyResponseDiagnostic,
} from "../lib/providerHealthPolicyCore.ts";

test("one or two failures do not limit an entire provider", () => {
  assert.deepEqual(
    evaluateProviderFailureHealth({
      successCount: 0,
      failureCount: 2,
      consecutiveSuccesses: 0,
    }),
    {
      totalCount: 2,
      failureRatePercent: 100,
      enoughSamples: false,
      recovered: false,
      limited: false,
      outage: false,
    }
  );
});

test("a sampled failure rate of at least fifty percent limits the provider", () => {
  const result = evaluateProviderFailureHealth({
    successCount: 2,
    failureCount: 3,
    consecutiveSuccesses: 0,
  });

  assert.equal(result.failureRatePercent, 60);
  assert.equal(result.limited, true);
  assert.equal(result.outage, false);
});

test("a severe sampled failure rate marks an outage", () => {
  const result = evaluateProviderFailureHealth({
    successCount: 1,
    failureCount: 5,
    consecutiveSuccesses: 0,
  });

  assert.equal(result.failureRatePercent, 83.3);
  assert.equal(result.outage, true);
});

test("three consecutive successes recover the provider before the window expires", () => {
  const result = evaluateProviderFailureHealth({
    successCount: 3,
    failureCount: 5,
    consecutiveSuccesses: 3,
  });

  assert.equal(result.recovered, true);
  assert.equal(result.limited, false);
  assert.equal(result.outage, false);
});

test("empty output diagnostics are model-scoped transient failures", () => {
  assert.equal(
    isEmptyResponseDiagnostic("AI_EMPTY_RESPONSE.AI_NoOutputGeneratedError"),
    true
  );
  assert.equal(isEmptyResponseDiagnostic("AI_REQUEST_FAILED.503"), false);
});
