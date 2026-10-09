import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { Session } from "next-auth";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST,
  promptRefinerVnextOneShotShadowPublicKeyDigest,
  signPromptRefinerVnextOneShotShadowProof } from
  "../../lib/promptRefinerVnextOneShotShadowProof";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const stageId = "prompt-refiner-vnext-one-shot-v4";
const target = {
  stageApprovalAuditLogId: "synthetic-stage-audit",
  runApprovalAuditLogId: "synthetic-run-audit",
  runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
};
const shadowKeys = generateKeyPairSync("ed25519");
const privateKey = shadowKeys.privateKey.export({
  format: "der", type: "pkcs8",
}).toString("base64");
const publicKey = shadowKeys.publicKey.export({
  format: "der", type: "spki",
}).toString("base64");
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
let runCreatedAt = new Date();
const tx = {
  adminAuditLog: {
    findMany: async ({ where }: { where: { targetId: string } }) =>
      evidenceRows.filter((row) => row.targetId === where.targetId),
    findUnique: async () => ({ createdAt: runCreatedAt }),
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
      metadata: input.metadata, createdAt: new Date() });
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
mock.module(mod("lib/promptRefinerVnextOneShotPriceGuard.ts"), {
  namedExports: { assertPromptRefinerVnextOneShotCurrentPrice: async () => {} },
});
mock.module(mod("lib/promptRefinerVnextOneShotStageReadback.ts"), {
  namedExports: { lockAndReadPromptRefinerVnextOneShotStage: async () => snapshot },
});
mock.module(mod("lib/prisma.ts"), { namedExports: {
  prisma: { $transaction: async (work: (tx: object) => Promise<unknown>) => work(tx) },
} });
type ShadowModule = typeof import("../../lib/promptRefinerVnextOneShotOperationalShadow");
const load = () => import(mod("lib/promptRefinerVnextOneShotOperationalShadow.ts")) as
  Promise<ShadowModule>;
const proof = () => signPromptRefinerVnextOneShotShadowProof({
  version: "prompt-refiner-vnext-one-shot-shadow-proof-v1",
  ...target,
  sourceCommitSha: baseStage.sourceCommitSha,
  sourceManifestDigest: baseStage.sourceManifestDigest,
  runnerDigest: baseStage.runnerDigest,
  runtimeCommitSha: baseStage.runtimeCommitSha,
  pricePinDigest: baseStage.pricePinDigest,
  perRequestCostMicroUsd: 29_918, costCeilingMicroUsd: 2_393_440,
  slotCount: 80, reservedSlots: 80, consumedSlots: 0,
  manifestRoot: baseStage.manifestRoot,
  runnerPreflightDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST,
  cacheWriteInputTokens: 0, providerCalls: 0, slotConsumeCalls: 0,
  signedAt: new Date().toISOString(),
}, privateKey);
const input = () => ({
  session: { user: { id: "synthetic-owner" } } as Session,
  request: new Request("https://example.test/api/admin/prompt-refiner/vnext-operational-shadow",
    { method: "POST" }),
  proof: proof(),
});
const reset = () => {
  stage = { ...baseStage };
  snapshot = { stagePresent: true, stageStatus: "run_approved",
    slotCount: 80, reservedSlots: 80, consumedSlots: 0,
    reservationShapeValid: true, approvalAuditsValid: true };
  evidenceRows = []; auditsValid = true; receiptValid = true;
  writes = 0; sourceReads = 0; writeFailure = false;
  runCreatedAt = new Date(Date.now() - 2_000);
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT = baseStage.manifestRoot;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = baseStage.runnerDigest;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_B64 = publicKey;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_DIGEST =
    promptRefinerVnextOneShotShadowPublicKeyDigest(publicKey);
};

test("absent v5 readback does not report historical v4 shadow as present", async () => {
  const shadow = await load(); reset();
  evidenceRows = [{ targetId: stageId }];
  const result = await shadow.readPromptRefinerVnextOneShotOperationalShadow(
    tx as never, null, "prompt-refiner-vnext-one-shot-v5");
  assert.equal(result.present, false);
  assert.equal(result.valid, false);
});

