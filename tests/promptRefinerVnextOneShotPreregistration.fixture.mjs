// Runs only through the small wrapper that enables Node's module-mock flag.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
const source = { sourceCommitSha: "a".repeat(40),
  sourceManifestDigest: "b".repeat(64) };
const expected = { ...source, runnerDigest: "c".repeat(64),
  pricePinDigest: "d".repeat(64) };
let sourceReads = 0;
let sourceFailure = null;
let existing = [];
let auditInput = null;
let priceReads = 0;
let priceMatches = true;
let auditValid = true;
let policyDrift = false;
let policyUnavailable = false;
let stageExists = false;
let inTransaction = false;
const policyBytes = readFileSync(resolve(root,
  "docs/policy/prompt-refiner-quality-evaluation-vnext-one-shot-v2.md"));
const tx = {
  adminAuditLog: { findMany: async () => existing },
};

mock.module(mod("lib/prisma.ts"), { namedExports: {
  prisma: { $transaction: async (callback) => {
    inTransaction = true;
    try { return await callback(tx); } finally { inTransaction = false; }
  } },
} });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  takeAuditChainLock: async () => {},
  writeAdminAuditLog: async (input) => {
    auditInput = input;
    return "audit-prereg-1";
  },
} });
mock.module(mod("lib/adminAuditIntegrityCore.ts"), { namedExports: {
  adminAuditIntegrityKeys: () => ["synthetic-key"],
} });
mock.module(mod("lib/promptRefinerStageAdmission.ts"), { namedExports: {
  readExactCheckoutFile: async () => {
    if (policyUnavailable) throw new Error("synthetic EACCES");
    return policyDrift ? Buffer.from("changed policy") : policyBytes;
  },
} });
mock.module(mod("lib/promptRefinerVnextOneShotAuditReadback.ts"), { namedExports: {
  promptRefinerVnextOneShotAuditReceiptIsValid: async () => auditValid,
} });
mock.module(mod("lib/promptRefinerVnextOneShotCandidateSourceReadback.ts"), {
  namedExports: {
    previewPromptRefinerVnextOneShotCandidateSourcePin: async () => {
      sourceReads++;
      return source;
    },
    verifyPromptRefinerVnextOneShotCandidateSourceAtRoot: async (
      rootPath, runtimeCommitSha, pin) => {
      assert.equal(inTransaction, false, "checkout files are read outside the DB transaction");
      assert.equal(rootPath, process.cwd());
      assert.match(runtimeCommitSha, /^[0-9a-f]{40}$/);
      assert.equal(pin.sourceCommitSha, expected.sourceCommitSha);
      sourceReads++;
      if (sourceFailure) throw new Error(sourceFailure);
      if (pin.sourceManifestDigest !== source.sourceManifestDigest) {
        throw new Error("vnext_one_shot_candidate_manifest_drift");
      }
      return { candidateSourceVerified: true, dispatchAuthorized: false };
    },
  },
});
mock.module(mod("lib/promptRefinerVnextOneShotPriceBinding.ts"), { namedExports: {
  PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST: expected.pricePinDigest,
} });
mock.module(mod("lib/promptRefinerVnextOneShotStageReadback.ts"), { namedExports: {
  readPromptRefinerVnextOneShotStage: async () => ({ stagePresent: stageExists }),
} });
mock.module(mod("lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback.ts"), {
  namedExports: { readPromptRefinerVnextOneShotPrice: async () => {
    assert.equal(inTransaction, true, "registry price is read inside the DB transaction");
    priceReads++;
    return { pricePinMatchesRegistry: priceMatches,
      problems: priceMatches ? [] : ["price_pin_mismatch"] };
  } },
});
const { preparePromptRefinerVnextOneShotPreregistration,
  recordPromptRefinerVnextOneShotPreregistration,
  readPromptRefinerVnextOneShotPreregistration,
  assertPromptRefinerVnextOneShotPreregistrationForStage } = await import(
  mod("lib/promptRefinerVnextOneShotPreregistration.ts"));

const session = { user: { id: "synthetic-owner" } };
const request = new Request("http://localhost/internal/test", { method: "POST" });
process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = expected.runnerDigest;
process.env.RAILWAY_GIT_COMMIT_SHA = expected.sourceCommitSha;

