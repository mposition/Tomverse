import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  CHAT_UNIFIED_OPTIMIZER_PURPOSE,
  CHAT_UNIFIED_OPTIMIZER_ROLES,
  chatUnifiedOptimizerClaimDigest,
  chatUnifiedOptimizerTerminalDigest,
  chatUnifiedOptimizerTerminalSchema,
} from "../lib/chatUnifiedOptimizerLedgerCore.ts";

const DIGEST = "a".repeat(64);

test("optimizer ledger roles and purpose are closed provider-free values", () => {
  assert.equal(CHAT_UNIFIED_OPTIMIZER_PURPOSE, "provider_free_validation");
  assert.deepEqual(CHAT_UNIFIED_OPTIMIZER_ROLES, [
    "candidate_author", "case_author", "case_reviewer", "judge_primary",
    "judge_secondary", "coordinator",
  ]);
  assert.equal(Object.isFrozen(CHAT_UNIFIED_OPTIMIZER_ROLES), true);
});

test("claim and terminal digests bind exact immutable operation identity", () => {
  const requestId = randomUUID();
  const jobId = randomUUID();
  const claimToken = randomUUID();
  const claim = chatUnifiedOptimizerClaimDigest({ requestId, jobId });
  assert.match(claim, /^[0-9a-f]{64}$/);
  assert.notEqual(claim, chatUnifiedOptimizerClaimDigest({
    requestId: randomUUID(), jobId,
  }));
  const terminal = chatUnifiedOptimizerTerminalDigest({
    requestId, jobId, claimToken, outcome: "succeeded",
    evidenceRef: "synthetic:evidence:1", evidencePayloadDigest: DIGEST,
  });
  assert.notEqual(terminal, chatUnifiedOptimizerTerminalDigest({
    requestId, jobId, claimToken, outcome: "failed",
    evidenceRef: "synthetic:evidence:1", evidencePayloadDigest: DIGEST,
  }));
});

test("known terminal outcomes require evidence and unknown forbids it", () => {
  const base = { requestId: randomUUID(), jobId: randomUUID(),
    claimToken: randomUUID() };
  assert.equal(chatUnifiedOptimizerTerminalSchema.safeParse({ ...base,
    outcome: "succeeded", evidenceRef: "synthetic:evidence:1",
    evidencePayloadDigest: DIGEST }).success, true);
  assert.equal(chatUnifiedOptimizerTerminalSchema.safeParse({ ...base,
    outcome: "failed", evidenceRef: null,
    evidencePayloadDigest: null }).success, false);
  assert.equal(chatUnifiedOptimizerTerminalSchema.safeParse({ ...base,
    outcome: "outcome_unknown", evidenceRef: "synthetic:evidence:1",
    evidencePayloadDigest: DIGEST }).success, false);
  assert.equal(chatUnifiedOptimizerTerminalSchema.safeParse({ ...base,
    outcome: "outcome_unknown", evidenceRef: null,
    evidencePayloadDigest: null }).success, true);
  assert.equal(chatUnifiedOptimizerTerminalSchema.safeParse({ ...base,
    outcome: "succeeded", evidenceRef: "hidden/case/path",
    evidencePayloadDigest: DIGEST }).success, false);
});
