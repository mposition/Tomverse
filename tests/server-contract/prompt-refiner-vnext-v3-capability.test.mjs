import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { promptRefinerVnextOneShotShadowPublicKeyDigest } from
  "../../lib/promptRefinerVnextOneShotShadowProof.ts";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
mock.module(mod("lib/promptRefinerVnextOneShotSlotConsumption.ts"), {
  namedExports: { PROMPT_REFINER_VNEXT_PAID_GUARD_CAPABILITY: "old-slot-build" },
});
mock.module(mod("lib/promptRefinerQualityEvaluationVnextOneShotDeploymentReadback.ts"), {
  namedExports: { observePromptRefinerVnextOneShotDeployment: async () => ({
    deploymentId: "12345678-1234-1234-1234-123456789abc",
    commitSha: "b".repeat(40), runtimeAndRailwayAgree: true,
    activeDeploymentConfirmed: true,
  }) },
});
mock.module(mod("lib/promptRefinerVnextOneShotPriceBinding.ts"), {
  namedExports: { PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST: "e".repeat(64) },
});
const { preparePromptRefinerVnextOneShotStageBinding } = await import(
  mod("lib/promptRefinerVnextOneShotStageAdmission.ts"));

test("v3 stage refuses an app build without the guarded slot capability", async () => {
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT = "d".repeat(64);
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = "c".repeat(64);
  for (const name of ["DISPATCH_ENABLED", "SLOT_CONSUME_ENABLED",
    "SHADOW_WRITE_ENABLED", "RUN_WRITE_ENABLED", "PAID_APPROVAL_WRITE_ENABLED"]) {
    process.env[`PROMPT_REFINER_VNEXT_ONE_SHOT_${name}`] = "1";
  }
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({
    format: "der", type: "spki",
  }).toString("base64");
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_B64 = publicKey;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_DIGEST =
    promptRefinerVnextOneShotShadowPublicKeyDigest(publicKey);
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = "t".repeat(40);
  await assert.rejects(preparePromptRefinerVnextOneShotStageBinding({
    sourceCommitSha: "a".repeat(40), sourceManifestDigest: "f".repeat(64),
    runnerDigest: "c".repeat(64), manifestRoot: "d".repeat(64),
    runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
    runtimeCommitSha: "b".repeat(40), pricePinDigest: "e".repeat(64),
  }), /vnext_one_shot_recovery_capability_unavailable/);
});
