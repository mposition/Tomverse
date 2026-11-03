import assert from "node:assert/strict";
import test from "node:test";

import { v22PublishCandidateMatches, v22PublishPreflightEligible,
  v22ReviewCandidateMatches } from
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
    { publication: { ...publication, imageProofDigest: "not-a-digest" } },
    { publication: { ...publication, imageProofDigest: null } },
    { publication: null },
    { publication: { ok: false } },
    { publication: { ...publication, tier: { tier: "T2" } } },
    { publication: { ...publication, candidate: {
      baseCommitterDate: null } } },
  ]) assert.equal(v22PublishCandidateMatches(input(changed)), false);
});

test("a T2 patch is an owner-review candidate under the same bindings, without a workflow file", () => {
  const review = { ...publication, tier: { tier: "T2" }, imageProofDigest: null,
    candidate: { ...publication.candidate, changes: [
      { path: "components/chat/ChatInput.tsx" }, { path: "scripts/x.mjs" }] } };
  assert.equal(v22ReviewCandidateMatches(input({ publication: review })), true);
  // A T1 verdict is the ordinary path, not this one.
  assert.equal(v22ReviewCandidateMatches(input({ publication: {
    ...review, tier: { tier: "T1" } } })), false);
  for (const changed of [
    { policyVersion: 3 },
    { modeAtStart: "shadow" },
    { runId: "another-run" },
    { taskId: "another-card" },
    { baseSha: "c".repeat(40) },
    { patchDigest: "d".repeat(64) },
    { publication: null },
    { publication: { ok: false } },
    { publication: { ...review, candidate: { ...review.candidate,
      baseCommitterDate: null } } },
    { publication: { ...review, candidate: { ...review.candidate,
      changes: [] } } },
    { publication: { ...review, candidate: { ...review.candidate,
      changes: [{ path: ".github/workflows/ci.yml" }] } } },
    { publication: { ...review, candidate: { ...review.candidate,
      changes: [{ path: "docs/ci.yml", previousPath: ".github/workflows/ci.yml" }] } } },
    { publication: { ...review, candidate: { baseCommitterDate: "1791336934 +1000" } } },
  ]) assert.equal(v22ReviewCandidateMatches(input(changed)), false);
  // Other files under .github are not workflows: the token may push them.
  assert.equal(v22ReviewCandidateMatches(input({ publication: { ...review,
    candidate: { ...review.candidate, changes: [{ path: ".github/CODEOWNERS" }] } } })), true);
});
