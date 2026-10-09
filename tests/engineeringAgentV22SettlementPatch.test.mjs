import assert from "node:assert/strict";
import test from "node:test";

import { loadEngineeringAgentV22SettlementPatch } from
  "../lib/engineeringAgentV22SettlementPatch.ts";

const attemptId = "29cf907f-2741-4dd1-b6d4-d85c881eb357";
const row = { taskId: "card-1", baseSha: "a".repeat(40),
  bodyPurgedAt: null };
const evidence = { text: "diff --git a/x b/x\n", files: null,
  sha256: "b".repeat(64), baseSha: row.baseSha };
const ports = (overrides = {}) => ({
  readMeta: async () => row,
  readEvidence: async () => evidence,
  ...overrides,
});

test("settlement patch is read before the transaction and bound to the card and base", async () => {
  let read = 0;
  assert.deepEqual(await loadEngineeringAgentV22SettlementPatch(attemptId,
    ports({ readEvidence: async (attempt, card) => {
      assert.equal(attempt, attemptId);
      assert.equal(card, row.taskId);
      read++;
      return evidence;
    } })), { taskId: row.taskId, ...evidence });
  assert.equal(read, 1);
});

test("missing patch is a private result, but purged or corrupt patch blocks settlement", async () => {
  let read = 0;
  assert.equal(await loadEngineeringAgentV22SettlementPatch(attemptId,
    ports({ readMeta: async () => null,
      readEvidence: async () => { read++; return evidence; } })), null);
  assert.equal(read, 0);
  await assert.rejects(loadEngineeringAgentV22SettlementPatch(attemptId,
    ports({ readMeta: async () => ({ ...row, bodyPurgedAt: new Date() }) })),
  /v22_patch_purged_before_settlement/);
  await assert.rejects(loadEngineeringAgentV22SettlementPatch(attemptId,
    ports({ readEvidence: async () => null })),
  /v22_patch_unavailable_before_settlement/);
  await assert.rejects(loadEngineeringAgentV22SettlementPatch(attemptId,
    ports({ readEvidence: async () => ({ ...evidence,
      baseSha: "c".repeat(40) }) })),
  /v22_patch_unavailable_before_settlement/);
});