test("app records one content-free shadow for the exact synthetic stage/run/80 slots", async () => {
  const { readPromptRefinerVnextOneShotOperationalShadow,
    recordPromptRefinerVnextOneShotOperationalShadow } = await load();
  reset();
  assert.deepEqual(await readPromptRefinerVnextOneShotOperationalShadow(
    tx as never, stage as never), {
    present: false, valid: false, shadowAuditLogId: null,
    cacheWriteInputTokens: null, dispatchAuthorized: false,
  });
  const submitted = input();
  const result = await recordPromptRefinerVnextOneShotOperationalShadow(submitted);
  assert.deepEqual(result, { stageId, shadowAuditLogId: "synthetic-shadow-audit",
    dispatchAuthorized: false });
  assert.equal(writes, 1);
  assert.equal(sourceReads, 1);
  assert.equal(evidenceRows[0].metadata &&
    JSON.stringify(evidenceRows[0].metadata).includes("manifestRoot"), false);
  assert.equal((evidenceRows[0].metadata as Record<string, unknown>)
    .cacheWriteInputTokens, submitted.proof.cacheWriteInputTokens);
  assert.deepEqual(await readPromptRefinerVnextOneShotOperationalShadow(
    tx as never, stage as never), {
    present: true, valid: true, shadowAuditLogId: "synthetic-shadow-audit",
    cacheWriteInputTokens: 0,
    dispatchAuthorized: false,
  });
  // A database clock behind the app clock must not invalidate an audit that
  // passed the app-clock freshness check before its transactional write.
  evidenceRows[0].createdAt = new Date(Date.now() - 30_000);
  runCreatedAt = new Date(Date.now() - 60_000);
  assert.equal((await readPromptRefinerVnextOneShotOperationalShadow(
    tx as never, stage as never)).valid, true);
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
  const { recordPromptRefinerVnextOneShotOperationalShadow,
    promptRefinerVnextOneShotShadowTarget } = await load();
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
    () => { stage.perRequestCostMicroUsd = BigInt(1); },
  ];
  for (const mutate of mutations) {
    reset(); mutate();
    await assert.rejects(recordPromptRefinerVnextOneShotOperationalShadow(input()));
    assert.equal(writes, 0);
  }
  assert.equal(promptRefinerVnextOneShotShadowTarget(stage as never), null);
});

test("caller claims and altered signed evidence cannot create an audit", async () => {
  const { recordPromptRefinerVnextOneShotOperationalShadow } = await load();
  for (const altered of [
    { cacheWriteInputTokens: true },
    { cacheWriteInputTokens: "0" },
    { cacheWriteInputTokens: 1 },
    { runtimeCommitSha: "0".repeat(40) },
  ]) {
    reset();
    await assert.rejects(recordPromptRefinerVnextOneShotOperationalShadow({
      ...input(), proof: { ...proof(), ...altered },
    }), /vnext_one_shot_shadow_proof_invalid/);
    assert.equal(writes, 0);
    assert.equal(sourceReads, 0);
  }
  reset();
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_PUBLIC_KEY_DIGEST =
    "0".repeat(64);
  await assert.rejects(recordPromptRefinerVnextOneShotOperationalShadow(input()),
    /vnext_one_shot_shadow_signer_pin_unavailable/);
  assert.equal(writes, 0);
});

test("mismatched, duplicate and unverifiable shadow rows never read back as valid", async () => {
  const { readPromptRefinerVnextOneShotOperationalShadow,
    recordPromptRefinerVnextOneShotOperationalShadow } = await load();
  reset();
  await recordPromptRefinerVnextOneShotOperationalShadow(input());
  const original = evidenceRows[0];
  for (const value of [undefined, true, "0", 1]) {
    const metadata = { ...(original.metadata as object),
      cacheWriteInputTokens: value };
    if (value === undefined) delete metadata.cacheWriteInputTokens;
    evidenceRows = [{ ...original, metadata }];
    const readback = await readPromptRefinerVnextOneShotOperationalShadow(
      tx as never, stage as never);
    assert.equal(readback.valid, false);
    assert.equal(readback.cacheWriteInputTokens, null);
  }
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
