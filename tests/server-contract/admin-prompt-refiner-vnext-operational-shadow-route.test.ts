import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST,
  signPromptRefinerVnextOneShotShadowProof } from
  "../../lib/promptRefinerVnextOneShotShadowProof";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "one-shot-shadow-route-test";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

let authenticated = true;
let role = "owner";
let recent = true;
let validOrigin = true;
let writes = 0;
let unknown = false;
let readbackValid = false;
const stageReadIds: string[] = [];
let installed = false;
const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey.export({ format: "der", type: "pkcs8" })
  .toString("base64");
const shadowTarget = {
  stageApprovalAuditLogId: "synthetic-stage-audit",
  runApprovalAuditLogId: "synthetic-run-audit",
  runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
  sourceCommitSha: "a".repeat(40), sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64), runtimeCommitSha: "d".repeat(40),
  pricePinDigest: "e".repeat(64),
  perRequestCostMicroUsd: 29_918, costCeilingMicroUsd: 2_393_440,
  slotCount: 80, reservedSlots: 80, consumedSlots: 0,
};
const proof = signPromptRefinerVnextOneShotShadowProof({
  version: "prompt-refiner-vnext-one-shot-shadow-proof-v1",
  ...shadowTarget, manifestRoot: "f".repeat(64),
  runnerPreflightDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST,
  cacheWriteInputTokens: 0, providerCalls: 0, slotConsumeCalls: 0,
  signedAt: new Date().toISOString(),
}, privateKey);
const body = {
  proof,
  confirmation: "RECORD_VNEXT_ONE_SHOT_OPERATIONAL_SHADOW_80_SLOTS",
};

async function loadRoute() {
  if (installed) return import(mod("app/api/admin/prompt-refiner/vnext-operational-shadow/route.ts"));
  installed = true;
  mock.module(mod("node_modules/next-auth/next/index.js"), { namedExports: {
    getServerSession: async () => authenticated ? { user: { id: "synthetic-owner" } } : null,
  } });
  mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
  mock.module(mod("lib/adminAuth.ts"), { namedExports: {
    isAdminSession: () => authenticated, getAdminRole: () => role,
  } });
  mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
    assertRecentAdminAuthentication: async () => {
      if (!recent) throw new Error("reauth");
    },
    isAdminReauthenticationError: (error: unknown) =>
      error instanceof Error && error.message === "reauth",
  } });
  mock.module(mod("lib/requestOrigin.ts"), { namedExports: {
    hasValidMutationOrigin: () => validOrigin,
  } });
  mock.module(mod("lib/apiSecurity.ts"), { namedExports: {
    consumeApiRateLimit: async () => {},
    readLimitedJson: async (request: Request, _limit: number,
      schema: { parse: (value: unknown) => unknown }) => schema.parse(await request.json()),
    apiSecurityResponse: (error: unknown) => error instanceof z.ZodError
      ? Response.json({ code: "INVALID_REQUEST" }, { status: 400 }) : null,
  } });
  mock.module(mod("lib/readOnlySnapshotTransaction.ts"), { namedExports: {
    readOnlySnapshotTransaction: async (work: (tx: object) => Promise<unknown>) =>
      work({ promptRefinerVnextOneShotStage: { findUnique: async ({ where }: {
        where: { id: string } }) => {
        stageReadIds.push(where.id);
        return { id: where.id };
      } } }),
  } });
  mock.module(mod("lib/promptRefinerVnextOneShotStageReadback.ts"), { namedExports: {
    readPromptRefinerVnextOneShotStage: async () => ({ stageStatus: "run_approved",
      slotCount: 80, reservedSlots: 80, consumedSlots: 0,
      reservationShapeValid: true, approvalAuditsValid: true,
      dispatchAuthorized: false }),
  } });
  mock.module(mod("lib/promptRefinerVnextOneShotOperationalShadow.ts"), {
    namedExports: {
      recordPromptRefinerVnextOneShotOperationalShadow: async (input: {
        proof: Record<string, unknown>;
        stageId?: string;
      }) => {
        writes++;
        assert.deepEqual(input.proof, proof);
        if (unknown) throw new Error("private transaction failure");
        readbackValid = true;
        return { stageId: input.stageId ?? "prompt-refiner-vnext-one-shot-v4",
          shadowAuditLogId: "synthetic-shadow-audit", dispatchAuthorized: false };
      },
      readPromptRefinerVnextOneShotOperationalShadow: async () => ({
        present: readbackValid, valid: readbackValid,
        shadowAuditLogId: readbackValid ? "synthetic-shadow-audit" : null,
        cacheWriteInputTokens: readbackValid ? 0 : null,
        dispatchAuthorized: false,
      }),
      promptRefinerVnextOneShotShadowTarget: () => shadowTarget,
    },
  });
  mock.module(mod("lib/promptRefinerVnextOneShotPaidAuthorization.ts"), {
    namedExports: { readPromptRefinerVnextOneShotPaidAuthorization: async () => ({
      present: false, valid: false, auditLogId: null,
    }) },
  });
  return import(mod("app/api/admin/prompt-refiner/vnext-operational-shadow/route.ts"));
}

