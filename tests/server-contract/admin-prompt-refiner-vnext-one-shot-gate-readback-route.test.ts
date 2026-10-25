import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const stageId = "prompt-refiner-vnext-one-shot-v4";
const v5StageId = "prompt-refiner-vnext-one-shot-v5";
const stageReadIds: string[] = [];
const gateWriteIds: string[] = [];
const dispositionWriteIds: string[] = [];

mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: {
    apiSecurityResponse: () => null,
    readLimitedJson: async (request: Request, _limit: number,
      schema: z.ZodTypeAny) => schema.parse(await request.json()),
  },
});
mock.module(mod("lib/promptRefinerVnextOneShotGateAttestation.ts"), {
  namedExports: { promptRefinerVnextOneShotGateAttestationSchema: z.any() },
});
mock.module(mod("lib/promptRefinerVnextOneShotGateRouteAccess.ts"), {
  namedExports: { promptRefinerVnextOneShotGateOwner: async () => ({
    session: { user: { id: "synthetic-owner" } },
  }) },
});
mock.module(mod("lib/promptRefinerVnextOneShotGateEvidence.ts"), {
  namedExports: {
    readPromptRefinerVnextOneShotGateEvidence: async (_tx: unknown,
      stage: { id: string } | null, requestedStageId: string) =>
      ({ valid: stage?.id === requestedStageId,
        reasonCodes: stage?.id === v5StageId ? ["latency_ceiling_exceeded"] : null,
        latencyOnlyFailure: stage?.id === v5StageId ? true : null }),
    readPromptRefinerVnextOneShotDisposition: async (_tx: unknown,
      stage: { id: string } | null, requestedStageId: string) =>
      ({ valid: stage?.id === requestedStageId }),
    recordPromptRefinerVnextOneShotGateEvidence: async (input: {
      stageId: string }) => {
      gateWriteIds.push(input.stageId);
      return { gateOutcome: "pass" };
    },
    recordPromptRefinerVnextOneShotDisposition: async (input: {
      stageId: string }) => {
      dispositionWriteIds.push(input.stageId);
      return { finalDisposition: "pass" };
    },
  },
});

test("v5 gate and disposition writes require explicit v5 confirmation", async () => {
  const gate = await import(mod("app/api/admin/prompt-refiner/vnext-one-shot-gate/route.ts"));
  const disposition = await import(mod(
    "app/api/admin/prompt-refiner/vnext-one-shot-disposition/route.ts"));
  const priorGateFlag = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_WRITE_ENABLED;
  const priorDecisionFlag = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPOSITION_WRITE_ENABLED;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_WRITE_ENABLED = "1";
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPOSITION_WRITE_ENABLED = "1";
  try {
    const gateBody = { stageId: v5StageId, attestation: {},
      confirmation: "RECORD_VNEXT_ONE_SHOT_V5_DETERMINISTIC_GATE" };
    const gateRequest = (body: object) => new Request(
      "https://example.test/api/admin/prompt-refiner/vnext-one-shot-gate",
      { method: "POST", body: JSON.stringify(body) });
    assert.equal((await gate.POST(gateRequest(gateBody))).status, 201);
    assert.deepEqual(gateWriteIds, [v5StageId]);
    await gate.POST(gateRequest({ ...gateBody,
      confirmation: "RECORD_VNEXT_ONE_SHOT_DETERMINISTIC_GATE" }));
    assert.deepEqual(gateWriteIds, [v5StageId]);
    const decisionBody = {
      stageId: v5StageId, stageApprovalAuditLogId: "stage-audit",
      runApprovalAuditLogId: "run-audit", shadowAuditLogId: "shadow-audit",
      gateAuditLogId: "gate-audit",
      runtimeDeploymentId: "11111111-1111-4111-8111-111111111111",
      decision: "pass",
      confirmation: "RECORD_VNEXT_ONE_SHOT_V5_OWNER_DISPOSITION",
    };
    const decisionRequest = (body: object) => new Request(
      "https://example.test/api/admin/prompt-refiner/vnext-one-shot-disposition",
      { method: "POST", body: JSON.stringify(body) });
    assert.equal((await disposition.POST(decisionRequest(decisionBody))).status, 201);
    assert.deepEqual(dispositionWriteIds, [v5StageId]);
    await disposition.POST(decisionRequest({ ...decisionBody,
      confirmation: "RECORD_VNEXT_ONE_SHOT_OWNER_DISPOSITION" }));
    assert.deepEqual(dispositionWriteIds, [v5StageId]);
  } finally {
    if (priorGateFlag === undefined)
      delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_WRITE_ENABLED;
    else process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_WRITE_ENABLED = priorGateFlag;
    if (priorDecisionFlag === undefined)
      delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPOSITION_WRITE_ENABLED;
    else process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPOSITION_WRITE_ENABLED =
      priorDecisionFlag;
  }
});
mock.module(mod("lib/readOnlySnapshotTransaction.ts"), {
  namedExports: { readOnlySnapshotTransaction: async (
    work: (tx: object) => Promise<unknown>) => work({
      promptRefinerVnextOneShotStage: { findUnique: async ({ where }: {
        where: { id: string } }) => {
        stageReadIds.push(where.id);
        return where.id === stageId || where.id === v5StageId
          ? { id: where.id } : null;
      } },
    }),
  },
});

test("gate and disposition read back the replacement stage only", async () => {
  const gate = await import(mod("app/api/admin/prompt-refiner/vnext-one-shot-gate/route.ts"));
  const disposition = await import(mod(
    "app/api/admin/prompt-refiner/vnext-one-shot-disposition/route.ts"));
  const request = new Request("https://example.test/api/admin/prompt-refiner/vnext-one-shot-gate");
  const gateResponse = await gate.GET(request);
  const dispositionResponse = await disposition.GET(request);
  assert.equal(gateResponse.status, 200);
  assert.equal(dispositionResponse.status, 200);
  assert.equal((await gateResponse.json()).readback.valid, true);
  assert.equal((await dispositionResponse.json()).readback.valid, true);
  assert.deepEqual(stageReadIds, [stageId, stageId]);
});

test("explicit v5 readback selects v5 and rejects unknown stage IDs", async () => {
  stageReadIds.length = 0;
  const gate = await import(mod("app/api/admin/prompt-refiner/vnext-one-shot-gate/route.ts"));
  const disposition = await import(mod(
    "app/api/admin/prompt-refiner/vnext-one-shot-disposition/route.ts"));
  const request = new Request("https://example.test/api/admin/prompt-refiner/vnext-one-shot-gate?stageId=" +
    v5StageId);
  const gateReadback = (await (await gate.GET(request)).json()).readback;
  assert.equal(gateReadback.valid, true);
  assert.deepEqual(gateReadback.reasonCodes, ["latency_ceiling_exceeded"]);
  assert.equal(gateReadback.latencyOnlyFailure, true);
  assert.equal((await (await disposition.GET(request)).json()).readback.valid, true);
  assert.deepEqual(stageReadIds, [v5StageId, v5StageId]);
  const invalid = new Request("https://example.test/api/admin/prompt-refiner/vnext-one-shot-gate?stageId=invalid");
  assert.equal((await gate.GET(invalid)).status, 400);
  assert.equal((await disposition.GET(invalid)).status, 400);
  assert.deepEqual(stageReadIds, [v5StageId, v5StageId]);
});
