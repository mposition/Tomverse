import assert from "node:assert/strict";
import test from "node:test";

import { decideEngineeringAgentV22ImageExclusion,
  readEngineeringAgentV22ImageExclusion } from
  "../lib/engineeringAgentV22ImageEvidence.ts";

const baseSha = "a".repeat(40);
const deploymentId = "11111111-2222-3333-4444-555555555555";
const proof = {
  sourceCommit: baseSha,
  deploymentId,
  imageDigest: `sha256:${"b".repeat(64)}`,
  completePathListSha256: "c".repeat(64),
  testsPathCount: 0,
  approvedBy: "mposition",
  approvedAt: "2026-10-07",
};
const input = (overrides = {}) => ({
  proof, baseSha, runtimeSourceSha: baseSha,
  runtimeDeploymentId: deploymentId, testsExist: false,
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
  ]) assert.deepEqual(decideEngineeringAgentV22ImageExclusion(
    input(changed)), []);
});

test("no environment proof leaves the image exclusion closed", async () => {
  assert.deepEqual(await readEngineeringAgentV22ImageExclusion(baseSha, {}), []);
});
