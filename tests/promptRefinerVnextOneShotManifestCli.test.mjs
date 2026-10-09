import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkManifestFiles } from
  "../scripts/prompt-refiner-vnext-one-shot-check-manifest.mjs";
import { syntheticManifest } from
  "./support/promptRefinerVnextOneShotSyntheticManifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = fileURLToPath(new URL(
  "../scripts/prompt-refiner-vnext-one-shot-check-manifest.mjs", import.meta.url));
const expectedRootDigest = "a".repeat(64);
const expectedPreregistrationDigest = "b".repeat(64);
const sentinel = "SYNTHETIC_PRIVATE_MANIFEST_SENTINEL";

test("owner CLI reads separate bindings and returns only non-authoritative counts", () => {
  const temporary = mkdtempSync(join(tmpdir(), "prvnext-manifest-cli-"));
  const manifestPath = join(temporary, "manifest.json");
  const bindingPath = join(temporary, "binding.json");
  try {
    const fixture = syntheticManifest();
    writeFileSync(manifestPath, fixture.manifestText);
    writeFileSync(bindingPath, fixture.bindingText);
    const result = checkManifestFiles(manifestPath, bindingPath);
    assert.deepEqual(result, {
      structuralValidation: "pass", caseCount: 80,
      semanticTruthVerified: false, independentAuthorshipVerified: false,
      privacyExclusionVerified: false, fullManifestValidated: false,
      dispatchAuthorized: false,
    });
    assert.ok(!JSON.stringify(result).includes(fixture.rootDigest));
    assert.ok(!JSON.stringify(result).includes("synthetic ko source"));

    const valid = spawnSync(process.execPath,
      ["--import", "tsx", script, "--manifest", manifestPath, "--binding", bindingPath],
      { cwd: root, encoding: "utf8" });
    assert.equal(valid.status, 0);
    assert.deepEqual(JSON.parse(valid.stdout), result);
    assert.equal(valid.stderr, "");
    assert.ok(!valid.stdout.includes(fixture.rootDigest));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("owner CLI rejects unbound and ambiguous inputs before checking contents", () => {
  const temporary = mkdtempSync(join(tmpdir(), "prvnext-manifest-cli-"));
  const manifestPath = join(temporary, "manifest.json");
  const bindingPath = join(temporary, "binding.json");
  try {
    writeFileSync(manifestPath, sentinel);
    writeFileSync(bindingPath, JSON.stringify({
      version: "prompt-refiner-vnext-one-shot-binding-v1",
      expectedRootDigest,
      expectedPreregistrationDigest,
      extra: "not permitted",
    }));
    assert.throws(() => checkManifestFiles(manifestPath, bindingPath));
    const sameFile = spawnSync(process.execPath,
      ["--import", "tsx", script, "--manifest", manifestPath,
        "--binding", manifestPath],
      { cwd: root, encoding: "utf8" });
    assert.equal(sameFile.status, 2);
    assert.equal(sameFile.stderr, "usage_invalid\n");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("owner CLI rejects aliases, invalid UTF-8 and unbounded input before verification", () => {
  const temporary = mkdtempSync(join(tmpdir(), "prvnext-manifest-cli-"));
  const manifestPath = join(temporary, "manifest.json");
  const bindingPath = join(temporary, "binding.json");
  const aliasPath = join(temporary, "binding-alias.json");
  try {
    const validBinding = JSON.stringify({
      version: "prompt-refiner-vnext-one-shot-binding-v1",
      expectedRootDigest,
      expectedPreregistrationDigest,
    });
    writeFileSync(bindingPath, validBinding);
    linkSync(bindingPath, aliasPath);
    const assertRefusedBeforeVerify = (manifest, binding, code) => {
      assert.throws(() => checkManifestFiles(manifest, binding), { message: code });
    };
    assertRefusedBeforeVerify(aliasPath, bindingPath, "input_alias");
    assertRefusedBeforeVerify(bindingPath, aliasPath, "input_alias");
    writeFileSync(manifestPath, Buffer.from([0xff]));
    assertRefusedBeforeVerify(manifestPath, bindingPath, "input_unavailable");
    writeFileSync(manifestPath, "");
    assertRefusedBeforeVerify(manifestPath, bindingPath, "input_unavailable");
    writeFileSync(manifestPath, Buffer.alloc(16 * 1024 * 1024 + 1));
    assertRefusedBeforeVerify(manifestPath, bindingPath, "input_unavailable");
    writeFileSync(manifestPath, sentinel);
    writeFileSync(bindingPath, validBinding.padEnd(1025, " "));
    assertRefusedBeforeVerify(manifestPath, bindingPath, "input_unavailable");
    writeFileSync(bindingPath, Buffer.from([0xff]));
    assertRefusedBeforeVerify(manifestPath, bindingPath, "input_unavailable");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("owner CLI rejects each malformed 80-case allocation or witness with no content output", () => {
  const temporary = mkdtempSync(join(tmpdir(), "prvnext-manifest-cli-"));
  const manifestPath = join(temporary, "manifest.json");
  const bindingPath = join(temporary, "binding.json");
  try {
    const changes = [
      [(value) => { value.cases.pop(); return value; },
        /vnext_one_shot_manifest_binding_invalid/],
      [(value) => { value.cases.push(structuredClone(value.cases[0])); return value; },
        /vnext_one_shot_manifest_binding_invalid/],
      [(value) => { value.cases[0] = structuredClone(value.cases[40]); return value; },
        /vnext_one_shot_manifest_case_id_invalid/],
      [(value) => { value.cases[0].baseCell = "quoted_literal"; return value; },
        /vnext_allocation_cell_quota_invalid/],
      [(value) => { value.cases[5].sourceText = value.cases[4].sourceText; return value; },
        /vnext_one_shot_manifest_duplicate_source/],
      [(value) => {
        delete value.cases.find((item) => item.eligibleChallengeTag ===
          "adversarial_variant").challengeWitness;
        return value;
      }, /vnext_one_shot_manifest_witness_missing/],
      [(value) => {
        delete value.cases.find((item) => item.eligibleChallengeTag ===
          "constrained_format").challengeWitness.formatWitness;
        return value;
      }, /vnext_one_shot_manifest_witness_invalid/],
      [(value) => { delete value.cases[0].rubric; return value; },
        /vnext_one_shot_manifest_rubric_missing/],
    ];
    for (const [change, expectedError] of changes) {
      const fixture = syntheticManifest(change);
      writeFileSync(manifestPath, fixture.manifestText);
      writeFileSync(bindingPath, fixture.bindingText);
      assert.throws(() => checkManifestFiles(manifestPath, bindingPath), expectedError);
      const result = spawnSync(process.execPath,
        ["--import", "tsx", script, "--manifest", manifestPath, "--binding", bindingPath],
        { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "manifest_structure_invalid\n");
      assert.ok(!result.stderr.includes(fixture.rootDigest));
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("changed manifest cannot reuse an earlier root binding", () => {
  const temporary = mkdtempSync(join(tmpdir(), "prvnext-manifest-cli-"));
  const manifestPath = join(temporary, "manifest.json");
  const bindingPath = join(temporary, "binding.json");
  try {
    const original = syntheticManifest();
    const changed = syntheticManifest((value) => {
      value.cases[4].sourceText += " changed";
      return value;
    });
    writeFileSync(manifestPath, changed.manifestText);
    writeFileSync(bindingPath, original.bindingText);
    assert.throws(() => checkManifestFiles(manifestPath, bindingPath),
      /vnext_one_shot_manifest_binding_invalid/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
