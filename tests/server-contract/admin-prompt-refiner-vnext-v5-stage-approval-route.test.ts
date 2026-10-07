import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.DIRECT_URL ||= process.env.DATABASE_URL;
process.env.NEXTAUTH_SECRET ||= "one-shot-v5-stage-route-test";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";

let owner = true;
let recent = true;
let validOrigin = true;
let prepared = 0;
let written = 0;
const pins = {
  sourceCommitSha: "a".repeat(40),
  sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64),
  manifestRoot: "d".repeat(64),
  runtimeDeploymentId: "12345678-1234-1234-1234-123456789abc",
  runtimeCommitSha: "a".repeat(40),
  pricePinDigest: "e".repeat(64),
  confirmation: "APPROVE_VNEXT_ONE_SHOT_POST_UNKNOWN_NEW_V5_STAGE_ONLY",
};

mock.module(mod("node_modules/next-auth/next/index.js"), { namedExports: {
  getServerSession: async () => ({ user: { id: "synthetic-owner" } }),
} });
mock.module(mod("lib/auth.ts"), { namedExports: { authOptions: {} } });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  isAdminSession: () => true,
  getAdminRole: () => owner ? "owner" : "ops",
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
  readLimitedJson: async (request: Request, _limit: number, schema: {
    safeParse: (input: unknown) => { success: boolean; data?: unknown };
  }) => {
    const result = schema.safeParse(await request.json());
    if (!result.success) throw Object.assign(new Error("invalid"),
      { status: 400, code: "INVALID_REQUEST" });
    return result.data;
  },
  apiSecurityResponse: (error: unknown) => {
    const problem = error as { status?: number; code?: string };
    return problem.status === 400 ? Response.json({ code: problem.code },
      { status: 400 }) : null;
  },
} });
mock.module(mod("lib/promptRefinerVnextOneShotStageAdmission.ts"), { namedExports: {
  preparePromptRefinerVnextOneShotStageBinding: async (expected: unknown,
    successor: string) => {
    prepared++;
    assert.deepEqual(expected, pins);
    assert.equal(successor, "v5");
    return { id: "prompt-refiner-vnext-one-shot-v5" };
  },
} });
mock.module(mod("lib/promptRefinerVnextOneShotV5StageWriter.ts"), { namedExports: {
  createPromptRefinerVnextOneShotV5Stage: async () => {
    written++;
    return { stageId: "prompt-refiner-vnext-one-shot-v5",
      stageApprovalAuditLogId: "synthetic-stage-audit",
      recoveryAuditLogId: "synthetic-recovery-audit", slotCount: 80,
      dispatchAuthorized: false };
  },
} });

const loadRoute = () => import(mod(
  "app/api/admin/prompt-refiner/vnext-v5-stage-approval/route.ts"));
const request = (body: object = pins) => new Request(
  "http://127.0.0.1:3100/api/admin/prompt-refiner/vnext-v5-stage-approval",
  { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });

test("v5 stage is default off and requires recent owner authentication", async () => {
  const route = await loadRoute();
  delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_V5_STAGE_WRITE_ENABLED;
  owner = false;
  assert.equal((await route.POST(request())).status, 403);
  owner = true;
  recent = false;
  assert.equal((await route.POST(request())).status, 428);
  recent = true;
  validOrigin = false;
  assert.equal((await route.POST(request())).status, 403);
  validOrigin = true;
  assert.equal((await route.POST(request())).status, 409);
  assert.equal(prepared, 0);
  assert.equal(written, 0);
});

test("v5 stage requires its own strict confirmation and returns no content", async () => {
  const route = await loadRoute();
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_V5_STAGE_WRITE_ENABLED = "1";
  assert.equal((await route.POST(request({ ...pins,
    confirmation: "APPROVE_VNEXT_ONE_SHOT_B03O_RECOVERY_V4_AND_CLOSE_V3" })))
    .status, 400);
  assert.equal((await route.POST(request({ ...pins, extra: true }))).status, 400);
  assert.equal(prepared, 0);
  assert.equal(written, 0);
  const response = await route.POST(request());
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"),
    "private, no-store, max-age=0");
  assert.equal(prepared, 1);
  assert.equal(written, 1);
  const body = await response.json();
  assert.equal(body.dispatchAuthorized, false);
  assert.equal(body.slotCount, 80);
  assert.equal(JSON.stringify(body).includes(pins.manifestRoot), false);
  delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_V5_STAGE_WRITE_ENABLED;
});
