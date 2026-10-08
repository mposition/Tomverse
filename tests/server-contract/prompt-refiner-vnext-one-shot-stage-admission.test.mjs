import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { promptRefinerVnextOneShotShadowPublicKeyDigest } from
  "../../lib/promptRefinerVnextOneShotShadowProof.ts";
import { promptRefinerVnextOneShotGatePublicKeyDigest } from
  "../../lib/promptRefinerVnextOneShotGateAttestation.ts";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
let source = { sourceCommitSha: "a".repeat(40),
  sourceManifestDigest: "b".repeat(64) };
let deployment = { deploymentId: "12345678-1234-1234-1234-123456789abc",
  commitSha: "c".repeat(40), runtimeAndRailwayAgree: true,
  activeDeploymentConfirmed: true };
let sourceReads = 0;
let deploymentReads = 0;
let expectedPreviousStageId = "prompt-refiner-vnext-one-shot-v3";
mock.module(mod("lib/promptRefinerVnextOneShotCandidateSourceReadback.ts"), {
  namedExports: { verifyPromptRefinerVnextOneShotCandidateSourceAtRoot: async (
    _root, _runtimeCommit, pin) => {
    assert.deepEqual(pin, { sourceCommitSha: "a".repeat(40),
      sourceManifestDigest: "b".repeat(64) });
    sourceReads++;
    return source;
  } },
});
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  promptRefinerVnextOneShotStage: { findUnique: async ({ where }) => {
    assert.equal(where.id, expectedPreviousStageId);
    return { sourceCommitSha: "a".repeat(40), sourceManifestDigest: "b".repeat(64) };
  } },
} } });
mock.module(mod("lib/promptRefinerQualityEvaluationVnextOneShotDeploymentReadback.ts"), {
  namedExports: { observePromptRefinerVnextOneShotDeployment: async () => {
    deploymentReads++;
    return deployment;
  } },
});
mock.module(mod("lib/promptRefinerVnextOneShotPriceBinding.ts"), {
  namedExports: { PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST: "e".repeat(64) },
});
const { inspectPromptRefinerVnextOneShotStageControls,
  preparePromptRefinerVnextOneShotStageBinding } = await import(
  mod("lib/promptRefinerVnextOneShotStageAdmission.ts"));
const expected = {
  sourceCommitSha: "a".repeat(40), sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64), manifestRoot: "d".repeat(64),
  runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
  runtimeCommitSha: "c".repeat(40), pricePinDigest: "e".repeat(64),
};
for (const name of ["DISPATCH_ENABLED", "SLOT_CONSUME_ENABLED",
  "SHADOW_WRITE_ENABLED", "RUN_WRITE_ENABLED", "PAID_APPROVAL_WRITE_ENABLED"]) {
  process.env[`PROMPT_REFINER_VNEXT_ONE_SHOT_${name}`] = "1";
}
const shadowPublicKey = generateKeyPairSync("ed25519").publicKey.export({
  format: "der", type: "spki",
}).toString("base64");
process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_B64 = shadowPublicKey;
process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_DIGEST =
  promptRefinerVnextOneShotShadowPublicKeyDigest(shadowPublicKey);
const gatePublicKey = generateKeyPairSync("ed25519").publicKey.export({
  format: "der", type: "spki",
}).toString("base64");
process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PUBLIC_KEY_B64 = gatePublicKey;
process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PUBLIC_KEY_DIGEST =
  promptRefinerVnextOneShotGatePublicKeyDigest(gatePublicKey);
process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_WRITE_ENABLED = "1";
process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPOSITION_WRITE_ENABLED = "1";
process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = "t".repeat(40);
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
    id: "prompt-refiner-vnext-one-shot-v4", ...expected,
    perRequestCostMicroUsd: 29_918n, slotCount: 80,
    costCeilingMicroUsd: 2_393_440n,
    sourceCommitPreregistrationVerified: false,
    dispatchAuthorized: false,
  });
  assert.equal(sourceReads, 1);
  assert.equal(deploymentReads, 1);
});

