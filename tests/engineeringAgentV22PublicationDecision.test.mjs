import assert from "node:assert/strict";
import test from "node:test";

import { v22PublishCandidateMatches, v22PublishPreflightEligible } from
  "../lib/engineeringAgentV22PublicationDecision.ts";

test("v22 skips expensive publication preflight before policy approval", () => {
  const base = { policyVersion: 4, patchPresent: true,
    publicationEnabled: true };
  assert.equal(v22PublishPreflightEligible(base), true);
  assert.equal(v22PublishPreflightEligible({ ...base, policyVersion: 3 }), false);
  assert.equal(v22PublishPreflightEligible({ ...base, patchPresent: false }), false);
  assert.equal(v22PublishPreflightEligible({ ...base,
    publicationEnabled: false }), false);
});

const publication = { ok: true, runId: "123456789012", taskId: "card-1",
  baseSha: "a".repeat(40), patchDigest: "b".repeat(64),
  imageProofDigest: "e".repeat(64),
  tier: { tier: "T1" }, candidate: {
    baseCommitterDate: "1791336934 +1000" } };
const input = (overrides = {}) => ({ policyVersion: 4,
  modeAtStart: "t1", runId: publication.runId,
  taskId: publication.taskId, baseSha: publication.baseSha,
  patchDigest: publication.patchDigest,
  currentImageProofDigest: publication.imageProofDigest,
  publication, ...overrides });

test("v22 publication requires the approved policy and exact locked bindings", () => {
  assert.equal(v22PublishCandidateMatches(input()), true);
  for (const changed of [
    { policyVersion: 3 },
    { modeAtStart: "shadow" },
    { runId: "another-run" },
    { taskId: "another-card" },
    { baseSha: "c".repeat(40) },
    { patchDigest: "d".repeat(64) },
    { currentImageProofDigest: "d".repeat(64) },
    { publication: { ...publication, imageProofDigest: null } },
    { publication: null },
    { publication: { ok: false } },
    { publication: { ...publication, tier: { tier: "T2" } } },
    { publication: { ...publication, candidate: {
      baseCommitterDate: null } } },
  ]) assert.equal(v22PublishCandidateMatches(input(changed)), false);
});
