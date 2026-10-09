import assert from "node:assert/strict";
import test from "node:test";

import { adminAuditEntryHashVariants } from "../lib/adminAuditIntegrityCore.ts";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_APPROVAL_SUMMARIES,
  promptRefinerVnextOneShotApprovalAuditMetadata } from
  "../lib/promptRefinerVnextOneShotAuditReadback.ts";
import { lockAndReadPromptRefinerVnextOneShotStage,
  readPromptRefinerVnextOneShotStage } from
  "../lib/promptRefinerVnextOneShotStageReadback.ts";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST } from
  "../lib/promptRefinerVnextOneShotPriceBinding.ts";
import { staticModelRegistrySeedRows } from "../lib/modelRegistryShared.ts";

const stage = {
  id: "prompt-refiner-vnext-one-shot-v4",
  status: "staged",
  slotCount: 80,
  sourceCommitSha: "a".repeat(40),
  sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64),
  manifestRoot: "d".repeat(64),
  runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
  runtimeCommitSha: "e".repeat(40),
  pricePinDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST,
  perRequestCostMicroUsd: 29_918n,
  costCeilingMicroUsd: 2_393_440n,
  approvedBy: "synthetic-owner",
  approvedAt: new Date("2026-10-03T00:00:00.000Z"),
  stageApprovalAuditLogId: "synthetic-audit",
  runApprovalAuditLogId: null,
};
const slots = () => Array.from({ length: 80 }, (_, slotIndex) => ({
  slotIndex, status: "reserved", reservedCostMicroUsd: 29_918n,
  requestId: null, consumedAt: null,
}));
const txFor = (row, items) => {
  const calls = { stages: 0, slots: 0 };
  return {
    calls,
    tx: {
      promptRefinerVnextOneShotStage: { async findUnique({ where }) {
        assert.deepEqual(where, { id: "prompt-refiner-vnext-one-shot-v4" });
        calls.stages++;
        return row;
      } },
      promptRefinerVnextOneShotSlot: { async findMany({ where }) {
        assert.deepEqual(where, { stageId: "prompt-refiner-vnext-one-shot-v4" });
        calls.slots++;
        return items;
      } },
      adminAuditLog: { async findUnique() { return null; } },
    },
  };
};

test("missing stage is content-free and cannot dispatch", async () => {
  const { tx, calls } = txFor(null, []);
  const result = await readPromptRefinerVnextOneShotStage(tx);
  assert.deepEqual(result, {
    stagePresent: false, stageId: null, stageStatus: null,
    runtimeDeploymentId: null, runtimeCommitSha: null,
    stageApprovalAuditLogId: null, runApprovalAuditLogId: null,
    slotCount: 0,
    reservedSlots: 0, consumedSlots: 0, reservationShapeValid: false,
    approvalAuditsValid: false, dispatchAuthorized: false,
  });
  assert.deepEqual(calls, { stages: 1, slots: 0 });
});

test("exact 80-slot shape returns approval IDs without root or request IDs", async () => {
  const items = slots();
  items[0] = { ...items[0], status: "consumed", requestId: "synthetic-request",
    consumedAt: new Date("2026-10-03T00:01:00.000Z") };
  const { tx, calls } = txFor(stage, items);
  const result = await readPromptRefinerVnextOneShotStage(tx);
  assert.equal(result.reservationShapeValid, true);
  assert.equal(result.slotCount, 80);
  assert.equal(result.stageId, stage.id);
  assert.equal(result.runtimeDeploymentId, stage.runtimeDeploymentId);
  assert.equal(result.runtimeCommitSha, stage.runtimeCommitSha);
  assert.equal(result.stageApprovalAuditLogId, stage.stageApprovalAuditLogId);
  assert.equal(result.runApprovalAuditLogId, null);
  assert.equal(result.reservedSlots, 79);
  assert.equal(result.consumedSlots, 1);
  assert.equal(result.approvalAuditsValid, false);
  assert.equal(result.dispatchAuthorized, false);
  assert.deepEqual(calls, { stages: 1, slots: 1 });
  assert.doesNotMatch(JSON.stringify(result), /manifestRoot|digest|requestId|sourceCommitSha/i);
});

