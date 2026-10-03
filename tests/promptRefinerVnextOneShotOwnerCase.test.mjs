import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("owner case reader rehashes sealed N80 input and maps each slot by case ID", (t) => {
  const input = fixture(t);
  const cases = JSON.parse(input.synthetic.manifestText).cases;
  for (const slotIndex of [0, 39, 40, 79]) {
    const selected = readVerifiedPromptRefinerVnextOneShotOwnerCase({
      ...input, slotIndex,
    });
    const expected = cases.find((item) => item.caseId === selected.caseId);
    assert.equal(selected.language, slotIndex < 40 ? "ko" : "en");
    assert.equal(selected.sourceText, expected.sourceText);
    assert.equal(selected.dispatchAuthorized, false);
    assert.deepEqual(Object.keys(selected), [
      "caseId", "language", "sourceText", "dispatchAuthorized",
    ]);
  }
});

test("changed manifest, binding, seal or key fails closed before selecting text", (t) => {
  const input = fixture(t);
  const read = (overrides = {}) => readVerifiedPromptRefinerVnextOneShotOwnerCase({
    ...input, slotIndex: 0, ...overrides,
  });
  assert.throws(() => read({ slotIndex: 80 }), { message: "owner_case_unavailable" });
  assert.throws(() => read({ ownerKeyHex: "11".repeat(32) }),
    { message: "owner_case_unavailable" });
  writeFileSync(input.manifestPath,
    readFileSync(input.manifestPath, "utf8").replace("synthetic ko source", "changed ko source"));
  assert.throws(() => read(), { message: "owner_case_unavailable" });
  writeFileSync(input.manifestPath, input.synthetic.manifestText);
  writeFileSync(input.bindingPath,
    input.synthetic.bindingText.replace(/a{64}/, "b".repeat(64)));
  assert.throws(() => read(), { message: "owner_case_unavailable" });
  writeFileSync(input.bindingPath, input.synthetic.bindingText);
  writeFileSync(input.sealPath, readFileSync(input.sealPath, "utf8").replace(
    /[0-9a-f]{64}(?="\s*})/, "0".repeat(64)));
  assert.throws(() => read(), { message: "owner_case_unavailable" });
});
