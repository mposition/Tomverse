import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CHAT_UNIFIED_OPTIMIZER_PURPOSE,
  CHAT_UNIFIED_OPTIMIZER_QUEUED_CLOSE_REASONS,
  CHAT_UNIFIED_OPTIMIZER_ROLES,
  chatUnifiedOptimizerClaimDigest,
  chatUnifiedOptimizerQueuedCloseDigest,
  chatUnifiedOptimizerQueuedCloseSchema,
  chatUnifiedOptimizerQueuedJobEvidenceDigest,
  chatUnifiedOptimizerQueuedJobTerminalDigest,
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

test("database role constraints and commit guard match the closed runtime roles", () => {
  const migrations = [
    "20261016200000_chat_unified_optimizer_ledger",
    "20261016203000_chat_unified_optimizer_queued_closure",
  ];
  const expected = [...CHAT_UNIFIED_OPTIMIZER_ROLES].sort();
  for (const migration of migrations) {
    const sql = readFileSync(new URL(
      `../prisma/migrations/${migration}/migration.sql`, import.meta.url), "utf8");
    const lists = [...sql.matchAll(/(?:"role"\s+IN\s*\(([^)]*)\)|ARRAY\[([\s\S]*?)\]::TEXT\[\])/g)]
      .map(match => match[1] ?? match[2])
      .filter(value => value.includes("'candidate_author'"));
    assert.equal(lists.length, migration.includes("200000") ? 2 : 1);
    for (const list of lists) {
      assert.deepEqual([...list.matchAll(/'([^']+)'/g)]
        .map(match => match[1]).sort(), expected);
    }
  }
});

test("audit metadata repair makes missing keys fail closed in every ledger guard", () => {
  const sql = readFileSync(new URL(
    "../prisma/migrations/20261016203500_chat_unified_optimizer_audit_metadata_null_guard/migration.sql",
    import.meta.url), "utf8");
  for (const guard of ["run_guard", "job_guard", "evidence_guard",
    "queued_closure_guard"]) {
    assert.ok(sql.includes(`CREATE OR REPLACE FUNCTION "chat_unified_optimizer_${guard}"()`));
  }
  assert.equal(/(?:audit_row|a)\."metadata"->>'[^']+'\s*<>/.test(sql), false);
  assert.ok((sql.match(/"metadata"->>'[^']+'\s+IS DISTINCT FROM/g) ?? []).length >= 30);
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

test("queued closure has a closed reason set and binds every content-free fact", () => {
  assert.deepEqual(CHAT_UNIFIED_OPTIMIZER_QUEUED_CLOSE_REASONS, [
    "expired_before_dispatch", "cancelled_before_dispatch",
  ]);
  assert.equal(Object.isFrozen(CHAT_UNIFIED_OPTIMIZER_QUEUED_CLOSE_REASONS), true);
  const requestId = randomUUID();
  const cycleId = randomUUID();
  const runId = randomUUID();
  const candidateId = randomUUID();
  const jobId = randomUUID();
  const reason = "expired_before_dispatch";
  assert.equal(chatUnifiedOptimizerQueuedCloseSchema.safeParse({
    requestId, cycleId, reason,
  }).success, true);
  assert.equal(chatUnifiedOptimizerQueuedCloseSchema.safeParse({
    requestId, cycleId, reason: "vendor_failed",
  }).success, false);
  const closeRequestDigest = chatUnifiedOptimizerQueuedCloseDigest({
    requestId, cycleId, reason,
  });
  const evidenceRef = `optimizer:queued:${reason}:${jobId}`;
  const evidencePayloadDigest = chatUnifiedOptimizerQueuedJobEvidenceDigest({
    closeRequestDigest, cycleId, runId, candidateId, jobId,
    role: "candidate_author", reason,
  });
  const terminal = chatUnifiedOptimizerQueuedJobTerminalDigest({
    closeRequestDigest, cycleId, runId, jobId, role: "candidate_author",
    reason, evidenceRef, evidencePayloadDigest,
  });
  assert.match(closeRequestDigest, /^[0-9a-f]{64}$/);
  assert.match(evidencePayloadDigest, /^[0-9a-f]{64}$/);
  assert.match(terminal, /^[0-9a-f]{64}$/);
  assert.notEqual(closeRequestDigest, chatUnifiedOptimizerQueuedCloseDigest({
    requestId, cycleId, reason: "cancelled_before_dispatch",
  }));
  assert.notEqual(terminal, chatUnifiedOptimizerQueuedJobTerminalDigest({
    closeRequestDigest, cycleId, runId, jobId, role: "case_author",
    reason, evidenceRef, evidencePayloadDigest,
  }));
});
