import assert from "node:assert/strict";
import test from "node:test";

import { engineeringAgentV22CandidateSummary,
  loadEngineeringAgentV22StoredCandidate } from
  "../lib/engineeringAgentV22StoredCandidate.ts";

const attemptId = "29cf907f-2741-4dd1-b6d4-d85c881eb357";
const snapshot = { runId: "123456789012", taskId: "task-1",
  baseSha: "a".repeat(40) };
const patch = { text: "diff --git a/file.ts b/file.ts\n",
  files: [{ path: "file.ts", mode: "100644", bytesBase64: "YQ==" }],
  sha256: "b".repeat(64), baseSha: snapshot.baseSha };
const candidate = { ok: true, baseRootTreeId: "d".repeat(40),
  expectedTreeId: "c".repeat(40),
  changes: [], baseTree: [], baseCommitterDate: "1791336934 +1000" };
const tier = { tier: "T2", findings: [{
  reason: "slice_analysis_failed", path: null }] };
const imageProofDigest = "f".repeat(64);

function ports(overrides = {}) {
  return { readSnapshot: async () => snapshot,
    readPatch: async () => patch, readConsent: async () => true,
    readSwitch: async () => true,
    publicationEnabled: () => true,
    loadCandidate: async () => candidate,
    readTier: async () => ({ tier, imageProofDigest }), ...overrides };
}

test("stored v22 patch reaches the pinned candidate loader only with consent", async () => {
  let called = 0;
  const value = await loadEngineeringAgentV22StoredCandidate(attemptId,
    ports({ loadCandidate: async (input) => {
      called++;
      assert.deepEqual(input, { baseSha: snapshot.baseSha,
        files: patch.files });
      return candidate;
    } }));
  assert.equal(called, 1);
  assert.deepEqual(value, { ok: true, ...snapshot,
    patchBody: patch.text, patchDigest: patch.sha256, candidate,
    tier, imageProofDigest });
  assert.deepEqual(engineeringAgentV22CandidateSummary(value), {
    verified: true, queued: false, baseSha: snapshot.baseSha,
    patchDigest: patch.sha256, baseTreeId: candidate.baseRootTreeId,
    expectedTreeId: candidate.expectedTreeId,
    changedPaths: [],
  });
  const refused = await loadEngineeringAgentV22StoredCandidate(attemptId,
    ports({ readConsent: async () => false,
      loadCandidate: async () => { called++; return candidate; } }));
  assert.deepEqual(refused, { ok: false,
    reason: "publication_not_authorized" });
  assert.equal(called, 1);
});

test("stored v22 patch refuses a changed run or revoked consent after GitHub I/O", async () => {
  let reads = 0;
  const changed = await loadEngineeringAgentV22StoredCandidate(attemptId,
    ports({ readSnapshot: async () => ++reads === 1 ? snapshot :
      { ...snapshot, baseSha: "d".repeat(40) } }));
  assert.deepEqual(changed, { ok: false,
    reason: "publication_state_changed" });
  let consents = 0;
  const revoked = await loadEngineeringAgentV22StoredCandidate(attemptId,
    ports({ readConsent: async () => ++consents === 1 }));
  assert.deepEqual(revoked, { ok: false,
    reason: "publication_state_changed" });
  let checks = 0;
  const closedDuringRead = await loadEngineeringAgentV22StoredCandidate(
    attemptId, ports({ publicationEnabled: () => ++checks === 1 }));
  assert.deepEqual(closedDuringRead, { ok: false,
    reason: "publication_state_changed" });
});

test("stored v22 patch refuses while the separate publication latch is closed", async () => {
  let patchReads = 0;
  const refused = await loadEngineeringAgentV22StoredCandidate(attemptId,
    ports({ publicationEnabled: () => false,
      readPatch: async () => { patchReads++; return patch; } }));
  assert.deepEqual(refused, { ok: false,
    reason: "publication_not_authorized" });
  assert.equal(patchReads, 0);
});

test("stored v22 patch refuses missing files, base drift and candidate errors", async () => {
  for (const wrong of [null, { ...patch, files: null },
    { ...patch, baseSha: "e".repeat(40) }]) {
    assert.deepEqual(await loadEngineeringAgentV22StoredCandidate(attemptId,
      ports({ readPatch: async () => wrong,
        loadCandidate: async () => { throw new Error("must not load"); } })),
    { ok: false, reason: "patch_unavailable" });
  }
  assert.deepEqual(await loadEngineeringAgentV22StoredCandidate(attemptId,
    ports({ loadCandidate: async () => ({ ok: false,
      reason: "tree_verification_failed" }) })),
  { ok: false, reason: "tree_verification_failed" });
});
