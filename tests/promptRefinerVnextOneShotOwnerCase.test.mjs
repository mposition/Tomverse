import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createPromptRefinerVnextOneShotOwnerSeal } from
  "../lib/promptRefinerVnextOneShotOwnerSeal.ts";
import { readVerifiedPromptRefinerVnextOneShotOwnerCase } from
  "../scripts/prompt-refiner-vnext-one-shot-owner-case.mjs";
import { syntheticManifest } from
  "./support/promptRefinerVnextOneShotSyntheticManifest.mjs";

const keyHex = "42".repeat(32);
const confirmation = "I_AM_MPOSITION_AND_VERIFIED_EVERY_LABEL_AND_PRIVACY_EXCLUSION";

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), "prvnext-owner-case-"));
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
  return { ...paths, ownerKeyHex: keyHex, now: new Date("2026-10-04T00:00:00.000Z"),
    synthetic };
}

test("owner case reader rehashes sealed N80 input and maps every slot by case ID", (t) => {
  const input = fixture(t);
  const cases = JSON.parse(input.synthetic.manifestText).cases;
  for (let slotIndex = 0; slotIndex < 80; slotIndex++) {
    const selected = readVerifiedPromptRefinerVnextOneShotOwnerCase({
      ...input, slotIndex,
    });
    const expected = cases.find((item) => item.caseId === selected.caseId);
    assert.equal(selected.language, slotIndex < 40 ? "ko" : "en");
    assert.equal(selected.sourceText, expected.sourceText);
    assert.equal(selected.manifestRoot, JSON.parse(input.synthetic.bindingText).expectedRootDigest);
    assert.equal(selected.dispatchAuthorized, false);
    assert.deepEqual(Object.keys(selected), [
      "caseId", "language", "sourceText", "manifestRoot", "dispatchAuthorized",
    ]);
  }
});

test("changed manifest, binding, seal or key fails closed before selecting text", (t) => {
  const input = fixture(t);
  const read = (overrides = {}) => readVerifiedPromptRefinerVnextOneShotOwnerCase({
    ...input, slotIndex: 0, ...overrides,
  });
  assert.throws(() => read({ slotIndex: 80 }), { message: "owner_case_unavailable" });
  assert.throws(() => read({ slotIndex: -1 }), { message: "owner_case_unavailable" });
  assert.throws(() => read({ slotIndex: 0.5 }), { message: "owner_case_unavailable" });
  assert.throws(() => read({ sealPath: input.manifestPath }),
    { message: "owner_case_unavailable" });
  assert.throws(() => read({ ownerKeyHex: "11".repeat(32) }),
    { message: "owner_case_unavailable" });
  assert.throws(() => read({ ownerKeyHex: "not-hex" }),
    { message: "owner_case_unavailable" });
  assert.throws(() => read({ now: new Date("2026-09-30T00:00:00.000Z") }),
    { message: "owner_case_unavailable" });
  assert.throws(() => read({ now: new Date("2026-12-03T00:00:00.000Z") }),
    { message: "owner_case_unavailable" });
  writeFileSync(input.manifestPath,
    readFileSync(input.manifestPath, "utf8").replace("synthetic ko source", "changed ko source"));
  assert.throws(() => read(), { message: "owner_case_unavailable" });
  writeFileSync(input.manifestPath, input.synthetic.manifestText);
  writeFileSync(input.bindingPath,
    input.synthetic.bindingText.replace(/a{64}/, "b".repeat(64)));
  assert.throws(() => read(), { message: "owner_case_unavailable" });
  writeFileSync(input.bindingPath, input.synthetic.bindingText);
  const originalSeal = readFileSync(input.sealPath, "utf8");
  const tamperedSeal = originalSeal.replace(
    /[0-9a-f]{64}(?="\s*})/, "0".repeat(64));
  assert.notEqual(tamperedSeal, originalSeal);
  writeFileSync(input.sealPath, tamperedSeal);
  assert.throws(() => read(), { message: "owner_case_unavailable" });
});

test("symlinked owner inputs are refused where supported", (t) => {
  const input = fixture(t);
  const linkPath = join(dirname(input.manifestPath), "manifest-link.json");
  try {
    symlinkSync(input.manifestPath, linkPath, "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("this host cannot create file symlinks");
      return;
    }
    throw error;
  }
  assert.throws(() => readVerifiedPromptRefinerVnextOneShotOwnerCase({
    ...input, manifestPath: linkPath, slotIndex: 0,
  }), { message: "owner_case_unavailable" });
});
