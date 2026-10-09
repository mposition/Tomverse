import assert from "node:assert/strict";
import test from "node:test";

import {
  PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST,
  PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
  PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
} from "../lib/promptRefinerProductContract.ts";
import {
  PROMPT_REFINER_AUTO_EXCEPTION_POLICY_COMMIT,
  PROMPT_REFINER_AUTO_EXCEPTION_POLICY_SHA256,
  resolvePromptRefinerProductRelease,
} from "../lib/promptRefinerProductRelease.ts";

const runtimeCommitSha = "a".repeat(40);
const runtimeDeploymentId = "11111111-1111-4111-8111-111111111111";
const entry = Object.freeze({
  version: "prompt-refiner-product-release-v1",
  status: "active",
  approvedBy: "owner",
  approvedAt: "2026-10-10T00:00:00.000Z",
  policyCommit: PROMPT_REFINER_AUTO_EXCEPTION_POLICY_COMMIT,
  policySha256: PROMPT_REFINER_AUTO_EXCEPTION_POLICY_SHA256,
  gateAuditLogId: "gate_audit",
  dispositionAuditLogId: "disposition_audit",
  limitedAuditReceiptId: "limited_audit",
  gateOutcome: "fail",
  gateReasonCodes: ["latency_ceiling_exceeded"],
  latencyOnlyFailure: true,
  limitedAuditDisposition: "pass",
  unresolvedAuditViolations: 0,
  candidateDigest: PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
  pricePinDigest: PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
  adapterConfigDigest: PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST,
  runtimeCommitSha,
  runtimeDeploymentId,
  explicitEnabled: true,
  autoEnabled: true,
});

test("product release is closed without one exact deployment-bound record", () => {
  const runtime = { RAILWAY_GIT_COMMIT_SHA: runtimeCommitSha,
    RAILWAY_DEPLOYMENT_ID: runtimeDeploymentId };
  assert.equal(resolvePromptRefinerProductRelease(runtime, []).autoEnabled, false);
  assert.equal(resolvePromptRefinerProductRelease(runtime, [entry, entry]).autoEnabled,
    false);
  assert.equal(resolvePromptRefinerProductRelease({ ...runtime,
    RAILWAY_DEPLOYMENT_ID: "22222222-2222-4222-8222-222222222222" },
  [entry]).explicitEnabled, false);
});

test("release validator accepts only the pinned latency exception shape", () => {
  const runtime = { RAILWAY_GIT_COMMIT_SHA: runtimeCommitSha,
    RAILWAY_DEPLOYMENT_ID: runtimeDeploymentId };
  assert.deepEqual(resolvePromptRefinerProductRelease(runtime, [entry]), {
    explicitEnabled: true, autoEnabled: true,
    runtimeDeploymentId, runtimeCommitSha,
  });
  assert.equal(resolvePromptRefinerProductRelease(runtime, [{ ...entry,
    gateReasonCodes: ["quality_failed"] }]).autoEnabled, false);
  assert.equal(resolvePromptRefinerProductRelease(runtime, [{ ...entry,
    adapterConfigDigest: "b".repeat(64) }]).autoEnabled, false);
});