test("duplicate, missing or malformed reservations fail closed", async () => {
  const missing = slots().slice(0, 79);
  assert.equal((await readPromptRefinerVnextOneShotStage(txFor(stage, missing).tx))
    .reservationShapeValid, false);
  const duplicate = slots();
  duplicate[79] = { ...duplicate[79], slotIndex: 0 };
  assert.equal((await readPromptRefinerVnextOneShotStage(txFor(stage, duplicate).tx))
    .reservationShapeValid, false);
  const wrongCost = slots();
  wrongCost[79] = { ...wrongCost[79], reservedCostMicroUsd: 29_919n };
  assert.equal((await readPromptRefinerVnextOneShotStage(txFor(stage, wrongCost).tx))
    .reservationShapeValid, false);
  const incomplete = slots();
  incomplete[79] = { ...incomplete[79], status: "consumed", requestId: null,
    consumedAt: null };
  assert.equal((await readPromptRefinerVnextOneShotStage(txFor(stage, incomplete).tx))
    .reservationShapeValid, false);
});

test("replacement readback refuses missing legacy close and broken audit links", async () => {
  const key = "synthetic-replacement-readback-key";
  const previousKey = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = key;
  const replacement = { ...stage, id: "prompt-refiner-vnext-one-shot-v3",
    supersededAuditLogId: null };
  const legacy = { ...replacement, id: "prompt-refiner-vnext-one-shot-v2",
    status: "closed", stageApprovalAuditLogId: "legacy-stage-audit",
    runApprovalAuditLogId: "legacy-run-audit",
    supersededAuditLogId: "legacy-close-audit",
    runtimeDeploymentId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" };
  const signed = (entry) => {
    const hashInput = { ...entry, createdAt: entry.createdAt.toISOString() };
    delete hashInput.id;
    delete hashInput.entryHash;
    return { ...entry,
      entryHash: adminAuditEntryHashVariants(hashInput, key).codepoint };
  };
  const commonAudit = { actorUserId: stage.approvedBy, actorEmail: null,
    targetType: "PromptRefinerVnextOneShotStage", ipAddress: null,
    userAgent: null, entryHash: null };
  const stageAudit = signed({ ...commonAudit, id: replacement.stageApprovalAuditLogId,
    action: "prompt_refiner.vnext_one_shot.stage_approved", targetId: replacement.id,
    summary: PROMPT_REFINER_VNEXT_ONE_SHOT_APPROVAL_SUMMARIES.stage,
    metadata: promptRefinerVnextOneShotApprovalAuditMetadata(replacement, "stage"),
    previousHash: null, createdAt: replacement.approvedAt });
  const closeAudit = signed({ ...commonAudit, id: legacy.supersededAuditLogId,
    action: "prompt_refiner.vnext_one_shot.stage_superseded", targetId: legacy.id,
    summary: "Closed an unrun one-shot stage for exact-deployment replacement.",
    metadata: { replacementStageId: replacement.id,
      previousStageApprovalAuditLogId: legacy.stageApprovalAuditLogId,
      previousRunApprovalAuditLogId: legacy.runApprovalAuditLogId,
      replacementStageApprovalAuditLogId: replacement.stageApprovalAuditLogId },
    previousHash: stageAudit.entryHash,
    createdAt: new Date(stage.approvedAt.getTime() + 1000) });
  const read = (oldStage = legacy, closure = closeAudit) => {
    const byId = new Map([[stageAudit.id, stageAudit], [closure.id, closure]]);
    const tx = {
      promptRefinerVnextOneShotStage: { async findUnique({ where }) {
        return where.id === replacement.id ? replacement : oldStage;
      } },
      promptRefinerVnextOneShotSlot: { async findMany() { return slots(); } },
      adminAuditLog: { async findUnique({ where }) {
        if (where.id) return byId.get(where.id) ?? null;
        return [stageAudit, closure].find((entry) =>
          entry.entryHash === where.entryHash) ?? null;
      } },
    };
    return readPromptRefinerVnextOneShotStage(tx, replacement.id);
  };
  try {
    assert.equal((await read()).approvalAuditsValid, true);
    assert.equal((await read({ ...legacy, status: "staged" })).approvalAuditsValid, false);
    assert.equal((await read(legacy, { ...closeAudit, entryHash: "0".repeat(64) }))
      .approvalAuditsValid, false);
    assert.equal((await read(legacy, { ...closeAudit,
      metadata: { ...closeAudit.metadata, replacementStageApprovalAuditLogId: "other" } }))
      .approvalAuditsValid, false);
  } finally {
    if (previousKey === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
    else process.env.ADMIN_AUDIT_INTEGRITY_KEY = previousKey;
  }
});

test("transactional read locks the stage before reading reservations", async () => {
  const { tx, calls } = txFor(stage, slots());
  let locks = 0;
  tx.$queryRaw = async (strings, id) => {
    const sql = strings.join("?");
    assert.match(sql, /FOR NO KEY UPDATE NOWAIT/);
    assert.equal(id, "prompt-refiner-vnext-one-shot-v4");
    locks++;
    if (!sql.includes('"status"')) {
      if (locks === 1) assert.deepEqual(calls, { stages: 0, slots: 0 });
      return [{ id }];
    }
    if (sql.includes('"pricePinDigest"')) return [stage];
    return [{ id, status: stage.status,
      runtimeDeploymentId: stage.runtimeDeploymentId,
      runtimeCommitSha: stage.runtimeCommitSha }];
  };
  let priceLocks = 0;
  tx.$executeRaw = async (sql) => {
    assert.deepEqual([...sql], ['LOCK TABLE "ModelRegistryEntry" IN SHARE MODE']);
    priceLocks++;
    return 0;
  };
  tx.modelRegistryEntry = { findUnique: async () =>
    staticModelRegistrySeedRows().find((row) => row.id === "gpt-5-6-luna") };
  const deploymentOptions = {
    environment: {
      RAILWAY_ENVIRONMENT_NAME: "staging",
      RAILWAY_DEPLOYMENT_ID: stage.runtimeDeploymentId,
      RAILWAY_GIT_COMMIT_SHA: stage.runtimeCommitSha,
      RAILWAY_PROJECT_ID: "22345678-1234-1234-1234-123456789abc",
      RAILWAY_SERVICE_ID: "32345678-1234-1234-1234-123456789abc",
      RAILWAY_ENVIRONMENT_ID: "42345678-1234-1234-1234-123456789abc",
      RAILWAY_API_TOKEN: "synthetic-token",
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: {
      deployment: { id: stage.runtimeDeploymentId, status: "SUCCESS",
        meta: { commitHash: stage.runtimeCommitSha } },
      deployments: { edges: [{ node: { id: stage.runtimeDeploymentId,
        status: "SUCCESS" } }] },
    } }) }),
  };
  const result = await lockAndReadPromptRefinerVnextOneShotStage(tx, deploymentOptions);
  assert.equal(result.reservationShapeValid, true);
  assert.equal(result.dispatchAuthorized, false);
  assert.deepEqual(calls, { stages: 1, slots: 1 });
  assert.equal(locks, 3);
  assert.equal(priceLocks, 1);
  await assert.rejects(
    lockAndReadPromptRefinerVnextOneShotStage(tx, {
      ...deploymentOptions,
      environment: { ...deploymentOptions.environment,
        RAILWAY_GIT_COMMIT_SHA: "b".repeat(40) },
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: {
        deployment: { id: stage.runtimeDeploymentId, status: "SUCCESS",
          meta: { commitHash: "b".repeat(40) } },
        deployments: { edges: [{ node: { id: stage.runtimeDeploymentId,
          status: "SUCCESS" } }] },
      } }) }),
    }),
    /vnext_one_shot_approved_deployment_mismatch/
  );
  assert.equal(priceLocks, 1);
  tx.modelRegistryEntry.findUnique = async () => ({
    ...staticModelRegistrySeedRows().find((row) => row.id === "gpt-5-6-luna"),
    inputUsdPerMillionTokens: 0.01,
  });
  await assert.rejects(
    lockAndReadPromptRefinerVnextOneShotStage(tx, deploymentOptions),
    /vnext_one_shot_registry_price_mismatch/
  );
  assert.equal(priceLocks, 2);
});

