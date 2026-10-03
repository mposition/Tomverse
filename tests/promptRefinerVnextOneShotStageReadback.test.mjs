import assert from "node:assert/strict";
import test from "node:test";

import { lockAndReadPromptRefinerVnextOneShotStage,
  readPromptRefinerVnextOneShotStage } from
  "../lib/promptRefinerVnextOneShotStageReadback.ts";

const stage = {
  id: "prompt-refiner-vnext-one-shot-v1",
  status: "staged",
  slotCount: 80,
  sourceCommitSha: "a".repeat(40),
  sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64),
  manifestRoot: "d".repeat(64),
  runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
  runtimeCommitSha: "e".repeat(40),
  pricePinDigest: "f".repeat(64),
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
        assert.deepEqual(where, { id: "prompt-refiner-vnext-one-shot-v1" });
        calls.stages++;
        return row;
      } },
      promptRefinerVnextOneShotSlot: { async findMany({ where }) {
        assert.deepEqual(where, { stageId: "prompt-refiner-vnext-one-shot-v1" });
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
    stagePresent: false, stageStatus: null, slotCount: 0,
    reservedSlots: 0, consumedSlots: 0, reservationShapeValid: false,
    approvalAuditsValid: false, dispatchAuthorized: false,
  });
  assert.deepEqual(calls, { stages: 1, slots: 0 });
});

test("exact 80-slot shape is observed without returning root or identifiers", async () => {
  const items = slots();
  items[0] = { ...items[0], status: "consumed", requestId: "synthetic-request",
    consumedAt: new Date("2026-10-03T00:01:00.000Z") };
  const { tx, calls } = txFor(stage, items);
  const result = await readPromptRefinerVnextOneShotStage(tx);
  assert.equal(result.reservationShapeValid, true);
  assert.equal(result.slotCount, 80);
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

test("transactional read locks the stage before reading reservations", async () => {
  const { tx, calls } = txFor(stage, slots());
  tx.$queryRaw = async (strings, id) => {
    assert.match(strings.join("?"), /FOR NO KEY UPDATE NOWAIT/);
    assert.equal(id, "prompt-refiner-vnext-one-shot-v1");
    assert.deepEqual(calls, { stages: 0, slots: 0 });
    return [{ id }];
  };
  const result = await lockAndReadPromptRefinerVnextOneShotStage(tx);
  assert.equal(result.reservationShapeValid, true);
  assert.equal(result.dispatchAuthorized, false);
  assert.deepEqual(calls, { stages: 1, slots: 1 });
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