test("preregistration reobserves source and rejects an unpinned runner or price", async () => {
  assert.deepEqual(await preparePromptRefinerVnextOneShotPreregistration(expected), expected);
  assert.equal(sourceReads, 1);
  policyDrift = true;
  await assert.rejects(preparePromptRefinerVnextOneShotPreregistration(expected),
    /preregistration_policy_mismatch/);
  policyDrift = false;
  assert.equal(sourceReads, 1);
  await assert.rejects(preparePromptRefinerVnextOneShotPreregistration({
    ...expected, runnerDigest: "e".repeat(64),
  }), /preregistration_pin_mismatch/);
  await assert.rejects(preparePromptRefinerVnextOneShotPreregistration({
    ...expected, pricePinDigest: "e".repeat(64),
  }), /preregistration_pin_mismatch/);
  assert.equal(sourceReads, 1);
  await assert.rejects(preparePromptRefinerVnextOneShotPreregistration({
    ...expected, sourceCommitSha: "e".repeat(40),
  }), /preregistration_source_mismatch/);
});

test("one owner approval records fixed policy, cost, access and retention without content", async () => {
  existing = [];
  const readsBefore = sourceReads;
  await assert.rejects(recordPromptRefinerVnextOneShotPreregistration({
    session, request, pins: { ...expected, sourceCommitSha: "e".repeat(40) },
  }), /preregistration_source_mismatch/);
  assert.equal(priceReads, 0);
  assert.equal(auditInput, null);
  const result = await recordPromptRefinerVnextOneShotPreregistration({
    session, request, pins: expected,
  });
  assert.equal(sourceReads, readsBefore + 2);
  assert.deepEqual(result, { auditLogId: "audit-prereg-1", dispatchAuthorized: false });
  assert.equal(priceReads, 1);
  assert.equal(auditInput.tx, tx);
  assert.equal(auditInput.action, "prompt_refiner.vnext_one_shot.preregistered");
  assert.equal(auditInput.metadata.accessorUserId, "synthetic-owner");
  assert.equal(auditInput.metadata.rawRetentionDaysAfterDisposition, 30);
  assert.equal(auditInput.metadata.rawRetentionDaysAfterSeal, 60);
  assert.equal(auditInput.metadata.slotCount, 80);
  assert.equal(auditInput.metadata.perRequestCeilingMicroUsd, 29_918);
  assert.equal(auditInput.metadata.runCeilingMicroUsd, 2_393_440);
  assert.equal(auditInput.metadata.retryCount, 0);
  assert.ok(!JSON.stringify(auditInput.metadata).includes("manifestRoot"));
  assert.ok(!JSON.stringify(auditInput.metadata).includes("sourceText"));
  existing = [{ id: "audit-prereg-1" }];
  await assert.rejects(recordPromptRefinerVnextOneShotPreregistration({
    session, request, pins: expected,
  }), /preregistration_already_recorded/);
  assert.equal(priceReads, 1);
  existing = [];
  stageExists = true;
  await assert.rejects(recordPromptRefinerVnextOneShotPreregistration({
    session, request, pins: expected,
  }), /preregistration_stage_exists/);
  stageExists = false;
  assert.equal(priceReads, 1);
});

test("stage requires exactly one signed matching owner preregistration", async () => {
  const entry = { id: "audit-prereg-1", actorUserId: "synthetic-owner",
    summary: auditInput.summary, metadata: auditInput.metadata };
  existing = [entry];
  await assert.doesNotReject(assertPromptRefinerVnextOneShotPreregistrationForStage(
    tx, expected, "synthetic-owner"));
  for (const [rows, pins, owner, signed] of [
    [[], expected, "synthetic-owner", true],
    [[entry, entry], expected, "synthetic-owner", true],
    [[entry], { ...expected, runnerDigest: "e".repeat(64) }, "synthetic-owner", true],
    [[entry], { ...expected, sourceCommitSha: "e".repeat(40) }, "synthetic-owner", true],
    [[entry], expected, "different-owner", true],
    [[entry], expected, "synthetic-owner", false],
  ]) {
    existing = rows;
    auditValid = signed;
    await assert.rejects(assertPromptRefinerVnextOneShotPreregistrationForStage(
      tx, pins, owner), /preregistration_unavailable/);
  }
});

