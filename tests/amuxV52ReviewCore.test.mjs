import assert from "node:assert/strict";
import test from "node:test";

import { decideAmuxV52ReviewDisposition,
  validAmuxV52ReviewEvidence } from "../lib/amux/v52ReviewCore.ts";

const evidence = (overrides = {}) => ({
  jobId: "r-20261016-101442-654908",
  baseSha: "a".repeat(40), commitSha: "b".repeat(40),
  verdict: "accept", authorVendor: "openai",
  reviewerVendors: ["anthropic"], touchesContract: false,
  ...overrides,
});

test("review evidence binds one job and an independent reviewer", () => {
  assert.equal(validAmuxV52ReviewEvidence(evidence()), true);
  assert.equal(validAmuxV52ReviewEvidence(evidence({
    touchesContract: true, reviewerVendors: ["anthropic", "moonshot"],
  })), true);
  for (const invalid of [
    { baseSha: "a".repeat(39) }, { commitSha: "a".repeat(40) },
    { jobId: null }, { reviewerVendors: [] },
    { reviewerVendors: ["openai"] },
    { reviewerVendors: ["anthropic", "anthropic"] },
    { touchesContract: true },
  ]) assert.equal(validAmuxV52ReviewEvidence(evidence(invalid)), false);
});

test("unknown outcomes may lack a job but cannot be resubmitted as accepted", () => {
  assert.equal(validAmuxV52ReviewEvidence(evidence({
    verdict: "unknown", jobId: null, reviewerVendors: [],
  })), true);
  assert.deepEqual(decideAmuxV52ReviewDisposition("unknown", 0),
    { status: "blocked", reason: "review_server_unknown" });
});

test("the first rejection retries in the same grade and the second blocks", () => {
  assert.deepEqual(decideAmuxV52ReviewDisposition("reject", 0),
    { status: "todo", reason: "review_server_rejected" });
  assert.deepEqual(decideAmuxV52ReviewDisposition("reject", 1),
    { status: "blocked", reason: "review_server_rejected_twice" });
  assert.deepEqual(decideAmuxV52ReviewDisposition("accept", 1),
    { status: "review", reason: "review_server_accepted" });
  assert.deepEqual(decideAmuxV52ReviewDisposition("accept", -1),
    { status: "blocked", reason: "review_history_unavailable" });
});
