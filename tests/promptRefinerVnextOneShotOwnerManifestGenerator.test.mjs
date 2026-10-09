// Synthetic data only. Never import or print an owner holdout here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { assembleOwnerManifest } from
  "../scripts/prompt-refiner-vnext-one-shot-create-manifest.mjs";
import { checkManifestFiles } from
  "../scripts/prompt-refiner-vnext-one-shot-check-manifest.mjs";
import { syntheticManifest } from
  "./support/promptRefinerVnextOneShotSyntheticManifest.mjs";
import { canonicalBenchmarkJson } from "../lib/routerDevelopmentBenchmark.ts";

const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts/prompt-refiner-vnext-one-shot-create-manifest.mjs");
const synthetic = JSON.parse(syntheticManifest().manifestText);
const draft = JSON.stringify({
  version: "prompt-refiner-vnext-one-shot-owner-cases-v1",
  cases: synthetic.cases.map((item) => {
    const copy = { ...item };
    delete copy.caseId;
    return copy;
  }),
});
const receipt = (overrides = {}) => JSON.stringify({ readback: {
  preregistrationRecorded: true,
  preregistrationAuditLogId: "synthetic-audit-id",
  currentPinsMatch: true, dispatchAuthorized: false, ...overrides,
} });
const expectedPreregistrationDigest = createHash("sha256")
  .update(canonicalBenchmarkJson({
    version: "prompt-refiner-vnext-one-shot-preregistration-audit-id-v1",
    auditLogId: "synthetic-audit-id",
  }), "utf8").digest("hex");

test("owner assembly binds a saved preregistration readback digest to all 80 cases", () => {
  const { manifestText, bindingText } = assembleOwnerManifest(
    draft, receipt(), "00".repeat(32));
  const manifest = JSON.parse(manifestText);
  const binding = JSON.parse(bindingText);
  assert.equal(manifest.cases.length, 80);
  assert.equal(manifest.preregistrationDigest, expectedPreregistrationDigest);
  assert.equal(binding.expectedPreregistrationDigest, expectedPreregistrationDigest);
  assert.equal(binding.expectedRootDigest, manifest.rootDigest);
  assert.notEqual(manifest.rootDigest, synthetic.rootDigest);
  assert.deepEqual(manifest.cases.map((item) => item.caseId),
    synthetic.cases.map((item) => item.caseId));
  assert.equal(assembleOwnerManifest(draft, receipt(), "00".repeat(32)).manifestText,
    manifestText);
  assert.notEqual(assembleOwnerManifest(draft, receipt({
    preregistrationAuditLogId: "different-signed-record",
  }), "00".repeat(32)).bindingText, bindingText);
});

test("invalid readback shapes and incomplete cases fail closed", () => {
  for (const bad of [
    { currentPinsMatch: false },
    { preregistrationRecorded: false },
    { dispatchAuthorized: true },
    { preregistrationAuditLogId: "" },
    { preregistrationAuditLogId: "unbounded/invalid" },
  ]) {
    assert.throws(() => assembleOwnerManifest(draft, receipt(bad), "00".repeat(32)));
  }
  const parsed = JSON.parse(draft);
  parsed.cases.pop();
  assert.throws(() => assembleOwnerManifest(JSON.stringify(parsed), receipt(),
    "00".repeat(32)));
  parsed.cases.push(parsed.cases[0]);
  assert.throws(() => assembleOwnerManifest(JSON.stringify(parsed), receipt(),
    "00".repeat(32)));
  assert.throws(() => assembleOwnerManifest(draft, receipt(), "00"),
    /owner_seed_invalid/);
  assert.throws(() => assembleOwnerManifest(draft, receipt({
    preregistrationBindingDigest: "b".repeat(64),
  }), "00".repeat(32)));
});

test("CLI writes only new owner files, prints no case or root and refuses overwrite", () => {
  const folder = mkdtempSync(join(tmpdir(), "one-shot-owner-synthetic-"));
  try {
    const casesPath = join(folder, "cases.json");
    const receiptPath = join(folder, "receipt.json");
    const manifestPath = join(folder, "owner-manifest.json");
    const bindingPath = join(folder, "binding.json");
    writeFileSync(casesPath, draft);
    writeFileSync(receiptPath, receipt());
    const args = ["--import", "tsx", script, "--cases", casesPath,
      "--preregistration-readback", receiptPath,
      "--manifest-output", manifestPath, "--binding-output", bindingPath];
    const output = execFileSync(process.execPath, args,
      { cwd: root, encoding: "utf8" });
    assert.deepEqual(JSON.parse(output), { created: true, caseCount: 80,
      preregistrationAuthenticityVerified: false,
      semanticTruthVerified: false, privacyExclusionVerified: false,
      fullManifestValidated: false,
      dispatchAuthorized: false });
    assert.equal(checkManifestFiles(manifestPath, bindingPath).structuralValidation,
      "pass");
    assert.ok(readFileSync(manifestPath, "utf8").includes("synthetic ko source"));
    const before = readFileSync(manifestPath);
    assert.throws(() => execFileSync(process.execPath, args,
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    assert.deepEqual(readFileSync(manifestPath), before);
    assert.ok(!output.includes("synthetic") && !output.includes("rootDigest"));
    rmSync(manifestPath);
    assert.throws(() => execFileSync(process.execPath, args,
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    assert.equal(readFileSync(bindingPath, "utf8").length > 0, true);
    assert.throws(() => readFileSync(manifestPath), { code: "ENOENT" });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