test("absent or unavailable lock never reads an unlocked stage", async () => {
  const absent = txFor(stage, slots());
  absent.tx.$queryRaw = async () => [];
  const result = await lockAndReadPromptRefinerVnextOneShotStage(absent.tx);
  assert.equal(result.stagePresent, false);
  assert.equal(result.dispatchAuthorized, false);
  assert.deepEqual(absent.calls, { stages: 0, slots: 0 });

  const unavailable = txFor(stage, slots());
  unavailable.tx.$queryRaw = async () => { throw new Error("lock_not_available"); };
  await assert.rejects(lockAndReadPromptRefinerVnextOneShotStage(unavailable.tx),
    /lock_not_available/);
  assert.deepEqual(unavailable.calls, { stages: 0, slots: 0 });

  const inconsistent = txFor(null, slots());
  inconsistent.tx.$queryRaw = async () => [{ id: stage.id }];
  await assert.rejects(lockAndReadPromptRefinerVnextOneShotStage(inconsistent.tx),
    /vnext_one_shot_stage_changed_after_lock/);
  assert.deepEqual(inconsistent.calls, { stages: 1, slots: 0 });

  const wrongId = txFor(stage, slots());
  wrongId.tx.$queryRaw = async () => [{ id: "wrong-stage" }];
  await assert.rejects(lockAndReadPromptRefinerVnextOneShotStage(wrongId.tx),
    /vnext_one_shot_stage_lock_mismatch/);
  assert.deepEqual(wrongId.calls, { stages: 0, slots: 0 });
});
