import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const stageId = "prompt-refiner-vnext-one-shot-v3";
const stageReadIds: string[] = [];

mock.module(mod("lib/apiSecurity.ts"), {
  namedExports: {
    apiSecurityResponse: () => null,
    readLimitedJson: async () => { throw new Error("write_not_expected"); },
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
      stage: { id: string } | null) => ({ valid: stage?.id === stageId }),
    readPromptRefinerVnextOneShotDisposition: async (_tx: unknown,
      stage: { id: string } | null) => ({ valid: stage?.id === stageId }),
    recordPromptRefinerVnextOneShotGateEvidence: async () => {
      throw new Error("write_not_expected");
    },
    recordPromptRefinerVnextOneShotDisposition: async () => {
      throw new Error("write_not_expected");
    },
  },
});
mock.module(mod("lib/readOnlySnapshotTransaction.ts"), {
  namedExports: { readOnlySnapshotTransaction: async (
    work: (tx: object) => Promise<unknown>) => work({
      promptRefinerVnextOneShotStage: { findUnique: async ({ where }: {
        where: { id: string } }) => {
        stageReadIds.push(where.id);
        return where.id === stageId ? { id: stageId } : null;
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
