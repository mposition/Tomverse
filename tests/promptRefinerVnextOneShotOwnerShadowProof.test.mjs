import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { build } from "esbuild";

import { createPromptRefinerVnextOneShotOwnerSeal } from
  "../lib/promptRefinerVnextOneShotOwnerSeal.ts";
import {
  PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST,
  verifyPromptRefinerVnextOneShotShadowProof,
} from "../lib/promptRefinerVnextOneShotShadowProof.ts";
import { createPromptRefinerVnextOneShotOwnerShadowProof } from
  "../scripts/prompt-refiner-vnext-one-shot-owner-shadow-proof.mjs";
import { syntheticManifest } from
  "./support/promptRefinerVnextOneShotSyntheticManifest.mjs";

const sourceRoot = resolve(import.meta.dirname, "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("owner attestor executes the A17 runner and signs only bound zero-cost proof", async () => {
  const folder = mkdtempSync(join(tmpdir(), "prvnext-shadow-proof-synthetic-"));
  try {
    const bundle = await build({
      absWorkingDir: sourceRoot,
      entryPoints: ["scripts/prompt-refiner-vnext-one-shot-owner-runner.mjs"],
      outfile: join(folder, "runner.mjs"), bundle: true, platform: "node",
      format: "esm", target: "node22", conditions: ["react-server"],
      alias: { "@": sourceRoot }, packages: "bundle", legalComments: "inline",
      banner: { js: "/* eslint-disable */\n// prompt-refiner-vnext-one-shot-runner-0.1.0; exact merged source.\n" },
      write: false, logLevel: "silent",
    });
    assert.equal(bundle.outputFiles.length, 1);
    const runnerBytes = bundle.outputFiles[0].contents;
    const runnerPath = join(folder, "runner.mjs");
    const manifestPath = join(folder, "manifest.json");
    const bindingPath = join(folder, "binding.json");
    const sealPath = join(folder, "seal.json");
    const targetPath = join(folder, "target.json");
    const synthetic = syntheticManifest();
    const binding = JSON.parse(synthetic.bindingText);
    const now = new Date();
    const ownerKeyHex = "42".repeat(32);
    const seal = createPromptRefinerVnextOneShotOwnerSeal({
      manifestText: synthetic.manifestText,
      expectedRootDigest: binding.expectedRootDigest,
      expectedPreregistrationDigest: binding.expectedPreregistrationDigest,
      ownerHmacKey: Buffer.from(ownerKeyHex, "hex"), now,
      confirmation: "I_AM_MPOSITION_AND_VERIFIED_EVERY_LABEL_AND_PRIVACY_EXCLUSION",
    });
    const keys = generateKeyPairSync("ed25519");
    const privateKey = keys.privateKey.export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" })
      .toString("base64");
    const target = {
      stageApprovalAuditLogId: "stage-audit", runApprovalAuditLogId: "run-audit",
      sourceCommitSha: "a".repeat(40), sourceManifestDigest: "b".repeat(64),
      runnerDigest: sha256(runnerBytes),
      runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
      runtimeCommitSha: "c".repeat(40), pricePinDigest: "d".repeat(64),
      perRequestCostMicroUsd: 29_918, costCeilingMicroUsd: 2_393_440,
      slotCount: 80, reservedSlots: 80, consumedSlots: 0,
    };
    writeFileSync(runnerPath, runnerBytes);
    const settledTime = new Date(Date.now() - 60_000);
    utimesSync(runnerPath, settledTime, settledTime);
    writeFileSync(manifestPath, synthetic.manifestText);
    writeFileSync(bindingPath, synthetic.bindingText);
    writeFileSync(sealPath, seal);
    writeFileSync(targetPath, JSON.stringify(target));
    const input = {
      manifestPath, bindingPath, sealPath, targetPath, runnerPath,
      ownerKeyHex, signingPrivateKeyB64: privateKey, now,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      spawn: (...args) => {
        const result = spawnSync(...args);
        assert.equal(result.status, 0, `synthetic A17 runner status ${result.status}; ` +
          `signal ${result.signal}; error ${result.error?.code ?? "none"}; ` +
          `stderr bytes ${Buffer.byteLength(result.stderr ?? "", "utf8")}`);
        assert.equal(result.stderr, "", "synthetic runner emitted stderr");
        assert.ok(typeof result.stdout === "string" && result.stdout.length > 0 &&
          Buffer.byteLength(result.stdout, "utf8") <= 1024,
        "synthetic runner stdout shape invalid");
        return result;
      },
    };
    const proof = createPromptRefinerVnextOneShotOwnerShadowProof(input);
    assert.deepEqual(verifyPromptRefinerVnextOneShotShadowProof(
      proof, publicKey, new Date()), proof);
    assert.ok(Date.parse(proof.signedAt) >= now.getTime(),
      "the signed observation follows the completed A17 preflight");
    assert.equal(proof.runnerDigest, target.runnerDigest);
    assert.equal(proof.manifestRoot, synthetic.rootDigest);
    assert.equal(proof.runnerPreflightDigest,
      PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST);
    assert.equal(proof.cacheWriteInputTokens, 0);
    assert.equal(proof.providerCalls, 0);
    assert.equal(proof.slotConsumeCalls, 0);
    assert.throws(() => createPromptRefinerVnextOneShotOwnerShadowProof({
      ...input, env: { ...input.env, OPENAI_API_KEY: "test-only" },
    }), /owner_shadow_proof_unavailable/);
    writeFileSync(targetPath, JSON.stringify({ ...target,
      runnerDigest: "0".repeat(64) }));
    assert.throws(() => createPromptRefinerVnextOneShotOwnerShadowProof(input),
      /owner_shadow_proof_unavailable/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