const request = (value: object = body) => new Request(
  "http://127.0.0.1:3100/api/admin/prompt-refiner/vnext-operational-shadow",
  { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(value) });
const readRequest = () => new Request(
  "http://127.0.0.1:3100/api/admin/prompt-refiner/vnext-operational-shadow");

test("shadow write is owner-only, recent-authenticated, origin-bound and default off", async () => {
  const route = await loadRoute();
  delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_WRITE_ENABLED;
  authenticated = false;
  assert.equal((await route.POST(request())).status, 404);
  authenticated = true; role = "ops";
  assert.equal((await route.POST(request())).status, 403);
  role = "owner"; recent = false;
  assert.equal((await route.POST(request())).status, 428);
  recent = true; validOrigin = false;
  assert.equal((await route.POST(request())).status, 403);
  validOrigin = true;
  assert.equal((await route.POST(request())).status, 409);
  assert.equal(writes, 0);
});

test("write and readback are content-free; unknown outcome requests human readback", async () => {
  const route = await loadRoute();
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_WRITE_ENABLED = "1";
  assert.equal((await route.POST(request({ ...body, sourceText: "never accepted" }))).status, 400);
  const written = await route.POST(request());
  assert.equal(written.status, 201);
  assert.deepEqual(await written.json(), { stageId: "prompt-refiner-vnext-one-shot-v4",
    shadowAuditLogId: "synthetic-shadow-audit", dispatchAuthorized: false });
  const readback = await route.GET(readRequest());
  assert.equal(readback.status, 200);
  assert.deepEqual(stageReadIds, ["prompt-refiner-vnext-one-shot-v4"]);
  const observed = (await readback.json()).readback;
  assert.equal(observed.evidence.valid, true);
  assert.equal(observed.evidence.cacheWriteInputTokens, 0);
  assert.equal(observed.paidAuthorizationAuditPresent, false);
  unknown = true;
  const failed = await route.POST(request());
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { code: "SHADOW_EVIDENCE_OUTCOME_UNKNOWN",
    retryAuthorized: false, humanReviewRequired: true });
  assert.equal(writes, 2);
});

test("v5 shadow requires a separate stage-specific confirmation", async () => {
  const route = await loadRoute();
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_WRITE_ENABLED = "1";
  unknown = false;
  const before = writes;
  const stageId = "prompt-refiner-vnext-one-shot-v5";
  assert.equal((await route.POST(request({ ...body, stageId }))).status, 400);
  assert.equal((await route.POST(request({ ...body,
    confirmation: "RECORD_VNEXT_ONE_SHOT_NEW_V5_OPERATIONAL_SHADOW_80_SLOTS" }))).status, 400);
  assert.equal(writes, before);
  const accepted = await route.POST(request({ ...body, stageId,
    confirmation: "RECORD_VNEXT_ONE_SHOT_NEW_V5_OPERATIONAL_SHADOW_80_SLOTS" }));
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).stageId, stageId);
  assert.equal(writes, before + 1);
  delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SHADOW_WRITE_ENABLED;
});
