import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
let source = { sourceCommitSha: "a".repeat(40),
  sourceManifestDigest: "b".repeat(64) };
let deployment = { deploymentId: "12345678-1234-1234-1234-123456789abc",
  commitSha: "a".repeat(40), runtimeAndRailwayAgree: true,
  activeDeploymentConfirmed: true };
let sourceReads = 0;
let deploymentReads = 0;
mock.module(mod("lib/promptRefinerVnextOneShotCandidateSourceReadback.ts"), {
  namedExports: { previewPromptRefinerVnextOneShotCandidateSourcePin: async () => {
    sourceReads++;
    return source;
  } },
});
mock.module(mod("lib/promptRefinerQualityEvaluationVnextOneShotDeploymentReadback.ts"), {
  namedExports: { observePromptRefinerVnextOneShotDeployment: async () => {
    deploymentReads++;
    return deployment;
  } },
});
mock.module(mod("lib/promptRefinerVnextOneShotPriceBinding.ts"), {
  namedExports: { PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST: "e".repeat(64) },
});
const { preparePromptRefinerVnextOneShotStageBinding } = await import(
  mod("lib/promptRefinerVnextOneShotStageAdmission.ts"));
const expected = {
  sourceCommitSha: "a".repeat(40), sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64), manifestRoot: "d".repeat(64),
  runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
  runtimeCommitSha: "a".repeat(40), pricePinDigest: "e".repeat(64),
};
const priorManifestRoot = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT;
const priorRunnerDigest = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST;
process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT = expected.manifestRoot;
process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = expected.runnerDigest;
test.after(() => {
  if (priorManifestRoot === undefined) delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT;
  else process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT = priorManifestRoot;
  if (priorRunnerDigest === undefined) delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST;
  else process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = priorRunnerDigest;
});

test("stage binding comes from fresh app and Railway observations", async () => {
  const binding = await preparePromptRefinerVnextOneShotStageBinding(expected);
  assert.deepEqual(binding, {
    id: "prompt-refiner-vnext-one-shot-v1", ...expected,
    perRequestCostMicroUsd: 29_918n, slotCount: 80,
    costCeilingMicroUsd: 2_393_440n,
  });
  assert.equal(sourceReads, 1);
  assert.equal(deploymentReads, 1);
});

test("stale or disagreeing source, deployment and price pins fail closed", async () => {
  for (const override of [
    { sourceCommitSha: "short" },
    { sourceManifestDigest: "f".repeat(64) },
    { runtimeDeploymentId: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
    { runtimeCommitSha: "f".repeat(40) },
    { pricePinDigest: "f".repeat(64) },
  ]) {
    await assert.rejects(preparePromptRefinerVnextOneShotStageBinding({
      ...expected, ...override,
    }), /stage_observation_mismatch/);
  }
  deployment = { ...deployment, activeDeploymentConfirmed: false };
  await assert.rejects(preparePromptRefinerVnextOneShotStageBinding(expected),
    /stage_observation_mismatch/);
  deployment = { ...deployment, activeDeploymentConfirmed: true,
    commitSha: "f".repeat(40) };
  await assert.rejects(preparePromptRefinerVnextOneShotStageBinding(expected),
    /stage_observation_mismatch/);
  deployment = { ...deployment, commitSha: "a".repeat(40) };
  source = { ...source, sourceManifestDigest: "f".repeat(64) };
  await assert.rejects(preparePromptRefinerVnextOneShotStageBinding(expected),
    /stage_observation_mismatch/);
  source = { ...source, sourceManifestDigest: expected.sourceManifestDigest };
  deployment = { ...deployment, commitSha: "b".repeat(40) };
  source = { ...source, sourceCommitSha: "b".repeat(40) };
  const laterDeployment = await preparePromptRefinerVnextOneShotStageBinding({
    ...expected, runtimeCommitSha: "b".repeat(40),
  });
  assert.equal(laterDeployment.sourceCommitSha, expected.sourceCommitSha);
  assert.equal(laterDeployment.runtimeCommitSha, "b".repeat(40));
  source = { ...source, sourceCommitSha: expected.sourceCommitSha };
  deployment = { ...deployment, commitSha: expected.runtimeCommitSha };
});

test("missing or different server custody pins refuse before external observation", async () => {
  const before = [sourceReads, deploymentReads];
  delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT;
  await assert.rejects(preparePromptRefinerVnextOneShotStageBinding(expected),
    /stage_custody_pin_mismatch/);
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT = "f".repeat(64);
  await assert.rejects(preparePromptRefinerVnextOneShotStageBinding(expected),
    /stage_custody_pin_mismatch/);
  assert.deepEqual([sourceReads, deploymentReads], before);
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT = expected.manifestRoot;
});
