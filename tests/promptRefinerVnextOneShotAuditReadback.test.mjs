import assert from "node:assert/strict";
import test from "node:test";

import { adminAuditEntryHashVariants } from "../lib/adminAuditIntegrityCore.ts";
import {
  PROMPT_REFINER_VNEXT_ONE_SHOT_APPROVAL_SUMMARIES,
  promptRefinerVnextOneShotApprovalAuditEntryIsValid,
  promptRefinerVnextOneShotApprovalAuditsAreValid,
} from "../lib/promptRefinerVnextOneShotAuditReadback.ts";

const key = "synthetic-one-shot-audit-test-key";
const approvedAt = new Date("2026-10-02T12:00:00.000Z");
const stage = {
  id: "prompt-refiner-vnext-one-shot-v1",
  sourceCommitSha: "a".repeat(40),
  sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64),
  manifestRoot: "d".repeat(64),
  runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
  runtimeCommitSha: "e".repeat(40),
  pricePinDigest: "f".repeat(64),
  perRequestCostMicroUsd: 29_918n,
  slotCount: 80,
  costCeilingMicroUsd: 2_393_440n,
  approvedBy: "synthetic-owner",
  approvedAt,
  stageApprovalAuditLogId: "synthetic-stage-audit",
  runApprovalAuditLogId: "synthetic-run-audit",
};

const metadata = (kind) => ({
  approvalKind: kind,
  sourceCommitSha: stage.sourceCommitSha,
  sourceManifestDigest: stage.sourceManifestDigest,
  runnerDigest: stage.runnerDigest,
  manifestRoot: stage.manifestRoot,
  runtimeDeploymentId: stage.runtimeDeploymentId,
  runtimeCommitSha: stage.runtimeCommitSha,
  pricePinDigest: stage.pricePinDigest,
  perRequestCostMicroUsd: 29_918,
  slotCount: 80,
  costCeilingMicroUsd: 2_393_440,
});

const signedAudit = (kind, previousHash = null, createdAt = null) => {
  const entry = {
    id: kind === "stage" ? stage.stageApprovalAuditLogId : stage.runApprovalAuditLogId,
    actorUserId: stage.approvedBy,
    actorEmail: null,
    action: `prompt_refiner.vnext_one_shot.${kind}_approved`,
    targetType: "PromptRefinerVnextOneShotStage",
    targetId: stage.id,
    summary: PROMPT_REFINER_VNEXT_ONE_SHOT_APPROVAL_SUMMARIES[kind],
    metadata: metadata(kind),
    ipAddress: null,
    userAgent: null,
    previousHash,
    entryHash: null,
    createdAt: createdAt ?? (kind === "stage" ? approvedAt : new Date(approvedAt.getTime() + 1000)),
  };
  const hashInput = { ...entry, createdAt: entry.createdAt.toISOString() };
  delete hashInput.id;
  delete hashInput.entryHash;
  return { ...entry, entryHash: adminAuditEntryHashVariants(hashInput, key).codepoint };
};

test("one-shot stage and run audit rows require signed exact bindings", () => {
  const stageAudit = signedAudit("stage");
  const runAudit = signedAudit("run", stageAudit.entryHash);
  assert.equal(promptRefinerVnextOneShotApprovalAuditEntryIsValid(stage, stageAudit, "stage", [key]), true);
  assert.equal(promptRefinerVnextOneShotApprovalAuditEntryIsValid(stage, runAudit, "run", [key]), true);
  assert.equal(promptRefinerVnextOneShotApprovalAuditEntryIsValid(stage, stageAudit, "run", [key]), false);
  assert.equal(promptRefinerVnextOneShotApprovalAuditEntryIsValid(
    stage, signedAudit("run", stageAudit.entryHash, approvedAt), "run", [key]
  ), false);
  assert.equal(promptRefinerVnextOneShotApprovalAuditEntryIsValid(stage, stageAudit, "stage", []), false);
  assert.equal(promptRefinerVnextOneShotApprovalAuditEntryIsValid(stage, stageAudit, "stage", ["wrong-key"]), false);
  assert.equal(promptRefinerVnextOneShotApprovalAuditEntryIsValid(
    { ...stage, manifestRoot: "0".repeat(64) }, stageAudit, "stage", [key]
  ), false);
  assert.equal(promptRefinerVnextOneShotApprovalAuditEntryIsValid(
    { ...stage, costCeilingMicroUsd: 2_393_441n }, stageAudit, "stage", [key]
  ), false);
  assert.equal(promptRefinerVnextOneShotApprovalAuditEntryIsValid(
    stage, { ...stageAudit, actorUserId: "other" }, "stage", [key]
  ), false);
  assert.equal(promptRefinerVnextOneShotApprovalAuditEntryIsValid(
    stage, { ...stageAudit, summary: "different summary" }, "stage", [key]
  ), false);
  assert.equal(promptRefinerVnextOneShotApprovalAuditEntryIsValid(
    stage, { ...stageAudit, createdAt: new Date(approvedAt.getTime() + 1000) }, "stage", [key]
  ), false);
});

test("one-shot audit readback checks both signatures and predecessor inside its transaction", async () => {
  const stageAudit = signedAudit("stage");
  const runAudit = signedAudit("run", stageAudit.entryHash);
  const byId = new Map([[stageAudit.id, stageAudit], [runAudit.id, runAudit]]);
  const byHash = new Map([[stageAudit.entryHash, stageAudit], [runAudit.entryHash, runAudit]]);
  const tx = {
    adminAuditLog: {
      async findUnique({ where }) {
        return where.id ? byId.get(where.id) ?? null : byHash.get(where.entryHash) ?? null;
      },
    },
  };
  const previousKey = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  const previousHistory = process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS;
  const previousFallback = process.env.NEXTAUTH_SECRET;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = key;
  delete process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS;
  try {
    assert.equal(await promptRefinerVnextOneShotApprovalAuditsAreValid(tx, stage), true);
    assert.equal(await promptRefinerVnextOneShotApprovalAuditsAreValid(
      tx, { ...stage, runApprovalAuditLogId: null }
    ), true);
    byHash.delete(stageAudit.entryHash);
    assert.equal(await promptRefinerVnextOneShotApprovalAuditsAreValid(tx, stage), false);
    byHash.set(stageAudit.entryHash, stageAudit);
    byHash.set(stageAudit.entryHash, { ...stageAudit, summary: "tampered predecessor" });
    assert.equal(await promptRefinerVnextOneShotApprovalAuditsAreValid(tx, stage), false);
    byHash.set(stageAudit.entryHash, stageAudit);
    byId.set(runAudit.id, { ...runAudit, entryHash: "0".repeat(64) });
    assert.equal(await promptRefinerVnextOneShotApprovalAuditsAreValid(tx, stage), false);
    byId.set(runAudit.id, runAudit);
    process.env.ADMIN_AUDIT_INTEGRITY_KEY = "rotated-current-key";
    process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS = key;
    assert.equal(await promptRefinerVnextOneShotApprovalAuditsAreValid(tx, stage), true);
    delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
    delete process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS;
    process.env.NEXTAUTH_SECRET = key;
    assert.equal(await promptRefinerVnextOneShotApprovalAuditsAreValid(tx, stage), true);
  } finally {
    if (previousKey === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
    else process.env.ADMIN_AUDIT_INTEGRITY_KEY = previousKey;
    if (previousHistory === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS;
    else process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS = previousHistory;
    if (previousFallback === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = previousFallback;
  }
});
