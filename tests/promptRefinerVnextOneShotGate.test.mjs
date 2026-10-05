import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { syntheticManifest } from
  "./support/promptRefinerVnextOneShotSyntheticManifest.mjs";
import { scorePromptRefinerVnextOneShotOwnerGate } from
  "../lib/promptRefinerVnextOneShotOwnerGate.ts";
import { evaluatePromptRefinerVnextOneShotGateSummary } from
  "../lib/promptRefinerVnextOneShotGateSummary.ts";
import { signPromptRefinerVnextOneShotGateAttestation,
  verifyPromptRefinerVnextOneShotGateAttestation } from
  "../lib/promptRefinerVnextOneShotGateAttestation.ts";
import { canonicalBenchmarkJson } from "../lib/routerDevelopmentBenchmark.ts";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_SOURCE_DIGEST } from
  "../lib/promptRefinerVnextOneShotGateSource.ts";
import { createPromptRefinerVnextOneShotOwnerSeal } from
  "../lib/promptRefinerVnextOneShotOwnerSeal.ts";
import { createPromptRefinerVnextOneShotOwnerGateAttestation } from
  "../scripts/prompt-refiner-vnext-one-shot-owner-gate.mjs";

const target = {
  stageApprovalAuditLogId: "synthetic-stage-audit",
  runApprovalAuditLogId: "synthetic-run-audit",
  shadowAuditLogId: "synthetic-shadow-audit",
  runtimeDeploymentId: "11111111-1111-4111-8111-111111111111",
};
const usage = () => ({ inputTokens: 100, outputTokens: 40,
  cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 });

function fixture() {
  const manifest = syntheticManifest();
  const cases = JSON.parse(manifest.manifestText).cases;
  const results = cases.map((item) => {
    const slotIndex = (item.language === "ko" ? 0 : 40) +
      Number(item.caseId.slice(-3)) - 1;
    const abstain = item.expectedDirection === "abstain_preferred";
    const constrained = item.eligibleChallengeTag === "constrained_format";
    const boundary = item.eligibleChallengeTag === "boundary_near_miss";
    return {
      caseId: item.caseId, status: abstain ? "abstained" : "suggested",
      slotIndex,
      requestId: `11111111-1111-4111-8111-${String(slotIndex).padStart(12, "0")}`,
      slotConsumptionAuditLogId: `synthetic-slot-audit-${slotIndex}`,
      modelOutput: abstain
        ? { outcome: "abstained", refinedPrompt: null,
          abstentionReason: "unsafe_to_rewrite" }
        : { outcome: "suggested",
          refinedPrompt: constrained ? '{"title":"SAFE","count":2}' :
            boundary ? "SAFE exactly 3 items" : "SAFE synthetic rewrite",
          abstentionReason: null },
      reasonCode: null, criticalClass: null, usage: usage(),
      latencyMs: 100, toolCallCount: 0, providerRetryCount: 0,
    };
  });
  const fixed = ["ko", "en"].flatMap((language) =>
    ["rewrite_expected", "abstain_preferred"].map((direction) =>
      cases.filter((item) => item.language === language &&
        item.expectedDirection === direction)
        .sort((a, b) => auditRank(manifest.rootDigest, a.caseId)
          .localeCompare(auditRank(manifest.rootDigest, b.caseId)))[0].caseId));
  const audits = fixed.map((caseId) => ({ caseId, finding: "clear",
    criticalClass: null }));
  return { manifest, cases, results, audits };
}

function auditRank(root, caseId) {
  return createHash("sha256").update(canonicalBenchmarkJson({
    version: "audit-v1", manifestRoot: root, caseId,
  }), "utf8").digest("hex");
}

function score(f) {
  return scorePromptRefinerVnextOneShotOwnerGate({
    manifestText: f.manifest.manifestText,
    expectedRootDigest: f.manifest.rootDigest,
    expectedPreregistrationDigest: "a".repeat(64),
    results: f.results, audits: f.audits,
  });
}

test("synthetic sealed allocation and all gate denominators pass only with four fixed audits", () => {
  const f = fixture();
  const scored = score(f);
  assert.equal(scored.outcome, "pass");
  assert.deepEqual(scored.summary.outcomes, { suggested: 64,
    abstained: 16, failed: 0, unknown: 0, not_dispatched: 0 });
  assert.equal(scored.summary.cost.completeUsageCount, 80);
  assert.equal(scored.summary.latency.p90Ms, 100);
  assert.equal(scored.summary.audit.fixedReviewed, 4);
  assert.deepEqual(scored.reasonCodes, []);
  f.audits.pop();
  assert.equal(score(f).outcome, "insufficient_evidence");
});

test("missing, unknown and tampered restricted observations refuse or stay insufficient", () => {
  const missing = fixture();
  missing.results.pop();
  assert.throws(() => score(missing), /owner_gate_evidence_invalid/);
  const duplicate = fixture();
  duplicate.results[1].caseId = duplicate.results[0].caseId;
  assert.throws(() => score(duplicate), /owner_gate_evidence_invalid/);
  const unknown = fixture();
  unknown.results[0] = { ...unknown.results[0], status: "unknown",
    modelOutput: null, reasonCode: "unknown_after_dispatch", usage: null,
    latencyMs: null };
  assert.equal(score(unknown).outcome, "insufficient_evidence");
  const unreached = fixture();
  unreached.results[0] = { ...unreached.results[0], status: "not_dispatched",
    requestId: null, slotConsumptionAuditLogId: null,
    modelOutput: null, reasonCode: null, usage: null, latencyMs: null };
  assert.equal(score(unreached).outcome, "insufficient_evidence");
  const incomplete = fixture();
  incomplete.results[0].usage.cacheWriteInputTokens = null;
  assert.equal(score(incomplete).outcome, "insufficient_evidence");
  const root = fixture();
  root.manifest.rootDigest = "b".repeat(64);
  assert.throws(() => score(root), /owner_gate_evidence_invalid/);
});

