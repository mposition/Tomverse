import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { Session } from "next-auth";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const stageId = "prompt-refiner-vnext-one-shot-v2";
const target = {
  stageApprovalAuditLogId: "synthetic-stage-audit",
  runApprovalAuditLogId: "synthetic-run-audit",
  runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
};
const baseStage = {
  id: stageId, status: "run_approved", approvedBy: "synthetic-owner",
  ...target,
  sourceCommitSha: "a".repeat(40), sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64), manifestRoot: "d".repeat(64),
  runtimeCommitSha: "e".repeat(40), pricePinDigest: "f".repeat(64),
  perRequestCostMicroUsd: BigInt(29_918), slotCount: 80,
  costCeilingMicroUsd: BigInt(2_393_440),
};
let stage = { ...baseStage };
let snapshot = { stagePresent: true, stageStatus: "run_approved",
  slotCount: 80, reservedSlots: 80, consumedSlots: 0,
  reservationShapeValid: true, approvalAuditsValid: true };
let evidenceRows: Array<Record<string, unknown>> = [];
let auditsValid = true;
let receiptValid = true;
let writes = 0;
let sourceReads = 0;
let writeFailure = false;
const tx = {
  adminAuditLog: {
    findMany: async () => evidenceRows,
    findUnique: async () => ({ createdAt: new Date("2026-10-05T00:00:00.000Z") }),
  },
  promptRefinerVnextOneShotStage: { findUnique: async ({ where }: {
    where: { id: string } }) => where.id === stage.id ? stage : null },
};

mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  takeAuditChainLock: async () => {},
  writeAdminAuditLog: async (input: Record<string, unknown>) => {
    if (writeFailure) throw new Error("ambiguous transaction failure");
    writes++;
    evidenceRows.push({ id: "synthetic-shadow-audit", action: input.action,
      targetType: input.targetType, targetId: input.targetId,
      actorUserId: "synthetic-owner", summary: input.summary,
      metadata: input.metadata, createdAt: new Date("2026-10-05T00:00:01.000Z") });
    return "synthetic-shadow-audit";
  },
} });
mock.module(mod("lib/adminAuditIntegrityCore.ts"), { namedExports: {
  adminAuditIntegrityKeys: () => ["synthetic-integrity-key"],
} });
mock.module(mod("lib/promptRefinerVnextOneShotAuditReadback.ts"), { namedExports: {
  promptRefinerVnextOneShotApprovalAuditsAreValid: async () => auditsValid,
  promptRefinerVnextOneShotAuditReceiptIsValid: async () => receiptValid,
} });
mock.module(mod("lib/promptRefinerVnextOneShotCandidateSourceReadback.ts"), {
  namedExports: { readPromptRefinerVnextOneShotCandidateSource: async () => {
    sourceReads++;
  } },
});
mock.module(mod("lib/promptRefinerVnextOneShotStageReadback.ts"), {
  namedExports: { lockAndReadPromptRefinerVnextOneShotStage: async () => snapshot },
});
mock.module(mod("lib/prisma.ts"), { namedExports: {
  prisma: { $transaction: async (work: (tx: object) => Promise<unknown>) => work(tx) },
} });
mock.module(mod("lib/routerDevelopmentBenchmark.ts"), { namedExports: {
  canonicalBenchmarkJson: (value: unknown) => JSON.stringify(value),
} });

type ShadowModule = typeof import("../../lib/promptRefinerVnextOneShotOperationalShadow");
const load = () => import(mod("lib/promptRefinerVnextOneShotOperationalShadow.ts")) as
  Promise<ShadowModule>;
const input = () => ({
  session: { user: { id: "synthetic-owner" } } as Session,
  request: new Request("https://example.test/api/admin/prompt-refiner/vnext-operational-shadow",
    { method: "POST" }),
  expected: target,
});
const reset = () => {
  stage = { ...baseStage };
  snapshot = { stagePresent: true, stageStatus: "run_approved",
    slotCount: 80, reservedSlots: 80, consumedSlots: 0,
    reservationShapeValid: true, approvalAuditsValid: true };
  evidenceRows = []; auditsValid = true; receiptValid = true;
  writes = 0; sourceReads = 0; writeFailure = false;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT = baseStage.manifestRoot;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = baseStage.runnerDigest;
};

