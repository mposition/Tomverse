import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createPromptRefinerVnextOneShotOwnerSeal,
  verifyPromptRefinerVnextOneShotOwnerSeal } from
  "../lib/promptRefinerVnextOneShotOwnerSeal.ts";
import { canonicalBenchmarkJson } from "../lib/routerDevelopmentBenchmark.ts";
import { syntheticManifest } from
  "./support/promptRefinerVnextOneShotSyntheticManifest.mjs";

const fixture = syntheticManifest();
const fixtureBinding = JSON.parse(fixture.bindingText);
const key = Buffer.alloc(32, 0x42);
const now = new Date("2026-10-04T00:00:00.000Z");
const signed = {
  version: "prompt-refiner-vnext-one-shot-owner-seal-v1",
  ownerId: "mposition",
  confirmedAt: "2026-10-03T23:00:00.000Z",
  rootDigest: fixture.rootDigest,
  preregistrationDigest: fixtureBinding.expectedPreregistrationDigest,
  independentAuthorshipConfirmed: true,
  semanticLabelsConfirmed: true,
  privacyExclusionConfirmed: true,
};
const attest = (value = signed, secret = key) => JSON.stringify({
  ...value,
  hmacSha256: createHmac("sha256", secret)
    .update(canonicalBenchmarkJson(value), "utf8").digest("hex"),
});
const input = (overrides = {}) => ({
  manifestText: fixture.manifestText,
  attestationText: attest(),
  expectedRootDigest: fixture.rootDigest,
  expectedPreregistrationDigest: signed.preregistrationDigest,
  ownerHmacKey: key,
  now,
  ...overrides,
});

test("synthetic owner confirmation and all 80 structural cases verify without content output", () => {
  const result = verifyPromptRefinerVnextOneShotOwnerSeal(input());
  assert.deepEqual(result, {
    structuralValidation: "pass", ownerKeyBindingVerified: true,
    caseCount: 80, dispatchAuthorized: false,
    semanticTruthVerified: false, independentAuthorshipVerified: false,
    privacyExclusionVerified: false,
  });
  assert.ok(!JSON.stringify(result).includes(fixture.rootDigest));
  assert.ok(!JSON.stringify(result).includes("synthetic ko source"));
});

test("missing, stale or forged owner confirmation refuses without leaking details", () => {
  const changes = [
    { attestationText: attest({ ...signed, semanticLabelsConfirmed: false }) },
    { attestationText: attest({ ...signed, ownerId: "codex" }) },
    { attestationText: attest({ ...signed, rootDigest: "c".repeat(64) }) },
    { attestationText: attest({ ...signed, confirmedAt: "2026-07-01T00:00:00.000Z" }) },
    { attestationText: attest(signed, Buffer.alloc(32, 0x43)) },
    { attestationText: attest({ ...signed, confirmedAt: "2026-10-04T00:00:01.000Z" }) },
    { attestationText: JSON.stringify({ ...JSON.parse(attest()), extra: true }) },
    { attestationText: JSON.stringify(signed) },
    { attestationText: JSON.stringify({ ...JSON.parse(attest()), hmacSha256: "g".repeat(64) }) },
    { attestationText: attest().padEnd(2049, " ") },
    { ownerHmacKey: Buffer.alloc(31) },
    { expectedPreregistrationDigest: "c".repeat(64) },
    { manifestText: syntheticManifest((manifest) => {
      manifest.cases[0].sourceText += " changed";
      return manifest;
    }).manifestText },
  ];
  for (const change of changes) {
    assert.throws(() => verifyPromptRefinerVnextOneShotOwnerSeal(input(change)),
      { message: "vnext_one_shot_owner_seal_unavailable" });
  }
  assert.throws(() => createPromptRefinerVnextOneShotOwnerSeal({
    ...input(), confirmation: "NOT_OWNER_CONFIRMED",
  }), { message: "vnext_one_shot_owner_seal_unavailable" });
});
