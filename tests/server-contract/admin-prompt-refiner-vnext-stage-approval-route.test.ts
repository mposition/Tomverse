import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "one-shot-stage-approval-route-test";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

let authenticated = true;
let role = "owner";
let recent = true;
let validOrigin = true;
let prepared = 0;
let writes = 0;
let failPreparation = false;
let failWrite = false;
let installed = false;
const pins = {
  sourceCommitSha: "a".repeat(40),
  sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64),
  manifestRoot: "d".repeat(64),
  runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
  runtimeCommitSha: "a".repeat(40),
  pricePinDigest: "e".repeat(64),
  confirmation: "APPROVE_VNEXT_ONE_SHOT_B03O_RECOVERY_V4_AND_CLOSE_V3",
};

async function loadRoute() {
  if (installed) return import(mod("app/api/admin/prompt-refiner/vnext-stage-approval/route.ts"));
  installed = true;
  mock.module(mod("node_modules/next-auth/next/index.js"), {
    namedExports: { getServerSession: async () => authenticated ?
      { user: { id: "synthetic-owner" } } : null },
  });
  mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
  mock.module(mod("lib/adminAuth.ts"), { namedExports: {
    isAdminSession: () => authenticated,
    getAdminRole: () => role,
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
    readLimitedJson: async (request: Request, limit: number, schema: {
      safeParse: (input: unknown) => { success: boolean; data?: unknown };
    }) => {
      assert.equal(limit, 2 * 1024);
      const parsed = schema.safeParse(await request.json());
      if (!parsed.success) throw Object.assign(new Error("Invalid request payload."),
        { status: 400, code: "INVALID_REQUEST" });
      return parsed.data;
    },
    apiSecurityResponse: (error: unknown) => {
      const problem = error as { status?: number; code?: string };
      return problem.status === 400 ? Response.json({ code: problem.code },
        { status: 400 }) : null;
    },
  } });
  mock.module(mod("lib/promptRefinerVnextOneShotStageAdmission.ts"), { namedExports: {
    preparePromptRefinerVnextOneShotStageBinding: async (input: unknown) => {
      prepared++;
      assert.deepEqual(input, pins);
      if (failPreparation) throw new Error("private observation failed");
      return { id: "prompt-refiner-vnext-one-shot-v4" };
    },
  } });
  mock.module(mod("lib/promptRefinerVnextOneShotV4StageWriter.ts"), { namedExports: {
    createPromptRefinerVnextOneShotV4Stage: async () => {
      writes++;
      if (failWrite) throw new Error("private storage failed");
      return { stageId: "prompt-refiner-vnext-one-shot-v4",
        stageApprovalAuditLogId: "synthetic-audit", slotCount: 80,
        dispatchAuthorized: false };
    },
  } });
  return import(mod("app/api/admin/prompt-refiner/vnext-stage-approval/route.ts"));
}

const request = (body: object = pins) => new Request(
  "http://127.0.0.1:3100/api/admin/prompt-refiner/vnext-stage-approval",
  { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) }
);
const noStore = (response: Response) => assert.equal(
  response.headers.get("cache-control"), "private, no-store, max-age=0");

test("only recently authenticated owner can record a stage, default off", async () => {
  const route = await loadRoute();
  delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_STAGE_WRITE_ENABLED;
  authenticated = false;
  assert.equal((await route.POST(request())).status, 404);
  authenticated = true;
  role = "ops";
  assert.equal((await route.POST(request())).status, 403);
  role = "owner";
  recent = false;
  assert.equal((await route.POST(request())).status, 428);
  recent = true;
  validOrigin = false;
  assert.equal((await route.POST(request())).status, 403);
  validOrigin = true;
  const off = await route.POST(request());
  assert.equal(off.status, 409);
  noStore(off);
  assert.equal(prepared, 0);
  assert.equal(writes, 0);
});

test("strict owner pins are checked before one stage write; response is content-free", async () => {
  const route = await loadRoute();
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_STAGE_WRITE_ENABLED = "1";
  const invalid = await route.POST(request({ ...pins, dispatchAuthorized: true }));
  assert.equal(invalid.status, 400);
  const oldConfirmation = await route.POST(request({ ...pins,
    confirmation: "APPROVE_VNEXT_ONE_SHOT_STAGE_80_SLOTS" }));
  assert.equal(oldConfirmation.status, 400);
  assert.equal(prepared, 0);
  assert.equal(writes, 0);
  const approved = await route.POST(request());
  assert.equal(approved.status, 201);
  noStore(approved);
  assert.deepEqual(await approved.json(), {
    stageId: "prompt-refiner-vnext-one-shot-v4",
    stageApprovalAuditLogId: "synthetic-audit",
    slotCount: 80, dispatchAuthorized: false,
  });
  assert.equal(prepared, 1);
  assert.equal(writes, 1);
  failPreparation = true;
  const failedObservation = await route.POST(request());
  assert.equal(failedObservation.status, 503);
  noStore(failedObservation);
  assert.equal(writes, 1);
  assert.doesNotMatch(JSON.stringify(await failedObservation.json()), /private|runner|root/);
  failPreparation = false;
  failWrite = true;
  const failedStorage = await route.POST(request());
  assert.equal(failedStorage.status, 503);
  noStore(failedStorage);
  assert.doesNotMatch(JSON.stringify(await failedStorage.json()), /private|runner|root/);
  delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_STAGE_WRITE_ENABLED;
});
