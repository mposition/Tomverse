import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPromptRefinerVnextOneShotOwnerSeal } from
  "../lib/promptRefinerVnextOneShotOwnerSeal.ts";
import { verifyPromptRefinerVnextOneShotManifestEnvelope } from
  "../lib/promptRefinerQualityEvaluationVnextOneShotManifestEnvelope.ts";
import { isForbiddenOwnerRunnerEnvironmentKey,
  runPromptRefinerVnextOneShotOwnerPreflight } from
  "../scripts/prompt-refiner-vnext-one-shot-owner-runner.mjs";
import { syntheticManifest } from
  "./support/promptRefinerVnextOneShotSyntheticManifest.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = fileURLToPath(new URL(
  "../scripts/prompt-refiner-vnext-one-shot-owner-runner.mjs", import.meta.url));
const keyHex = "42".repeat(32);
const confirmation = "I_AM_MPOSITION_AND_VERIFIED_EVERY_LABEL_AND_PRIVACY_EXCLUSION";
const at = new Date("2026-10-04T00:00:00.000Z");

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), "prvnext-owner-runner-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const paths = {
    manifestPath: join(folder, "manifest.json"),
    bindingPath: join(folder, "binding.json"),
    sealPath: join(folder, "seal.json"),
  };
  const synthetic = syntheticManifest();
  const binding = JSON.parse(synthetic.bindingText);
  const seal = createPromptRefinerVnextOneShotOwnerSeal({
    manifestText: synthetic.manifestText,
    expectedRootDigest: binding.expectedRootDigest,
    expectedPreregistrationDigest: binding.expectedPreregistrationDigest,
    ownerHmacKey: Buffer.from(keyHex, "hex"),
    now: new Date("2026-10-03T00:00:00.000Z"), confirmation,
  });
  writeFileSync(paths.manifestPath, synthetic.manifestText);
  writeFileSync(paths.bindingPath, synthetic.bindingText);
  writeFileSync(paths.sealPath, seal);
  return { ...paths, ownerKeyHex: keyHex, now: at, env: {}, synthetic };
}

function runCli(input, envOverride = {}) {
  const env = { ...process.env,
    PROMPT_REFINER_VNEXT_ONE_SHOT_OWNER_SEAL_KEY_HEX: keyHex,
    ...envOverride };
  for (const key of Object.keys(env)) {
    if (isForbiddenOwnerRunnerEnvironmentKey(key) &&
        !Object.hasOwn(envOverride, key)) delete env[key];
  }
  return spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", cli,
    "--manifest", input.manifestPath, "--binding", input.bindingPath,
    "--seal", input.sealPath], { cwd: repo, encoding: "utf8", env });
}

test("owner CLI rehashes all 80 sealed synthetic cases and reports only aggregate preflight", (t) => {
  const input = fixture(t);
  const result = runCli(input);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    preflight: "passed", caseCount: 80,
    syntheticTransportCalls: 80, dispatchAuthorized: false,
  });
  assert.equal(result.stderr, "");
  for (const restricted of [input.synthetic.rootDigest, keyHex,
    input.manifestPath, "synthetic ko source", "prsvnext-ko-001"])
    assert.ok(!`${result.stdout}${result.stderr}`.includes(restricted));
});

test("root drift and invalid duplicate or oversized manifests refuse without content in logs", async (t) => {
  const input = fixture(t);
  const original = readFileSync(input.manifestPath, "utf8");
  const drifted = original.replace("synthetic ko source", "drifted ko source");
  const invalid = [
    {
      expectedError: "vnext_one_shot_manifest_case_id_invalid",
      fixture: syntheticManifest((manifest) => {
        manifest.cases[1].caseId = manifest.cases[0].caseId;
        return manifest;
      }),
    },
    {
      expectedError: "vnext_one_shot_manifest_source_invalid",
      fixture: syntheticManifest((manifest) => {
        manifest.cases[0].sourceText = "x".repeat(16_001);
        return manifest;
      }),
    },
  ];
  for (const { fixture: candidate, expectedError } of invalid) {
    const binding = JSON.parse(candidate.bindingText);
    assert.throws(() => verifyPromptRefinerVnextOneShotManifestEnvelope(
      candidate.manifestText, binding.expectedRootDigest,
      binding.expectedPreregistrationDigest), { message: expectedError });
    assert.throws(() => createPromptRefinerVnextOneShotOwnerSeal({
      manifestText: candidate.manifestText,
      expectedRootDigest: binding.expectedRootDigest,
      expectedPreregistrationDigest: binding.expectedPreregistrationDigest,
      ownerHmacKey: Buffer.from(keyHex, "hex"),
      now: new Date("2026-10-03T00:00:00.000Z"), confirmation,
    }), { message: "vnext_one_shot_owner_seal_unavailable" });
  }
  for (const manifestText of [drifted,
    ...invalid.map(({ fixture: item }) => item.manifestText)]) {
    writeFileSync(input.manifestPath, manifestText);
    await assert.rejects(
      runPromptRefinerVnextOneShotOwnerPreflight(input),
      { message: "owner_runner_preflight_unavailable" });
    const result = runCli(input);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "owner_runner_preflight_unavailable\n");
  }
});

test("product DB, provider and app runner credentials stop preflight", async (t) => {
  const input = fixture(t);
  for (const key of ["DATABASE_URL", "DATABASE_PUBLIC_URL", "DIRECT_URL",
    "POSTGRES_URL", "PGPASSFILE", "Db_Password",
    "OPENAI_API_KEY", "PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN"]) {
    await assert.rejects(runPromptRefinerVnextOneShotOwnerPreflight({
      ...input, env: { [key]: "synthetic-secret" },
    }), { message: "owner_runner_preflight_unavailable" });
  }
  const result = runCli(input, { DATABASE_URL: "synthetic-secret" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "owner_runner_preflight_unavailable\n");
});