test("app records one content-free shadow for the exact synthetic stage/run/80 slots", async () => {
  const { readPromptRefinerVnextOneShotOperationalShadow,
    recordPromptRefinerVnextOneShotOperationalShadow } = await load();
  reset();
  assert.deepEqual(await readPromptRefinerVnextOneShotOperationalShadow(
    tx as never, stage as never), {
    present: false, valid: false, shadowAuditLogId: null, dispatchAuthorized: false,
  });
  const result = await recordPromptRefinerVnextOneShotOperationalShadow(input());
  assert.deepEqual(result, { stageId, shadowAuditLogId: "synthetic-shadow-audit",
    dispatchAuthorized: false });
  assert.equal(writes, 1);
  assert.equal(sourceReads, 1);
  assert.equal(evidenceRows[0].metadata &&
    JSON.stringify(evidenceRows[0].metadata).includes("manifestRoot"), false);
  assert.deepEqual(await readPromptRefinerVnextOneShotOperationalShadow(
    tx as never, stage as never), {
    present: true, valid: true, shadowAuditLogId: "synthetic-shadow-audit",
    dispatchAuthorized: false,
  });
  await assert.rejects(recordPromptRefinerVnextOneShotOperationalShadow(input()),
    /vnext_one_shot_shadow_duplicate/);
  assert.equal(writes, 1);
});

test("the closed legacy stage cannot receive new shadow evidence", async () => {
  const { recordPromptRefinerVnextOneShotOperationalShadow } = await load();
  reset();
  stage = { ...baseStage, id: "prompt-refiner-vnext-one-shot-v1",
    status: "closed" };
  await assert.rejects(recordPromptRefinerVnextOneShotOperationalShadow(input()),
    /vnext_one_shot_shadow_binding_mismatch/);
  assert.equal(writes, 0);
});

test("missing run, broken reservations, audit, custody or target refuse before write", async () => {
  const { recordPromptRefinerVnextOneShotOperationalShadow } = await load();
  reset();
  const mutations = [
    () => { snapshot.stageStatus = "staged"; },
    () => { snapshot.reservedSlots = 79; },
    () => { snapshot.reservationShapeValid = false; },
    () => { snapshot.approvalAuditsValid = false; },
    () => { stage.runApprovalAuditLogId = "different-run"; },
    () => { stage.runtimeDeploymentId = "ffffffff-ffff-ffff-ffff-ffffffffffff"; },
    () => { stage.manifestRoot = "0".repeat(64); },
    () => { stage.runnerDigest = "0".repeat(64); },
  ];
  for (const mutate of mutations) {
    reset(); mutate();
    await assert.rejects(recordPromptRefinerVnextOneShotOperationalShadow(input()));
    assert.equal(writes, 0);
  }
});

test("mismatched, duplicate and unverifiable shadow rows never read back as valid", async () => {
  const { readPromptRefinerVnextOneShotOperationalShadow,
    recordPromptRefinerVnextOneShotOperationalShadow } = await load();
  reset();
  await recordPromptRefinerVnextOneShotOperationalShadow(input());
  const original = evidenceRows[0];
  evidenceRows = [{ ...original, metadata: { ...(original.metadata as object),
    runApprovalAuditLogId: "different-run" } }];
  assert.equal((await readPromptRefinerVnextOneShotOperationalShadow(
    tx as never, stage as never)).valid, false);
  evidenceRows = [original, { ...original, id: "duplicate" }];
  assert.equal((await readPromptRefinerVnextOneShotOperationalShadow(
    tx as never, stage as never)).valid, false);
  evidenceRows = [original]; receiptValid = false;
  assert.equal((await readPromptRefinerVnextOneShotOperationalShadow(
    tx as never, stage as never)).valid, false);
  receiptValid = true; auditsValid = false;
  assert.equal((await readPromptRefinerVnextOneShotOperationalShadow(
    tx as never, stage as never)).valid, false);
});

test("unknown audit outcome yields no claimed completion", async () => {
  const { readPromptRefinerVnextOneShotOperationalShadow,
    recordPromptRefinerVnextOneShotOperationalShadow } = await load();
  reset(); writeFailure = true;
  await assert.rejects(recordPromptRefinerVnextOneShotOperationalShadow(input()),
    /ambiguous transaction failure/);
  assert.equal(writes, 0);
  assert.equal((await readPromptRefinerVnextOneShotOperationalShadow(
    tx as never, stage as never)).valid, false);
});