test("confirmed failure, cell, challenge, latency and cost thresholds are decisive", () => {
  const failed = fixture();
  failed.results[0] = { ...failed.results[0], status: "failed",
    modelOutput: null, reasonCode: "provider_failure" };
  assert.equal(score(failed).outcome, "fail");
  const latency = fixture();
  latency.results[0].latencyMs = 12_001;
  assert.ok(score(latency).reasonCodes.includes("latency_ceiling_exceeded"));
  const quality = fixture();
  const selected = quality.cases.filter((item) =>
    item.baseCell === "general_rewrite" && item.language === "ko" &&
    item.eligibleChallengeTag === null).slice(0, 2);
  for (const item of selected) {
    quality.results.find((result) => result.caseId === item.caseId)
      .modelOutput.refinedPrompt = "Synthetic rewrite without required literal";
  }
  assert.ok(score(quality).reasonCodes.includes("quality_cell_threshold"));
  const costly = fixture();
  costly.results.forEach((item) => { item.usage = { inputTokens: 100_000,
    outputTokens: 4_096, cachedInputTokens: 1,
    cacheWriteInputTokens: 99_998, reasoningTokens: 0 }; });
  assert.equal(score(costly).summary.cost.knownCostMicroUsd, 2_393_440);
  const overCap = fixture();
  overCap.results[0].usage.inputTokens = 100_001;
  const overCapScore = score(overCap);
  assert.equal(overCapScore.outcome, "fail");
  assert.ok(overCapScore.reasonCodes.includes("cost_ceiling_exceeded"));
});

test("attestation accepts only signed content-free numbers for the exact target", () => {
  const f = fixture();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const privateB64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const signedAt = "2026-10-05T00:00:00.000Z";
  const attestation = signPromptRefinerVnextOneShotGateAttestation({
    version: "prompt-refiner-vnext-one-shot-gate-attestation-v1",
    ...target, gateSourceDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_SOURCE_DIGEST,
    slotBindingDigest: score(f).slotBindingDigest,
    signedAt, summary: score(f).summary,
  }, privateB64);
  assert.deepEqual(verifyPromptRefinerVnextOneShotGateAttestation(
    attestation, publicB64, new Date("2026-10-05T00:00:01.000Z")), attestation);
  assert.equal(JSON.stringify(attestation).includes(f.manifest.rootDigest), false);
  assert.equal(JSON.stringify(attestation).includes("sourceText"), false);
  assert.throws(() => verifyPromptRefinerVnextOneShotGateAttestation({
    ...attestation, runtimeDeploymentId: "22222222-2222-4222-8222-222222222222",
  }, publicB64, new Date("2026-10-05T00:00:01.000Z")), /attestation_invalid/);
  assert.throws(() => signPromptRefinerVnextOneShotGateAttestation({
    ...attestation, summary: { ...attestation.summary, manifestRoot: f.manifest.rootDigest },
  }, privateB64), /attestation_invalid/);
  assert.equal(evaluatePromptRefinerVnextOneShotGateSummary(
    attestation.summary).outcome, "pass");
});

test("restricted owner entrypoint checks synthetic seal and source closure before signing", () => {
  const f = fixture();
  const ownerKeyHex = "11".repeat(32);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const privateB64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const now = new Date("2026-10-05T00:00:00.000Z");
  const sealText = createPromptRefinerVnextOneShotOwnerSeal({
    manifestText: f.manifest.manifestText,
    expectedRootDigest: f.manifest.rootDigest,
    expectedPreregistrationDigest: "a".repeat(64),
    ownerHmacKey: Buffer.from(ownerKeyHex, "hex"), now,
    confirmation: "I_AM_MPOSITION_AND_VERIFIED_EVERY_LABEL_AND_PRIVACY_EXCLUSION",
  });
  const dir = mkdtempSync(join(tmpdir(), "synthetic-b03g-"));
  const paths = ["manifest", "binding", "seal", "results", "audits", "target"]
    .map((name) => join(dir, `${name}.json`));
  try {
    [f.manifest.manifestText, f.manifest.bindingText, sealText,
      JSON.stringify(f.results), JSON.stringify(f.audits), JSON.stringify(target)]
      .forEach((body, index) => writeFileSync(paths[index], body));
    const input = { manifestPath: paths[0], bindingPath: paths[1],
      sealPath: paths[2], resultsPath: paths[3], auditsPath: paths[4],
      targetPath: paths[5], ownerKeyHex,
      signingPrivateKeyB64: privateB64, now };
    const attested = createPromptRefinerVnextOneShotOwnerGateAttestation(input);
    assert.equal(verifyPromptRefinerVnextOneShotGateAttestation(
      attested, publicB64, now).summary.outcomes.suggested, 64);
    assert.equal(JSON.stringify(attested).includes(f.manifest.rootDigest), false);
    writeFileSync(paths[2], "{}", { encoding: "utf8" });
    assert.throws(() => createPromptRefinerVnextOneShotOwnerGateAttestation(input),
      /owner_gate_unavailable/);
  } finally {
    if (dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true });
  }
});
