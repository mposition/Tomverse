import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { createPromptRefinerVnextOneShotOwnerSeal } from
  "../lib/promptRefinerVnextOneShotOwnerSeal.ts";
import { builtinOnlyRequireBanner } from
  "../scripts/prompt-refiner-vnext-one-shot-runner-banner.mjs";
import { syntheticManifest } from
  "./support/promptRefinerVnextOneShotSyntheticManifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("bundled runner reaches admission with built-ins only and no external preload", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "chat01-b07-runner-banner-"));
  const ownerFolder = mkdtempSync(join(tmpdir(), "chat01-b07-owner-synthetic-"));
  t.after(() => {
    rmSync(folder, { recursive: true, force: true });
    rmSync(ownerFolder, { recursive: true, force: true });
  });
  mkdirSync(join(folder, "bundle"));
  const runner = join(folder, "bundle", "synthetic-runner.mjs");
  const manifestPath = join(ownerFolder, "manifest.json");
  const bindingPath = join(ownerFolder, "binding.json");
  const sealPath = join(ownerFolder, "seal.json");
  const resultPath = join(ownerFolder, "result.json");
  const synthetic = syntheticManifest();
  const binding = JSON.parse(synthetic.bindingText);
  const keyHex = "42".repeat(32);
  const seal = createPromptRefinerVnextOneShotOwnerSeal({
    manifestText: synthetic.manifestText,
    expectedRootDigest: binding.expectedRootDigest,
    expectedPreregistrationDigest: binding.expectedPreregistrationDigest,
    ownerHmacKey: Buffer.from(keyHex, "hex"), now: new Date(),
    confirmation: "I_AM_MPOSITION_AND_VERIFIED_EVERY_LABEL_AND_PRIVACY_EXCLUSION",
  });
  writeFileSync(manifestPath, synthetic.manifestText);
  writeFileSync(bindingPath, synthetic.bindingText);
  writeFileSync(sealPath, seal);
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: ["scripts/prompt-refiner-vnext-one-shot-owner-runner.mjs"],
    outfile: runner, bundle: true, platform: "node", format: "esm",
    target: "node22", conditions: ["react-server"], alias: { "@": root },
    packages: "bundle", legalComments: "inline", write: false,
    banner: { js: builtinOnlyRequireBanner }, logLevel: "silent",
  });
  assert.equal(bundle.outputFiles.length, 1);
  const bytes = bundle.outputFiles[0].contents;
  writeFileSync(runner, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const run = spawnSync(process.execPath, ["--conditions=react-server",
    runner, "--dispatch-slot", "--manifest", manifestPath,
    "--binding", bindingPath, "--seal", sealPath, "--slot", "0",
    "--run-audit", "synthetic-run-audit", "--result", resultPath], {
    encoding: "utf8", timeout: 15_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      PROMPT_REFINER_VNEXT_ONE_SHOT_OWNER_SEAL_KEY_HEX: keyHex,
      PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED: "1",
      PROMPT_REFINER_VNEXT_ONE_SHOT_APP_ORIGIN: "https://127.0.0.1:1",
      PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN:
        "synthetic-runner-token-with-at-least-32-characters",
      PROMPT_REFINER_VNEXT_ONE_SHOT_PROVIDER_API_KEY:
        "sk-synthetic-provider-key-with-at-least-32-characters",
      PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST: digest },
  });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 1);
  assert.ok(run.stdout.length > 0, `synthetic stderr: ${run.stderr}`);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, "admission_outcome_unknown");
  assert.equal(result.retryAuthorized, false);
  assert.equal(existsSync(resultPath), false);

  const denied = spawnSync(process.execPath, ["--input-type=module", "-e",
    `${builtinOnlyRequireBanner}\nrequire("./package.json")`], {
    cwd: root, encoding: "utf8", timeout: 5_000,
  });
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /owner_runner_non_builtin_require_refused/);
});