test("content-free v5 controls distinguish custody, signer and token failures", () => {
  const valid = inspectPromptRefinerVnextOneShotStageControls(expected, "v5");
  assert.equal(Object.values(valid).every(Boolean), true);
  const wrongRoot = inspectPromptRefinerVnextOneShotStageControls({
    ...expected, manifestRoot: "f".repeat(64),
  }, "v5");
  assert.equal(wrongRoot.rootPinMatches, false);
  assert.equal(wrongRoot.runnerPinMatches, true);
  const wrongSigner = inspectPromptRefinerVnextOneShotStageControls(expected,
    "v5", { ...process.env,
      PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PUBLIC_KEY_DIGEST: "0".repeat(64) });
  assert.equal(wrongSigner.gateSignerValid, false);
  const missingToken = inspectPromptRefinerVnextOneShotStageControls(expected,
    "v5", { ...process.env,
      PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN: undefined });
  assert.equal(missingToken.runnerTokenValid, false);
  assert.equal(JSON.stringify(valid).includes(expected.manifestRoot), false);
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
  deployment = { ...deployment, commitSha: "c".repeat(40) };
  source = { ...source, sourceManifestDigest: "f".repeat(64) };
  await assert.rejects(preparePromptRefinerVnextOneShotStageBinding(expected),
    /stage_observation_mismatch/);
  source = { ...source, sourceManifestDigest: expected.sourceManifestDigest };
  deployment = { ...deployment, commitSha: "b".repeat(40) };
  const laterDeployment = await preparePromptRefinerVnextOneShotStageBinding({
    ...expected, runtimeCommitSha: "b".repeat(40),
  });
  assert.equal(laterDeployment.sourceCommitSha, expected.sourceCommitSha);
  assert.equal(laterDeployment.runtimeCommitSha, "b".repeat(40));
  assert.equal(laterDeployment.sourceCommitPreregistrationVerified, false);
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

test("v4 stage refuses missing future-route pins and an app-held provider key", async () => {
  const token = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
  delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
  await assert.rejects(preparePromptRefinerVnextOneShotStageBinding(expected),
    /recovery_capability_unavailable/);
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = token;
  const signer = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_DIGEST;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_DIGEST = "0".repeat(64);
  await assert.rejects(preparePromptRefinerVnextOneShotStageBinding(expected),
    /recovery_capability_unavailable/);
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_DIGEST = signer;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_PROVIDER_API_KEY = "synthetic-never-used";
  await assert.rejects(preparePromptRefinerVnextOneShotStageBinding(expected),
    /recovery_capability_unavailable/);
  delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_PROVIDER_API_KEY;
});

test("v5 stage uses v4 predecessor and rejects new pin and capability drift", async () => {
  expectedPreviousStageId = "prompt-refiner-vnext-one-shot-v4";
  try {
    const binding = await preparePromptRefinerVnextOneShotStageBinding(expected, "v5");
    assert.equal(binding.id, "prompt-refiner-vnext-one-shot-v5");
    for (const override of [
      { runtimeDeploymentId: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
      { runtimeCommitSha: "f".repeat(40) },
      { pricePinDigest: "f".repeat(64) },
    ]) {
      await assert.rejects(preparePromptRefinerVnextOneShotStageBinding({
        ...expected, ...override,
      }, "v5"), /stage_observation_mismatch/);
    }
    for (const override of [
      { manifestRoot: "f".repeat(64) },
      { runnerDigest: "f".repeat(64) },
    ]) {
      await assert.rejects(preparePromptRefinerVnextOneShotStageBinding({
        ...expected, ...override,
      }, "v5"), /stage_custody_pin_mismatch/);
    }
    const token = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
    delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN;
    try {
      await assert.rejects(preparePromptRefinerVnextOneShotStageBinding(
        expected, "v5"), /recovery_capability_unavailable/);
    } finally {
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = token;
    }
    const gateDigest =
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PUBLIC_KEY_DIGEST;
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PUBLIC_KEY_DIGEST =
      "0".repeat(64);
    try {
      await assert.rejects(preparePromptRefinerVnextOneShotStageBinding(
        expected, "v5"), /recovery_capability_unavailable/);
    } finally {
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PUBLIC_KEY_DIGEST = gateDigest;
    }
    delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_WRITE_ENABLED;
    try {
      await assert.rejects(preparePromptRefinerVnextOneShotStageBinding(
        expected, "v5"), /recovery_capability_unavailable/);
    } finally {
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_WRITE_ENABLED = "1";
    }
    delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPOSITION_WRITE_ENABLED;
    try {
      await assert.rejects(preparePromptRefinerVnextOneShotStageBinding(
        expected, "v5"), /recovery_capability_unavailable/);
    } finally {
      process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPOSITION_WRITE_ENABLED = "1";
    }
  } finally {
    expectedPreviousStageId = "prompt-refiner-vnext-one-shot-v3";
  }
});
