import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkManifestFiles } from
  "../scripts/prompt-refiner-vnext-one-shot-check-manifest.mjs";

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
    writeFileSync(manifestPath, sentinel);
    writeFileSync(bindingPath, JSON.stringify({
      version: "prompt-refiner-vnext-one-shot-binding-v1",
      expectedRootDigest,
      expectedPreregistrationDigest,
    }));
    let calls = 0;
    const result = checkManifestFiles(manifestPath, bindingPath,
      (manifest, rootDigest, preregistrationDigest) => {
        calls++;
        assert.equal(manifest, sentinel);
        assert.equal(rootDigest, expectedRootDigest);
        assert.equal(preregistrationDigest, expectedPreregistrationDigest);
      });
    assert.equal(calls, 1);
    assert.deepEqual(result, {
      structuralValidation: "pass", caseCount: 80,
      semanticTruthVerified: false, independentAuthorshipVerified: false,
      privacyExclusionVerified: false, fullManifestValidated: false,
      dispatchAuthorized: false,
    });
    assert.ok(!JSON.stringify(result).includes(expectedRootDigest));
    assert.ok(!JSON.stringify(result).includes(sentinel));

    const invalid = spawnSync(process.execPath,
      ["--import", "tsx", script, "--manifest", manifestPath, "--binding", bindingPath],
      { cwd: root, encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    assert.equal(invalid.stderr, "manifest_structure_invalid\n");
    assert.ok(!invalid.stderr.includes(sentinel));
    assert.ok(!invalid.stderr.includes(expectedRootDigest));
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
    assert.throws(() => checkManifestFiles(manifestPath, bindingPath,
      () => assert.fail("validator must not run")));
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
    writeFileSync(bindingPath, JSON.stringify({
      version: "prompt-refiner-vnext-one-shot-binding-v1",
      expectedRootDigest,
      expectedPreregistrationDigest,
    }));
    linkSync(bindingPath, aliasPath);
    const assertRefusedBeforeVerify = (manifest, binding) => {
      let verifierCalled = false;
      assert.throws(() => checkManifestFiles(manifest, binding,
        () => { verifierCalled = true; }));
      assert.equal(verifierCalled, false);
    };
    assertRefusedBeforeVerify(aliasPath, bindingPath);
    assertRefusedBeforeVerify(bindingPath, aliasPath);
    writeFileSync(manifestPath, Buffer.from([0xff]));
    assertRefusedBeforeVerify(manifestPath, bindingPath);
    writeFileSync(manifestPath, "");
    assertRefusedBeforeVerify(manifestPath, bindingPath);
    writeFileSync(manifestPath, Buffer.alloc(16 * 1024 * 1024 + 1));
    assertRefusedBeforeVerify(manifestPath, bindingPath);
    writeFileSync(manifestPath, sentinel);
    const validBinding = JSON.stringify({
      version: "prompt-refiner-vnext-one-shot-binding-v1",
      expectedRootDigest,
      expectedPreregistrationDigest,
    });
    writeFileSync(bindingPath, validBinding.padEnd(1025, " "));
    assertRefusedBeforeVerify(manifestPath, bindingPath);
    writeFileSync(bindingPath, Buffer.from([0xff]));
    assertRefusedBeforeVerify(manifestPath, bindingPath);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
