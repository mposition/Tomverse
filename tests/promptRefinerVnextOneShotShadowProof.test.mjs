import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST,
  promptRefinerVnextOneShotShadowPublicKeyDigest,
  signPromptRefinerVnextOneShotShadowProof,
  verifyPromptRefinerVnextOneShotShadowProof,
} from "../lib/promptRefinerVnextOneShotShadowProof.ts";

const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey.export({ format: "der", type: "pkcs8" })
  .toString("base64");
const publicKey = keys.publicKey.export({ format: "der", type: "spki" })
  .toString("base64");
const at = new Date("2026-10-05T08:00:00.000Z");
const target = Object.freeze({
  stageApprovalAuditLogId: "stage-audit", runApprovalAuditLogId: "run-audit",
  sourceCommitSha: "a".repeat(40), sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64),
  runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
  runtimeCommitSha: "d".repeat(40), pricePinDigest: "e".repeat(64),
  perRequestCostMicroUsd: 29_918, costCeilingMicroUsd: 2_393_440,
  slotCount: 80, reservedSlots: 80, consumedSlots: 0,
});
const proof = () => signPromptRefinerVnextOneShotShadowProof({
  version: "prompt-refiner-vnext-one-shot-shadow-proof-v1",
  ...target, manifestRoot: "f".repeat(64),
  runnerPreflightDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST,
  cacheWriteInputTokens: 0, providerCalls: 0, slotConsumeCalls: 0,
  signedAt: at.toISOString(),
}, privateKey);

test("signed A17 preflight evidence is closed, exact and short-lived", () => {
  const signed = proof();
  assert.deepEqual(verifyPromptRefinerVnextOneShotShadowProof(
    signed, publicKey, new Date(at.getTime() + 60_000)), signed);
  assert.match(promptRefinerVnextOneShotShadowPublicKeyDigest(publicKey),
    /^[0-9a-f]{64}$/);
  for (const changed of [
    { manifestRoot: "0".repeat(64) }, { runnerDigest: "0".repeat(64) },
    { runtimeDeploymentId: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
    { pricePinDigest: "0".repeat(64) },
    { stageApprovalAuditLogId: "other" },
  ]) {
    assert.throws(() => verifyPromptRefinerVnextOneShotShadowProof(
      { ...signed, ...changed }, publicKey, at), /shadow_proof_invalid/);
  }
  assert.throws(() => verifyPromptRefinerVnextOneShotShadowProof(
    signed, publicKey, new Date(at.getTime() + 10 * 60_000 + 1)),
  /shadow_proof_invalid/);
});

test("boolean claims, missing count, noninteger zero and extra content refuse", () => {
  const { signature: _signature, ...base } = proof();
  void _signature;
  for (const changed of [
    { cacheWriteInputTokens: false }, { cacheWriteInputTokens: "0" },
    { cacheWriteInputTokens: null }, { cacheWriteInputTokens: 1 },
    { providerCalls: true }, { slotConsumeCalls: 1 },
    { runnerPreflightDigest: "0".repeat(64) },
    { sourceText: "not accepted" },
  ]) {
    assert.throws(() => signPromptRefinerVnextOneShotShadowProof(
      { ...base, ...changed }, privateKey),
    /shadow_proof_invalid/);
  }
  const { cacheWriteInputTokens: _cacheWriteInputTokens, ...missing } = base;
  void _cacheWriteInputTokens;
  assert.throws(() => signPromptRefinerVnextOneShotShadowProof(
    missing, privateKey), /shadow_proof_invalid/);
});