test("lost POST response is recovered only from one signed, current owner receipt", async () => {
  existing = [];
  assert.deepEqual(await readPromptRefinerVnextOneShotPreregistration("synthetic-owner"), {
    preregistrationRecorded: false, preregistrationAuditLogId: null,
    currentPinsMatch: false, dispatchAuthorized: false,
  });
  const entry = { id: "audit-prereg-1", actorUserId: "synthetic-owner",
    summary: auditInput.summary, metadata: auditInput.metadata };
  existing = [entry];
  auditValid = true;
  assert.deepEqual(await readPromptRefinerVnextOneShotPreregistration("synthetic-owner"), {
    preregistrationRecorded: true, preregistrationAuditLogId: "audit-prereg-1",
    currentPinsMatch: true, dispatchAuthorized: false,
  });
  // A later app release can have a different commit if candidate bytes remain pinned.
  process.env.RAILWAY_GIT_COMMIT_SHA = "f".repeat(40);
  assert.deepEqual(await readPromptRefinerVnextOneShotPreregistration("synthetic-owner"), {
    preregistrationRecorded: true, preregistrationAuditLogId: "audit-prereg-1",
    currentPinsMatch: true, dispatchAuthorized: false,
  });
  existing = [entry, entry];
  await assert.rejects(readPromptRefinerVnextOneShotPreregistration("synthetic-owner"),
    /preregistration_record_unverifiable/);
  existing = [entry];
  auditValid = false;
  await assert.rejects(readPromptRefinerVnextOneShotPreregistration("synthetic-owner"),
    /preregistration_record_unverifiable/);
  auditValid = true;
  existing = [{ ...entry, actorUserId: "different-owner" }];
  await assert.rejects(readPromptRefinerVnextOneShotPreregistration("synthetic-owner"),
    /preregistration_record_unverifiable/);
  const stale = { preregistrationRecorded: true,
    preregistrationAuditLogId: "audit-prereg-1", currentPinsMatch: false,
    dispatchAuthorized: false };
  existing = [{ ...entry, metadata: { ...entry.metadata, slotCount: 81 } }];
  assert.deepEqual(await readPromptRefinerVnextOneShotPreregistration("synthetic-owner"),
    stale);
  existing = [entry];
  policyDrift = true;
  assert.deepEqual(await readPromptRefinerVnextOneShotPreregistration("synthetic-owner"),
    stale);
  policyDrift = false;
  policyUnavailable = true;
  await assert.rejects(readPromptRefinerVnextOneShotPreregistration("synthetic-owner"),
    /preregistration_policy_unavailable/);
  policyUnavailable = false;
  delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST;
  await assert.rejects(readPromptRefinerVnextOneShotPreregistration("synthetic-owner"),
    /preregistration_runner_unavailable/);
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = "e".repeat(64);
  assert.deepEqual(await readPromptRefinerVnextOneShotPreregistration("synthetic-owner"),
    stale);
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = expected.runnerDigest;
  priceMatches = false;
  assert.deepEqual(await readPromptRefinerVnextOneShotPreregistration("synthetic-owner"),
    stale);
  priceMatches = true;
  source.sourceManifestDigest = "e".repeat(64);
  assert.deepEqual(await readPromptRefinerVnextOneShotPreregistration("synthetic-owner"),
    stale);
  source.sourceManifestDigest = expected.sourceManifestDigest;
  sourceFailure = "vnext_one_shot_candidate_file_drift";
  assert.deepEqual(await readPromptRefinerVnextOneShotPreregistration("synthetic-owner"),
    stale);
  sourceFailure = "vnext_one_shot_candidate_source_unavailable";
  await assert.rejects(readPromptRefinerVnextOneShotPreregistration("synthetic-owner"),
    /preregistration_source_unavailable/);
  sourceFailure = "EACCES";
  await assert.rejects(readPromptRefinerVnextOneShotPreregistration("synthetic-owner"),
    /preregistration_source_unavailable/);
  sourceFailure = null;
});
