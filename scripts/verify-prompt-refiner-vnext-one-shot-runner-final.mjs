// Exercise only the rebuilt standalone runner against generated synthetic data.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { gunzipSync } from "node:zlib";

import { createPromptRefinerVnextOneShotOwnerSeal } from
  "../lib/promptRefinerVnextOneShotOwnerSeal.ts";
import { syntheticManifest } from
  "../tests/support/promptRefinerVnextOneShotSyntheticManifest.mjs";

const [sourceCommit, outputArgument] = process.argv.slice(2);
if (process.argv.length !== 4 || !/^[0-9a-f]{40}$/.test(sourceCommit ?? "") ||
    !outputArgument) {
  throw new Error("runner_final_synthetic_usage_invalid");
}
const outputDir = resolve(outputArgument);
const name = "prompt-refiner-vnext-one-shot-runner-0.1.0";
const pin = JSON.parse(readFileSync(join(outputDir, `${name}.json`), "utf8"));
assert.equal(pin.status, "rebuilt_from_merged_source");
assert.equal(pin.sourceCommit, sourceCommit);
assert.equal(pin.b01PreregistrationPerformed, false);
assert.equal(pin.dispatchAuthority, false);
const archive = readFileSync(join(outputDir, `${name}.mjs.gz`));
const runner = gunzipSync(archive);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256(archive), pin.packageSha256);
assert.equal(sha256(runner), pin.runnerSha256);

const folder = mkdtempSync(join(tmpdir(), "prvnext-runner-final-synthetic-"));
try {
  const executable = join(folder, "runner.mjs");
  const manifestPath = join(folder, "manifest.json");
  const bindingPath = join(folder, "binding.json");
  const sealPath = join(folder, "seal.json");
  const keyHex = "42".repeat(32);
  const synthetic = syntheticManifest();
  const binding = JSON.parse(synthetic.bindingText);
  const seal = createPromptRefinerVnextOneShotOwnerSeal({
    manifestText: synthetic.manifestText,
    expectedRootDigest: binding.expectedRootDigest,
    expectedPreregistrationDigest: binding.expectedPreregistrationDigest,
    ownerHmacKey: Buffer.from(keyHex, "hex"),
    now: new Date(),
    confirmation: "I_AM_MPOSITION_AND_VERIFIED_EVERY_LABEL_AND_PRIVACY_EXCLUSION",
  });
  writeFileSync(executable, runner);
  writeFileSync(manifestPath, synthetic.manifestText);
  writeFileSync(bindingPath, synthetic.bindingText);
  writeFileSync(sealPath, seal);
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    PROMPT_REFINER_VNEXT_ONE_SHOT_OWNER_SEAL_KEY_HEX: keyHex,
  };
  const result = spawnSync(process.execPath,
    ["--conditions=react-server", executable, "--manifest", manifestPath,
      "--binding", bindingPath, "--seal", sealPath],
    { cwd: folder, env, encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    preflight: "passed", caseCount: 80, syntheticTransportCalls: 80,
    dispatchAuthorized: false,
  });
  process.stdout.write(JSON.stringify({ status: "final_synthetic_verified",
    sourceCommit, version: pin.version,
    packageSha256: pin.packageSha256, runnerSha256: pin.runnerSha256,
    caseCount: 80, dispatchAuthorized: false }) + "\n");
} finally {
  rmSync(folder, { recursive: true, force: true });
}
