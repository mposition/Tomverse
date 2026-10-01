import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { PromptRefinerStageAdmissionError } from "../lib/promptRefinerStageAdmission";
import {
  promptRefinerVnextOneShotSourceReadFailureCode,
  verifyPromptRefinerVnextOneShotDevelopmentSource,
} from
  "../lib/promptRefinerQualityEvaluationVnextOneShotSource.ts";

test("safe-reader denials map to distinct content-free reasons", () => {
  const cases = [
    ["PROMPT_REFINER_STAGE_SOURCE_BOUNDARY", "vnext_one_shot_source_boundary"],
    ["PROMPT_REFINER_STAGE_SOURCE_NOT_REGULAR", "vnext_one_shot_source_not_regular"],
    ["PROMPT_REFINER_STAGE_SOURCE_CHANGED", "vnext_one_shot_source_changed"],
    ["PROMPT_REFINER_STAGE_SOURCE_SIZE", "vnext_one_shot_source_size"],
  ];
  for (const [sourceCode, expected] of cases) {
    const error = new PromptRefinerStageAdmissionError(503, sourceCode, "synthetic only");
    assert.equal(promptRefinerVnextOneShotSourceReadFailureCode(error), expected);
  }
  assert.equal(
    promptRefinerVnextOneShotSourceReadFailureCode(new Error("private path")),
    "vnext_one_shot_source_unavailable"
  );
});

test("server re-reads the approved policy, numeric spec and all development source blobs", async () => {
  const result = await verifyPromptRefinerVnextOneShotDevelopmentSource(process.cwd());
  assert.equal(result.policySha256, "dacdaab3360b7d848ea622bf83cc6a49c519c8a2f50ed1bc2d8b34a9a5b5ef7b");
  assert.equal(result.numericSpecSha256, "a1ebccdbbe10c02725d73686235f379f51abd38f5cf8a6acd9e3ba294edbbfea");
  assert.equal(result.verifiedFileCount, 17);
  assert.equal(result.deploymentAttested, false);
  assert.equal(result.priceVerified, false);
  assert.equal(result.reservationVerified, false);
  assert.equal(result.successorClosureVerified, false);
  assert.equal(result.dispatchAuthorized, false);
});

test("a changed pinned source is reported as drift, not an I/O failure", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "tomverse-one-shot-source-"));
  assert.ok(resolve(temporary).startsWith(`${resolve(tmpdir())}${sep}`));
  t.after(async () => { await rm(temporary, { recursive: true, force: true }); });
  const closurePath = "docs/ops/prompt-refiner-quality-evaluation-vnext-candidate-source-closure.json";
  const policyPath = "docs/policy/prompt-refiner-quality-evaluation-vnext-one-shot-v2.md";
  const closure = JSON.parse(await readFile(join(process.cwd(), closurePath), "utf8"));
  for (const path of new Set([closurePath, policyPath, ...Object.keys(closure.files)])) {
    const target = join(temporary, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(process.cwd(), path), target);
  }
  await appendFile(join(temporary, "docs/ops/prompt-refiner-quality-evaluation-vnext-numeric-spec-draft.md"), "\n");
  await assert.rejects(
    verifyPromptRefinerVnextOneShotDevelopmentSource(temporary),
    /vnext_one_shot_source_drift/
  );
});

test("missing checkout and invalid root cannot become source approval", async () => {
  await assert.rejects(
    verifyPromptRefinerVnextOneShotDevelopmentSource(""),
    /vnext_one_shot_source_root_invalid/
  );
  await assert.rejects(
    verifyPromptRefinerVnextOneShotDevelopmentSource("Z:/no-such-one-shot-checkout"),
    /vnext_one_shot_source_unavailable/
  );
});

test("oversize pinned files fail before hashing with a distinct size reason", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "tomverse-one-shot-size-"));
  assert.ok(resolve(temporary).startsWith(`${resolve(tmpdir())}${sep}`));
  t.after(async () => { await rm(temporary, { recursive: true, force: true }); });
  const closurePath = "docs/ops/prompt-refiner-quality-evaluation-vnext-candidate-source-closure.json";
  const policyPath = "docs/policy/prompt-refiner-quality-evaluation-vnext-one-shot-v2.md";
  const closure = JSON.parse(await readFile(join(process.cwd(), closurePath), "utf8"));
  for (const path of new Set([closurePath, policyPath, ...Object.keys(closure.files)])) {
    const target = join(temporary, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(process.cwd(), path), target);
  }
  await truncate(join(temporary, policyPath), 8 * 1024 * 1024 + 1);
  await assert.rejects(
    verifyPromptRefinerVnextOneShotDevelopmentSource(temporary),
    /vnext_one_shot_source_size/
  );
});
