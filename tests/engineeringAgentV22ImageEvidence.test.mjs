import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { decideEngineeringAgentV22ImageExclusion,
  currentEngineeringAgentV22ImageProofDigest,
  readEngineeringAgentV22ImageExclusion } from
  "../lib/engineeringAgentV22ImageEvidence.ts";

const baseSha = "a".repeat(40);
const deploymentId = "11111111-2222-3333-4444-555555555555";
const proof = {
  sourceCommit: baseSha,
  deploymentId,
  imageDigest: `sha256:${"b".repeat(64)}`,
  completePathCount: 5,
  completePathListSha256: "c".repeat(64),
  testsPathCount: 0,
  approvedBy: "mposition",
  approvedAt: "2026-10-07",
};
const input = (overrides = {}) => ({
  proof, baseSha, runtimeSourceSha: baseSha,
  runtimeDeploymentId: deploymentId, testsExist: false,
  runtimeManifest: { completePathCount: 5,
    completePathListSha256: "c".repeat(64), testsPathCount: 0 },
  adminPlaywrightConfigExists: false, ...overrides,
});

test("only the exact owner-attested image can exclude tests", () => {
  assert.deepEqual(decideEngineeringAgentV22ImageExclusion(input()), ["tests"]);
  for (const changed of [
    { baseSha: "d".repeat(40) },
    { runtimeSourceSha: "d".repeat(40) },
    { runtimeDeploymentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    { testsExist: true },
    { adminPlaywrightConfigExists: true },
    { proof: { ...proof, testsPathCount: 1 } },
    { proof: { ...proof, approvedBy: "agent" } },
    { proof: { ...proof, completePathListSha256: "bad" } },
    { proof: { ...proof, completePathCount: 4 } },
    { runtimeManifest: { completePathCount: 5,
      completePathListSha256: "d".repeat(64), testsPathCount: 0 } },
    { runtimeManifest: { completePathCount: 5,
      completePathListSha256: "c".repeat(64), testsPathCount: 1 } },
  ]) assert.deepEqual(decideEngineeringAgentV22ImageExclusion(
    input(changed)), []);
});

test("no environment proof leaves the image exclusion closed", async () => {
  assert.deepEqual(await readEngineeringAgentV22ImageExclusion(baseSha, {}),
    { excludedPrefixes: [], proofDigest: null });
});

test("runtime manifest and proof digest are bound on the success path", async () => {
  const raw = JSON.stringify(proof);
  const env = { ENGINEERING_AGENT_V22_IMAGE_PROOF: raw,
    RAILWAY_GIT_COMMIT_SHA: baseSha,
    RAILWAY_DEPLOYMENT_ID: deploymentId };
  const runtime = { cwd: () => "/app", exists: async () => false,
    imageManifest: async () => input().runtimeManifest };
  assert.deepEqual(await readEngineeringAgentV22ImageExclusion(baseSha,
    env, runtime), { excludedPrefixes: ["tests"],
    proofDigest: createHash("sha256").update(raw).digest("hex") });
  assert.deepEqual(await readEngineeringAgentV22ImageExclusion(baseSha,
    env, { ...runtime, imageManifest: async () => ({
      ...input().runtimeManifest, completePathCount: 4 }) }),
  { excludedPrefixes: [], proofDigest: null });
});

test("proof digest changes when its environment value changes", () => {
  const key = "ENGINEERING_AGENT_V22_IMAGE_PROOF";
  const current = currentEngineeringAgentV22ImageProofDigest({
    [key]: JSON.stringify(proof),
  });
  assert.match(current, /^[0-9a-f]{64}$/);
  assert.notEqual(currentEngineeringAgentV22ImageProofDigest({
    [key]: JSON.stringify({ ...proof, approvedAt: "2026-10-08" }),
  }), current);
  assert.equal(currentEngineeringAgentV22ImageProofDigest({}), null);
});
