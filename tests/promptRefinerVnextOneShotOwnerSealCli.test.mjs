import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { verifyPromptRefinerVnextOneShotOwnerSeal } from
  "../lib/promptRefinerVnextOneShotOwnerSeal.ts";
import { OWNER_SEAL_CLEANUP_UNKNOWN, ownerSealFailureCode } from
  "../scripts/prompt-refiner-vnext-one-shot-owner-seal.mjs";
import { syntheticManifest } from
  "./support/promptRefinerVnextOneShotSyntheticManifest.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = fileURLToPath(new URL(
  "../scripts/prompt-refiner-vnext-one-shot-owner-seal.mjs", import.meta.url));
const confirmation = "I_AM_MPOSITION_AND_VERIFIED_EVERY_LABEL_AND_PRIVACY_EXCLUSION";
const keyHex = "42".repeat(32);

test("cleanup ambiguity has a distinct content-free stop code", () => {
  assert.equal(ownerSealFailureCode(new AggregateError(
    [new Error("write"), new Error("unlink")],
    OWNER_SEAL_CLEANUP_UNKNOWN)), OWNER_SEAL_CLEANUP_UNKNOWN);
  assert.equal(ownerSealFailureCode(new Error("write")), "owner_seal_unavailable");
});

function withSyntheticFiles(t) {
  const folder = mkdtempSync(join(tmpdir(), "prvnext-owner-seal-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const manifestPath = join(folder, "synthetic-manifest.json");
  const bindingPath = join(folder, "synthetic-binding.json");
  const outputPath = join(folder, "owner-only-seal.json");
  const fixture = syntheticManifest();
  writeFileSync(manifestPath, fixture.manifestText);
  writeFileSync(bindingPath, fixture.bindingText);
  return { manifestPath, bindingPath, outputPath, fixture };
}

function run(files, overrides = {}) {
  const args = ["--import", "tsx", cli,
    "--manifest", files.manifestPath, "--binding", files.bindingPath,
    "--seal-output", files.outputPath, "--confirm", confirmation];
  return spawnSync(process.execPath, args, {
    cwd: repo, encoding: "utf8",
    env: { ...process.env,
      PROMPT_REFINER_VNEXT_ONE_SHOT_OWNER_SEAL_KEY_HEX: keyHex,
      ...overrides },
  });
}

test("owner-only synthetic CLI seals once and prints no root or case data", (t) => {
  const files = withSyntheticFiles(t);
  const result = run(files);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    sealed: true, caseCount: 80, dispatchAuthorized: false,
  });
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(files.fixture.rootDigest));
  assert.ok(!result.stdout.includes("synthetic ko source"));
  const attestationText = readFileSync(files.outputPath, "utf8");
  const binding = JSON.parse(files.fixture.bindingText);
  assert.deepEqual(verifyPromptRefinerVnextOneShotOwnerSeal({
    manifestText: files.fixture.manifestText, attestationText,
    expectedRootDigest: binding.expectedRootDigest,
    expectedPreregistrationDigest: binding.expectedPreregistrationDigest,
    ownerHmacKey: Buffer.from(keyHex, "hex"), now: new Date(),
  }), {
    structuralValidation: "pass", ownerKeyBindingVerified: true,
    caseCount: 80, dispatchAuthorized: false,
    semanticTruthVerified: false, independentAuthorshipVerified: false,
    privacyExclusionVerified: false,
  });
  const duplicate = run(files);
  assert.equal(duplicate.status, 1);
  assert.equal(duplicate.stdout, "");
  assert.equal(duplicate.stderr, "owner_seal_unavailable\n");
  assert.deepEqual(readdirSync(dirname(files.outputPath)).filter(
    (name) => name.endsWith(".tmp")), []);
});

test("invalid key or changed manifest never creates a seal", (t) => {
  const files = withSyntheticFiles(t);
  const noKey = run(files, { PROMPT_REFINER_VNEXT_ONE_SHOT_OWNER_SEAL_KEY_HEX: "short" });
  assert.equal(noKey.status, 1);
  assert.equal(noKey.stdout, "");
  assert.equal(noKey.stderr, "owner_seal_unavailable\n");
  const oddKey = run(files, {
    PROMPT_REFINER_VNEXT_ONE_SHOT_OWNER_SEAL_KEY_HEX: "a".repeat(65),
  });
  assert.equal(oddKey.status, 1);
  const changed = syntheticManifest((manifest) => {
    manifest.cases[0].sourceText += " changed";
    return manifest;
  });
  writeFileSync(files.manifestPath, changed.manifestText);
  const result = run(files);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "owner_seal_unavailable\n");
  assert.throws(() => readFileSync(files.outputPath), { code: "ENOENT" });
  assert.deepEqual(readdirSync(dirname(files.outputPath)).filter(
    (name) => name.endsWith(".tmp")), []);
});
