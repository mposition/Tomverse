import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { createPromptRefinerVnextOneShotOwnerSeal } from
  "../lib/promptRefinerVnextOneShotOwnerSeal.ts";
import { verifyPromptRefinerVnextOneShotRunnerBytes } from
  "../scripts/prompt-refiner-vnext-one-shot-owner-runner.mjs";
import { syntheticManifest } from
  "./support/promptRefinerVnextOneShotSyntheticManifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const name = "prompt-refiner-vnext-one-shot-runner-0.1.0-candidate.3";
const packagePath = join(root, "bin", `${name}.mjs.gz`);
const record = join(root, "bin", `${name}.json`);
const keyHex = "42".repeat(32);
const confirmation = "I_AM_MPOSITION_AND_VERIFIED_EVERY_LABEL_AND_PRIVACY_EXCLUSION";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("candidate pin names exact executable bytes and a local A15 descendant", () => {
  const pin = JSON.parse(readFileSync(record, "utf8"));
  const archive = readFileSync(packagePath);
  const bytes = gunzipSync(archive);
  assert.equal(pin.status, "candidate_only");
  assert.equal(pin.b01FinalDigest, false);
  assert.equal(pin.dispatchAuthority, false);
  assert.equal(pin.version, "0.1.0-candidate.3");
  assert.equal(pin.verificationBoundary,
    "owner_checksum_and_runner_self_check_not_server_attestation");
  assert.equal(pin.packageSha256, sha256(archive));
  assert.equal(pin.runnerSha256, sha256(bytes));
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor",
    pin.a15BaseCommit, pin.sourceCommit], { cwd: root });
  assert.equal(ancestry.status, 0);
});

test("standalone candidate runs all 80 synthetic cases without transport", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "prvnext-runner-candidate-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const executable = join(folder, "runner.mjs");
  writeFileSync(executable, gunzipSync(readFileSync(packagePath)));
  const pin = JSON.parse(readFileSync(record, "utf8"));
  assert.equal(verifyPromptRefinerVnextOneShotRunnerBytes(executable,
    pin.runnerSha256), true);
  assert.equal(verifyPromptRefinerVnextOneShotRunnerBytes(executable,
    "00".repeat(32)), false);
  const manifestPath = join(folder, "manifest.json");
  const bindingPath = join(folder, "binding.json");
  const sealPath = join(folder, "seal.json");
  const synthetic = syntheticManifest();
  const binding = JSON.parse(synthetic.bindingText);
  const seal = createPromptRefinerVnextOneShotOwnerSeal({
    manifestText: synthetic.manifestText,
    expectedRootDigest: binding.expectedRootDigest,
    expectedPreregistrationDigest: binding.expectedPreregistrationDigest,
    ownerHmacKey: Buffer.from(keyHex, "hex"),
    now: new Date(), confirmation,
  });
  writeFileSync(manifestPath, synthetic.manifestText);
  writeFileSync(bindingPath, synthetic.bindingText);
  writeFileSync(sealPath, seal);
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    PROMPT_REFINER_VNEXT_ONE_SHOT_OWNER_SEAL_KEY_HEX: keyHex,
  };
  const preflight = spawnSync(process.execPath,
    ["--conditions=react-server", executable, "--manifest", manifestPath,
      "--binding", bindingPath, "--seal", sealPath],
    { cwd: folder, env, encoding: "utf8" });
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.equal(preflight.stderr, "");
  assert.deepEqual(JSON.parse(preflight.stdout), {
    preflight: "passed", caseCount: 80, syntheticTransportCalls: 80,
    dispatchAuthorized: false,
  });
  for (const slot of ["", " ", "0x4f", "1e1", "01"]) {
    const invalid = spawnSync(process.execPath,
      ["--conditions=react-server", executable, "--dispatch-slot",
        "--manifest", manifestPath, "--binding", bindingPath,
        "--seal", sealPath, "--slot", slot,
        "--run-audit", "synthetic-run-audit", "--result", join(folder, "invalid.json")],
      { cwd: folder, env, encoding: "utf8" });
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stderr, "usage_invalid\n");
    assert.equal(existsSync(join(folder, "invalid.json")), false);
  }

  // Even with plausible synthetic credentials, altered executable bytes must
  // fail before app admission. A child preload records any attempted fetch.
  const tampered = join(folder, "tampered.mjs");
  copyFileSync(executable, tampered);
  writeFileSync(tampered, "\n// changed after pin\n", { flag: "a" });
  const marker = join(folder, "fetch-attempted");
  const preload = join(folder, "deny-fetch.mjs");
  writeFileSync(preload,
    `import { writeFileSync } from "node:fs";\n` +
    `globalThis.fetch = async () => { writeFileSync(${JSON.stringify(marker)}, "1"); ` +
    `return new Response(null, { status: 409 }); };\n`);
  const resultPath = join(folder, "result.json");
  const dispatch = spawnSync(process.execPath,
    ["--conditions=react-server", "--import", pathToFileURL(preload).href, tampered,
      "--dispatch-slot", "--manifest", manifestPath,
      "--binding", bindingPath, "--seal", sealPath,
      "--slot", "0", "--run-audit", "synthetic-run-audit",
      "--result", resultPath],
    { cwd: folder, encoding: "utf8", env: {
      ...env,
      PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED: "1",
      PROMPT_REFINER_VNEXT_ONE_SHOT_APP_ORIGIN: "https://app.example.test",
      PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN:
        "synthetic-runner-token-with-at-least-32-characters",
      PROMPT_REFINER_VNEXT_ONE_SHOT_PROVIDER_API_KEY:
        "synthetic-dedicated-provider-key-32-chars",
      PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST:
        JSON.parse(readFileSync(record, "utf8")).runnerSha256,
    } });
  assert.equal(dispatch.status, 1);
  assert.equal(dispatch.stdout, "");
  assert.equal(dispatch.stderr, "owner_runner_dispatch_unavailable\n");
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(resultPath), false);
});
