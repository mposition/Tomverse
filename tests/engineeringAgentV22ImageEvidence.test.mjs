import assert from "node:assert/strict";
import test from "node:test";

import { decideEngineeringAgentV22ImageExclusion,
  currentEngineeringAgentV22ImageProofDigest,
  engineeringAgentV22ImageEvidenceDigest,
  readEngineeringAgentV22ImageExclusion } from
  "../lib/engineeringAgentV22ImageEvidence.ts";

const manifest = { completePathCount: 5,
  completePathListSha256: "c".repeat(64), testsPathCount: 0 };
const input = (overrides = {}) => ({
  cwd: "/app", runtimeManifest: manifest, testsExist: false,
  adminPlaywrightConfigExists: false, ...overrides,
});
const env = { RAILWAY_GIT_COMMIT_SHA: "a".repeat(40),
  RAILWAY_DEPLOYMENT_ID: "11111111-2222-3333-4444-555555555555" };
const runtime = (overrides = {}) => ({ cwd: () => "/app",
  exists: async () => false, imageManifest: async () => manifest,
  ...overrides });

test("only a running image without the test sources can exclude tests", () => {
  assert.deepEqual(decideEngineeringAgentV22ImageExclusion(input()), ["tests"]);
  for (const changed of [
    { cwd: "/srv" },
    { testsExist: true },
    { adminPlaywrightConfigExists: true },
    { runtimeManifest: { ...manifest, testsPathCount: 1 } },
    { runtimeManifest: { ...manifest, completePathListSha256: "bad" } },
    { runtimeManifest: { ...manifest, completePathCount: 0 } },
  ]) assert.deepEqual(decideEngineeringAgentV22ImageExclusion(
    input(changed)), []);
});

test("no operator-pasted proof is needed or read", async () => {
  const result = await readEngineeringAgentV22ImageExclusion(env, runtime());
  assert.deepEqual(result.excludedPrefixes, ["tests"]);
  assert.equal(result.proofDigest,
    engineeringAgentV22ImageEvidenceDigest(manifest, env));
  assert.equal(await currentEngineeringAgentV22ImageProofDigest(env,
    runtime()), result.proofDigest);
});

test("a failed or refused measurement leaves the exclusion closed", async () => {
  const refused = { excludedPrefixes: [], proofDigest: null };
  assert.deepEqual(await readEngineeringAgentV22ImageExclusion(env,
    runtime({ cwd: () => "/workspace" })), refused);
  assert.deepEqual(await readEngineeringAgentV22ImageExclusion(env,
    runtime({ exists: async (path) => path === "/app/tests" })), refused);
  assert.deepEqual(await readEngineeringAgentV22ImageExclusion(env,
    runtime({ imageManifest: async () => { throw new Error("scan"); } })),
  refused);
  assert.equal(await currentEngineeringAgentV22ImageProofDigest(env,
    runtime({ exists: async () => true })), null);
});

test("the digest moves with the deployment and the measured image", () => {
  const current = engineeringAgentV22ImageEvidenceDigest(manifest, env);
  assert.match(current, /^[0-9a-f]{64}$/);
  assert.notEqual(engineeringAgentV22ImageEvidenceDigest(manifest,
    { ...env, RAILWAY_DEPLOYMENT_ID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
  current);
  assert.notEqual(engineeringAgentV22ImageEvidenceDigest(
    { ...manifest, completePathCount: 6 }, env), current);
});
